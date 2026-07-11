#!/usr/bin/env node
/**
 * CLI: Run capitulation bounce scan and send to Telegram
 * 
 * Usage:
 *   npm run scan:capitulation
 *   npm run scan:capitulation -- --rotation
 *   npm run scan:capitulation -- --send-telegram
 *   npm run scan:capitulation -- --symbols TAC
 *   npm run scan:capitulation -- --symbols TAC,OPG,MOCA
 */

import "./env.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { scanCapitulationBounces, formatCapitulationForTelegram } from "./capitulation-bounce-scan.js";
import { fetchRecentCandles } from "./bitunix-service.js";
import { fetchBurstUniverseCandidates } from "./scanner-burst-universe.js";
import { scanFastPumpCandidates } from "./fast-pump-scan.js";
import { calculateLatestRsi, calculateStochasticRsi } from "./rsi.js";
import { sendTelegramMessage } from "./telegram-service.js";

type CapitulationCandidate = Awaited<ReturnType<typeof scanCapitulationBounces>>["nearBounceZone"][number];
type CapitulationScanResult = Awaited<ReturnType<typeof scanCapitulationBounces>>;

function resolveIncludedSymbolsArg(argv: string[]): string[] {
  const parsed = new Set<string>();

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg.startsWith("--symbols=")) {
      const raw = arg.slice("--symbols=".length);
      for (const token of raw.split(",")) {
        const normalized = token.trim().toUpperCase();
        if (normalized !== "") {
          parsed.add(normalized);
        }
      }
      continue;
    }

    if (arg.startsWith("--symbol=")) {
      const raw = arg.slice("--symbol=".length);
      const normalized = raw.trim().toUpperCase();
      if (normalized !== "") {
        parsed.add(normalized);
      }
      continue;
    }

    if ((arg === "--symbols" || arg === "--symbol") && idx + 1 < argv.length) {
      const raw = argv[idx + 1];
      for (const token of raw.split(",")) {
        const normalized = token.trim().toUpperCase();
        if (normalized !== "") {
          parsed.add(normalized);
        }
      }
      idx += 1;
    }
  }

  return Array.from(parsed);
}

function resolveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

const SNAPBACK_MIN_DRAWDOWN_PCT = resolveNumberEnv("SNAPBACK_MIN_DRAWDOWN_PCT", 97);
const SNAPBACK_MAX_DISTANCE_PCT = resolveNumberEnv("SNAPBACK_MAX_DISTANCE_PCT", 4);
const SNAPBACK_MAX_FUNDING_RATE = resolveNumberEnv("SNAPBACK_MAX_FUNDING_RATE", -0.00001);
const SNAPBACK_MIN_SPIKE_X = resolveNumberEnv("SNAPBACK_MIN_SPIKE_X", 1.2);
const SNAPBACK_MIN_DELTA_VOL_PCT = resolveNumberEnv("SNAPBACK_MIN_DELTA_VOL_PCT", 20) / 100;
const SNAPBACK_MIN_ASK_DEPTH_USD = resolveNumberEnv("SNAPBACK_MIN_ASK_DEPTH_USD", 1000);

const BURST_READY_MIN_SPIKE_X = resolveNumberEnv("BURST_READY_MIN_SPIKE_X", 1.2);
const BURST_READY_MIN_DELTA_VOL_PCT = resolveNumberEnv("BURST_READY_MIN_DELTA_VOL_PCT", 20) / 100;
const BURST_READY_MIN_DELTA_SCORE = resolveNumberEnv("BURST_READY_MIN_DELTA_SCORE", 5);
const BURST_READY_MIN_ASK_DEPTH_USD = resolveNumberEnv("BURST_READY_MIN_ASK_DEPTH_USD", 3000);
const BURST_READY_MIN_READINESS = resolveNumberEnv("BURST_READY_MIN_READINESS", 65);
const BURST_READY_REQUIRE_ACTION_BUY = resolveBooleanEnv("BURST_READY_REQUIRE_ACTION_BUY", true);

const RANKING_STATE_PATH = path.resolve(process.cwd(), "data/capitulation-ranking-state.json");
const SCAN_SNAPSHOT_PATH = path.resolve(process.cwd(), "data/capitulation-last-scan.json");
const RECENT_DROPPED_TRACK_LIMIT = 30;
const LEADERBOARD_TRACK_LIMIT = 20;

type ConfidenceTrend = "RISING" | "STABLE" | "FALLING";

interface PersistedTokenState {
  symbol: string;
  rank: number;
  priority: number;
  burstProbabilityScore: number;
  readiness: number;
  abs: number;
  rs: number;
  as: number;
  pp: number;
  obs: number;
  distance: number;
  lifecycleAction: string;
  marketCycle: string;
  stage: string;
  deltaScore24h: number;
  deltaVolumePct: number;
  fundingRate: number;
  askWallScore: number;
  bidWallScore: number;
  orderbookImbalance1m: number;
  orderbookImbalance5m: number;
  top5Streak: number;
  top10Streak: number;
  cycleStreak: number;
  noInvalidationStreak: number;
  readinessHistory: number[];
  updatedAt: string;
}

interface RankingStateFile {
  scans: number;
  updatedAt: string;
  leaderboard: string[];
  tokens: Record<string, PersistedTokenState>;
}

interface CandidateWithStability {
  candidate: CapitulationCandidate;
  rank: number;
  priority: number;
  rawPriority: number;
  readiness: number;
  persistenceBonus: number;
  confidenceTrend: ConfidenceTrend;
  invalidated: boolean;
  invalidationReasons: string[];
  prev?: PersistedTokenState;
}

interface PersistedScanToken {
  symbol: string;
  rank: number;
  priority: number;
  readiness: number;
  burstProbabilityScore: number;
  recoveryScore: number;
  accumulationScore: number;
  prePumpScore: number;
  obsScore: number;
  absorptionScore: number;
  distanceFromZeroFib: number;
  lifecycleAction: string;
  marketCycle: string;
  stage: string;
  deltaScore24h: number;
  deltaVolumePct: number;
  fundingRate: number;
}

interface ScanSnapshotFile {
  scannedAt: string;
  totalScanned: number;
  zones: {
    bounce: number;
    near: number;
    ultra: number;
  };
  leaderboard: PersistedScanToken[];
}

function emptyRankingState(): RankingStateFile {
  return {
    scans: 0,
    updatedAt: new Date(0).toISOString(),
    leaderboard: [],
    tokens: {},
  };
}

async function loadRankingState(): Promise<RankingStateFile> {
  try {
    const raw = await fs.readFile(RANKING_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as RankingStateFile;
    if (!parsed || typeof parsed !== "object") return emptyRankingState();
    if (!parsed.tokens || typeof parsed.tokens !== "object") return emptyRankingState();
    return {
      scans: Number.isFinite(parsed.scans) ? parsed.scans : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      leaderboard: Array.isArray(parsed.leaderboard) ? parsed.leaderboard : [],
      tokens: parsed.tokens,
    };
  } catch {
    return emptyRankingState();
  }
}

async function saveRankingState(state: RankingStateFile): Promise<void> {
  await fs.mkdir(path.dirname(RANKING_STATE_PATH), { recursive: true });
  await fs.writeFile(RANKING_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

async function loadScanSnapshot(): Promise<ScanSnapshotFile | null> {
  try {
    const raw = await fs.readFile(SCAN_SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw) as ScanSnapshotFile;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.leaderboard)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function saveScanSnapshot(snapshot: ScanSnapshotFile): Promise<void> {
  await fs.mkdir(path.dirname(SCAN_SNAPSHOT_PATH), { recursive: true });
  await fs.writeFile(SCAN_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf8");
}

function buildScanSnapshot(result: CapitulationScanResult, ranked: CandidateWithStability[]): ScanSnapshotFile {
  return {
    scannedAt: new Date().toISOString(),
    totalScanned: result.totalScanned,
    zones: {
      bounce: result.bounceZoneCandidates.length,
      near: result.nearBounceZone.length,
      ultra: result.ultraCapitulationCandidates.length,
    },
    leaderboard: ranked.slice(0, LEADERBOARD_TRACK_LIMIT).map((row) => ({
      symbol: row.candidate.symbol,
      rank: row.rank,
      priority: row.priority,
      readiness: row.readiness,
      burstProbabilityScore: row.candidate.burstProbabilityScore,
      recoveryScore: row.candidate.recoveryScore,
      accumulationScore: row.candidate.accumulationScore,
      prePumpScore: row.candidate.prePumpScore,
      obsScore: row.candidate.obsScore,
      absorptionScore: row.candidate.absorptionScore,
      distanceFromZeroFib: row.candidate.distanceFromZeroFib,
      lifecycleAction: row.candidate.lifecycleAction,
      marketCycle: row.candidate.marketCycle,
      stage: row.candidate.stage,
      deltaScore24h: row.candidate.deltaScore24h,
      deltaVolumePct: row.candidate.deltaVolumePct,
      fundingRate: row.candidate.fundingRate,
    })),
  };
}

function computeConfidenceTrend(history: number[]): ConfidenceTrend {
  if (history.length < 3) return "STABLE";
  const tail = history.slice(-4);
  const first = tail[0] ?? 0;
  const last = tail[tail.length - 1] ?? 0;
  const slope = last - first;
  if (slope >= 6) return "RISING";
  if (slope <= -6) return "FALLING";
  return "STABLE";
}

function resolveInvalidation(prev: PersistedTokenState, curr: CapitulationCandidate): { invalidated: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (curr.distanceFromZeroFib > 16 && prev.distance <= 15) {
    reasons.push("Price left capitulation/near-ATL zone");
  }
  if (prev.fundingRate < -0.00003 && curr.fundingRate > 0.00012) {
    reasons.push("Funding flipped against setup");
  }
  if (prev.abs - curr.absorptionScore >= 10 && curr.absorptionScore < 30) {
    reasons.push("Absorption materially weakened");
  }
  if (curr.askWallScore - prev.askWallScore >= 15) {
    reasons.push("Ask pressure increased materially");
  }
  if ((prev.orderbookImbalance1m - curr.orderbookImbalance1m) >= 0.08 && (prev.orderbookImbalance5m - curr.orderbookImbalance5m) >= 0.06) {
    reasons.push("Bid support deteriorated materially");
  }
  if (curr.marketCycle === "EXHAUSTION" || curr.marketCycle === "EXTENDED") {
    reasons.push("Regime shifted away from early setup");
  }

  return { invalidated: reasons.length > 0, reasons };
}

function computePersistenceBonus(prev: PersistedTokenState | undefined, cycle: string, trend: ConfidenceTrend): number {
  if (!prev) return 0;

  let bonus = 0;
  if (prev.top5Streak >= 3) bonus += 8;
  if (prev.top10Streak >= 6) bonus += 6;
  if ((cycle === "EARLY_BURST" || cycle === "ACCUMULATION") && prev.cycleStreak >= 3) bonus += 6;
  if (prev.noInvalidationStreak >= 4) bonus += 4;
  if (trend === "RISING") bonus += 3;
  return Math.min(24, bonus);
}

function clampPriorityDrop(prevPriority: number, rawPriority: number, invalidated: boolean): number {
  const maxDropPerScan = invalidated ? 48 : 18;
  const floor = prevPriority - maxDropPerScan;
  return rawPriority < floor ? floor : rawPriority;
}

function formatDelta(current: number, prev: number | undefined, digits: number = 1): string {
  if (prev == null || !Number.isFinite(prev)) return "n/a";
  const delta = current - prev;
  const prefix = delta > 0 ? "+" : "";
  return `${prefix}${delta.toFixed(digits)}`;
}

function alignmentReadinessAdjustment(suite: MultiTimeframeSuite | undefined): number {
  if (!suite) return 0;
  switch (suite.longAlignment) {
    case "FULL_BULL":
      return 10;
    case "HTF_BULL_LTF_WEAK":
      return -4;
    case "LTF_BULL_HTF_WEAK":
      return -14;
    case "FULL_BEAR":
      return -20;
    default:
      return -8;
  }
}

function alignmentPriorityAdjustment(suite: MultiTimeframeSuite | undefined): number {
  if (!suite) return 0;
  switch (suite.longAlignment) {
    case "FULL_BULL":
      return 18;
    case "HTF_BULL_LTF_WEAK":
      return 4;
    case "LTF_BULL_HTF_WEAK":
      return -18;
    case "FULL_BEAR":
      return -28;
    default:
      return -10;
  }
}

function computeReadinessScore(candidate: CapitulationCandidate, suite?: MultiTimeframeSuite): number {
  let score = 0;

  if (candidate.actionRecommendation === "BUY") score += 25;
  else if (candidate.actionRecommendation === "WAIT") score += 10;

  score += Math.max(0, Math.min(100, candidate.actionConfidencePct)) * 0.2;
  score += Math.max(0, Math.min(100, candidate.obsScore)) * 0.25;
  score += Math.max(0, Math.min(100, candidate.absorptionScore)) * 0.2;
  score += Math.max(0, Math.min(100, candidate.finalLiquidityScore)) * 0.15;

  const ob1m = candidate.orderbookImbalance1m * 100;
  const ob5m = candidate.orderbookImbalance5m * 100;
  if (ob1m > 5 && ob5m > 3) score += 10;
  else if (ob1m > 0 && ob5m > 0) score += 6;
  else if (ob1m < -5 && ob5m < -3) score -= 8;

  if (candidate.deltaScore24h > 0) score += Math.min(8, candidate.deltaScore24h * 0.8);

  if (candidate.lifecycleAction === "EARLY_ENTRY") score += 8;
  else if (candidate.lifecycleAction === "BUY") score += 5;
  else if (candidate.lifecycleAction === "AVOID_CHASE" || candidate.lifecycleAction === "SELL") score -= 8;

  score += Math.max(0, Math.min(100, candidate.burstProbabilityScore)) * 0.12;
  score += Math.max(0, Math.min(100, candidate.deltaVolumePct * 120)) * 0.05;
  score += alignmentReadinessAdjustment(suite);

  return Math.max(0, Math.min(100, Number(score.toFixed(1))));
}

function computeNearZoneBuyPriority(candidate: CapitulationCandidate, suite?: MultiTimeframeSuite): number {
  const readiness = computeReadinessScore(candidate, suite);
  const cycleBase =
    candidate.marketCycle === "EARLY_BURST" ? 94
    : candidate.marketCycle === "ACCUMULATION" ? 86
    : candidate.marketCycle === "CAPITULATION" ? 64
    : candidate.marketCycle === "BURSTING" ? 58
    : candidate.marketCycle === "EXTENDED" ? 34
    : 20;
  const actionTilt =
    candidate.lifecycleAction === "EARLY_ENTRY" ? 16
    : candidate.lifecycleAction === "BUY" ? 10
    : candidate.lifecycleAction === "HOLD" ? 4
    : candidate.lifecycleAction === "AVOID_CHASE" ? -12
    : candidate.lifecycleAction === "SELL" ? -18
    : 0;

  const distanceFit = Math.max(0, 100 - Math.abs(candidate.distanceFromZeroFib - 10) * 10);
  const rsiFit = Math.max(0, 100 - Math.abs(candidate.rsi14 - 40) * 3);
  const signalFreshness = Math.max(0, 100 - candidate.signalAgeHours * 2);

  const score =
    cycleBase * 0.16 +
    actionTilt +
    alignmentPriorityAdjustment(suite) +
    candidate.burstProbabilityScore * 0.34 +
    candidate.prePumpScore * 0.12 +
    candidate.accumulationScore * 0.12 +
    candidate.recoveryScore * 0.08 +
    readiness * 0.18 +
    Math.max(-12, Math.min(12, candidate.deltaScore24h)) * 0.25 +
    distanceFit * 0.06 +
    rsiFit * 0.02 +
    signalFreshness * 0.02;

  return Number(score.toFixed(1));
}

function buildStableRankings(
  result: Awaited<ReturnType<typeof scanCapitulationBounces>>,
  previous: RankingStateFile,
  suites: Map<string, MultiTimeframeSuite>,
): {
  ranked: CandidateWithStability[];
  state: RankingStateFile;
  recentlyDropped: CandidateWithStability[];
} {
  const merged = new Map<string, CapitulationCandidate>();
  for (const c of [...result.ultraCapitulationCandidates, ...result.bounceZoneCandidates, ...result.nearBounceZone]) {
    if (c.stage !== "IGNORE") merged.set(c.symbol, c);
  }

  const now = new Date().toISOString();
  const rows: CandidateWithStability[] = [];
  for (const candidate of merged.values()) {
    const prev = previous.tokens[candidate.symbol];
    const suite = suites.get(candidate.symbol);
    const readiness = computeReadinessScore(candidate, suite);
    const rawPriority = computeNearZoneBuyPriority(candidate, suite);
    const priorHistory = prev?.readinessHistory ?? [];
    const trend = computeConfidenceTrend([...priorHistory, readiness]);
    const invalidation = prev ? resolveInvalidation(prev, candidate) : { invalidated: false, reasons: [] };
    const persistenceBonus = computePersistenceBonus(prev, candidate.marketCycle, trend);
    const dampenedPriority = prev
      ? clampPriorityDrop(prev.priority, rawPriority, invalidation.invalidated)
      : rawPriority;
    const smoothed = prev
      ? (invalidation.invalidated ? dampenedPriority * 0.72 + prev.priority * 0.28 : dampenedPriority * 0.8 + prev.priority * 0.2)
      : dampenedPriority;
    const priority = Number((smoothed + persistenceBonus).toFixed(1));

    rows.push({
      candidate,
      rank: 0,
      priority,
      rawPriority,
      readiness,
      persistenceBonus,
      confidenceTrend: trend,
      invalidated: invalidation.invalidated,
      invalidationReasons: invalidation.reasons,
      prev,
    });
  }

  rows.sort((a, b) => b.priority - a.priority);
  rows.forEach((row, idx) => { row.rank = idx + 1; });

  const droppedSymbols = previous.leaderboard
    .slice(0, LEADERBOARD_TRACK_LIMIT)
    .filter((symbol) => {
      const current = rows.find((r) => r.candidate.symbol === symbol);
      return !current || current.rank > LEADERBOARD_TRACK_LIMIT;
    });

  const recentlyDropped: CandidateWithStability[] = droppedSymbols
    .map((symbol) => rows.find((r) => r.candidate.symbol === symbol))
    .filter((r): r is CandidateWithStability => Boolean(r))
    .slice(0, RECENT_DROPPED_TRACK_LIMIT);

  const nextTokens: Record<string, PersistedTokenState> = { ...previous.tokens };
  for (const row of rows) {
    const prev = row.prev;
    const currentRank = row.rank;
    const top5Streak = currentRank <= 5 ? (prev?.top5Streak ?? 0) + 1 : 0;
    const top10Streak = currentRank <= 10 ? (prev?.top10Streak ?? 0) + 1 : 0;
    const cycleStreak = prev && prev.marketCycle === row.candidate.marketCycle ? prev.cycleStreak + 1 : 1;
    const noInvalidationStreak = row.invalidated ? 0 : (prev?.noInvalidationStreak ?? 0) + 1;
    const readinessHistory = [...(prev?.readinessHistory ?? []), row.readiness].slice(-8);

    nextTokens[row.candidate.symbol] = {
      symbol: row.candidate.symbol,
      rank: currentRank,
      priority: row.priority,
      burstProbabilityScore: row.candidate.burstProbabilityScore,
      readiness: row.readiness,
      abs: row.candidate.absorptionScore,
      rs: row.candidate.recoveryScore,
      as: row.candidate.accumulationScore,
      pp: row.candidate.prePumpScore,
      obs: row.candidate.obsScore,
      distance: row.candidate.distanceFromZeroFib,
      lifecycleAction: row.candidate.lifecycleAction,
      marketCycle: row.candidate.marketCycle,
      stage: row.candidate.stage,
      deltaScore24h: row.candidate.deltaScore24h,
      deltaVolumePct: row.candidate.deltaVolumePct,
      fundingRate: row.candidate.fundingRate,
      askWallScore: row.candidate.askWallScore,
      bidWallScore: row.candidate.bidWallScore,
      orderbookImbalance1m: row.candidate.orderbookImbalance1m,
      orderbookImbalance5m: row.candidate.orderbookImbalance5m,
      top5Streak,
      top10Streak,
      cycleStreak,
      noInvalidationStreak,
      readinessHistory,
      updatedAt: now,
    };
  }

  const state: RankingStateFile = {
    scans: previous.scans + 1,
    updatedAt: now,
    leaderboard: rows.slice(0, LEADERBOARD_TRACK_LIMIT).map((r) => r.candidate.symbol),
    tokens: nextTokens,
  };

  return { ranked: rows, state, recentlyDropped };
}

function resolvePrimaryCause(row: CandidateWithStability): string {
  if (!row.prev) return "Newly detected setup";
  if (row.invalidationReasons.length > 0) return row.invalidationReasons[0];

  const deltas = [
    { label: "Price pressure deteriorated", value: row.candidate.deltaScore24h - row.prev.deltaScore24h },
    { label: "Absorption weakened", value: row.candidate.absorptionScore - row.prev.abs },
    { label: "Accumulation weakened", value: row.candidate.accumulationScore - row.prev.as },
    { label: "Pre-pump compression weakened", value: row.candidate.prePumpScore - row.prev.pp },
    { label: "Readiness cooled", value: row.readiness - row.prev.readiness },
  ].sort((a, b) => a.value - b.value);

  const worst = deltas[0]?.value ?? 0;
  if (worst > -3) {
    return "No material deterioration; normal ranking rotation";
  }

  return deltas[0]?.label ?? "Natural rotation displacement";
}

async function printNearZonePriority(
  rankedAll: CandidateWithStability[],
  suites: Map<string, MultiTimeframeSuite>,
): Promise<void> {
  const ranked = rankedAll
    .filter((row) => row.candidate.distanceFromZeroFib >= 3 && row.candidate.distanceFromZeroFib <= 15)
    .slice(0, 20);

  if (ranked.length === 0) {
    console.log("\n🎯 NEAR ZONE BUY PRIORITY: none");
    return;
  }

  console.log("\n🎯 NEAR ZONE BUY PRIORITY (STABLE + EXPLAINABLE):");
  console.log("  " + "#".padEnd(4) + "Symbol".padEnd(14) + "Prio".padEnd(7) + "Prev".padEnd(7) + "ΔPrio".padEnd(7) + "BP".padEnd(5) + "ΔBP".padEnd(6) + "Read".padEnd(7) + "ΔRead".padEnd(7) + "Life".padEnd(12) + "Cycle".padEnd(14) + "Verdict".padEnd(13) + "Align".padEnd(18) + "TFs(15m/1h/4h/6h/12h/1d/1w)");

  for (const row of ranked) {
    const c = row.candidate;
    const prev = row.prev;
    const suite = suites.get(c.symbol) ?? createEmptyMultiTimeframeSuite();
    const prevPriority = prev ? prev.priority.toFixed(1) : "n/a";
    console.log(
      `${String(row.rank).padStart(3)} `.padEnd(4) +
      `${c.symbol.padEnd(13)}`.padEnd(14) +
      `${row.priority.toFixed(1)}`.padEnd(7) +
      `${prevPriority}`.padEnd(7) +
      `${formatDelta(row.priority, prev?.priority)}`.padEnd(7) +
      `${c.burstProbabilityScore}`.padEnd(5) +
      `${formatDelta(c.burstProbabilityScore, prev?.burstProbabilityScore, 0)}`.padEnd(6) +
      `${row.readiness.toFixed(1)}`.padEnd(7) +
      `${formatDelta(row.readiness, prev?.readiness)}`.padEnd(7) +
      `${c.lifecycleAction}`.padEnd(12) +
      `${c.marketCycle}`.padEnd(14) +
      `${suite.bullishVerdict}`.padEnd(13) +
      `${suite.longAlignment}`.padEnd(18) +
      formatSuiteCompact(suite)
    );
    console.log(
      `     prevRank=${prev?.rank ?? "n/a"} ` +
      `ΔABS=${formatDelta(c.absorptionScore, prev?.abs, 0)} ` +
      `ΔRS=${formatDelta(c.recoveryScore, prev?.rs, 0)} ` +
      `ΔAS=${formatDelta(c.accumulationScore, prev?.as, 0)} ` +
      `ΔPP=${formatDelta(c.prePumpScore, prev?.pp, 0)} ` +
      `ΔOBS=${formatDelta(c.obsScore, prev?.obs, 0)} ` +
      `ΔDist=${formatDelta(c.distanceFromZeroFib, prev?.distance)} ` +
      `trend=${row.confidenceTrend} ` +
      `bonus=+${row.persistenceBonus.toFixed(1)} ` +
      `raw=${row.rawPriority.toFixed(1)}`
    );
  }

  console.log("\n🧪 WHY SCORE CHANGED:");
  for (const row of ranked.slice(0, 8)) {
    const prev = row.prev;
    if (!prev) continue;
    const c = row.candidate;
    console.log(`${c.symbol}`);
    console.log(`  Priority: ${prev.priority.toFixed(1)} -> ${row.priority.toFixed(1)} (${formatDelta(row.priority, prev.priority)})`);
    console.log(`  BP: ${prev.burstProbabilityScore.toFixed(0)} -> ${c.burstProbabilityScore.toFixed(0)} (${formatDelta(c.burstProbabilityScore, prev.burstProbabilityScore, 0)})`);
    console.log(`  ABS: ${prev.abs.toFixed(0)} -> ${c.absorptionScore.toFixed(0)} (${formatDelta(c.absorptionScore, prev.abs, 0)})`);
    console.log(`  PP: ${prev.pp.toFixed(0)} -> ${c.prePumpScore.toFixed(0)} (${formatDelta(c.prePumpScore, prev.pp, 0)})`);
    console.log(`  Primary Cause: ${resolvePrimaryCause(row)}`);
  }
}

function printRecentlyDroppedCandidates(recentlyDropped: CandidateWithStability[]): void {
  if (recentlyDropped.length === 0) {
    return;
  }

  console.log("\n🟠 RECENTLY DROPPED CANDIDATES:");
  for (const row of recentlyDropped.slice(0, 10)) {
    const prev = row.prev;
    if (!prev) continue;
    const reason = row.invalidationReasons.length > 0
      ? row.invalidationReasons.join("; ")
      : `${resolvePrimaryCause(row)}; remains ${row.candidate.marketCycle}`;
    console.log(`${row.candidate.symbol} | Previous Rank: #${prev.rank} | Current Rank: #${row.rank} | Reason: ${reason}`);
  }
}

function printExtremeSnapbackWatchlist(result: Awaited<ReturnType<typeof scanCapitulationBounces>>): void {
  const merged = new Map<string, CapitulationCandidate>();
  for (const c of [...result.ultraCapitulationCandidates, ...result.bounceZoneCandidates, ...result.nearBounceZone]) {
    merged.set(c.symbol, c);
  }

  const ranked = Array.from(merged.values())
    .filter((c) => c.drawdownFromHigh >= SNAPBACK_MIN_DRAWDOWN_PCT)
    .filter((c) => c.distanceFromZeroFib >= 0 && c.distanceFromZeroFib <= SNAPBACK_MAX_DISTANCE_PCT)
    .filter((c) => c.fundingRate <= SNAPBACK_MAX_FUNDING_RATE)
    .filter((c) => c.volumeSpikeX >= SNAPBACK_MIN_SPIKE_X)
    .filter((c) => c.deltaVolumePct >= SNAPBACK_MIN_DELTA_VOL_PCT)
    .filter((c) => (c.askDepthUsd ?? 0) >= SNAPBACK_MIN_ASK_DEPTH_USD)
    .map((c) => {
      const squeezeScore =
        Math.min(100, c.drawdownFromHigh) * 0.2 +
        (100 - Math.min(100, c.distanceFromZeroFib * 20)) * 0.15 +
        Math.min(100, c.volumeSpikeX * 40) * 0.2 +
        Math.min(100, c.deltaVolumePct * 100) * 0.15 +
        Math.min(100, Math.abs(c.fundingRate) * 100_000) * 0.1 +
        computeReadinessScore(c) * 0.2;
      return {
        candidate: c,
        score: Number(squeezeScore.toFixed(1)),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  if (ranked.length === 0) {
    console.log("\n⚡ EXTREME SNAPBACK WATCHLIST: none");
    return;
  }

  console.log(
    `\n⚡ EXTREME SNAPBACK WATCHLIST (${SNAPBACK_MIN_DRAWDOWN_PCT.toFixed(0)}%+ DD / <=${SNAPBACK_MAX_DISTANCE_PCT.toFixed(1)}% ATL / funding<=${(SNAPBACK_MAX_FUNDING_RATE * 100).toFixed(4)}% / spike>=${SNAPBACK_MIN_SPIKE_X.toFixed(2)}x):`
  );
  console.log("  " + "#".padEnd(4) + "Symbol".padEnd(14) + "Sqz".padEnd(6) + "DD".padEnd(7) + "Dist".padEnd(8) + "Fund%".padEnd(10) + "Spike".padEnd(8) + "ΔVol".padEnd(8) + "Ask$".padEnd(10) + "Read".padEnd(7) + "Act".padEnd(10) + "Stage");

  for (const [idx, row] of ranked.entries()) {
    const c = row.candidate;
    const funding = `${(c.fundingRate * 100).toFixed(4)}%`;
    const askDepthStr = c.askDepthUsd == null ? "n/a" : `$${Math.round(c.askDepthUsd).toLocaleString()}`;
    console.log(
      `${String(idx + 1).padStart(3)} `.padEnd(4) +
      `${c.symbol.padEnd(13)}`.padEnd(14) +
      `${row.score.toFixed(1)}`.padEnd(6) +
      `${c.drawdownFromHigh.toFixed(1)}%`.padEnd(7) +
      `+${c.distanceFromZeroFib.toFixed(1)}%`.padEnd(8) +
      funding.padEnd(10) +
      `${c.volumeSpikeX.toFixed(2)}x`.padEnd(8) +
      `${c.deltaVolumePct >= 0 ? "+" : ""}${(c.deltaVolumePct * 100).toFixed(0)}%`.padEnd(8) +
      askDepthStr.padEnd(10) +
      `${computeReadinessScore(c).toFixed(1)}`.padEnd(7) +
      `${c.actionRecommendation}(${c.actionConfidencePct}%)`.padEnd(10) +
      c.stage
    );
  }
}

function smaAt(values: number[], period: number, endIndex: number): number {
  const start = endIndex - period + 1;
  if (start < 0 || endIndex >= values.length) return Number.NaN;
  let sum = 0;
  for (let i = start; i <= endIndex; i += 1) {
    sum += values[i];
  }
  return sum / period;
}

type BottomShortSetup = {
  symbol: string;
  distanceFromZeroFib: number;
  close: number;
  sma20: number;
  sma50: number;
  smaGapPct: number;
  stochK: number;
  stochD: number;
  prevK: number;
  prevD: number;
  trendTag: "DOWNTREND" | "TRANSITION";
  fifteenMinTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  oneHourTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  fourHourTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  sixHourTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  twelveHourTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  oneDayTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  oneWeekTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  conflictTag: "HTF_BEAR_LTF_BEAR" | "HTF_BEAR_LTF_BULL";
  status: "SHORT_READY" | "SHORT_WATCH_PULLBACK";
  score: number;
  bullishVerdict: "BULLISH" | "NOT_BULLISH";
};

type OverextendedDropSetup = {
  symbol: string;
  close: number;
  sma20: number;
  sma50: number;
  extensionPct: number;
  rsi14: number;
  dailyStochK: number;
  dailyStochD: number;
  oneHourStochK: number;
  oneHourStochD: number;
  fifteenMinTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  oneHourTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  fourHourTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  sixHourTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  twelveHourTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  oneDayTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  oneWeekTrend: "DOWN" | "UP" | "TRANSITION" | "N_A";
  bearishMomentumTag: "STRONG" | "EARLY" | "WEAK";
  status: "DROP_READY" | "DROP_WATCH";
  score: number;
};

type WeeklyCapitulationSetup = {
  symbol: string;
  close: number;
  weeklyRsi14: number;
  weeklyStochK: number;
  weeklyStochD: number;
  weeklyStochCrossUp: boolean;
  dailyRsi14: number;
  dailyStochK: number;
  dailyStochD: number;
  dailyStochCrossUp: boolean;
  extensionPct: number;
  status: "REVERSAL_READY" | "REVERSAL_WATCH";
  score: number;
};

type TimeframeDirection = "UP" | "DOWN" | "TRANSITION" | "N_A";

type MultiTimeframeSuite = {
  fifteenMin: TimeframeDirection;
  oneHour: TimeframeDirection;
  fourHour: TimeframeDirection;
  sixHour: TimeframeDirection;
  twelveHour: TimeframeDirection;
  oneDay: TimeframeDirection;
  oneWeek: TimeframeDirection;
  longAlignment: "FULL_BULL" | "HTF_BULL_LTF_WEAK" | "LTF_BULL_HTF_WEAK" | "MIXED" | "FULL_BEAR";
  bullishVerdict: "BULLISH" | "NOT_BULLISH";
};

function createEmptyMultiTimeframeSuite(): MultiTimeframeSuite {
  return {
    fifteenMin: "N_A",
    oneHour: "N_A",
    fourHour: "N_A",
    sixHour: "N_A",
    twelveHour: "N_A",
    oneDay: "N_A",
    oneWeek: "N_A",
    longAlignment: "MIXED",
    bullishVerdict: "NOT_BULLISH",
  };
}

function hasAnyResolvedTimeframe(suite: MultiTimeframeSuite): boolean {
  return [
    suite.fifteenMin,
    suite.oneHour,
    suite.fourHour,
    suite.sixHour,
    suite.twelveHour,
    suite.oneDay,
    suite.oneWeek,
  ].some((v) => v !== "N_A");
}

function aggregateCloseSeries(values: number[], bucket: number): number[] {
  const out: number[] = [];
  if (bucket <= 1) return [...values];
  for (let i = bucket - 1; i < values.length; i += bucket) {
    out.push(values[i]);
  }
  return out;
}

function resolveTrendState(closes: number[]): TimeframeDirection {
  const i = closes.length - 1;
  if (i < 55) return "N_A";
  const close = closes[i];
  const sma20 = smaAt(closes, 20, i);
  const sma50 = smaAt(closes, 50, i);
  const sma20Prev5 = smaAt(closes, 20, i - 5);
  if (![close, sma20, sma50, sma20Prev5].every((v) => Number.isFinite(v) && v > 0)) {
    return "N_A";
  }

  if (close < sma20 && sma20 < sma50 && sma20 < sma20Prev5) return "DOWN";
  if (close > sma20 && sma20 > sma50 && sma20 > sma20Prev5) return "UP";
  return "TRANSITION";
}

function resolveLongAlignment(suite: Omit<MultiTimeframeSuite, "longAlignment" | "bullishVerdict">): MultiTimeframeSuite["longAlignment"] {
  const htfBull = suite.twelveHour === "UP" || suite.oneDay === "UP" || suite.oneWeek === "UP";
  const htfBear = suite.twelveHour === "DOWN" || suite.oneDay === "DOWN" || suite.oneWeek === "DOWN";
  const ltfBull = suite.fifteenMin === "UP" || suite.oneHour === "UP" || suite.fourHour === "UP" || suite.sixHour === "UP";
  const ltfBear = suite.fifteenMin === "DOWN" || suite.oneHour === "DOWN" || suite.fourHour === "DOWN" || suite.sixHour === "DOWN";

  if (htfBull && ltfBull && !htfBear && !ltfBear) return "FULL_BULL";
  if (htfBull && ltfBear) return "HTF_BULL_LTF_WEAK";
  if (htfBear && ltfBull) return "LTF_BULL_HTF_WEAK";
  if (htfBear && ltfBear && !htfBull) return "FULL_BEAR";
  return "MIXED";
}

function resolveBullishVerdict(
  suite: Omit<MultiTimeframeSuite, "longAlignment" | "bullishVerdict">,
  alignment: MultiTimeframeSuite["longAlignment"],
): MultiTimeframeSuite["bullishVerdict"] {
  const states = [
    suite.fifteenMin,
    suite.oneHour,
    suite.fourHour,
    suite.sixHour,
    suite.twelveHour,
    suite.oneDay,
    suite.oneWeek,
  ];
  const upCount = states.filter((s) => s === "UP").length;
  const downCount = states.filter((s) => s === "DOWN").length;

  if (alignment === "FULL_BULL") return "BULLISH";
  if (alignment === "HTF_BULL_LTF_WEAK" && upCount >= 4 && suite.oneWeek !== "DOWN") return "BULLISH";
  if (alignment === "MIXED" && upCount >= 5 && downCount <= 1 && suite.oneDay === "UP") return "BULLISH";
  return "NOT_BULLISH";
}

async function buildMultiTimeframeSuite(symbol: string): Promise<MultiTimeframeSuite | null> {
  try {
    const [fifteenMinCandlesResult, oneHourCandlesResult, dailyCandlesResult] = await Promise.allSettled([
      fetchRecentCandles(symbol, "15m", 420),
      // 12h trend needs >= 56 candles => 56 * 12 = 672 hours
      fetchRecentCandles(symbol, "1h", 720),
      // 1w trend needs >= 56 candles => 56 * 7 = 392 daily candles
      fetchRecentCandles(symbol, "1d", 420),
    ]);

    const fifteenMinCandles = fifteenMinCandlesResult.status === "fulfilled" ? fifteenMinCandlesResult.value : null;
    const oneHourCandles = oneHourCandlesResult.status === "fulfilled" ? oneHourCandlesResult.value : null;
    const dailyCandles = dailyCandlesResult.status === "fulfilled" ? dailyCandlesResult.value : null;

    const suiteBase: Omit<MultiTimeframeSuite, "longAlignment" | "bullishVerdict"> = {
      fifteenMin: "N_A",
      oneHour: "N_A",
      fourHour: "N_A",
      sixHour: "N_A",
      twelveHour: "N_A",
      oneDay: "N_A",
      oneWeek: "N_A",
    };

    if (fifteenMinCandles && fifteenMinCandles.length >= 56) {
      const fifteenMinCloses = fifteenMinCandles.map((x) => Number(x.close));
      suiteBase.fifteenMin = resolveTrendState(fifteenMinCloses);
    }

    if (oneHourCandles && oneHourCandles.length >= 56) {
      const oneHourCloses = oneHourCandles.map((x) => Number(x.close));
      suiteBase.oneHour = resolveTrendState(oneHourCloses);

      if (oneHourCloses.length >= 56 * 4) {
        suiteBase.fourHour = resolveTrendState(aggregateCloseSeries(oneHourCloses, 4));
      }
      if (oneHourCloses.length >= 56 * 6) {
        suiteBase.sixHour = resolveTrendState(aggregateCloseSeries(oneHourCloses, 6));
      }
      if (oneHourCloses.length >= 56 * 12) {
        suiteBase.twelveHour = resolveTrendState(aggregateCloseSeries(oneHourCloses, 12));
      }
    }

    if (dailyCandles && dailyCandles.length >= 56) {
      const oneDayCloses = dailyCandles.map((x) => Number(x.close));
      suiteBase.oneDay = resolveTrendState(oneDayCloses);
      if (oneDayCloses.length >= 56 * 7) {
        suiteBase.oneWeek = resolveTrendState(aggregateCloseSeries(oneDayCloses, 7));
      }
    }

    const longAlignment = resolveLongAlignment(suiteBase);
    const bullishVerdict = resolveBullishVerdict(suiteBase, longAlignment);

    const suite: MultiTimeframeSuite = {
      ...suiteBase,
      longAlignment,
      bullishVerdict,
    };

    return hasAnyResolvedTimeframe(suite) ? suite : null;
  } catch {
    return null;
  }
}

async function buildMultiTimeframeSuites(symbols: string[]): Promise<Map<string, MultiTimeframeSuite>> {
  const suites = new Map<string, MultiTimeframeSuite>();
  const unique = Array.from(new Set(symbols));

  // Avoid overloading Bitunix with massive parallel fetches; this was producing N_A across the board.
  const concurrency = 8;
  for (let i = 0; i < unique.length; i += concurrency) {
    const chunk = unique.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (symbol) => ({ symbol, suite: await buildMultiTimeframeSuite(symbol) })),
    );

    for (const item of results) {
      if (item.status !== "fulfilled") continue;
      suites.set(item.value.symbol, item.value.suite ?? createEmptyMultiTimeframeSuite());
    }
  }

  const resolvedCount = Array.from(suites.values()).filter((suite) => hasAnyResolvedTimeframe(suite)).length;
  console.log(`[capitulation-scan] timeframe suites resolved for ${resolvedCount}/${unique.length} symbols`);
  return suites;
}

function formatSuiteCompact(suite: MultiTimeframeSuite | undefined): string {
  if (!suite) return "N_A/N_A/N_A/N_A/N_A/N_A/N_A";
  return `${suite.fifteenMin}/${suite.oneHour}/${suite.fourHour}/${suite.sixHour}/${suite.twelveHour}/${suite.oneDay}/${suite.oneWeek}`;
}

async function printBottomShortSetups(
  result: Awaited<ReturnType<typeof scanCapitulationBounces>>,
  suites: Map<string, MultiTimeframeSuite>,
): Promise<void> {
  const merged = new Map<string, CapitulationCandidate>();
  for (const c of [...result.ultraCapitulationCandidates, ...result.bounceZoneCandidates, ...result.nearBounceZone]) {
    merged.set(c.symbol, c);
  }

  const symbols = Array.from(merged.values());
  if (symbols.length === 0) {
    console.log("\n📉 BOTTOM SHORT SETUPS: none");
    return;
  }

  const setups: BottomShortSetup[] = [];
  for (const c of symbols) {
    try {
      const [dailyCandles, oneHourCandles] = await Promise.all([
        fetchRecentCandles(c.symbol, "1d", 560),
        fetchRecentCandles(c.symbol, "1h", 420),
      ]);
      if (!dailyCandles || dailyCandles.length < 140 || !oneHourCandles || oneHourCandles.length < 80) continue;

      const dailyCloses = dailyCandles.map((x) => Number(x.close));
      const hourCloses = oneHourCandles.map((x) => Number(x.close));
      const suite = suites.get(c.symbol) ?? createEmptyMultiTimeframeSuite();

      const i = dailyCloses.length - 1;
      const close = dailyCloses[i];
      const prevClose = dailyCloses[i - 1];
      const sma20 = smaAt(dailyCloses, 20, i);
      const sma50 = smaAt(dailyCloses, 50, i);
      const prevSma20 = smaAt(dailyCloses, 20, i - 1);
      const sma20Prev5 = smaAt(dailyCloses, 20, i - 5);
      if (![close, prevClose, sma20, sma50, prevSma20, sma20Prev5].every((v) => Number.isFinite(v) && v > 0)) continue;

      const dailySrsi = calculateStochasticRsi(dailyCloses, 14, 14, 3, 3);
      const oneHourSrsi = calculateStochasticRsi(hourCloses, 14, 14, 3, 3);
      if (!dailySrsi || !oneHourSrsi) continue;

      const fifteenMinTrend = suite.fifteenMin;
      const oneHourTrend = suite.oneHour;
      const fourHourTrend = suite.fourHour;
      const sixHourTrend = suite.sixHour;
      const twelveHourTrend = suite.twelveHour;
      const oneDayTrend = suite.oneDay;
      const oneWeekTrend = suite.oneWeek;

      const htfBearish = (oneDayTrend === "DOWN" || twelveHourTrend === "DOWN") && oneWeekTrend === "DOWN";
      const ltfBearishTiming =
        oneHourTrend === "DOWN" ||
        fourHourTrend === "DOWN" ||
        sixHourTrend === "DOWN" ||
        (oneHourSrsi.prevK >= oneHourSrsi.prevD && oneHourSrsi.k < oneHourSrsi.d);

      const downtrend = oneDayTrend === "DOWN";
      const justBrokeBelowSma20 = prevClose >= prevSma20 && close < sma20;
      const dailySrsiCrossDown = dailySrsi.prevK >= dailySrsi.prevD && dailySrsi.k < dailySrsi.d;

      if (!(htfBearish && downtrend && justBrokeBelowSma20 && dailySrsiCrossDown)) {
        continue;
      }

      const smaGapPct = ((close - sma20) / sma20) * 100;
      let score = 0;
      score += Math.min(40, Math.abs(smaGapPct) * 4.5);
      score += Math.min(25, Math.max(0, dailySrsi.d - dailySrsi.k) * 1.8);
      score += Math.min(20, Math.max(0, c.deltaScore24h * -1.2));
      score += Math.min(15, Math.max(0, (c.orderbookImbalance1m * -100) * 0.9));
      if (ltfBearishTiming) score += 10;
      else score -= 8;

      setups.push({
        symbol: c.symbol,
        distanceFromZeroFib: c.distanceFromZeroFib,
        close,
        sma20,
        sma50,
        smaGapPct,
        stochK: dailySrsi.k,
        stochD: dailySrsi.d,
        prevK: dailySrsi.prevK,
        prevD: dailySrsi.prevD,
        trendTag: downtrend ? "DOWNTREND" : "TRANSITION",
        fifteenMinTrend,
        oneHourTrend,
        fourHourTrend,
        sixHourTrend,
        twelveHourTrend,
        oneDayTrend,
        oneWeekTrend,
        conflictTag: ltfBearishTiming && fifteenMinTrend !== "UP" ? "HTF_BEAR_LTF_BEAR" : "HTF_BEAR_LTF_BULL",
        status: ltfBearishTiming ? "SHORT_READY" : "SHORT_WATCH_PULLBACK",
        score: Number(score.toFixed(1)),
        bullishVerdict: suite.bullishVerdict,
      });
    } catch {
      // Keep scan resilient; missing symbol data should not fail the whole board.
      continue;
    }
  }

  const ranked = setups.sort((a, b) => b.score - a.score).slice(0, 20);
  if (ranked.length === 0) {
    console.log("\n📉 BOTTOM SHORT SETUPS (HTF BEAR + DAILY SMA BREAK + DAILY SRSI CROSS-DOWN): none");
    return;
  }

  console.log("\n📉 BOTTOM SHORT SETUPS (HTF BEAR + DAILY SMA BREAK + DAILY SRSI CROSS-DOWN):");
  console.log("  " + "#".padEnd(4) + "Symbol".padEnd(14) + "Score".padEnd(7) + "Status".padEnd(22) + "Verdict".padEnd(13) + "Conflict".padEnd(20) + "15m".padEnd(12) + "1h".padEnd(12) + "4h".padEnd(12) + "6h".padEnd(12) + "12h".padEnd(12) + "1d".padEnd(12) + "1w".padEnd(12) + "Gap".padEnd(8) + "K/D");
  for (const [idx, s] of ranked.entries()) {
    const kd = `${s.stochK.toFixed(1)}/${s.stochD.toFixed(1)}`;
    console.log(
      `${String(idx + 1).padStart(3)} `.padEnd(4) +
      `${s.symbol.padEnd(13)}`.padEnd(14) +
      `${s.score.toFixed(1)}`.padEnd(7) +
      `${s.status}`.padEnd(22) +
      `${s.bullishVerdict}`.padEnd(13) +
      `${s.conflictTag}`.padEnd(20) +
      `${s.fifteenMinTrend}`.padEnd(12) +
      `${s.oneHourTrend}`.padEnd(12) +
      `${s.fourHourTrend}`.padEnd(12) +
      `${s.sixHourTrend}`.padEnd(12) +
      `${s.twelveHourTrend}`.padEnd(12) +
      `${s.oneDayTrend}`.padEnd(12) +
      `${s.oneWeekTrend}`.padEnd(12) +
      `${s.smaGapPct.toFixed(1)}%`.padEnd(8) +
      kd
    );
    console.log(`     dist=+${s.distanceFromZeroFib.toFixed(1)}% close=${s.close.toFixed(6)} sma20=${s.sma20.toFixed(6)} sma50=${s.sma50.toFixed(6)} daily-prevK/D=${s.prevK.toFixed(1)}/${s.prevD.toFixed(1)}`);
  }
}

async function printOverextendedDropSetups(
  symbols: string[],
  suites: Map<string, MultiTimeframeSuite>,
): Promise<void> {
  const uniqueSymbols = Array.from(new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)));
  if (uniqueSymbols.length === 0) {
    console.log("\n📛 OVEREXTENDED DROP SETUPS: none (scan universe unavailable)");
    return;
  }

  const setups: OverextendedDropSetup[] = [];
  const concurrency = 8;

  for (let i = 0; i < uniqueSymbols.length; i += concurrency) {
    const chunk = uniqueSymbols.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (symbol) => {
        const [dailyCandles, oneHourCandles] = await Promise.all([
          fetchRecentCandles(symbol, "1d", 260),
          fetchRecentCandles(symbol, "1h", 260),
        ]);
        return { symbol, dailyCandles, oneHourCandles };
      }),
    );

    for (const result of results) {
      if (result.status !== "fulfilled") {
        continue;
      }

      const { symbol, dailyCandles, oneHourCandles } = result.value;
      if (dailyCandles.length < 80 || oneHourCandles.length < 80) {
        continue;
      }

      const dailyCloses = dailyCandles.map((c) => Number(c.close));
      const oneHourCloses = oneHourCandles.map((c) => Number(c.close));
      const suite = suites.get(symbol) ?? createEmptyMultiTimeframeSuite();

      const di = dailyCloses.length - 1;
      const close = dailyCloses[di];
      const sma20 = smaAt(dailyCloses, 20, di);
      const sma50 = smaAt(dailyCloses, 50, di);
      if (![close, sma20, sma50].every((v) => Number.isFinite(v) && v > 0)) {
        continue;
      }

      const extensionPct = ((close - sma20) / sma20) * 100;
      const dailyRsi = calculateLatestRsi(dailyCloses, 14);
      const dailySrsi = calculateStochasticRsi(dailyCloses, 14, 14, 3, 3);
      const oneHourSrsi = calculateStochasticRsi(oneHourCloses, 14, 14, 3, 3);
      if (dailyRsi == null || !dailySrsi || !oneHourSrsi) {
        continue;
      }

      const htfUp =
        suite.oneDay === "UP" ||
        suite.twelveHour === "UP" ||
        suite.oneWeek === "UP";
      const ltfWeak =
        suite.fifteenMin === "DOWN" ||
        suite.oneHour === "DOWN" ||
        suite.fourHour === "DOWN" ||
        suite.sixHour === "DOWN" ||
        suite.fifteenMin === "TRANSITION" ||
        suite.oneHour === "TRANSITION";

      const dailyCrossDown = dailySrsi.prevK >= dailySrsi.prevD && dailySrsi.k < dailySrsi.d;
      const oneHourCrossDown = oneHourSrsi.prevK >= oneHourSrsi.prevD && oneHourSrsi.k < oneHourSrsi.d;
      const dailyOverbought = dailySrsi.prevK >= 80 || dailySrsi.prevD >= 80 || dailyRsi >= 66;
      const oneHourRollingOver = oneHourSrsi.k < oneHourSrsi.d && oneHourSrsi.k <= 70;

      const strongBearish = dailyCrossDown && oneHourCrossDown && oneHourRollingOver;
      const earlyBearish = (dailyCrossDown || oneHourCrossDown) && oneHourRollingOver;
      const bearishMomentumTag: OverextendedDropSetup["bearishMomentumTag"] = strongBearish
        ? "STRONG"
        : earlyBearish
        ? "EARLY"
        : "WEAK";

      const isDropReady = htfUp && extensionPct >= 8 && dailyOverbought && strongBearish;
      const isDropWatch = htfUp && extensionPct >= 5.5 && dailyOverbought && (earlyBearish || ltfWeak);
      if (!isDropReady && !isDropWatch) {
        continue;
      }

      let score = 0;
      score += Math.min(45, Math.max(0, extensionPct - 4) * 4.8);
      score += Math.min(25, Math.max(0, dailyRsi - 60) * 1.2);
      score += Math.min(20, Math.max(0, dailySrsi.d - dailySrsi.k) * 1.6);
      if (oneHourCrossDown) score += 10;
      if (suite.oneHour === "DOWN" || suite.fourHour === "DOWN") score += 8;

      setups.push({
        symbol,
        close,
        sma20,
        sma50,
        extensionPct,
        rsi14: dailyRsi,
        dailyStochK: dailySrsi.k,
        dailyStochD: dailySrsi.d,
        oneHourStochK: oneHourSrsi.k,
        oneHourStochD: oneHourSrsi.d,
        fifteenMinTrend: suite.fifteenMin,
        oneHourTrend: suite.oneHour,
        fourHourTrend: suite.fourHour,
        sixHourTrend: suite.sixHour,
        twelveHourTrend: suite.twelveHour,
        oneDayTrend: suite.oneDay,
        oneWeekTrend: suite.oneWeek,
        bearishMomentumTag,
        status: isDropReady ? "DROP_READY" : "DROP_WATCH",
        score: Number(score.toFixed(1)),
      });
    }
  }

  const ranked = setups.sort((a, b) => b.score - a.score).slice(0, 20);
  if (ranked.length === 0) {
    console.log("\n📛 OVEREXTENDED DROP SETUPS (HTF UP + EXTENSION + BEARISH ROLLOVER): none");
    return;
  }

  console.log("\n📛 OVEREXTENDED DROP SETUPS (HTF UP + EXTENSION + BEARISH ROLLOVER):");
  console.log("  " + "#".padEnd(4) + "Symbol".padEnd(14) + "Score".padEnd(7) + "Status".padEnd(13) + "Bear".padEnd(8) + "Ext".padEnd(8) + "RSI".padEnd(6) + "dK/dD".padEnd(12) + "1hK/1hD".padEnd(12) + "15m".padEnd(12) + "1h".padEnd(12) + "4h".padEnd(12) + "6h".padEnd(12) + "12h".padEnd(12) + "1d".padEnd(12) + "1w");

  for (const [idx, row] of ranked.entries()) {
    console.log(
      `${String(idx + 1).padStart(3)} `.padEnd(4) +
      `${row.symbol.padEnd(13)}`.padEnd(14) +
      `${row.score.toFixed(1)}`.padEnd(7) +
      `${row.status}`.padEnd(13) +
      `${row.bearishMomentumTag}`.padEnd(8) +
      `${row.extensionPct.toFixed(1)}%`.padEnd(8) +
      `${row.rsi14.toFixed(1)}`.padEnd(6) +
      `${row.dailyStochK.toFixed(1)}/${row.dailyStochD.toFixed(1)}`.padEnd(12) +
      `${row.oneHourStochK.toFixed(1)}/${row.oneHourStochD.toFixed(1)}`.padEnd(12) +
      `${row.fifteenMinTrend}`.padEnd(12) +
      `${row.oneHourTrend}`.padEnd(12) +
      `${row.fourHourTrend}`.padEnd(12) +
      `${row.sixHourTrend}`.padEnd(12) +
      `${row.twelveHourTrend}`.padEnd(12) +
      `${row.oneDayTrend}`.padEnd(12) +
      row.oneWeekTrend
    );
    console.log(
      `     close=${row.close.toFixed(6)} sma20=${row.sma20.toFixed(6)} sma50=${row.sma50.toFixed(6)}`
    );
  }
}

async function printWeeklyCapitulationSetups(symbols: string[]): Promise<void> {
  const uniqueSymbols = Array.from(new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)));
  if (uniqueSymbols.length === 0) {
    console.log("\n📆 WEEKLY CAPITULATION REVERSALS: none (scan universe unavailable)");
    return;
  }

  // Build weekly closes by grouping every 7 daily closes.
  function buildWeeklyCloses(dailyCloses: number[]): number[] {
    const weekly: number[] = [];
    const start = dailyCloses.length % 7;
    for (let i = start; i + 7 <= dailyCloses.length; i += 7) {
      weekly.push(dailyCloses[i + 6]);
    }
    return weekly;
  }

  const setups: WeeklyCapitulationSetup[] = [];
  const concurrency = 8;

  for (let i = 0; i < uniqueSymbols.length; i += concurrency) {
    const chunk = uniqueSymbols.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (symbol) => {
        const candles = await fetchRecentCandles(symbol, "1d", 500);
        return { symbol, candles };
      }),
    );

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { symbol, candles } = result.value;

      const dailyCloses = candles.map((c) => Number(c.close)).filter(Number.isFinite);
      if (dailyCloses.length < 80) continue;

      const weeklyCloses = buildWeeklyCloses(dailyCloses);
      if (weeklyCloses.length < 20) continue;

      const weeklyRsi = calculateLatestRsi(weeklyCloses, 14);
      const weeklyStoch = calculateStochasticRsi(weeklyCloses, 14, 14, 3, 3);
      const dailyRsi = calculateLatestRsi(dailyCloses, 14);
      const dailyStoch = calculateStochasticRsi(dailyCloses, 14, 14, 3, 3);

      if (weeklyRsi == null || !weeklyStoch || dailyRsi == null || !dailyStoch) continue;

      // Only care about weekly oversold territory
      if (weeklyRsi >= 38) continue;

      const di = dailyCloses.length - 1;
      const close = dailyCloses[di];
      const sma20 = smaAt(dailyCloses, 20, di);
      const extensionPct = Number.isFinite(sma20) && sma20 > 0
        ? ((close - sma20) / sma20) * 100
        : 0;

      const weeklyCrossUp = weeklyStoch.prevK <= weeklyStoch.prevD && weeklyStoch.k > weeklyStoch.d;
      const dailyCrossUp = dailyStoch.prevK <= dailyStoch.prevD && dailyStoch.k > dailyStoch.d;

      // REVERSAL_READY: weekly cross-up confirmed with daily confluence
      // REVERSAL_WATCH: weekly oversold but cross-up not yet triggered
      const isReversalReady = weeklyCrossUp && (dailyCrossUp || dailyStoch.k > dailyStoch.d);
      const isReversalWatch = !isReversalReady && weeklyRsi < 35;
      if (!isReversalReady && !isReversalWatch) continue;

      // Score: oversold depth + weekly stoch crossup strength + daily confluence
      let score = 0;
      score += Math.min(40, (38 - weeklyRsi) * 2);
      if (weeklyCrossUp) score += 25;
      if (dailyCrossUp) score += 20;
      if (dailyStoch.k > dailyStoch.d) score += 10;
      score += Math.min(15, Math.max(0, (30 - weeklyStoch.d) * 0.5));

      setups.push({
        symbol,
        close,
        weeklyRsi14: Number(weeklyRsi.toFixed(2)),
        weeklyStochK: Number(weeklyStoch.k.toFixed(2)),
        weeklyStochD: Number(weeklyStoch.d.toFixed(2)),
        weeklyStochCrossUp: weeklyCrossUp,
        dailyRsi14: Number(dailyRsi.toFixed(2)),
        dailyStochK: Number(dailyStoch.k.toFixed(2)),
        dailyStochD: Number(dailyStoch.d.toFixed(2)),
        dailyStochCrossUp: dailyCrossUp,
        extensionPct: Number(extensionPct.toFixed(2)),
        status: isReversalReady ? "REVERSAL_READY" : "REVERSAL_WATCH",
        score: Number(score.toFixed(1)),
      });
    }
  }

  const ranked = setups.sort((a, b) => b.score - a.score).slice(0, 20);
  if (ranked.length === 0) {
    console.log("\n📆 WEEKLY CAPITULATION REVERSALS (WEEKLY RSI <38 + STOCH CROSSUP): none");
    return;
  }

  console.log("\n📆 WEEKLY CAPITULATION REVERSALS (WEEKLY RSI <38 + STOCH CROSSUP):");
  console.log(
    "  " +
    "#".padEnd(4) +
    "Symbol".padEnd(14) +
    "Score".padEnd(7) +
    "Status".padEnd(16) +
    "wRSI".padEnd(7) +
    "wK/wD".padEnd(12) +
    "wCross".padEnd(8) +
    "dRSI".padEnd(7) +
    "dK/dD".padEnd(12) +
    "dCross".padEnd(8) +
    "Ext%",
  );
  for (const [idx, row] of ranked.entries()) {
    console.log(
      `${String(idx + 1).padStart(3)} `.padEnd(4) +
      `${row.symbol}`.padEnd(14) +
      `${row.score.toFixed(1)}`.padEnd(7) +
      `${row.status}`.padEnd(16) +
      `${row.weeklyRsi14.toFixed(1)}`.padEnd(7) +
      `${row.weeklyStochK.toFixed(1)}/${row.weeklyStochD.toFixed(1)}`.padEnd(12) +
      `${row.weeklyStochCrossUp ? "YES" : "no"}`.padEnd(8) +
      `${row.dailyRsi14.toFixed(1)}`.padEnd(7) +
      `${row.dailyStochK.toFixed(1)}/${row.dailyStochD.toFixed(1)}`.padEnd(12) +
      `${row.dailyStochCrossUp ? "YES" : "no"}`.padEnd(8) +
      `${row.extensionPct >= 0 ? "+" : ""}${row.extensionPct.toFixed(1)}%`,
    );
    console.log(`     close=${row.close.toFixed(6)}`);
  }
}

function computeBurstReadinessScore(candidate: CapitulationCandidate, suite?: MultiTimeframeSuite): number {
  const readiness = computeReadinessScore(candidate, suite);
  const spikeScore = Math.max(0, Math.min(100, candidate.volumeSpikeX * 45));
  const deltaVolScore = Math.max(0, Math.min(100, candidate.deltaVolumePct * 200));
  const deltaScore = Math.max(0, Math.min(100, (candidate.deltaScore24h + 20) * 2.5));
  const askDepthScore = Math.max(0, Math.min(100, (candidate.askDepthUsd ?? 0) / 300));
  const fundingScore = candidate.fundingRate < -0.00003 ? 70 : candidate.fundingRate <= 0 ? 50 : 35;
  const stageScore =
    candidate.stage === "PRE_PUMP" ? 92
    : candidate.stage === "ACCUMULATION" ? 82
    : candidate.stage === "RECOVERING_CAPITULATION" ? 76
    : candidate.stage === "RECOVERY" ? 72
    : candidate.stage === "DEAD_CAPITULATION" ? 54
    : 48;

  const score =
    readiness * 0.28 +
    spikeScore * 0.2 +
    deltaVolScore * 0.14 +
    deltaScore * 0.14 +
    askDepthScore * 0.1 +
    fundingScore * 0.06 +
    stageScore * 0.08 +
    alignmentPriorityAdjustment(suite) * 0.35;

  return Number(Math.max(0, Math.min(100, score)).toFixed(1));
}

function classifyBurstTier(score: number): "A" | "B" | "C" | "D" {
  if (score >= 80) return "A";
  if (score >= 68) return "B";
  if (score >= 55) return "C";
  return "D";
}

async function printBurstReadinessBoard(
  result: Awaited<ReturnType<typeof scanCapitulationBounces>>,
  suites: Map<string, MultiTimeframeSuite>,
): Promise<void> {
  const merged = new Map<string, CapitulationCandidate>();
  for (const c of [...result.ultraCapitulationCandidates, ...result.bounceZoneCandidates, ...result.nearBounceZone]) {
    merged.set(c.symbol, c);
  }

  const ranked = Array.from(merged.values())
    .map((c) => {
      const suite = suites.get(c.symbol);
      const readiness = computeReadinessScore(c, suite);
      const burstScore = computeBurstReadinessScore(c, suite);
      const isGo =
        burstScore >= 75 &&
        (!BURST_READY_REQUIRE_ACTION_BUY || c.actionRecommendation === "BUY") &&
        c.volumeSpikeX >= BURST_READY_MIN_SPIKE_X &&
        c.deltaVolumePct >= BURST_READY_MIN_DELTA_VOL_PCT &&
        c.deltaScore24h >= BURST_READY_MIN_DELTA_SCORE &&
        (c.askDepthUsd ?? 0) >= BURST_READY_MIN_ASK_DEPTH_USD &&
        readiness >= BURST_READY_MIN_READINESS;

      return {
        candidate: c,
        readiness,
        burstScore,
        tier: classifyBurstTier(burstScore),
        goNoGo: isGo ? "GO" : "NO",
      };
    })
    .sort((a, b) => b.burstScore - a.burstScore)
    .slice(0, 20);

  if (ranked.length === 0) {
    console.log("\n🚨 BURST READINESS BOARD: none");
    return;
  }

  console.log("\n🚨 BURST READINESS BOARD (GO/NO-GO):");
  console.log(
    "  " +
      "#".padEnd(4) +
      "Symbol".padEnd(14) +
      "BRS".padEnd(6) +
      "Tier".padEnd(6) +
      "Go".padEnd(5) +
      "Act".padEnd(10) +
      "Verdict".padEnd(13) +
      "Align".padEnd(18) +
      "Spike".padEnd(8) +
      "ΔVol".padEnd(8) +
      "ΔS".padEnd(7) +
      "Read".padEnd(7) +
      "Ask$".padEnd(10) +
      "Fund%".padEnd(10) +
      "Stage".padEnd(24) +
      "TFs(15m/1h/4h/6h/12h/1d/1w)"
  );

  for (const [idx, row] of ranked.entries()) {
    const c = row.candidate;
    const suite = suites.get(c.symbol) ?? createEmptyMultiTimeframeSuite();
    const askDepthStr = c.askDepthUsd == null ? "n/a" : `$${Math.round(c.askDepthUsd).toLocaleString()}`;
    const fundStr = `${(c.fundingRate * 100).toFixed(4)}%`;
    const deltaVolStr = `${c.deltaVolumePct >= 0 ? "+" : ""}${(c.deltaVolumePct * 100).toFixed(0)}%`;
    const deltaScoreStr = `${c.deltaScore24h >= 0 ? "+" : ""}${c.deltaScore24h.toFixed(1)}`;

    console.log(
      `${String(idx + 1).padStart(3)} `.padEnd(4) +
      `${c.symbol.padEnd(13)}`.padEnd(14) +
      `${row.burstScore.toFixed(1)}`.padEnd(6) +
      `${row.tier}`.padEnd(6) +
      row.goNoGo.padEnd(5) +
      `${c.actionRecommendation}(${c.actionConfidencePct}%)`.padEnd(10) +
      `${suite.bullishVerdict}`.padEnd(13) +
      `${suite.longAlignment}`.padEnd(18) +
      `${c.volumeSpikeX.toFixed(2)}x`.padEnd(8) +
      deltaVolStr.padEnd(8) +
      deltaScoreStr.padEnd(7) +
      `${row.readiness.toFixed(1)}`.padEnd(7) +
      askDepthStr.padEnd(10) +
      fundStr.padEnd(10) +
      c.stage.padEnd(24) +
      formatSuiteCompact(suite)
    );
  }
}

function estimateRotationWindow(candidate: Awaited<ReturnType<typeof scanCapitulationBounces>>["bounceZoneCandidates"][number]): string {
  if (candidate.marketCycle === "EARLY_BURST") {
    return "1-3d";
  }

  if (candidate.marketCycle === "ACCUMULATION") {
    return "2-5d";
  }

  if (candidate.marketCycle === "BURSTING") {
    return "1-2d";
  }

  if (candidate.stage === "RECOVERY") {
    return "3-7d";
  }

  const fundingIsNegative = candidate.fundingRate < -0.00003;
  const fundingIsVeryNegative = candidate.fundingRate < -0.0003;

  if (candidate.prePumpScore >= 50) {
    return fundingIsNegative ? "2-5d" : "3-7d";
  }

  if (candidate.prePumpScore >= 35) {
    return fundingIsNegative ? "3-7d" : "4-10d";
  }

  if (candidate.capitulationScore >= 65) {
    return fundingIsVeryNegative ? "4-7d" : "1-2w";
  }

  if (candidate.capitulationScore >= 50) {
    return "1-2w";
  }

  return "2-3w";
}

function printRotationShortlist(
  result: Awaited<ReturnType<typeof scanCapitulationBounces>>,
  suites: Map<string, MultiTimeframeSuite>,
) {
  const pool = [...result.bounceZoneCandidates, ...result.nearBounceZone]
    .filter((c) => c.marketCycle !== "EXTENDED" && c.marketCycle !== "EXHAUSTION")
    .filter((c) => c.distanceFromZeroFib >= 5 && c.distanceFromZeroFib <= 13)
    .filter((c) => c.rsi14 >= 28 && c.rsi14 <= 50)
    .filter((c) => c.stage !== "IGNORE" && c.stage !== "DEAD_CAPITULATION");

  const ranked = pool
    .map((c) => {
      const suite = suites.get(c.symbol);
      const fundingPenalty = c.fundingRate > 0.00012 ? 12 : c.fundingRate > 0.00008 ? 7 : 0;
      const fundingBonus = c.fundingRate < -0.00008 ? 10 : c.fundingRate < -0.00003 ? 5 : 0;
      const score =
        alignmentPriorityAdjustment(suite) +
        c.burstProbabilityScore * 0.56 +
        c.prePumpScore * 0.18 +
        c.accumulationScore * 0.14 +
        Math.max(-12, Math.min(12, c.deltaScore24h)) * 0.3 +
        (50 - Math.abs(c.rsi14 - 36)) * 0.2 +
        fundingBonus - fundingPenalty;
      return { c, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  if (ranked.length === 0) {
    console.log("\n🔁 NEXT ROTATION SHORTLIST: none (current filter produced no early candidates)");
    return;
  }

  console.log("\n🔁 NEXT ROTATION SHORTLIST (EARLY ONLY):");
  console.log("  " + "Symbol".padEnd(14) + "ETA".padEnd(7) + "Score".padEnd(8) + "BP".padEnd(5) + "Dist".padEnd(8) + "RSI".padEnd(6) + "AS".padEnd(5) + "PP".padEnd(5) + "OBS".padEnd(6) + "Fund%".padEnd(10) + "Life".padEnd(12) + "Cycle".padEnd(14) + "Verdict".padEnd(13) + "Align".padEnd(18) + "TFs(15m/1h/4h/6h/12h/1d/1w)");
  for (const row of ranked) {
    const c = row.c;
    const suite = suites.get(c.symbol) ?? createEmptyMultiTimeframeSuite();
    const eta = estimateRotationWindow(c);
    const fundStr = c.fundingRate !== 0 ? `${(c.fundingRate * 100).toFixed(4)}%` : "n/a";
    const stageIcon = c.marketCycle === "EARLY_BURST" ? "🚀" : c.marketCycle === "ACCUMULATION" ? "🌱" : c.marketCycle === "CAPITULATION" ? "🧊" : "";
    console.log(
      `  ${stageIcon} ${c.symbol.padEnd(12)}`.padEnd(18) +
      eta.padEnd(7) +
      `${row.score.toFixed(1)}`.padEnd(8) +
      `${c.burstProbabilityScore}`.padEnd(5) +
      `+${c.distanceFromZeroFib.toFixed(1)}%`.padEnd(8) +
      `${c.rsi14.toFixed(0)}`.padEnd(6) +
      `${c.accumulationScore}`.padEnd(5) +
      `${c.prePumpScore}`.padEnd(5) +
      `${c.obsScore}`.padEnd(6) +
      fundStr.padEnd(10) +
      `${c.lifecycleAction}`.padEnd(12) +
      `${c.marketCycle}`.padEnd(14) +
      `${suite.bullishVerdict}`.padEnd(13) +
      `${suite.longAlignment}`.padEnd(18) +
      formatSuiteCompact(suite)
    );
  }
}

async function printFastPumpShortlist(result: Awaited<ReturnType<typeof scanCapitulationBounces>>) {
  const fastPump = await scanFastPumpCandidates(result);
  const ranked = fastPump.shortlisted;
  const nearMisses = fastPump.nearMisses;
  const marketRotation = fastPump.marketRotation;
  const preBoomAlert = fastPump.preBoomAlert;

  console.log(
    `\n🧭 ROTATION STATE: ${marketRotation.dominantMode} | Spike ${marketRotation.spikeState} (${marketRotation.spikeScore.toFixed(1)}) | Breadth ${marketRotation.breadthPct.toFixed(1)}% (${marketRotation.breadthDelta24h >= 0 ? "+" : ""}${marketRotation.breadthDelta24h.toFixed(1)} 24h, ${marketRotation.breadthDelta72h >= 0 ? "+" : ""}${marketRotation.breadthDelta72h.toFixed(1)} 72h) | Accel ${marketRotation.accelerationPct.toFixed(1)}% (${marketRotation.accelerationDelta24h >= 0 ? "+" : ""}${marketRotation.accelerationDelta24h.toFixed(1)} 24h)`
  );

  if (preBoomAlert.active) {
    console.log(`\n🚨 PRE-BOOM ROTATION ALERT: ${preBoomAlert.transition}`);
    console.log("  " + "Symbol".padEnd(14) + "RTS".padEnd(6) + "ABS".padEnd(6) + "SRSI".padEnd(12) + "1h".padEnd(7) + "4h".padEnd(7) + "Mode");
    for (const item of preBoomAlert.confirmed) {
      const srsiText = `${item.oneHourStochRsi.toFixed(0)}/${item.fourHourStochRsi.toFixed(0)}`;
      console.log(
        `  ${item.symbol.padEnd(12)}`.padEnd(16) +
        `${item.rotationTriggerScore.toFixed(0)}`.padEnd(6) +
        `${item.absorptionScore.toFixed(0)}`.padEnd(6) +
        srsiText.padEnd(12) +
        `${item.oneHourChangePct.toFixed(1)}%`.padEnd(7) +
        `${item.fourHourChangePct.toFixed(1)}%`.padEnd(7) +
        item.rotationMode
      );
    }
  }

  if (ranked.length === 0) {
    console.log("\n⚡ FAST PUMP SHORTLIST: none (no same-day / next-day candidates passed)");
    if (nearMisses.length === 0) {
      return;
    }
  }

  if (ranked.length > 0) {
    console.log("\n⚡ FAST PUMP SHORTLIST (TODAY / TOMORROW):");
    console.log("  " + "Symbol".padEnd(14) + "ETA".padEnd(10) + "Pot".padEnd(7) + "Score".padEnd(8) + "ΔS".padEnd(7) + "RTS".padEnd(6) + "Mode".padEnd(14) + "1h".padEnd(7) + "4h".padEnd(7) + "SRSI".padEnd(12) + "VB1h".padEnd(7) + "ΔVB".padEnd(7) + "Fund%".padEnd(10) + "OBS".padEnd(6) + "OB1m".padEnd(7) + "OB5m".padEnd(7) + "ABS".padEnd(6) + "Regime".padEnd(18) + "Stage");
    for (const item of ranked) {
      const srsiText = `${item.oneHourStochRsi.toFixed(0)}/${item.fourHourStochRsi.toFixed(0)}${item.srsiConsolidationRisk ? "!" : ""}`;
      console.log(
        `  ${item.symbol.padEnd(12)}`.padEnd(16) +
        item.window.padEnd(10) +
        item.potential.padEnd(7) +
        `${item.score.toFixed(1)}`.padEnd(8) +
        `${item.deltaScore >= 0 ? "+" : ""}${item.deltaScore.toFixed(1)}`.padEnd(7) +
        `${item.rotationTriggerScore.toFixed(0)}`.padEnd(6) +
        `${item.rotationMode}`.padEnd(14) +
        `${item.oneHourChangePct.toFixed(1)}%`.padEnd(7) +
        `${item.fourHourChangePct.toFixed(1)}%`.padEnd(7) +
        srsiText.padEnd(12) +
        `${item.oneHourVolumeBurst.toFixed(2)}x`.padEnd(7) +
        `${item.deltaOneHourVolumeBurst >= 0 ? "+" : ""}${item.deltaOneHourVolumeBurst.toFixed(2)}`.padEnd(7) +
        `${(item.fundingRate * 100).toFixed(4)}%`.padEnd(10) +
        `${item.obsScore.toFixed(0)}`.padEnd(6) +
        `${(item.orderbookImbalance1m * 100).toFixed(1)}%`.padEnd(7) +
        `${(item.orderbookImbalance5m * 100).toFixed(1)}%`.padEnd(7) +
        `${item.absorptionScore.toFixed(0)}`.padEnd(6) +
        `${item.liquidityRegime}`.padEnd(18) +
        item.dailyStage
      );
    }
  }

  if (nearMisses.length > 0) {
    console.log("\n🟡 FAST PUMP NEAR MISSES (watchlist):");
    console.log("  " + "Symbol".padEnd(14) + "Score".padEnd(8) + "Gap".padEnd(7) + "RTS".padEnd(6) + "Mode".padEnd(14) + "SRSI".padEnd(12) + "1h".padEnd(7) + "4h".padEnd(7) + "VB1h".padEnd(7) + "ABS".padEnd(6) + "Top Reason");
    for (const item of nearMisses) {
      const srsiText = `${item.oneHourStochRsi.toFixed(0)}/${item.fourHourStochRsi.toFixed(0)}${item.srsiConsolidationRisk ? "!" : ""}`;
      const topReason = item.reasons[0] ?? "building setup";
      console.log(
        `  ${item.symbol.padEnd(12)}`.padEnd(16) +
        `${item.score.toFixed(1)}`.padEnd(8) +
        `${item.entryGap.toFixed(1)}`.padEnd(7) +
        `${item.rotationTriggerScore.toFixed(0)}`.padEnd(6) +
        `${item.rotationMode}`.padEnd(14) +
        srsiText.padEnd(12) +
        `${item.oneHourChangePct.toFixed(1)}%`.padEnd(7) +
        `${item.fourHourChangePct.toFixed(1)}%`.padEnd(7) +
        `${item.oneHourVolumeBurst.toFixed(2)}x`.padEnd(7) +
        `${item.absorptionScore.toFixed(0)}`.padEnd(6) +
        topReason
      );
    }
  }
}

async function main() {
  try {
    const includeSymbols = resolveIncludedSymbolsArg(process.argv.slice(2));
    let scanUniverseSymbols: string[] = [...includeSymbols];
    if (includeSymbols.length > 0) {
      process.env.CAPITULATION_SCAN_INCLUDE_SYMBOLS = includeSymbols.join(",");
      console.log(`[capitulation-scan] Symbol filter enabled: ${includeSymbols.join(", ")}`);
    } else {
      const burstCandidates = await fetchBurstUniverseCandidates();
      const burstSymbols = burstCandidates.map((candidate) => candidate.symbol);

      if (burstSymbols.length > 0) {
        scanUniverseSymbols = burstSymbols;
        process.env.CAPITULATION_SCAN_INCLUDE_SYMBOLS = burstSymbols.join(",");
        console.log(
          `[capitulation-scan] Auto universe enabled (low-cap/high-volume): ${burstSymbols.length} symbols (maxMcap=${(Number(process.env.SCAN_BURST_MAX_MARKET_CAP_USD ?? 150_000_000) / 1_000_000).toFixed(0)}M)`
        );
        console.log(
          `[capitulation-scan] Universe preview: showing all ${burstCandidates.length} symbols`
        );
        console.table(
          burstCandidates.map((candidate) => ({
            symbol: candidate.symbol,
            mcapM: (candidate.marketCapUsd / 1_000_000).toFixed(2),
            vol1hM: candidate.volume1hUsd.toFixed(2),
            change24hPct: candidate.change24hPct == null ? "n/a" : candidate.change24hPct.toFixed(2)
          }))
        );
      } else {
        console.warn("[capitulation-scan] Auto universe produced 0 symbols; falling back to exchange universe");
      }
    }

    const showRotationShortlist = process.argv.includes("--rotation");
    const showFastPumpShortlist = process.argv.includes("--fast-pump");
    const shouldSendTelegram = process.argv.includes("--send-telegram");
    const previousSnapshot = await loadScanSnapshot();

    console.log("[capitulation-scan] Starting bounce scan on Bitunix...");
    const startAt = Date.now();

    const result = await scanCapitulationBounces();
      const previousRankingState = await loadRankingState();
      const suiteSymbols = Array.from(new Set([
      ...scanUniverseSymbols,
      ...result.bounceZoneCandidates.map((c) => c.symbol),
      ...result.nearBounceZone.map((c) => c.symbol),
      ...result.ultraCapitulationCandidates.map((c) => c.symbol),
    ]));
    const timeframeSuites = await buildMultiTimeframeSuites(suiteSymbols);
      const stability = buildStableRankings(result, previousRankingState, timeframeSuites);
    await saveRankingState(stability.state);
    const latestSnapshot = buildScanSnapshot(result, stability.ranked);
    await saveScanSnapshot(latestSnapshot);
    const elapsedMs = Date.now() - startAt;

    if (previousSnapshot) {
      console.log(
        `[capitulation-scan] Previous snapshot loaded (${previousSnapshot.scannedAt}) with ${previousSnapshot.leaderboard.length} tracked candidates`
      );
    } else {
      console.log("[capitulation-scan] No previous snapshot found (first persisted run)");
    }

    console.log(
      `[capitulation-scan] ✅ Scan completed in ${(elapsedMs / 1000).toFixed(1)}s`
    );
    console.log(
      `[capitulation-scan] Found ${result.bounceZoneCandidates.length} in CAPITULATION ZONE (5-10% above ATL)`
    );
    console.log(
      `[capitulation-scan] Found ${result.nearBounceZone.length} in NEAR ZONE (3-15% above ATL)`
    );
    console.log(
      `[capitulation-scan] Found ${result.ultraCapitulationCandidates.length} in ULTRA CAPITULATION (0-3% above ATL)`
    );

    // Log bounce zone tokens to terminal
    if (result.bounceZoneCandidates.length > 0) {
      console.log("\n🎯 CAPITULATION ZONE (5-10% above ATL):");
      console.log("  " + "#".padEnd(4) + "Symbol".padEnd(14) + "Dist".padEnd(8) + "RSI".padEnd(6) + "CS".padEnd(5) + "RS".padEnd(5) + "AS".padEnd(5) + "PP".padEnd(5) + "OBS".padEnd(6) + "ΔS".padEnd(7) + "ΔVol".padEnd(8) + "ΔOI".padEnd(8) + "Verdict".padEnd(13) + "Align".padEnd(18) + "TFs(15m/1h/4h/6h/12h/1d/1w)".padEnd(38) + "Stage");
      for (const [idx, candidate] of result.bounceZoneCandidates.slice(0, 20).entries()) {
        const suite = timeframeSuites.get(candidate.symbol) ?? createEmptyMultiTimeframeSuite();
        const icon = candidate.rsi14 < 30 ? "🔥" : "⚠️";
        const deltaScoreStr = `${candidate.deltaScore24h >= 0 ? "+" : ""}${candidate.deltaScore24h.toFixed(1)}`;
        const deltaVolStr = `${candidate.deltaVolumePct >= 0 ? "+" : ""}${(candidate.deltaVolumePct * 100).toFixed(0)}%`;
        const deltaOiStr = candidate.deltaOpenInterestPct == null
          ? "n/a"
          : `${candidate.deltaOpenInterestPct >= 0 ? "+" : ""}${(candidate.deltaOpenInterestPct * 100).toFixed(0)}%`;
        console.log(
          `${String(idx + 1).padStart(3)} `.padEnd(4) +
          `${icon} ${candidate.symbol.padEnd(12)} +${candidate.distanceFromZeroFib.toFixed(1)}%`.padEnd(24) +
          `RSI ${candidate.rsi14.toFixed(0)}`.padEnd(9) +
          `CS:${candidate.capitulationScore}`.padEnd(8) +
          `RS:${candidate.recoveryScore}`.padEnd(8) +
          `AS:${candidate.accumulationScore}`.padEnd(8) +
          `PP:${candidate.prePumpScore}`.padEnd(8) +
          `${candidate.obsScore}`.padEnd(6) +
          deltaScoreStr.padEnd(7) +
          deltaVolStr.padEnd(8) +
          deltaOiStr.padEnd(8) +
          `${suite.bullishVerdict}`.padEnd(13) +
          `${suite.longAlignment}`.padEnd(18) +
          `${formatSuiteCompact(suite)}`.padEnd(38) +
          candidate.stage
        );
      }
    }

    // Log near zone tokens to terminal
    if (result.nearBounceZone.length > 0) {
      console.log("\n👀 NEAR ZONE (3-15% above ATL):");
      console.log("  " + "#".padEnd(4) + "Symbol".padEnd(14) + "Dist".padEnd(8) + "RSI".padEnd(6) + "CS".padEnd(5) + "RS".padEnd(5) + "AS".padEnd(5) + "PP".padEnd(5) + "OBS".padEnd(6) + "ABS".padEnd(6) + "Prio".padEnd(7) + "Read".padEnd(7) + "Act".padEnd(10) + "Verdict".padEnd(13) + "Align".padEnd(18) + "TFs(15m/1h/4h/6h/12h/1d/1w)".padEnd(38) + "FLS".padEnd(6) + "Ask$".padEnd(10) + "Regime".padEnd(18) + "ΔS".padEnd(7) + "ΔVol".padEnd(8) + "Spike".padEnd(8) + "ΔOI".padEnd(8) + "Fund%".padEnd(10) + "Stage");
      for (const [idx, candidate] of result.nearBounceZone.slice(0, 20).entries()) {
        const suite = timeframeSuites.get(candidate.symbol) ?? createEmptyMultiTimeframeSuite();
        const stageIcon = candidate.stage === "PRE_PUMP" ? "🚀" : candidate.stage === "ACCUMULATION" ? "🌱" : candidate.stage === "RECOVERING_CAPITULATION" ? "♻️" : candidate.stage === "CAPITULATION" ? "🧊" : "";
        const fundStr = candidate.fundingRate !== 0
          ? (candidate.fundingRate * 100).toFixed(4) + "%"
          : "n/a";
        const nearPriority = computeNearZoneBuyPriority(candidate, suite);
        const readiness = computeReadinessScore(candidate, suite);
        const deltaScoreStr = `${candidate.deltaScore24h >= 0 ? "+" : ""}${candidate.deltaScore24h.toFixed(1)}`;
        const deltaVolStr = `${candidate.deltaVolumePct >= 0 ? "+" : ""}${(candidate.deltaVolumePct * 100).toFixed(0)}%`;
        const deltaOiStr = candidate.deltaOpenInterestPct == null
          ? "n/a"
          : `${candidate.deltaOpenInterestPct >= 0 ? "+" : ""}${(candidate.deltaOpenInterestPct * 100).toFixed(0)}%`;
        const spikeStr = `${candidate.volumeSpikeX.toFixed(2)}x`;
        const flsStr = candidate.finalLiquidityScore == null ? "n/a" : `${candidate.finalLiquidityScore.toFixed(0)}`;
        const askDepthStr = candidate.askDepthUsd == null ? "n/a" : `$${Math.round(candidate.askDepthUsd).toLocaleString()}`;
        const regimeStr = candidate.liquidityRegime ?? "n/a";
        console.log(
          `${String(idx + 1).padStart(3)} `.padEnd(4) +
          `${stageIcon} ${candidate.symbol.padEnd(12)} +${candidate.distanceFromZeroFib.toFixed(1)}%`.padEnd(26) +
          `RSI ${candidate.rsi14.toFixed(0)}`.padEnd(9) +
          `CS:${candidate.capitulationScore}`.padEnd(8) +
          `RS:${candidate.recoveryScore}`.padEnd(8) +
          `AS:${candidate.accumulationScore}`.padEnd(8) +
          `PP:${candidate.prePumpScore}`.padEnd(8) +
          `${candidate.obsScore}`.padEnd(6) +
          `${candidate.absorptionScore}`.padEnd(6) +
          `${nearPriority.toFixed(1)}`.padEnd(7) +
          `${readiness.toFixed(1)}`.padEnd(7) +
          `${candidate.actionRecommendation}(${candidate.actionConfidencePct}%)`.padEnd(10) +
          `${suite.bullishVerdict}`.padEnd(13) +
          `${suite.longAlignment}`.padEnd(18) +
          `${formatSuiteCompact(suite)}`.padEnd(38) +
          flsStr.padEnd(6) +
          askDepthStr.padEnd(10) +
          regimeStr.padEnd(18) +
          deltaScoreStr.padEnd(7) +
          deltaVolStr.padEnd(8) +
          spikeStr.padEnd(8) +
          deltaOiStr.padEnd(8) +
          fundStr.padEnd(10) +
          candidate.stage
        );
      }
    }

    // Log ultra capitulation tokens to terminal
    if (result.ultraCapitulationCandidates.length > 0) {
      console.log("\n🧊 ULTRA CAPITULATION (0-3% above ATL):");
      console.log("  " + "#".padEnd(4) + "Symbol".padEnd(14) + "Dist".padEnd(8) + "RSI".padEnd(6) + "CS".padEnd(5) + "RS".padEnd(5) + "AS".padEnd(5) + "OBS".padEnd(6) + "Fund%".padEnd(10) + "Verdict".padEnd(13) + "Align".padEnd(18) + "TFs(15m/1h/4h/6h/12h/1d/1w)".padEnd(38) + "Stage");
      for (const [idx, candidate] of result.ultraCapitulationCandidates.slice(0, 20).entries()) {
        const suite = timeframeSuites.get(candidate.symbol) ?? createEmptyMultiTimeframeSuite();
        const stageIcon = candidate.stage === "PRE_PUMP" ? "🚀" : candidate.stage === "ACCUMULATION" ? "🌱" : candidate.stage === "RECOVERING_CAPITULATION" ? "♻️" : candidate.stage === "DEAD_CAPITULATION" ? "💀" : "";
        const fundStr = candidate.fundingRate !== 0
          ? (candidate.fundingRate * 100).toFixed(4) + "%"
          : "n/a";
        console.log(
          `${String(idx + 1).padStart(3)} `.padEnd(4) +
          `${stageIcon} ${candidate.symbol.padEnd(12)} +${candidate.distanceFromZeroFib.toFixed(1)}%`.padEnd(26) +
          `RSI ${candidate.rsi14.toFixed(0)}`.padEnd(9) +
          `CS:${candidate.capitulationScore}`.padEnd(8) +
          `RS:${candidate.recoveryScore}`.padEnd(8) +
          `AS:${candidate.accumulationScore}`.padEnd(8) +
          `${candidate.obsScore}`.padEnd(6) +
          fundStr.padEnd(12) +
          `${suite.bullishVerdict}`.padEnd(13) +
          `${suite.longAlignment}`.padEnd(18) +
          `${formatSuiteCompact(suite)}`.padEnd(38) +
          candidate.stage
        );
      }
    }

    // Early-stage buy ordering: near-zone focus with breakout-readiness overlay.
    await printNearZonePriority(stability.ranked, timeframeSuites);
    // Explicit burst timing board with GO/NO-GO gating.
    await printBurstReadinessBoard(result, timeframeSuites);
    // Bottom-zone short setups: downtrend + fresh daily SMA break + daily SRSI cross-down.
    await printBottomShortSetups(result, timeframeSuites);
    // Overextended-drop board: names stretched above trend with bearish rollover risk.
    await printOverextendedDropSetups(suiteSymbols, timeframeSuites);
    // Weekly capitulation reversals: weekly RSI <38 + stoch cross-up (the SXT-class explosive movers).
    await printWeeklyCapitulationSetups(suiteSymbols);
    // Reflex-squeeze radar for deeply down names close to ATL with active participation.
    printExtremeSnapbackWatchlist(result);
    // Keep recently displaced names visible for trader context.
    printRecentlyDroppedCandidates(stability.recentlyDropped);

    // Ordered ranking for the next run
    const stableTop = stability.ranked.slice(0, 20);
    if (stableTop.length > 0) {
      console.log("\n🚀 HIGH CONVICTION NEXT-RUN CANDIDATES (STABLE):");
      console.log("  " + "#".padEnd(4) + "Symbol".padEnd(14) + "BP".padEnd(5) + "Conf".padEnd(7) + "RS".padEnd(5) + "AS".padEnd(5) + "PP".padEnd(5) + "OBS".padEnd(6) + "ABS".padEnd(6) + "PCS".padEnd(6) + "SDS".padEnd(6) + "AWS".padEnd(6) + "BWS".padEnd(6) + "Regime".padEnd(22) + "Div".padEnd(8) + "Life".padEnd(12) + "Act".padEnd(10) + "Verdict".padEnd(13) + "Align".padEnd(18) + "TFs(15m/1h/4h/6h/12h/1d/1w)".padEnd(38) + "Age".padEnd(6) + "Fund%".padEnd(10) + "Dist".padEnd(8) + "ΔS".padEnd(7) + "ΔVol".padEnd(8) + "ΔOI".padEnd(8) + "Mtm".padEnd(6) + "Risk".padEnd(6) + "Cycle");
      for (const [idx, row] of stableTop.entries()) {
        const candidate = row.candidate;
        const suite = timeframeSuites.get(candidate.symbol) ?? createEmptyMultiTimeframeSuite();
        const fundStr = candidate.fundingRate !== 0
          ? (candidate.fundingRate * 100).toFixed(4) + "%"
          : "n/a";
        const deltaScoreStr = `${candidate.deltaScore24h >= 0 ? "+" : ""}${candidate.deltaScore24h.toFixed(1)}`;
        const deltaVolStr = `${candidate.deltaVolumePct >= 0 ? "+" : ""}${(candidate.deltaVolumePct * 100).toFixed(0)}%`;
        const deltaOiStr = candidate.deltaOpenInterestPct == null
          ? "n/a"
          : `${candidate.deltaOpenInterestPct >= 0 ? "+" : ""}${(candidate.deltaOpenInterestPct * 100).toFixed(0)}%`;
        console.log(
          `${String(idx + 1).padStart(3)} `.padEnd(4) +
          `${candidate.symbol.padEnd(13)}`.padEnd(14) +
          `${candidate.burstProbabilityScore}`.padEnd(5) +
          `${candidate.confluenceScore}/11`.padEnd(7) +
          `${candidate.recoveryScore}`.padEnd(5) +
          `${candidate.accumulationScore}`.padEnd(5) +
          `${candidate.prePumpScore}`.padEnd(5) +
          `${candidate.obsScore}`.padEnd(6) +
          `${candidate.absorptionScore}`.padEnd(6) +
          `${candidate.priceConfirmationScore}`.padEnd(6) +
          `${candidate.supportDefenseScore}`.padEnd(6) +
          `${candidate.askWallScore}`.padEnd(6) +
          `${candidate.bidWallScore}`.padEnd(6) +
          `${candidate.liquidityRegime}`.padEnd(22) +
          `${candidate.liquidityDivergence}`.padEnd(8) +
          `${candidate.lifecycleAction}`.padEnd(12) +
          `${candidate.actionRecommendation}(${candidate.actionConfidencePct}%)`.padEnd(10) +
          `${suite.bullishVerdict}`.padEnd(13) +
          `${suite.longAlignment}`.padEnd(18) +
          `${formatSuiteCompact(suite)}`.padEnd(38) +
          `${candidate.signalAgeHours.toFixed(0)}h`.padEnd(6) +
          fundStr.padEnd(10) +
          `+${candidate.distanceFromZeroFib.toFixed(1)}%`.padEnd(8) +
          deltaScoreStr.padEnd(7) +
          deltaVolStr.padEnd(8) +
          deltaOiStr.padEnd(8) +
          `${candidate.momentumRank}`.padEnd(6) +
          `${candidate.riskRank}`.padEnd(6) +
          candidate.marketCycle
        );
        if (row.prev) {
          console.log(`     prev: rank #${row.prev.rank}, priority ${row.prev.priority.toFixed(1)}, bp ${row.prev.burstProbabilityScore.toFixed(0)}, readiness ${row.prev.readiness.toFixed(1)}, life ${row.prev.lifecycleAction}, cycle ${row.prev.marketCycle}`);
        }
        console.log(`     deltas: prio ${formatDelta(row.priority, row.prev?.priority)} | bp ${formatDelta(candidate.burstProbabilityScore, row.prev?.burstProbabilityScore, 0)} | read ${formatDelta(row.readiness, row.prev?.readiness)} | abs ${formatDelta(candidate.absorptionScore, row.prev?.abs, 0)} | rs ${formatDelta(candidate.recoveryScore, row.prev?.rs, 0)} | as ${formatDelta(candidate.accumulationScore, row.prev?.as, 0)} | pp ${formatDelta(candidate.prePumpScore, row.prev?.pp, 0)} | obs ${formatDelta(candidate.obsScore, row.prev?.obs, 0)} | dist ${formatDelta(candidate.distanceFromZeroFib, row.prev?.distance)}`);
        console.log(`     reason: ${candidate.actionReason}`);
        if (candidate.actionRecommendation === "WAIT" && candidate.actionMissingConditions.length > 0) {
          console.log("     What is preventing BUY?");
          console.log("     Missing Conditions:");
          for (const miss of candidate.actionMissingConditions.slice(0, 5)) {
            console.log(`       - ${miss}`);
          }
          console.log(`     Primary blocker: ${candidate.actionPrimaryBlocker}`);
        }
      }
    }

    if (showRotationShortlist) {
      printRotationShortlist(result, timeframeSuites);
    }

    if (showFastPumpShortlist) {
      await printFastPumpShortlist(result);
    }

    if (shouldSendTelegram) {
      // Optional for ad-hoc manual scans. Automated monitor/process handles regular alerts.
      const telegramMessage = formatCapitulationForTelegram(result);
      await sendTelegramMessage(telegramMessage);
      console.log("\n[capitulation-scan] ✅ Sent to Telegram successfully");
    } else {
      console.log("\n[capitulation-scan] ℹ️ Telegram send skipped (manual mode)");
      console.log("[capitulation-scan] Use --send-telegram to enable send for this run");
    }

    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[capitulation-scan] ❌ Error: ${message}`);
    console.error(error);
    process.exit(1);
  }
}

main();
