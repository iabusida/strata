import "./env.js";

import { AssetType, CandleInterval, SignalState, TradingStyle } from "@prisma/client";

import { fetchOrderBookExecutionRead, fetchRecentCandles } from "./bitunix-service.js";
import { scanCapitulationBounces } from "./capitulation-bounce-scan.js";
import { computeOrderBookStrengthScore } from "./dead-zone-engine.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma-client.js";
import { sendTelegramMessage } from "./telegram-service.js";

type RunnerSignalType = "RUNNER_LIQUIDITY_BUY" | "RUNNER_LIQUIDITY_WAIT" | "RUNNER_LIQUIDITY_EXIT";

type LifecycleMetrics = {
  firstDetectedAt: string;
  lastObservedAt: string;
  signalAgeHours: number;
  highestStageObserved: string;
};

type RunnerDecision = {
  symbol: string;
  signalState: SignalState;
  recommendation: "ENTER_LONG" | "WAIT" | "CLOSE";
  action: "BUY" | "WAIT" | "SELL";
  signalType: RunnerSignalType;
  rationale: string;
  metrics: {
    score: number;
    adjustedScore: number;
    stage: string;
    confluenceScore: number;
    adjustedConfluenceScore: number;
    recoveryScore: number;
    accumulationScore: number;
    prePumpScore: number;
    adjustedPrePumpScore: number;
    obsScore: number;
    deltaScore24h: number;
    spreadPct: number | null;
    markPrice: number | null;
    bidDepthUsd: number | null;
    askDepthUsd: number | null;
    combinedDepthUsd: number | null;
    imbalancePct: number | null;
    deltaImbalancePct: number | null;
    bidDepthGrowthPct: number | null;
    askDepthDecayPct: number | null;
    fundingRate: number;
    absorptionScore: number;
    distributionScore: number | null;
    askWallScore: number | null;
    bidWallScore: number | null;
    liquidityDivergence: string | null;
    supportDefenseScore: number | null;
    priceConfirmationScore: number | null;
    finalLiquidityScore: number | null;
    actionRecommendation: "BUY" | "WAIT" | "SELL";
    actionConfidencePct: number;
    actionEvidencePositive: string[];
    actionEvidenceWarnings: string[];
    actionMissingConditions: string[];
    actionPrimaryBlocker: string;
    actionReason: string;
    liquidityRegime: string;
    obCurrentPct: number | null;
    ob1mPct: number | null;
    ob5mPct: number | null;
    ob15mPct: number | null;
    liquidityStabilityScore: number | null;
    liquidityStabilityLabel: string | null;
    agePenaltyTier: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  };
};

type PreviousDecision = {
  recommendation: string | null;
  signalState: SignalState;
  createdAt: Date;
  metrics: Record<string, unknown>;
};

type StageSummary = {
  stage: string;
  count: number;
  wins: number;
  losses: number;
  breakeven: number;
  avgReturnPct: number;
};

type ExecutionPlan = {
  tier: "PROBE" | "SCALE" | "FULL" | "NO_ENTRY";
  sizeGuidance: string;
  leverageCap: string;
  invalidation: string;
  timeStop: string;
};

const MAX_RUNNERS = Math.max(3, Number.parseInt(process.env.RUNNER_LIQUIDITY_MAX_RUNNERS ?? "10", 10) || 10);
const MIN_COMBINED_DEPTH_USD = Math.max(1000, Number.parseFloat(process.env.RUNNER_LIQUIDITY_MIN_DEPTH_USD ?? "10000") || 10000);
const MAX_SPREAD_PCT = Math.max(0.01, Number.parseFloat(process.env.RUNNER_LIQUIDITY_MAX_SPREAD_PCT ?? "0.12") || 0.12);
const MIN_BUY_IMBALANCE = Math.max(-1, Math.min(1, Number.parseFloat(process.env.RUNNER_LIQUIDITY_MIN_BUY_IMBALANCE ?? "0.08") || 0.08));
const EXIT_IMBALANCE = Math.max(-1, Math.min(1, Number.parseFloat(process.env.RUNNER_LIQUIDITY_EXIT_IMBALANCE ?? "-0.20") || -0.20));
const WIDE_SPREAD_EXIT_PCT = Math.max(MAX_SPREAD_PCT, Number.parseFloat(process.env.RUNNER_LIQUIDITY_WIDE_SPREAD_EXIT_PCT ?? "0.30") || 0.30);
const ENTRY_OBS_MIN = Math.max(0, Math.min(100, Number.parseFloat(process.env.RUNNER_LIQUIDITY_ENTRY_OBS_MIN ?? "60") || 60));
const WAIT_OBS_MIN = Math.max(0, Math.min(100, Number.parseFloat(process.env.RUNNER_LIQUIDITY_WAIT_OBS_MIN ?? "40") || 40));

const STAGE_RANK: Record<string, number> = {
  IGNORE: 0,
  CAPITULATION: 1,
  RECOVERING_CAPITULATION: 2,
  RECOVERY: 3,
  ACCUMULATION: 4,
  PRE_PUMP: 5,
  ACTIVE_RUN: 6,
  OVEREXTENDED: 7,
  DEAD_CAPITULATION: 1,
};

function getDelayToNextBoundary(intervalMs: number): number {
  const nowMs = Date.now();
  const remainder = nowMs % intervalMs;
  return remainder === 0 ? intervalMs : intervalMs - remainder;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hoursBetween(fromIso: string, toDate: Date): number {
  const fromMs = Date.parse(fromIso);
  if (!Number.isFinite(fromMs)) {
    return 0;
  }
  return Math.max(0, (toDate.getTime() - fromMs) / (1000 * 60 * 60));
}

function resolveSignalAgePenalty(signalAgeHours: number): {
  confluencePenalty: number;
  prePumpPenalty: number;
  scoreMultiplier: number;
  tier: "NONE" | "LOW" | "MEDIUM" | "HIGH";
} {
  if (signalAgeHours <= 24) {
    return { confluencePenalty: 0, prePumpPenalty: 0, scoreMultiplier: 1, tier: "NONE" };
  }
  if (signalAgeHours <= 48) {
    return { confluencePenalty: 0.5, prePumpPenalty: 4, scoreMultiplier: 0.97, tier: "LOW" };
  }
  if (signalAgeHours <= 72) {
    return { confluencePenalty: 1, prePumpPenalty: 8, scoreMultiplier: 0.92, tier: "MEDIUM" };
  }
  return { confluencePenalty: 2, prePumpPenalty: 15, scoreMultiplier: 0.84, tier: "HIGH" };
}

async function resolveTargetUserId(): Promise<string> {
  const user = await prisma.user.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  if (!user?.id) {
    throw new Error("No user found. Cannot persist runner liquidity decisions without a user.");
  }

  return user.id;
}

async function getLatestDecisions(userId: string, symbols: string[]): Promise<Map<string, PreviousDecision>> {
  if (symbols.length === 0) {
    return new Map();
  }

  const rows = await prisma.alertEvent.findMany({
    where: {
      userId,
      symbol: { in: symbols },
      signalType: { startsWith: "RUNNER_LIQUIDITY_" },
    },
    orderBy: { createdAt: "desc" },
    take: symbols.length * 12,
    select: {
      symbol: true,
      recommendation: true,
      signalState: true,
      createdAt: true,
      metrics: true,
    },
  });

  const map = new Map<string, PreviousDecision>();
  for (const row of rows) {
    if (!map.has(row.symbol)) {
      map.set(row.symbol, {
        recommendation: row.recommendation,
        signalState: row.signalState,
        createdAt: row.createdAt,
        metrics: asRecord(row.metrics),
      });
    }
  }

  return map;
}

function resolveHighestStage(previousHighest: string | null, currentStage: string): string {
  const previousRank = previousHighest ? (STAGE_RANK[previousHighest] ?? 0) : 0;
  const currentRank = STAGE_RANK[currentStage] ?? 0;
  return currentRank >= previousRank ? currentStage : (previousHighest ?? currentStage);
}

function scoreLiquidityDecision(input: {
  symbol: string;
  stage: string;
  score: number;
  confluenceScore: number;
  recoveryScore: number;
  accumulationScore: number;
  prePumpScore: number;
  obsScoreFromScan: number;
  deltaScore24h: number;
  fundingRate: number;
  signalAgeHours: number;
  orderbook: Awaited<ReturnType<typeof fetchOrderBookExecutionRead>>;
  previousMetrics: Record<string, unknown>;
}): RunnerDecision {
  const ob = input.orderbook;
  const spreadPct = ob?.spreadPct ?? null;
  const markPrice = ob?.markPrice ?? null;
  const bidDepthUsd = ob?.bidDepthUsd ?? null;
  const askDepthUsd = ob?.askDepthUsd ?? null;
  const combinedDepthUsd = ob?.combinedDepthUsd ?? null;
  const imbalance = ob?.imbalance ?? null;

  const previousImbalance = readNumber(input.previousMetrics.imbalancePct);
  const previousBidDepth = readNumber(input.previousMetrics.bidDepthUsd);
  const previousAskDepth = readNumber(input.previousMetrics.askDepthUsd);

  const deltaImbalance = imbalance == null || previousImbalance == null
    ? 0
    : imbalance - previousImbalance / 100;
  const bidDepthGrowthPct = bidDepthUsd == null || previousBidDepth == null || previousBidDepth <= 0
    ? 0
    : (bidDepthUsd - previousBidDepth) / previousBidDepth;
  const askDepthDecayPct = askDepthUsd == null || previousAskDepth == null || previousAskDepth <= 0
    ? 0
    : (previousAskDepth - askDepthUsd) / previousAskDepth;

  const obsScore = ob?.obsScoreRolling ?? (ob
    ? computeOrderBookStrengthScore({
        currentImbalance: imbalance ?? 0,
        deltaImbalance,
        bidDepthGrowthPct,
        askDepthDecayPct,
        fundingRate: input.fundingRate,
      })
    : input.obsScoreFromScan);
  const absorptionScore = ob?.absorptionScore ?? 50;
  const distributionScore = ob?.distributionScore ?? null;
  const askWallScore = ob?.askWallScore ?? null;
  const bidWallScore = ob?.bidWallScore ?? null;
  const liquidityDivergence = ob?.liquidityDivergence ?? null;
  const supportDefenseScore = ob?.supportDefenseScore ?? null;
  const priceConfirmationScore = ob?.priceConfirmationScore ?? null;
  const finalLiquidityScore = ob?.finalLiquidityScore ?? null;
  const liquidityRegime = ob?.liquidityRegime ?? "NEUTRAL";

  const agePenalty = resolveSignalAgePenalty(input.signalAgeHours);
  const adjustedConfluenceScore = Math.max(0, input.confluenceScore - agePenalty.confluencePenalty);
  const adjustedPrePumpScore = Math.max(0, input.prePumpScore - agePenalty.prePumpPenalty);
  const adjustedScore = Number((input.score * agePenalty.scoreMultiplier).toFixed(1));

  const baseMetrics = {
    score: input.score,
    adjustedScore,
    stage: input.stage,
    confluenceScore: input.confluenceScore,
    adjustedConfluenceScore,
    recoveryScore: input.recoveryScore,
    accumulationScore: input.accumulationScore,
    prePumpScore: input.prePumpScore,
    adjustedPrePumpScore,
    obsScore,
    deltaScore24h: input.deltaScore24h,
    spreadPct,
    markPrice,
    bidDepthUsd,
    askDepthUsd,
    combinedDepthUsd,
    imbalancePct: imbalance == null ? null : imbalance * 100,
    deltaImbalancePct: Number.isFinite(deltaImbalance) ? deltaImbalance * 100 : null,
    bidDepthGrowthPct: Number.isFinite(bidDepthGrowthPct) ? bidDepthGrowthPct * 100 : null,
    askDepthDecayPct: Number.isFinite(askDepthDecayPct) ? askDepthDecayPct * 100 : null,
    fundingRate: input.fundingRate,
    absorptionScore,
    distributionScore,
    askWallScore,
    bidWallScore,
    liquidityDivergence,
    supportDefenseScore,
    priceConfirmationScore,
    finalLiquidityScore,
    actionRecommendation: "WAIT" as const,
    actionConfidencePct: 50,
    actionEvidencePositive: [],
    actionEvidenceWarnings: [],
    actionMissingConditions: [],
    actionPrimaryBlocker: "Confirmation is incomplete.",
    actionReason: "Conflicting liquidity signals",
    liquidityRegime,
    obCurrentPct: imbalance == null ? null : imbalance * 100,
    ob1mPct: ob?.imbalanceAvg1m == null ? null : ob.imbalanceAvg1m * 100,
    ob5mPct: ob?.imbalanceAvg5m == null ? null : ob.imbalanceAvg5m * 100,
    ob15mPct: ob?.imbalanceAvg15m == null ? null : ob.imbalanceAvg15m * 100,
    liquidityStabilityScore: ob?.liquidityStabilityScore ?? null,
    liquidityStabilityLabel: ob?.liquidityStabilityLabel ?? null,
    agePenaltyTier: agePenalty.tier,
  };

  if (!ob) {
    return {
      symbol: input.symbol,
      signalState: SignalState.UNRESOLVED,
      recommendation: "WAIT",
      action: "WAIT",
      signalType: "RUNNER_LIQUIDITY_WAIT",
      rationale: "Order book unavailable",
      metrics: baseMetrics,
    };
  }

  const transitionReady =
    (input.stage === "ACCUMULATION" || input.stage === "PRE_PUMP") &&
    adjustedConfluenceScore >= 8 &&
    obsScore >= ENTRY_OBS_MIN &&
    absorptionScore >= 55 &&
    (priceConfirmationScore ?? 50) >= 55 &&
    liquidityRegime !== "SELLER_DOMINATED";

  const liquiditySupportsEntry =
    spreadPct != null &&
    combinedDepthUsd != null &&
    imbalance != null &&
    spreadPct <= MAX_SPREAD_PCT &&
    combinedDepthUsd >= MIN_COMBINED_DEPTH_USD &&
    imbalance >= MIN_BUY_IMBALANCE;

  const liquidityBreakdown =
    liquidityRegime === "SELLER_DOMINATED" ||
    liquidityRegime === "DISTRIBUTION" ||
    (obsScore < 25 && absorptionScore < 40) ||
    (spreadPct != null && spreadPct >= WIDE_SPREAD_EXIT_PCT) ||
    (combinedDepthUsd != null && combinedDepthUsd < MIN_COMBINED_DEPTH_USD * 0.45) ||
    (imbalance != null && imbalance <= EXIT_IMBALANCE);

  const action: "BUY" | "WAIT" | "SELL" = liquidityBreakdown
    ? "SELL"
    : transitionReady && liquiditySupportsEntry
    ? "BUY"
    : "WAIT";

  const actionConfidencePct = ob?.actionConfidencePct ?? (
    action === "BUY" ? 78 : action === "SELL" ? 74 : liquidityRegime === "POTENTIAL_ABSORPTION" ? 68 : 60
  );
  const actionEvidencePositive = ob?.actionEvidencePositive ?? [];
  const actionEvidenceWarnings = ob?.actionEvidenceWarnings ?? [];
  const actionMissingConditions = ob?.actionMissingConditions ?? [];
  const actionPrimaryBlocker = ob?.actionPrimaryBlocker ?? "Confirmation is incomplete.";
  const actionReason = ob?.actionReason ?? (
    action === "BUY"
      ? "Accumulation/pre-pump with OBS, ABS and PCS confirmation"
      : action === "SELL"
      ? "Seller/distribution regime or liquidity collapse"
      : "Developing evidence; confirmation incomplete"
  );

  const metrics = {
    ...baseMetrics,
    actionRecommendation: action,
    actionConfidencePct,
    actionEvidencePositive,
    actionEvidenceWarnings,
    actionMissingConditions,
    actionPrimaryBlocker,
    actionReason,
  };

  if (action === "BUY") {
    return {
      symbol: input.symbol,
      signalState: SignalState.READY,
      recommendation: "ENTER_LONG",
      action,
      signalType: "RUNNER_LIQUIDITY_BUY",
      rationale: actionReason,
      metrics,
    };
  }

  if (action === "SELL") {
    return {
      symbol: input.symbol,
      signalState: SignalState.CAUTION,
      recommendation: "CLOSE",
      action,
      signalType: "RUNNER_LIQUIDITY_EXIT",
      rationale: actionReason,
      metrics,
    };
  }

  if (obsScore >= WAIT_OBS_MIN && obsScore < ENTRY_OBS_MIN) {
    return {
      symbol: input.symbol,
      signalState: SignalState.CAUTION,
      recommendation: "WAIT",
      action,
      signalType: "RUNNER_LIQUIDITY_WAIT",
      rationale: "OBS neutral zone",
      metrics,
    };
  }

  return {
    symbol: input.symbol,
    signalState: SignalState.CAUTION,
    recommendation: "WAIT",
    action,
    signalType: "RUNNER_LIQUIDITY_WAIT",
    rationale: actionReason,
    metrics,
  };
}

function pickReturnMetric(metrics: Record<string, unknown>): number {
  const r72 = readNumber(metrics.return72hPct);
  if (r72 != null) return r72;
  const r24 = readNumber(metrics.return24hPct);
  if (r24 != null) return r24;
  const r7d = readNumber(metrics.return7dPct);
  if (r7d != null) return r7d;
  return 0;
}

function classifySignalResult(ret24: number | null, ret72: number | null, ret7d: number | null): "WIN" | "LOSS" | "BREAKEVEN" {
  const anchor = ret72 ?? ret24 ?? ret7d ?? 0;
  if (anchor >= 4) return "WIN";
  if (anchor <= -3) return "LOSS";
  return "BREAKEVEN";
}

async function updateSignalOutcomes(userId: string): Promise<number> {
  const lookback = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const entries = await prisma.alertEvent.findMany({
    where: {
      userId,
      signalType: "RUNNER_LIQUIDITY_BUY",
      recommendation: "ENTER_LONG",
      createdAt: { gte: lookback },
    },
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  let updated = 0;
  for (const entry of entries) {
    const metrics = asRecord(entry.metrics);
    if (readString(metrics.signalResult) != null) {
      continue;
    }

    const entryPrice = readNumber(metrics.entryPrice) ?? readNumber(metrics.markPrice);
    if (entryPrice == null || entryPrice <= 0) {
      continue;
    }

    const ageHours = (Date.now() - entry.createdAt.getTime()) / (1000 * 60 * 60);
    if (ageHours < 24) {
      continue;
    }

    const candles = await fetchRecentCandles(entry.symbol, "1h", 220).catch(() => []);
    if (!candles || candles.length < 6) {
      continue;
    }

    const afterEntry = candles
      .filter((c) => c.timestamp * 1000 >= entry.createdAt.getTime())
      .sort((a, b) => a.timestamp - b.timestamp);

    if (afterEntry.length === 0) {
      continue;
    }

    const atOrAfterHours = (hours: number): number | null => {
      const targetMs = entry.createdAt.getTime() + hours * 60 * 60 * 1000;
      const row = afterEntry.find((c) => c.timestamp * 1000 >= targetMs);
      if (!row) {
        return null;
      }
      return ((Number(row.close) - entryPrice) / entryPrice) * 100;
    };

    const return24hPct = atOrAfterHours(24);
    const return72hPct = atOrAfterHours(72);
    const return7dPct = atOrAfterHours(168);

    const highs = afterEntry.map((c) => Number(c.high));
    const lows = afterEntry.map((c) => Number(c.low));
    const mfePct = highs.length > 0 ? ((Math.max(...highs) - entryPrice) / entryPrice) * 100 : 0;
    const maePct = lows.length > 0 ? ((Math.min(...lows) - entryPrice) / entryPrice) * 100 : 0;

    const signalResult = classifySignalResult(return24hPct, return72hPct, return7dPct);

    const nextMetrics = {
      ...metrics,
      return24hPct,
      return72hPct,
      return7dPct,
      mfePct,
      maePct,
      signalResult,
      lastOutcomeUpdatedAt: new Date().toISOString(),
    };

    await prisma.alertEvent.update({
      where: { id: entry.id },
      data: { metrics: nextMetrics },
    });

    updated++;
  }

  return updated;
}

function bestRangeLabel(rows: Array<{ value: number; win: boolean }>, buckets: Array<{ label: string; min: number; max: number }>): string {
  const stats = buckets.map((bucket) => {
    const inBucket = rows.filter((r) => r.value >= bucket.min && r.value < bucket.max);
    const count = inBucket.length;
    const wins = inBucket.filter((r) => r.win).length;
    const winRate = count > 0 ? wins / count : 0;
    return { label: bucket.label, count, winRate };
  });

  const eligible = stats.filter((s) => s.count >= 3);
  if (eligible.length === 0) {
    return "insufficient-data";
  }

  eligible.sort((a, b) => {
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    return b.count - a.count;
  });
  return `${eligible[0].label} (${(eligible[0].winRate * 100).toFixed(0)}%)`;
}

async function buildPerformanceDashboard(userId: string): Promise<{ text: string; summaries: StageSummary[] }> {
  const rows = await prisma.alertEvent.findMany({
    where: {
      userId,
      signalType: "RUNNER_LIQUIDITY_BUY",
      recommendation: "ENTER_LONG",
      createdAt: { gte: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: "desc" },
    take: 600,
    select: { metrics: true },
  });

  const samples = rows
    .map((row) => asRecord(row.metrics))
    .filter((m) => readString(m.signalResult) != null);

  if (samples.length === 0) {
    return { text: "📊 SIGNAL PERFORMANCE\nNo matured ENTER_LONG outcomes yet.", summaries: [] };
  }

  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const sample of samples) {
    const stage = readString(sample.stageAtEntry) ?? readString(sample.stage) ?? "UNKNOWN";
    if (!grouped.has(stage)) {
      grouped.set(stage, []);
    }
    grouped.get(stage)?.push(sample);
  }

  const summaries: StageSummary[] = [];
  for (const [stage, items] of grouped.entries()) {
    const count = items.length;
    const wins = items.filter((m) => readString(m.signalResult) === "WIN").length;
    const losses = items.filter((m) => readString(m.signalResult) === "LOSS").length;
    const breakeven = items.filter((m) => readString(m.signalResult) === "BREAKEVEN").length;
    const avgReturnPct = items.reduce((sum, m) => sum + pickReturnMetric(m), 0) / Math.max(1, count);
    summaries.push({ stage, count, wins, losses, breakeven, avgReturnPct });
  }

  summaries.sort((a, b) => b.wins / Math.max(1, b.count) - a.wins / Math.max(1, a.count));

  const rsRows = samples.map((m) => ({ value: readNumber(m.recoveryScore) ?? 0, win: readString(m.signalResult) === "WIN" }));
  const asRows = samples.map((m) => ({ value: readNumber(m.accumulationScore) ?? 0, win: readString(m.signalResult) === "WIN" }));
  const fundingRows = samples.map((m) => ({ value: (readNumber(m.fundingRate) ?? 0) * 100, win: readString(m.signalResult) === "WIN" }));
  const obsRows = samples.map((m) => ({ value: readNumber(m.obsScore) ?? 0, win: readString(m.signalResult) === "WIN" }));
  const confluenceRows = samples.map((m) => ({ value: readNumber(m.confluenceScore) ?? 0, win: readString(m.signalResult) === "WIN" }));

  const bestRs = bestRangeLabel(rsRows, [
    { label: "40-49", min: 40, max: 50 },
    { label: "50-59", min: 50, max: 60 },
    { label: "60-69", min: 60, max: 70 },
    { label: "70+", min: 70, max: 101 },
  ]);
  const bestAs = bestRangeLabel(asRows, [
    { label: "30-39", min: 30, max: 40 },
    { label: "40-49", min: 40, max: 50 },
    { label: "50-59", min: 50, max: 60 },
    { label: "60+", min: 60, max: 101 },
  ]);
  const bestFunding = bestRangeLabel(fundingRows, [
    { label: "<= -0.03%", min: -100, max: -0.03 },
    { label: "-0.03% to -0.01%", min: -0.03, max: -0.01 },
    { label: "-0.01% to 0.01%", min: -0.01, max: 0.01 },
    { label: "> 0.01%", min: 0.01, max: 100 },
  ]);
  const bestObs = bestRangeLabel(obsRows, [
    { label: "40-59", min: 40, max: 60 },
    { label: "60-79", min: 60, max: 80 },
    { label: "80+", min: 80, max: 101 },
  ]);
  const bestConfluence = bestRangeLabel(confluenceRows, [
    { label: "6-7", min: 6, max: 8 },
    { label: "8-9", min: 8, max: 10 },
    { label: "10-11", min: 10, max: 12 },
  ]);

  const lines = ["📊 SIGNAL PERFORMANCE"];
  for (const item of summaries.slice(0, 3)) {
    const winRate = (item.wins / Math.max(1, item.count)) * 100;
    lines.push(`${item.stage}: Win ${winRate.toFixed(0)}% | Avg ${item.avgReturnPct.toFixed(1)}% | n=${item.count}`);
  }
  lines.push(`Best RS: ${bestRs}`);
  lines.push(`Best AS: ${bestAs}`);
  lines.push(`Best Funding: ${bestFunding}`);
  lines.push(`Best OBS: ${bestObs}`);
  lines.push(`Best Confluence: ${bestConfluence}`);

  return { text: lines.join("\n"), summaries };
}

function formatRunnerLiquidityTelegram(input: {
  scannedAt: Date;
  decisions: RunnerDecision[];
  changed: RunnerDecision[];
  nextRunAt: Date;
  outcomesUpdated: number;
  dashboardText: string;
}): string {
  const buy = input.decisions.filter((d) => d.action === "BUY");
  const exit = input.decisions.filter((d) => d.action === "SELL");
  const wait = input.decisions.filter((d) => d.action === "WAIT");

  const lines: string[] = [];
  lines.push("🧭 **Runner + Liquidity Decision (30m)**");
  lines.push(`Scanned at: ${input.scannedAt.toISOString()}`);
  lines.push(`BUY: ${buy.length} | SELL: ${exit.length} | WAIT: ${wait.length} | Changes: ${input.changed.length}`);
  lines.push(`Outcomes updated: ${input.outcomesUpdated}`);
  lines.push(`Next run: ${input.nextRunAt.toISOString()}`);

  if (buy.length > 0) {
    lines.push("");
    lines.push("✅ **BUY READY**");
    for (const row of buy.slice(0, 6)) {
      lines.push(
        `${row.symbol} | ${row.metrics.stage} | OBS ${row.metrics.obsScore} | ABS ${row.metrics.absorptionScore} | PCS ${row.metrics.priceConfirmationScore ?? "n/a"} | SDS ${row.metrics.supportDefenseScore ?? "n/a"} | AWS ${row.metrics.askWallScore ?? "n/a"} | BWS ${row.metrics.bidWallScore ?? "n/a"} | ${row.metrics.liquidityRegime} ${row.metrics.liquidityDivergence ?? "NONE"} | ${row.metrics.actionRecommendation} (${row.metrics.actionConfidencePct}%): ${row.metrics.actionReason}`
      );
      if (row.metrics.actionEvidencePositive.length > 0) {
        lines.push(`  + ${row.metrics.actionEvidencePositive.slice(0, 3).join(" | ")}`);
      }
      if (row.metrics.actionEvidenceWarnings.length > 0) {
        lines.push(`  ! ${row.metrics.actionEvidenceWarnings.slice(0, 3).join(" | ")}`);
      }
      if (row.metrics.actionMissingConditions.length > 0) {
        lines.push(`  Missing: ${row.metrics.actionMissingConditions.slice(0, 3).join(" | ")}`);
        lines.push(`  Primary blocker: ${row.metrics.actionPrimaryBlocker}`);
      }
    }
  }

  if (exit.length > 0) {
    lines.push("");
    lines.push("⚠️ **SELL / RISK OFF**");
    for (const row of exit.slice(0, 6)) {
      lines.push(
        `${row.symbol} | ${row.rationale} | OBS ${row.metrics.obsScore} | ABS ${row.metrics.absorptionScore} | PCS ${row.metrics.priceConfirmationScore ?? "n/a"} | SDS ${row.metrics.supportDefenseScore ?? "n/a"} | AWS ${row.metrics.askWallScore ?? "n/a"} | BWS ${row.metrics.bidWallScore ?? "n/a"} | ${row.metrics.liquidityRegime} ${row.metrics.liquidityDivergence ?? "NONE"} | ${row.metrics.actionRecommendation} (${row.metrics.actionConfidencePct}%) | Spread ${row.metrics.spreadPct?.toFixed(3) ?? "n/a"}% | Imb ${row.metrics.imbalancePct?.toFixed(1) ?? "n/a"}%`
      );
    }
  }

  if (wait.length > 0) {
    lines.push("");
    lines.push("⏳ **WAIT WATCHLIST**");
    for (const row of wait.slice(0, 6)) {
      lines.push(
        `${row.symbol} | ${row.metrics.stage} | OBS ${row.metrics.obsScore} | ABS ${row.metrics.absorptionScore} | PCS ${row.metrics.priceConfirmationScore ?? "n/a"} | SDS ${row.metrics.supportDefenseScore ?? "n/a"} | AWS ${row.metrics.askWallScore ?? "n/a"} | BWS ${row.metrics.bidWallScore ?? "n/a"} | ${row.metrics.liquidityRegime} ${row.metrics.liquidityDivergence ?? "NONE"} | ${row.metrics.actionRecommendation} (${row.metrics.actionConfidencePct}%): ${row.metrics.actionReason}`
      );
      if (row.metrics.actionEvidencePositive.length > 0) {
        lines.push(`  + ${row.metrics.actionEvidencePositive.slice(0, 3).join(" | ")}`);
      }
      if (row.metrics.actionEvidenceWarnings.length > 0) {
        lines.push(`  ! ${row.metrics.actionEvidenceWarnings.slice(0, 3).join(" | ")}`);
      }
    }
  }

  if (input.changed.length > 0) {
    lines.push("");
    lines.push("🔄 **STATE CHANGES**");
    for (const row of input.changed.slice(0, 10)) {
      lines.push(`${row.symbol} -> ${row.action} (${row.signalType})`);
    }
  }

  lines.push("");
  lines.push(input.dashboardText);

  const playbookRows = input.decisions
    .filter((row) => row.action !== "SELL")
    .sort((a, b) => {
      if (a.action !== b.action) {
        return a.action === "BUY" ? -1 : 1;
      }
      return b.metrics.adjustedScore - a.metrics.adjustedScore;
    })
    .slice(0, 5);

  if (playbookRows.length > 0) {
    lines.push("");
    lines.push("🎯 **LEVERAGE PLAYBOOK**");
    for (const row of playbookRows) {
      const plan = resolveExecutionPlan(row);
      lines.push(
        `${row.symbol} | ${row.metrics.stage} | ${plan.tier} | Size ${plan.sizeGuidance} | Lev ${plan.leverageCap}`
      );
      lines.push(
        `  Gate: OBS ${row.metrics.obsScore} | ABS ${row.metrics.absorptionScore} | PCS ${row.metrics.priceConfirmationScore ?? "n/a"} | SDS ${row.metrics.supportDefenseScore ?? "n/a"} | AWS ${row.metrics.askWallScore ?? "n/a"} | BWS ${row.metrics.bidWallScore ?? "n/a"} | Regime ${row.metrics.liquidityRegime} | Div ${row.metrics.liquidityDivergence ?? "NONE"} | OB1m ${row.metrics.ob1mPct?.toFixed(1) ?? "n/a"}% | OB5m ${row.metrics.ob5mPct?.toFixed(1) ?? "n/a"}% | Conf ${row.metrics.adjustedConfluenceScore.toFixed(1)}/11 | Age ${row.metrics.agePenaltyTier} | ${row.action} (${row.metrics.actionConfidencePct}%)`
      );
      lines.push(
        `  Risk: ${plan.invalidation} | Time-stop: ${plan.timeStop}`
      );
    }
  }

  return lines.join("\n");
}

function resolveExecutionPlan(row: RunnerDecision): ExecutionPlan {
  if (row.recommendation === "CLOSE") {
    return {
      tier: "NO_ENTRY",
      sizeGuidance: "0%",
      leverageCap: "0x",
      invalidation: "Risk-off active",
      timeStop: "n/a",
    };
  }

  if (row.metrics.stage === "RECOVERING_CAPITULATION") {
    return {
      tier: "PROBE",
      sizeGuidance: "20-35%",
      leverageCap: "<=4x",
      invalidation: "Close if OBS < 40 or structure low breaks",
      timeStop: "Exit if no follow-through in 6-12h",
    };
  }

  if (row.metrics.stage === "RECOVERY") {
    return {
      tier: "SCALE",
      sizeGuidance: "40-60%",
      leverageCap: "<=6x",
      invalidation: "Close if OBS < 35 or spread widens > threshold",
      timeStop: "Reduce if momentum stalls for 12-18h",
    };
  }

  if (row.metrics.stage === "ACCUMULATION" || row.metrics.stage === "PRE_PUMP") {
    return {
      tier: "FULL",
      sizeGuidance: "70-100%",
      leverageCap: "<=8x",
      invalidation: "Close if OBS < 30 or liquidity deteriorates",
      timeStop: "Trail/trim if no extension in 18-24h",
    };
  }

  return {
    tier: "PROBE",
    sizeGuidance: "20-30%",
    leverageCap: "<=3x",
    invalidation: "Close on OBS/liquidity breakdown",
    timeStop: "Re-evaluate next cycle",
  };
}

async function runRunnerLiquidityPass(): Promise<{ scannedAt: Date; total: number; changed: number }> {
  const scannedAt = new Date();
  const userId = await resolveTargetUserId();

  logger.info("[runner-liquidity-monitor] running transition scan...");
  const scan = await scanCapitulationBounces();

  const runners = scan.topNextRunCandidates.slice(0, MAX_RUNNERS);
  if (runners.length === 0) {
    const outcomesUpdated = await updateSignalOutcomes(userId);
    logger.info("[runner-liquidity-monitor] no high-conviction runners in this pass", { outcomesUpdated });
    return { scannedAt, total: 0, changed: 0 };
  }

  const latestBySymbol = await getLatestDecisions(userId, runners.map((r) => r.symbol));

  const decisions: RunnerDecision[] = [];
  const nowIso = new Date().toISOString();
  for (const runner of runners) {
    const previous = latestBySymbol.get(runner.symbol);
    const previousMetrics = previous?.metrics ?? {};
    const firstDetectedAt = readString(previousMetrics.firstDetectedAt) ?? previous?.createdAt.toISOString() ?? nowIso;
    const signalAgeHours = hoursBetween(firstDetectedAt, scannedAt);

    const orderbook = await fetchOrderBookExecutionRead(runner.symbol);
    const decision = scoreLiquidityDecision({
      symbol: runner.symbol,
      stage: runner.stage,
      score: runner.score,
      confluenceScore: runner.confluenceScore,
      recoveryScore: runner.recoveryScore,
      accumulationScore: runner.accumulationScore,
      prePumpScore: runner.prePumpScore,
      obsScoreFromScan: runner.obsScore,
      deltaScore24h: runner.deltaScore24h,
      fundingRate: runner.fundingRate,
      signalAgeHours,
      orderbook,
      previousMetrics,
    });
    decisions.push(decision);
  }

  const changed = decisions.filter((d) => {
    const prev = latestBySymbol.get(d.symbol);
    if (!prev) {
      return true;
    }
    return prev.recommendation !== d.recommendation || prev.signalState !== d.signalState;
  });

  for (const row of changed) {
    const previous = latestBySymbol.get(row.symbol);
    const previousMetrics = previous?.metrics ?? {};
    const firstDetectedAt = readString(previousMetrics.firstDetectedAt) ?? previous?.createdAt.toISOString() ?? nowIso;
    const signalAgeHours = hoursBetween(firstDetectedAt, scannedAt);
    const highestStageObserved = resolveHighestStage(readString(previousMetrics.highestStageObserved), row.metrics.stage);

    const lifecycle: LifecycleMetrics = {
      firstDetectedAt,
      lastObservedAt: scannedAt.toISOString(),
      signalAgeHours: Number(signalAgeHours.toFixed(2)),
      highestStageObserved,
    };

    const metrics = {
      ...row.metrics,
      ...lifecycle,
      stageAtEntry: row.metrics.stage,
      entryPrice: row.metrics.markPrice,
      entryTime: scannedAt.toISOString(),
      source: "runner-liquidity-monitor",
      signalResult: row.recommendation === "ENTER_LONG" ? null : undefined,
    };

    await prisma.alertEvent.create({
      data: {
        userId,
        symbol: row.symbol,
        assetType: AssetType.CRYPTO,
        tradingStyle: TradingStyle.SWING,
        interval: CandleInterval.H1,
        signalState: row.signalState,
        signalType: row.signalType,
        recommendation: row.recommendation,
        metrics,
        priceContext: undefined,
      },
    });
  }

  const outcomesUpdated = await updateSignalOutcomes(userId);
  const dashboard = await buildPerformanceDashboard(userId);

  const intervalMs = Number.parseInt(process.env.RUNNER_LIQUIDITY_POLL_INTERVAL_MS ?? "1800000", 10) || 1800000;
  const delayMs = getDelayToNextBoundary(intervalMs);
  const nextRunAt = new Date(Date.now() + delayMs);

  const telegram = formatRunnerLiquidityTelegram({
    scannedAt,
    decisions,
    changed,
    nextRunAt,
    outcomesUpdated,
    dashboardText: dashboard.text,
  });
  await sendTelegramMessage(telegram);

  logger.info("[runner-liquidity-monitor] pass complete", {
    runners: runners.length,
    changed: changed.length,
    buyReady: decisions.filter((d) => d.action === "BUY").length,
    sell: decisions.filter((d) => d.action === "SELL").length,
    outcomesUpdated,
    performanceStages: dashboard.summaries.length,
  });

  return { scannedAt, total: runners.length, changed: changed.length };
}

async function monitorRunnerLiquidity(): Promise<void> {
  logger.info("[runner-liquidity-monitor] starting");

  const intervalMs = Number.parseInt(process.env.RUNNER_LIQUIDITY_POLL_INTERVAL_MS ?? "1800000", 10) || 1800000;

  while (true) {
    try {
      await runRunnerLiquidityPass();
      const delayMs = getDelayToNextBoundary(intervalMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } catch (error) {
      logger.error("[runner-liquidity-monitor] error in monitoring loop", { error });
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  monitorRunnerLiquidity().catch((error) => {
    logger.error("[runner-liquidity-monitor] fatal error", { error });
    process.exit(1);
  });
}
