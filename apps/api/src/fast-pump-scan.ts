import type { CapitulationBounceCandidate, CapitulationScanResult } from "./fibonacci-capitulation-scan.js";
import { fetchOrderBookExecutionRead, fetchPerpContexts, fetchRecentCandles } from "./bitunix-service.js";
import { calculateLatestEma, calculateLatestRsi, calculateStochasticRsi } from "./rsi.js";
import { promises as fs } from "node:fs";
import path from "node:path";

export type FastPumpWindow = "TODAY" | "TOMORROW" | "2-3D";
export type FastPumpPotential = "20%+" | "30%+" | "40%+";

export interface FastPumpCandidate {
  symbol: string;
  score: number;
  entryGap: number;
  isShortlisted: boolean;
  deltaScore: number;
  window: FastPumpWindow;
  potential: FastPumpPotential;
  dailyStage: CapitulationBounceCandidate["stage"];
  distanceFromZeroFib: number;
  dailyDeadZoneScore: number;
  dailyPrePumpScore: number;
  dailyBreakoutScore: number;
  fundingRate: number;
  orderbookImbalance: number;
  orderbookImbalance1m: number;
  orderbookImbalance5m: number;
  orderbookImbalance15m: number;
  obsScore: number;
  absorptionScore: number;
  liquidityRegime: string;
  smoothedOrderbookImbalance: number;
  deltaOrderbookImbalance: number;
  spreadPct: number;
  oneHourChangePct: number;
  fourHourChangePct: number;
  oneHourRsi: number;
  fourHourRsi: number;
  oneHourStochRsi: number;
  fourHourStochRsi: number;
  oneHourStochK: number;
  oneHourStochD: number;
  oneHourPrevStochK: number;
  fourHourStochK: number;
  fourHourStochD: number;
  fourHourPrevStochK: number;
  srsiConsolidationRisk: boolean;
  oneHourVolumeBurst: number;
  smoothedOneHourVolumeBurst: number;
  deltaOneHourVolumeBurst: number;
  fourHourVolumeBurst: number;
  rotationBreadthPct: number;
  leaderImpulseScore: number;
  laggardCatchupScore: number;
  rotationTriggerScore: number;
  rotationMode: "LEADER" | "FOLLOWER" | "EARLY_CATCHUP" | "NONE";
  reasons: string[];
}

export interface FastPumpScanResult {
  shortlisted: FastPumpCandidate[];
  nearMisses: FastPumpCandidate[];
  preBoomAlert: {
    active: boolean;
    transition: "NONE" | "FLAT_TO_RISING" | "RISING_TO_SURGING" | "FLAT_TO_SURGING";
    confirmed: FastPumpCandidate[];
  };
  marketRotation: {
    breadthPct: number;
    accelerationPct: number;
    dominantMode: "BROAD_ROTATION" | "LEADER_DRIVEN" | "EARLY_ROTATION" | "MUTED";
    breadthDelta24h: number;
    breadthDelta72h: number;
    accelerationDelta24h: number;
    accelerationDelta72h: number;
    spikeScore: number;
    spikeState: "SURGING" | "RISING" | "FLAT";
  };
}

type RotationHistoryPoint = {
  timestamp: string;
  breadthPct: number;
  accelerationPct: number;
  dominantMode: "BROAD_ROTATION" | "LEADER_DRIVEN" | "EARLY_ROTATION" | "MUTED";
  spikeScore?: number;
  spikeState?: "SURGING" | "RISING" | "FLAT";
};

type FastPumpStateEntry = {
  lastScore: number;
  lastOb: number;
  lastVb1h: number;
  smoothedOb: number;
  smoothedVb1h: number;
  inList: boolean;
  updatedAt: string;
};

type FastPumpState = {
  version: 2;
  symbols: Record<string, FastPumpStateEntry>;
  rotationHistory: RotationHistoryPoint[];
};

const FAST_PUMP_STATE_PATH = process.env.FAST_PUMP_STATE_PATH
  ? path.resolve(process.env.FAST_PUMP_STATE_PATH)
  : path.resolve(process.cwd(), "data", "fast-pump-state.json");

const ENTER_THRESHOLD = 55;
const STAY_THRESHOLD = 45;
const SMOOTHING_ALPHA = 0.4;

function safeNumber(value: number, fallback: number = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function smoothValue(previousSmoothed: number | undefined, current: number): number {
  if (!Number.isFinite(previousSmoothed as number)) {
    return current;
  }
  return (previousSmoothed as number) * (1 - SMOOTHING_ALPHA) + current * SMOOTHING_ALPHA;
}

async function loadFastPumpState(): Promise<FastPumpState> {
  try {
    const raw = await fs.readFile(FAST_PUMP_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<FastPumpState> & { version?: number };
    if (!parsed || typeof parsed.symbols !== "object" || parsed.symbols == null) {
      return { version: 2, symbols: {}, rotationHistory: [] };
    }

    const rotationHistory = Array.isArray(parsed.rotationHistory)
      ? parsed.rotationHistory.filter((item) =>
        item
        && typeof item.timestamp === "string"
        && Number.isFinite(item.breadthPct)
        && Number.isFinite(item.accelerationPct)
        && typeof item.dominantMode === "string"
      ) as RotationHistoryPoint[]
      : [];

    return {
      version: 2,
      symbols: parsed.symbols as Record<string, FastPumpStateEntry>,
      rotationHistory,
    };
  } catch {
    return { version: 2, symbols: {}, rotationHistory: [] };
  }
}

async function saveFastPumpState(state: FastPumpState): Promise<void> {
  await fs.mkdir(path.dirname(FAST_PUMP_STATE_PATH), { recursive: true });
  await fs.writeFile(FAST_PUMP_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function pctChange(current: number, previous: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
    return 0;
  }
  return ((current - previous) / previous) * 100;
}

function avg(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits: number = 1): number {
  return Number(value.toFixed(digits));
}

function pickHistoryAnchor(history: RotationHistoryPoint[], nowMs: number, lookbackMs: number): RotationHistoryPoint | null {
  const target = nowMs - lookbackMs;
  let best: RotationHistoryPoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const item of history) {
    const ts = new Date(item.timestamp).getTime();
    if (!Number.isFinite(ts)) {
      continue;
    }
    const distance = Math.abs(ts - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  }

  return best;
}

function enrichMarketRotation(
  base: Pick<FastPumpScanResult["marketRotation"], "breadthPct" | "accelerationPct" | "dominantMode">,
  rotationHistory: RotationHistoryPoint[]
): FastPumpScanResult["marketRotation"] {
  const nowMs = Date.now();
  const anchor24h = pickHistoryAnchor(rotationHistory, nowMs, 24 * 60 * 60 * 1000);
  const anchor72h = pickHistoryAnchor(rotationHistory, nowMs, 72 * 60 * 60 * 1000);

  const breadthDelta24h = round(base.breadthPct - (anchor24h?.breadthPct ?? base.breadthPct));
  const breadthDelta72h = round(base.breadthPct - (anchor72h?.breadthPct ?? base.breadthPct));
  const accelerationDelta24h = round(base.accelerationPct - (anchor24h?.accelerationPct ?? base.accelerationPct));
  const accelerationDelta72h = round(base.accelerationPct - (anchor72h?.accelerationPct ?? base.accelerationPct));

  const spikeScore = round(clamp(
    base.breadthPct * 0.35
    + base.accelerationPct * 0.2
    + Math.max(0, breadthDelta24h) * 0.9
    + Math.max(0, accelerationDelta24h) * 0.7
    + Math.max(0, breadthDelta72h) * 0.45,
    0,
    100
  ));

  const spikeState: FastPumpScanResult["marketRotation"]["spikeState"] =
    spikeScore >= 68 || (breadthDelta24h >= 10 && accelerationDelta24h >= 8)
      ? "SURGING"
      : spikeScore >= 48 || breadthDelta24h >= 5
      ? "RISING"
      : "FLAT";

  return {
    ...base,
    breadthDelta24h,
    breadthDelta72h,
    accelerationDelta24h,
    accelerationDelta72h,
    spikeScore,
    spikeState,
  };
}

function spikeStateRank(state: "SURGING" | "RISING" | "FLAT"): number {
  if (state === "SURGING") {
    return 2;
  }
  if (state === "RISING") {
    return 1;
  }
  return 0;
}

function resolveSpikeTransition(
  previous: "SURGING" | "RISING" | "FLAT" | null,
  current: "SURGING" | "RISING" | "FLAT"
): FastPumpScanResult["preBoomAlert"]["transition"] {
  if (!previous) {
    return "NONE";
  }

  if (previous === "FLAT" && current === "RISING") {
    return "FLAT_TO_RISING";
  }
  if (previous === "RISING" && current === "SURGING") {
    return "RISING_TO_SURGING";
  }
  if (previous === "FLAT" && current === "SURGING") {
    return "FLAT_TO_SURGING";
  }
  return "NONE";
}

function percentileRank(values: number[], value: number): number {
  if (values.length <= 1) {
    return 0.5;
  }

  const sorted = [...values].sort((a, b) => a - b);
  let count = 0;
  for (const item of sorted) {
    if (item <= value) {
      count += 1;
    }
  }
  return count / sorted.length;
}

type LiquidityTier = "MEGA" | "LARGE" | "MID" | "SMALL";

function classifyLiquidityTier(dayNtlVolume: number): LiquidityTier {
  if (dayNtlVolume >= 100) {
    return "MEGA";
  }
  if (dayNtlVolume >= 30) {
    return "LARGE";
  }
  if (dayNtlVolume >= 5) {
    return "MID";
  }
  return "SMALL";
}

type CandidateWithVolume = {
  symbol: string;
  dayNtlVolume: number;
  score: number;
};

function computeLiquidityTierScores(
  candidates: CandidateWithVolume[]
): Map<string, { tier: LiquidityTier; percentile: number; score: number }> {
  const result = new Map<string, { tier: LiquidityTier; percentile: number; score: number }>();

  // Group by tier
  const byTier: Record<LiquidityTier, CandidateWithVolume[]> = {
    MEGA: [],
    LARGE: [],
    MID: [],
    SMALL: [],
  };

  for (const candidate of candidates) {
    const tier = classifyLiquidityTier(candidate.dayNtlVolume);
    byTier[tier].push(candidate);
  }

  // Compute percentile and score within each tier
  for (const [tier, items] of Object.entries(byTier) as Array<[LiquidityTier, CandidateWithVolume[]]>) {
    if (items.length === 0) {
      continue;
    }

    const volumes = items.map((item) => item.dayNtlVolume);

    for (const candidate of items) {
      const percentile = percentileRank(volumes, candidate.dayNtlVolume);

      // Tier bonus based on percentile rank within tier
      // Top 10% of tier: +12, Top 25%: +8, Top 50%: +4, else: 0
      let tierBonus = 0;
      if (percentile >= 0.9) {
        tierBonus = 12;
      } else if (percentile >= 0.75) {
        tierBonus = 8;
      } else if (percentile >= 0.5) {
        tierBonus = 4;
      }

      result.set(candidate.symbol, {
        tier,
        percentile: Number(percentile.toFixed(3)),
        score: tierBonus,
      });
    }
  }

  return result;
}

function deriveRotationSignals(candidates: FastPumpCandidate[]): {
  enriched: FastPumpCandidate[];
  marketRotation: Pick<FastPumpScanResult["marketRotation"], "breadthPct" | "accelerationPct" | "dominantMode">;
} {
  if (candidates.length === 0) {
    return {
      enriched: candidates,
      marketRotation: {
        breadthPct: 0,
        accelerationPct: 0,
        dominantMode: "MUTED",
      },
    };
  }

  const breadthCount = candidates.filter(
    (item) => item.oneHourChangePct >= 0.75 && item.oneHourVolumeBurst >= 1.05
  ).length;
  const accelerationCount = candidates.filter(
    (item) => item.oneHourChangePct > 0 && item.deltaOneHourVolumeBurst > 0
  ).length;

  const breadthPct = Number(((breadthCount / candidates.length) * 100).toFixed(1));
  const accelerationPct = Number(((accelerationCount / candidates.length) * 100).toFixed(1));

  const impulseValues = candidates.map((item) =>
    item.oneHourChangePct * 0.45
    + item.fourHourChangePct * 0.2
    + (item.oneHourVolumeBurst - 1) * 18
    + item.smoothedOrderbookImbalance * 12
    + item.obsScore * 0.05
  );

  const enriched = candidates.map((item, index) => {
    const impulseRaw = impulseValues[index];
    const leaderImpulseScore = Number((percentileRank(impulseValues, impulseRaw) * 100).toFixed(1));

    const laggardCatchupScore = Number(clamp(
      (item.fourHourChangePct >= 0.8 && item.fourHourChangePct <= 8 ? 28 : 0)
      + (item.oneHourChangePct >= 0.2 && item.oneHourChangePct <= 3.2 ? 24 : 0)
      + (item.deltaOneHourVolumeBurst > 0 ? 20 : 0)
      + (item.oneHourVolumeBurst >= 1.0 && item.oneHourVolumeBurst <= 2.2 ? 14 : 0)
      + (item.smoothedOrderbookImbalance >= 0.08 ? 14 : 0),
      0,
      100
    ).toFixed(1));

    const rotationTriggerScore = Number(clamp(
      breadthPct * 0.35
      + accelerationPct * 0.15
      + leaderImpulseScore * 0.3
      + laggardCatchupScore * 0.1
      + item.obsScore * 0.1,
      0,
      100
    ).toFixed(1));

    let rotationMode: FastPumpCandidate["rotationMode"] = "NONE";
    if (leaderImpulseScore >= 75 && item.oneHourChangePct >= 1.8) {
      rotationMode = "LEADER";
    } else if (laggardCatchupScore >= 70 && item.oneHourChangePct > 0) {
      rotationMode = "EARLY_CATCHUP";
    } else if (leaderImpulseScore >= 55 && breadthPct >= 35) {
      rotationMode = "FOLLOWER";
    }

    const reasons = [...item.reasons];
    if (rotationTriggerScore >= 70) {
      reasons.push("cross-token rotation trigger is active");
    } else if (laggardCatchupScore >= 70) {
      reasons.push("laggard catch-up profile forming");
    }

    return {
      ...item,
      reasons,
      rotationBreadthPct: breadthPct,
      leaderImpulseScore,
      laggardCatchupScore,
      rotationTriggerScore,
      rotationMode,
    };
  });

  const leaderDominance = enriched.filter((item) => item.rotationMode === "LEADER").length;
  const earlyCatchupCount = enriched.filter((item) => item.rotationMode === "EARLY_CATCHUP").length;

  const dominantMode: FastPumpScanResult["marketRotation"]["dominantMode"] =
    breadthPct >= 45
      ? "BROAD_ROTATION"
      : leaderDominance >= 2
      ? "LEADER_DRIVEN"
      : earlyCatchupCount >= 2
      ? "EARLY_ROTATION"
      : "MUTED";

  return {
    enriched,
    marketRotation: {
      breadthPct,
      accelerationPct,
      dominantMode,
    },
  };
}

function volumeBurstRatio(volumes: number[], recentBars: number, baselineBars: number): number {
  if (volumes.length < recentBars + baselineBars) {
    return 0;
  }
  const recent = avg(volumes.slice(-recentBars));
  const baseline = avg(volumes.slice(-(recentBars + baselineBars), -recentBars));
  if (baseline <= 0) {
    return 0;
  }
  return recent / baseline;
}

function classifyWindow(score: number, oneHourChangePct: number, fourHourChangePct: number, oneHourVolumeBurst: number): FastPumpWindow {
  if (score >= 78 || (score >= 72 && oneHourChangePct >= 3 && oneHourVolumeBurst >= 1.8)) {
    return "TODAY";
  }
  if (score >= 62 || fourHourChangePct >= 8) {
    return "TOMORROW";
  }
  return "2-3D";
}

function classifyPotential(score: number, fundingRate: number, oneHourVolumeBurst: number): FastPumpPotential {
  if (score >= 82 || (fundingRate < -0.0003 && oneHourVolumeBurst >= 2.2)) {
    return "40%+";
  }
  if (score >= 68) {
    return "30%+";
  }
  return "20%+";
}

function scoreFastPumpCandidate(input: {
  base: CapitulationBounceCandidate;
  previousState?: FastPumpStateEntry;
  fundingRate: number;
  imbalance: number;
  imbalance1m: number;
  imbalance5m: number;
  imbalance15m: number;
  obsScore: number;
  absorptionScore: number;
  liquidityRegime: string;
  smoothedImbalance: number;
  spreadPct: number;
  oneHourChangePct: number;
  fourHourChangePct: number;
  oneHourRsi: number;
  fourHourRsi: number;
  oneHourStochRsi: number;
  fourHourStochRsi: number;
  oneHourStochK: number;
  oneHourStochD: number;
  oneHourPrevStochK: number;
  fourHourStochK: number;
  fourHourStochD: number;
  fourHourPrevStochK: number;
  oneHourVolumeBurst: number;
  smoothedOneHourVolumeBurst: number;
  fourHourVolumeBurst: number;
  oneHourAboveEma20: boolean;
  fourHourAboveEma20: boolean;
  dayNtlVolume: number;
}): FastPumpCandidate | null {
  const {
    base,
    previousState,
    fundingRate,
    imbalance,
    imbalance1m,
    imbalance5m,
    imbalance15m,
    obsScore,
    absorptionScore,
    liquidityRegime,
    smoothedImbalance,
    spreadPct,
    oneHourChangePct,
    fourHourChangePct,
    oneHourRsi,
    fourHourRsi,
    oneHourStochRsi,
    fourHourStochRsi,
    oneHourStochK,
    oneHourStochD,
    oneHourPrevStochK,
    fourHourStochK,
    fourHourStochD,
    fourHourPrevStochK,
    oneHourVolumeBurst,
    smoothedOneHourVolumeBurst,
    fourHourVolumeBurst,
    oneHourAboveEma20,
    fourHourAboveEma20,
    dayNtlVolume,
  } = input;

  let score = 0;
  const reasons: string[] = [];

  if (base.stage === "PRE_PUMP") {
    score += 24;
    reasons.push("daily stage pre-pump");
  } else if (base.stage === "ACCUMULATION") {
    score += 16;
    reasons.push("daily stage accumulation");
  } else if (base.stage === "RECOVERY" || base.stage === "RECOVERING_CAPITULATION") {
    score += 10;
    reasons.push("daily stage recovery");
  } else if (base.stage === "CAPITULATION") {
    score += 6;
  }

  if (base.prePumpScore >= 50) {
    score += 18;
    reasons.push("daily pre-pump score high");
  } else if (base.prePumpScore >= 35) {
    score += 12;
    reasons.push("daily pre-pump score improving");
  } else if (base.prePumpScore >= 20) {
    score += 7;
  }

  if (base.deadZoneScore >= 60) {
    score += 10;
    reasons.push("daily dead-zone compression strong");
  } else if (base.deadZoneScore >= 45) {
    score += 5;
  }

  if (oneHourChangePct >= 2 && oneHourChangePct <= 9) {
    score += 12;
    reasons.push("1h momentum started");
  } else if (oneHourChangePct > 9) {
    score -= 8;
  }

  if (fourHourChangePct >= 4 && fourHourChangePct <= 18) {
    score += 12;
    reasons.push("4h momentum expanding");
  } else if (fourHourChangePct > 18) {
    score -= 10;
  }

  if (smoothedOneHourVolumeBurst >= 2.0) {
    score += 15;
    reasons.push("1h volume burst");
  } else if (smoothedOneHourVolumeBurst >= 1.4) {
    score += 8;
  }

  if (fourHourVolumeBurst >= 1.8) {
    score += 10;
    reasons.push("4h volume expansion");
  } else if (fourHourVolumeBurst >= 1.3) {
    score += 5;
  }

  if (oneHourRsi >= 52 && oneHourRsi <= 68) {
    score += 8;
    reasons.push("1h RSI in ignition zone");
  } else if (oneHourRsi > 76) {
    score -= 8;
  }

  if (fourHourRsi >= 48 && fourHourRsi <= 64) {
    score += 8;
  } else if (fourHourRsi > 72) {
    score -= 6;
  }

  const oneHourSrsiOversold = oneHourStochRsi < 20;
  const fourHourSrsiOversold = fourHourStochRsi < 20;
  const oneHourCurlingUp = oneHourStochK > oneHourStochD && oneHourStochK > oneHourPrevStochK;
  const fourHourCurlingUp = fourHourStochK > fourHourStochD && fourHourStochK > fourHourPrevStochK;
  const srsiConsolidationRisk = oneHourSrsiOversold && fourHourSrsiOversold && !(oneHourCurlingUp || fourHourCurlingUp);

  if (srsiConsolidationRisk) {
    score -= 10;
    reasons.push("SRSI <20 on 1h/4h with no curl-up (consolidation risk)");
  } else if (oneHourSrsiOversold && fourHourSrsiOversold) {
    reasons.push("SRSI <20 on 1h/4h but curl-up is starting");
  }

  if (oneHourAboveEma20) {
    score += 6;
  }
  if (fourHourAboveEma20) {
    score += 6;
    reasons.push("price above 4h EMA20");
  }

  if (smoothedImbalance >= 0.2) {
    score += 14;
    reasons.push("order-book bid imbalance");
  } else if (smoothedImbalance >= 0.1) {
    score += 8;
  } else if (smoothedImbalance <= -0.15) {
    score -= 10;
  }

  if (spreadPct > 0 && spreadPct <= 0.12) {
    score += 4;
  } else if (spreadPct > 0.35) {
    score -= 6;
  }

  if (fundingRate <= -0.0003) {
    score += 14;
    reasons.push("shorts crowded / squeeze fuel");
  } else if (fundingRate <= -0.00008) {
    score += 8;
  } else if (fundingRate >= 0.00015) {
    score -= 10;
  } else if (fundingRate >= 0.00008) {
    score -= 6;
  }

  if (base.distanceFromZeroFib > 15) {
    score -= 10;
  }

  if (obsScore >= 75) {
    score += 10;
    reasons.push("rolling OBS strong");
  } else if (obsScore >= 60) {
    score += 6;
  } else if (obsScore < 35) {
    score -= 10;
  }

  // Liquidity tier scoring: favor relative strength within tier, not just absolute values
  const tier = classifyLiquidityTier(dayNtlVolume);
  let tierBonus = 0;
  if (tier === "MEGA" && dayNtlVolume >= 100) {
    tierBonus = 8;
    reasons.push("mega-cap liquidity (>=100M daily notional)");
  } else if (tier === "LARGE" && dayNtlVolume >= 30) {
    tierBonus = 6;
    reasons.push("large-cap liquidity (30-100M daily notional)");
  } else if (tier === "MID" && dayNtlVolume >= 5) {
    tierBonus = 4;
    reasons.push("mid-cap liquidity (5-30M daily notional)");
  } else if (tier === "SMALL" && dayNtlVolume > 0.5) {
    tierBonus = 2;
    reasons.push("low-float liquidity (<5M daily notional)");
  }
  score += tierBonus;

  const isInList = score >= ENTER_THRESHOLD || ((previousState?.inList ?? false) && score >= STAY_THRESHOLD);
  const entryGap = Math.max(0, ENTER_THRESHOLD - score);

  const window = classifyWindow(score, oneHourChangePct, fourHourChangePct, smoothedOneHourVolumeBurst);
  const potential = classifyPotential(score, fundingRate, smoothedOneHourVolumeBurst);
  const prevScore = previousState?.lastScore ?? score;
  const prevOb = previousState?.lastOb ?? imbalance;
  const prevVb1h = previousState?.lastVb1h ?? oneHourVolumeBurst;

  return {
    symbol: base.symbol,
    score: Number(score.toFixed(1)),
    entryGap: Number(entryGap.toFixed(1)),
    isShortlisted: isInList,
    deltaScore: Number((score - prevScore).toFixed(1)),
    window,
    potential,
    dailyStage: base.stage,
    distanceFromZeroFib: base.distanceFromZeroFib,
    dailyDeadZoneScore: base.deadZoneScore,
    dailyPrePumpScore: base.prePumpScore,
    dailyBreakoutScore: base.breakoutScore,
    fundingRate,
    orderbookImbalance: imbalance,
    orderbookImbalance1m: imbalance1m,
    orderbookImbalance5m: imbalance5m,
    orderbookImbalance15m: imbalance15m,
    obsScore,
    absorptionScore,
    liquidityRegime,
    smoothedOrderbookImbalance: Number(smoothedImbalance.toFixed(3)),
    deltaOrderbookImbalance: Number((imbalance - prevOb).toFixed(3)),
    spreadPct,
    oneHourChangePct: Number(oneHourChangePct.toFixed(2)),
    fourHourChangePct: Number(fourHourChangePct.toFixed(2)),
    oneHourRsi: Number(oneHourRsi.toFixed(1)),
    fourHourRsi: Number(fourHourRsi.toFixed(1)),
    oneHourStochRsi: Number(oneHourStochRsi.toFixed(1)),
    fourHourStochRsi: Number(fourHourStochRsi.toFixed(1)),
    oneHourStochK: Number(oneHourStochK.toFixed(1)),
    oneHourStochD: Number(oneHourStochD.toFixed(1)),
    oneHourPrevStochK: Number(oneHourPrevStochK.toFixed(1)),
    fourHourStochK: Number(fourHourStochK.toFixed(1)),
    fourHourStochD: Number(fourHourStochD.toFixed(1)),
    fourHourPrevStochK: Number(fourHourPrevStochK.toFixed(1)),
    srsiConsolidationRisk,
    oneHourVolumeBurst: Number(oneHourVolumeBurst.toFixed(2)),
    smoothedOneHourVolumeBurst: Number(smoothedOneHourVolumeBurst.toFixed(2)),
    deltaOneHourVolumeBurst: Number((oneHourVolumeBurst - prevVb1h).toFixed(2)),
    fourHourVolumeBurst: Number(fourHourVolumeBurst.toFixed(2)),
    rotationBreadthPct: 0,
    leaderImpulseScore: 0,
    laggardCatchupScore: 0,
    rotationTriggerScore: 0,
    rotationMode: "NONE",
    reasons,
  };
}

function selectPool(result: CapitulationScanResult): CapitulationBounceCandidate[] {
  const merged = [...result.bounceZoneCandidates, ...result.nearBounceZone];
  const deduped = new Map<string, CapitulationBounceCandidate>();
  for (const candidate of merged) {
    if (candidate.stage === "IGNORE") {
      continue;
    }
    if (candidate.distanceFromZeroFib < 3 || candidate.distanceFromZeroFib > 20) {
      continue;
    }
    if (candidate.breakoutScore >= 60) {
      continue;
    }
    if (candidate.prePumpScore < 20 && candidate.deadZoneScore < 45) {
      continue;
    }
    deduped.set(candidate.symbol, candidate);
  }

  return [...deduped.values()].sort((a, b) => {
    const left = b.prePumpScore + b.deadZoneScore * 0.6;
    const right = a.prePumpScore + a.deadZoneScore * 0.6;
    return left - right;
  }).slice(0, 25);
}

export async function scanFastPumpCandidates(result: CapitulationScanResult): Promise<FastPumpScanResult> {
  const state = await loadFastPumpState();
  const pool = selectPool(result);
  if (pool.length === 0) {
    return {
      shortlisted: [],
      nearMisses: [],
      preBoomAlert: {
        active: false,
        transition: "NONE",
        confirmed: [],
      },
      marketRotation: enrichMarketRotation({
        breadthPct: 0,
        accelerationPct: 0,
        dominantMode: "MUTED",
      }, state.rotationHistory),
    };
  }

  const symbols = pool.map((candidate) => candidate.symbol);
  const contexts = await fetchPerpContexts(symbols).catch(() => new Map());

  const items = await Promise.all(
    pool.map(async (base) => {
      try {
        const [oneHourCandles, fourHourCandles, orderBook] = await Promise.all([
          fetchRecentCandles(base.symbol, "1h", 48),
          fetchRecentCandles(base.symbol, "4h", 36),
          fetchOrderBookExecutionRead(base.symbol),
        ]);

        if (oneHourCandles.length < 24 || fourHourCandles.length < 20) {
          return null;
        }

        const oneHourCloses = oneHourCandles.map((c) => Number(c.close));
        const fourHourCloses = fourHourCandles.map((c) => Number(c.close));
        const oneHourVolumes = oneHourCandles.map((c) => Number(c.volume));
        const fourHourVolumes = fourHourCandles.map((c) => Number(c.volume));

        const oneHourCurrent = oneHourCloses[oneHourCloses.length - 1];
        const fourHourCurrent = fourHourCloses[fourHourCloses.length - 1];
        const oneHourChangePct = pctChange(oneHourCurrent, oneHourCloses[Math.max(0, oneHourCloses.length - 5)]);
        const fourHourChangePct = pctChange(fourHourCurrent, fourHourCloses[Math.max(0, fourHourCloses.length - 4)]);
        const oneHourRsi = calculateLatestRsi(oneHourCloses) ?? 50;
        const fourHourRsi = calculateLatestRsi(fourHourCloses) ?? 50;
        const oneHourStoch = calculateStochasticRsi(oneHourCloses, 14, 14, 3, 3);
        const fourHourStoch = calculateStochasticRsi(fourHourCloses, 14, 14, 3, 3);
        const oneHourEma20 = calculateLatestEma(oneHourCloses, 20) ?? oneHourCurrent;
        const fourHourEma20 = calculateLatestEma(fourHourCloses, 20) ?? fourHourCurrent;
        const oneHourVolumeBurst = volumeBurstRatio(oneHourVolumes, 3, 12);
        const fourHourVolumeBurst = volumeBurstRatio(fourHourVolumes, 2, 8);
        const fundingRate = contexts.get(base.symbol)?.fundingRate ?? base.fundingRate;
        const dayNtlVolume = contexts.get(base.symbol)?.dayNtlVolume ?? 0;
        const imbalance = orderBook?.imbalance ?? 0;
        const imbalance1m = orderBook?.imbalanceAvg1m ?? imbalance;
        const imbalance5m = orderBook?.imbalanceAvg5m ?? imbalance;
        const imbalance15m = orderBook?.imbalanceAvg15m ?? imbalance;
        const obsScore = orderBook?.obsScoreRolling ?? base.obsScore;
        const absorptionScore = orderBook?.absorptionScore ?? 50;
        const liquidityRegime = orderBook?.liquidityRegime ?? "NEUTRAL";
        const spreadPct = orderBook?.spreadPct ?? 0;
        const previousState = state.symbols[base.symbol];
        const smoothedImbalance = smoothValue(previousState?.smoothedOb, imbalance);
        const smoothedOneHourVolumeBurst = smoothValue(previousState?.smoothedVb1h, oneHourVolumeBurst);

        return scoreFastPumpCandidate({
          base,
          previousState,
          fundingRate,
          imbalance,
          imbalance1m,
          imbalance5m,
          imbalance15m,
          obsScore,
          absorptionScore,
          liquidityRegime,
          smoothedImbalance,
          spreadPct,
          oneHourChangePct,
          fourHourChangePct,
          oneHourRsi,
          fourHourRsi,
          oneHourStochRsi: oneHourStoch?.stochRsi ?? 50,
          fourHourStochRsi: fourHourStoch?.stochRsi ?? 50,
          oneHourStochK: oneHourStoch?.k ?? 50,
          oneHourStochD: oneHourStoch?.d ?? 50,
          oneHourPrevStochK: oneHourStoch?.prevK ?? 50,
          fourHourStochK: fourHourStoch?.k ?? 50,
          fourHourStochD: fourHourStoch?.d ?? 50,
          fourHourPrevStochK: fourHourStoch?.prevK ?? 50,
          oneHourVolumeBurst,
          smoothedOneHourVolumeBurst,
          fourHourVolumeBurst,
          oneHourAboveEma20: oneHourCurrent >= oneHourEma20,
          fourHourAboveEma20: fourHourCurrent >= fourHourEma20,
          dayNtlVolume,
        });
      } catch {
        return null;
      }
    })
  );

  const allCandidates = items
    .filter((item): item is FastPumpCandidate => item != null)
    .sort((a, b) => b.score - a.score);

  const rotation = deriveRotationSignals(allCandidates);
  const enrichedCandidates = rotation.enriched;

  const filtered = enrichedCandidates
    .filter((item) => item.isShortlisted)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  const nearMisses = enrichedCandidates
    .filter((item) => !item.isShortlisted && item.entryGap <= 8)
    .slice(0, 10);

  const previousSpikeState = state.rotationHistory[state.rotationHistory.length - 1]?.spikeState ?? null;

  const nowIso = new Date().toISOString();
  state.rotationHistory.push({
    timestamp: nowIso,
    breadthPct: rotation.marketRotation.breadthPct,
    accelerationPct: rotation.marketRotation.accelerationPct,
    dominantMode: rotation.marketRotation.dominantMode,
  });
  if (state.rotationHistory.length > 400) {
    state.rotationHistory = state.rotationHistory.slice(-400);
  }

  const marketRotation = enrichMarketRotation(rotation.marketRotation, state.rotationHistory);

  const transition = resolveSpikeTransition(previousSpikeState, marketRotation.spikeState);
  const transitionUp = transition !== "NONE"
    && spikeStateRank(marketRotation.spikeState) > spikeStateRank(previousSpikeState ?? "FLAT");

  const confirmedPreBoom = enrichedCandidates
    .filter((item) => {
      const oneHourCurl = item.oneHourStochK > item.oneHourStochD && item.oneHourStochK > item.oneHourPrevStochK;
      const fourHourCurl = item.fourHourStochK > item.fourHourStochD && item.fourHourStochK > item.fourHourPrevStochK;
      const srsiCurlUp = oneHourCurl || fourHourCurl;
      const rtsPass = item.rotationTriggerScore >= 40;
      const absorptionPass = item.absorptionScore >= 35;
      return rtsPass && absorptionPass && srsiCurlUp && !item.srsiConsolidationRisk;
    })
    .sort((a, b) => (b.rotationTriggerScore + b.score) - (a.rotationTriggerScore + a.score))
    .slice(0, 5);

  const preBoomAlert: FastPumpScanResult["preBoomAlert"] = {
    active: transitionUp && confirmedPreBoom.length > 0,
    transition,
    confirmed: confirmedPreBoom,
  };

  state.rotationHistory[state.rotationHistory.length - 1] = {
    ...state.rotationHistory[state.rotationHistory.length - 1],
    spikeState: marketRotation.spikeState,
    spikeScore: marketRotation.spikeScore,
  };

  for (const item of filtered) {
    state.symbols[item.symbol] = {
      lastScore: safeNumber(item.score),
      lastOb: safeNumber(item.orderbookImbalance),
      lastVb1h: safeNumber(item.oneHourVolumeBurst),
      smoothedOb: safeNumber(item.smoothedOrderbookImbalance),
      smoothedVb1h: safeNumber(item.smoothedOneHourVolumeBurst),
      inList: true,
      updatedAt: nowIso,
    };
  }

  const trackedSymbols = new Set(pool.map((c) => c.symbol));
  for (const [symbol, entry] of Object.entries(state.symbols)) {
    if (trackedSymbols.has(symbol)) {
      const stillInList = filtered.some((item) => item.symbol === symbol);
      state.symbols[symbol] = {
        ...entry,
        inList: stillInList,
        updatedAt: nowIso,
      };
    }
  }

  await saveFastPumpState(state);

  return {
    shortlisted: filtered,
    nearMisses,
    preBoomAlert,
    marketRotation,
  };
}
