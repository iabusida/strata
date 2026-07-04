import "./env.js";

import { AssetType, CandleInterval, SignalState, TradingStyle } from "@prisma/client";

import { fetchOrderBookExecutionRead } from "./bitunix-service.js";
import { scanCapitulationBounces } from "./capitulation-bounce-scan.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma-client.js";
import { sendTelegramMessage } from "./telegram-service.js";

type RunnerDecision = {
  symbol: string;
  signalState: SignalState;
  recommendation: "ENTER_LONG" | "WAIT" | "CLOSE";
  signalType: "RUNNER_LIQUIDITY_BUY" | "RUNNER_LIQUIDITY_WAIT" | "RUNNER_LIQUIDITY_EXIT";
  rationale: string;
  metrics: {
    score: number;
    stage: string;
    confluenceScore: number;
    recoveryScore: number;
    accumulationScore: number;
    prePumpScore: number;
    deltaScore24h: number;
    spreadPct: number | null;
    bidDepthUsd: number | null;
    askDepthUsd: number | null;
    combinedDepthUsd: number | null;
    imbalancePct: number | null;
  };
};

const MAX_RUNNERS = Math.max(3, Number.parseInt(process.env.RUNNER_LIQUIDITY_MAX_RUNNERS ?? "10", 10) || 10);
const MIN_COMBINED_DEPTH_USD = Math.max(1000, Number.parseFloat(process.env.RUNNER_LIQUIDITY_MIN_DEPTH_USD ?? "10000") || 10000);
const MAX_SPREAD_PCT = Math.max(0.01, Number.parseFloat(process.env.RUNNER_LIQUIDITY_MAX_SPREAD_PCT ?? "0.12") || 0.12);
const MIN_BUY_IMBALANCE = Math.max(-1, Math.min(1, Number.parseFloat(process.env.RUNNER_LIQUIDITY_MIN_BUY_IMBALANCE ?? "0.08") || 0.08));
const EXIT_IMBALANCE = Math.max(-1, Math.min(1, Number.parseFloat(process.env.RUNNER_LIQUIDITY_EXIT_IMBALANCE ?? "-0.20") || -0.20));
const WIDE_SPREAD_EXIT_PCT = Math.max(MAX_SPREAD_PCT, Number.parseFloat(process.env.RUNNER_LIQUIDITY_WIDE_SPREAD_EXIT_PCT ?? "0.30") || 0.30);

function getDelayToNextBoundary(intervalMs: number): number {
  const nowMs = Date.now();
  const remainder = nowMs % intervalMs;
  return remainder === 0 ? intervalMs : intervalMs - remainder;
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

async function getLatestDecisions(userId: string, symbols: string[]): Promise<Map<string, { recommendation: string | null; signalState: SignalState }>> {
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
    take: symbols.length * 10,
    select: {
      symbol: true,
      recommendation: true,
      signalState: true,
      signalType: true,
      createdAt: true,
    },
  });

  const map = new Map<string, { recommendation: string | null; signalState: SignalState }>();
  for (const row of rows) {
    if (!map.has(row.symbol)) {
      map.set(row.symbol, { recommendation: row.recommendation, signalState: row.signalState });
    }
  }

  return map;
}

function scoreLiquidityDecision(input: {
  symbol: string;
  stage: string;
  score: number;
  confluenceScore: number;
  recoveryScore: number;
  accumulationScore: number;
  prePumpScore: number;
  deltaScore24h: number;
  orderbook: Awaited<ReturnType<typeof fetchOrderBookExecutionRead>>;
}): RunnerDecision {
  const ob = input.orderbook;
  const spreadPct = ob?.spreadPct ?? null;
  const combinedDepthUsd = ob?.combinedDepthUsd ?? null;
  const imbalance = ob?.imbalance ?? null;

  const baseMetrics = {
    score: input.score,
    stage: input.stage,
    confluenceScore: input.confluenceScore,
    recoveryScore: input.recoveryScore,
    accumulationScore: input.accumulationScore,
    prePumpScore: input.prePumpScore,
    deltaScore24h: input.deltaScore24h,
    spreadPct,
    bidDepthUsd: ob?.bidDepthUsd ?? null,
    askDepthUsd: ob?.askDepthUsd ?? null,
    combinedDepthUsd,
    imbalancePct: imbalance == null ? null : imbalance * 100,
  };

  if (!ob) {
    return {
      symbol: input.symbol,
      signalState: SignalState.UNRESOLVED,
      recommendation: "WAIT",
      signalType: "RUNNER_LIQUIDITY_WAIT",
      rationale: "Order book unavailable",
      metrics: baseMetrics,
    };
  }

  const transitionReady =
    (input.stage === "PRE_PUMP" || input.stage === "ACCUMULATION" || input.stage === "RECOVERY") &&
    input.confluenceScore >= 7 &&
    input.recoveryScore >= 50 &&
    input.accumulationScore >= 50;

  const liquiditySupportsEntry =
    spreadPct != null &&
    combinedDepthUsd != null &&
    imbalance != null &&
    spreadPct <= MAX_SPREAD_PCT &&
    combinedDepthUsd >= MIN_COMBINED_DEPTH_USD &&
    imbalance >= MIN_BUY_IMBALANCE;

  const liquidityBreakdown =
    (spreadPct != null && spreadPct >= WIDE_SPREAD_EXIT_PCT) ||
    (combinedDepthUsd != null && combinedDepthUsd < MIN_COMBINED_DEPTH_USD * 0.45) ||
    (imbalance != null && imbalance <= EXIT_IMBALANCE);

  if (transitionReady && liquiditySupportsEntry) {
    return {
      symbol: input.symbol,
      signalState: SignalState.READY,
      recommendation: "ENTER_LONG",
      signalType: "RUNNER_LIQUIDITY_BUY",
      rationale: "Runner transition confirmed with supportive liquidity",
      metrics: baseMetrics,
    };
  }

  if (liquidityBreakdown) {
    return {
      symbol: input.symbol,
      signalState: SignalState.CAUTION,
      recommendation: "CLOSE",
      signalType: "RUNNER_LIQUIDITY_EXIT",
      rationale: "Liquidity deterioration detected",
      metrics: baseMetrics,
    };
  }

  return {
    symbol: input.symbol,
    signalState: SignalState.CAUTION,
    recommendation: "WAIT",
    signalType: "RUNNER_LIQUIDITY_WAIT",
    rationale: "Transition or liquidity is not yet strong enough",
    metrics: baseMetrics,
  };
}

function formatRunnerLiquidityTelegram(input: {
  scannedAt: Date;
  decisions: RunnerDecision[];
  changed: RunnerDecision[];
  nextRunAt: Date;
}): string {
  const buy = input.decisions.filter((d) => d.recommendation === "ENTER_LONG");
  const exit = input.decisions.filter((d) => d.recommendation === "CLOSE");
  const wait = input.decisions.filter((d) => d.recommendation === "WAIT");

  const lines: string[] = [];
  lines.push("🧭 **Runner + Liquidity Decision (30m)**");
  lines.push(`Scanned at: ${input.scannedAt.toISOString()}`);
  lines.push(`Buy: ${buy.length} | Exit: ${exit.length} | Wait: ${wait.length} | Changes: ${input.changed.length}`);
  lines.push(`Next run: ${input.nextRunAt.toISOString()}`);

  if (buy.length > 0) {
    lines.push("");
    lines.push("✅ **BUY READY**");
    for (const row of buy.slice(0, 6)) {
      lines.push(
        `${row.symbol} | ${row.metrics.stage} | Conf ${row.metrics.confluenceScore}/10 | Spread ${row.metrics.spreadPct?.toFixed(3) ?? "n/a"}% | Depth $${Math.round(row.metrics.combinedDepthUsd ?? 0)}`
      );
    }
  }

  if (exit.length > 0) {
    lines.push("");
    lines.push("⚠️ **EXIT / RISK OFF**");
    for (const row of exit.slice(0, 6)) {
      lines.push(
        `${row.symbol} | ${row.rationale} | Spread ${row.metrics.spreadPct?.toFixed(3) ?? "n/a"}% | Imb ${row.metrics.imbalancePct?.toFixed(1) ?? "n/a"}%`
      );
    }
  }

  if (input.changed.length > 0) {
    lines.push("");
    lines.push("🔄 **STATE CHANGES**");
    for (const row of input.changed.slice(0, 10)) {
      lines.push(`${row.symbol} -> ${row.recommendation} (${row.signalType})`);
    }
  }

  return lines.join("\n");
}

async function runRunnerLiquidityPass(): Promise<{ scannedAt: Date; total: number; changed: number }> {
  const scannedAt = new Date();
  const userId = await resolveTargetUserId();

  logger.info("[runner-liquidity-monitor] running transition scan...");
  const scan = await scanCapitulationBounces();

  const runners = scan.topNextRunCandidates.slice(0, MAX_RUNNERS);
  if (runners.length === 0) {
    logger.info("[runner-liquidity-monitor] no high-conviction runners in this pass");
    return { scannedAt, total: 0, changed: 0 };
  }

  const latestBySymbol = await getLatestDecisions(userId, runners.map((r) => r.symbol));

  const decisions: RunnerDecision[] = [];
  for (const runner of runners) {
    const orderbook = await fetchOrderBookExecutionRead(runner.symbol);
    const decision = scoreLiquidityDecision({
      symbol: runner.symbol,
      stage: runner.stage,
      score: runner.score,
      confluenceScore: runner.confluenceScore,
      recoveryScore: runner.recoveryScore,
      accumulationScore: runner.accumulationScore,
      prePumpScore: runner.prePumpScore,
      deltaScore24h: runner.deltaScore24h,
      orderbook,
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
        metrics: {
          ...row.metrics,
          rationale: row.rationale,
          source: "runner-liquidity-monitor",
        },
        priceContext: undefined,
      },
    });
  }

  const intervalMs = Number.parseInt(process.env.RUNNER_LIQUIDITY_POLL_INTERVAL_MS ?? "1800000", 10) || 1800000;
  const delayMs = getDelayToNextBoundary(intervalMs);
  const nextRunAt = new Date(Date.now() + delayMs);

  const telegram = formatRunnerLiquidityTelegram({
    scannedAt,
    decisions,
    changed,
    nextRunAt,
  });
  await sendTelegramMessage(telegram);

  logger.info("[runner-liquidity-monitor] pass complete", {
    runners: runners.length,
    changed: changed.length,
    buyReady: decisions.filter((d) => d.recommendation === "ENTER_LONG").length,
    exit: decisions.filter((d) => d.recommendation === "CLOSE").length,
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
