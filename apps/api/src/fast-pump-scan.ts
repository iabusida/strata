import type { CapitulationBounceCandidate, CapitulationScanResult } from "./fibonacci-capitulation-scan.js";
import { fetchOrderBookExecutionRead, fetchPerpContexts, fetchRecentCandles } from "./bitunix-service.js";
import { calculateLatestEma, calculateLatestRsi } from "./rsi.js";
import { promises as fs } from "node:fs";
import path from "node:path";

export type FastPumpWindow = "TODAY" | "TOMORROW" | "2-3D";
export type FastPumpPotential = "20%+" | "30%+" | "40%+";

export interface FastPumpCandidate {
  symbol: string;
  score: number;
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
  smoothedOrderbookImbalance: number;
  deltaOrderbookImbalance: number;
  spreadPct: number;
  oneHourChangePct: number;
  fourHourChangePct: number;
  oneHourRsi: number;
  fourHourRsi: number;
  oneHourVolumeBurst: number;
  smoothedOneHourVolumeBurst: number;
  deltaOneHourVolumeBurst: number;
  fourHourVolumeBurst: number;
  reasons: string[];
}

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
  version: 1;
  symbols: Record<string, FastPumpStateEntry>;
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
    const parsed = JSON.parse(raw) as FastPumpState;
    if (!parsed || parsed.version !== 1 || typeof parsed.symbols !== "object") {
      return { version: 1, symbols: {} };
    }
    return parsed;
  } catch {
    return { version: 1, symbols: {} };
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
  smoothedImbalance: number;
  spreadPct: number;
  oneHourChangePct: number;
  fourHourChangePct: number;
  oneHourRsi: number;
  fourHourRsi: number;
  oneHourVolumeBurst: number;
  smoothedOneHourVolumeBurst: number;
  fourHourVolumeBurst: number;
  oneHourAboveEma20: boolean;
  fourHourAboveEma20: boolean;
}): FastPumpCandidate | null {
  const {
    base,
    previousState,
    fundingRate,
    imbalance,
    smoothedImbalance,
    spreadPct,
    oneHourChangePct,
    fourHourChangePct,
    oneHourRsi,
    fourHourRsi,
    oneHourVolumeBurst,
    smoothedOneHourVolumeBurst,
    fourHourVolumeBurst,
    oneHourAboveEma20,
    fourHourAboveEma20,
  } = input;

  let score = 0;
  const reasons: string[] = [];

  if (base.stage === "PRE_PUMP") {
    score += 24;
    reasons.push("daily stage pre-pump");
  } else if (base.stage === "ACCUMULATION") {
    score += 16;
    reasons.push("daily stage accumulation");
  } else if (base.stage === "RECOVERY") {
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

  const isInList = score >= ENTER_THRESHOLD || ((previousState?.inList ?? false) && score >= STAY_THRESHOLD);
  if (!isInList) {
    return null;
  }

  const window = classifyWindow(score, oneHourChangePct, fourHourChangePct, smoothedOneHourVolumeBurst);
  const potential = classifyPotential(score, fundingRate, smoothedOneHourVolumeBurst);
  const prevScore = previousState?.lastScore ?? score;
  const prevOb = previousState?.lastOb ?? imbalance;
  const prevVb1h = previousState?.lastVb1h ?? oneHourVolumeBurst;

  return {
    symbol: base.symbol,
    score: Number(score.toFixed(1)),
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
    smoothedOrderbookImbalance: Number(smoothedImbalance.toFixed(3)),
    deltaOrderbookImbalance: Number((imbalance - prevOb).toFixed(3)),
    spreadPct,
    oneHourChangePct: Number(oneHourChangePct.toFixed(2)),
    fourHourChangePct: Number(fourHourChangePct.toFixed(2)),
    oneHourRsi: Number(oneHourRsi.toFixed(1)),
    fourHourRsi: Number(fourHourRsi.toFixed(1)),
    oneHourVolumeBurst: Number(oneHourVolumeBurst.toFixed(2)),
    smoothedOneHourVolumeBurst: Number(smoothedOneHourVolumeBurst.toFixed(2)),
    deltaOneHourVolumeBurst: Number((oneHourVolumeBurst - prevVb1h).toFixed(2)),
    fourHourVolumeBurst: Number(fourHourVolumeBurst.toFixed(2)),
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

export async function scanFastPumpCandidates(result: CapitulationScanResult): Promise<FastPumpCandidate[]> {
  const pool = selectPool(result);
  if (pool.length === 0) {
    return [];
  }

  const state = await loadFastPumpState();

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
        const oneHourEma20 = calculateLatestEma(oneHourCloses, 20) ?? oneHourCurrent;
        const fourHourEma20 = calculateLatestEma(fourHourCloses, 20) ?? fourHourCurrent;
        const oneHourVolumeBurst = volumeBurstRatio(oneHourVolumes, 3, 12);
        const fourHourVolumeBurst = volumeBurstRatio(fourHourVolumes, 2, 8);
        const fundingRate = contexts.get(base.symbol)?.fundingRate ?? base.fundingRate;
        const imbalance = orderBook?.imbalance ?? 0;
        const spreadPct = orderBook?.spreadPct ?? 0;
        const previousState = state.symbols[base.symbol];
        const smoothedImbalance = smoothValue(previousState?.smoothedOb, imbalance);
        const smoothedOneHourVolumeBurst = smoothValue(previousState?.smoothedVb1h, oneHourVolumeBurst);

        return scoreFastPumpCandidate({
          base,
          previousState,
          fundingRate,
          imbalance,
          smoothedImbalance,
          spreadPct,
          oneHourChangePct,
          fourHourChangePct,
          oneHourRsi,
          fourHourRsi,
          oneHourVolumeBurst,
          smoothedOneHourVolumeBurst,
          fourHourVolumeBurst,
          oneHourAboveEma20: oneHourCurrent >= oneHourEma20,
          fourHourAboveEma20: fourHourCurrent >= fourHourEma20,
        });
      } catch {
        return null;
      }
    })
  );

  const filtered = items
    .filter((item): item is FastPumpCandidate => item != null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  const nowIso = new Date().toISOString();
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

  return filtered;
}
