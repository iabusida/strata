import "./env.js";
import { readFile } from "node:fs/promises";

import {
  calculateLatestAtr,
  calculateLatestEma,
  calculateLatestMacdHistogram,
  calculateLatestRsi,
  calculateStochasticRsi,
  calculateStochasticRsiSeries,
  computeConfluenceScore,
  determineSignal,
  translateTimeframeTrend,
  type SignalType,
  type TimeframeRsi
} from "./rsi.js";
import { detectRegime, type MarketRegime } from "./regime-engine.js";
import { evaluateStructure, breakoutHigh, breakdownLow } from "./structure-engine.js";
import { evaluateMicroTrend } from "./ema-engine.js";
import { evaluateSupportResistance } from "./sr-engine.js";
import { effectiveEntryPrice, validateExecution } from "./execution-engine.js";

export type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
};

type SimulationInterval = "15m" | "1h" | "4h" | "12h" | "1d";
type MultiTimeframeCandles = Record<SimulationInterval, Candle[]>;

export type CandleDataBySymbol = Record<string, Candle[] | MultiTimeframeCandles>;

type SimulationContext = {
  symbol: string;
  price: number;
  macro: TimeframeRsi;
  intermediary: TimeframeRsi;
  micro: TimeframeRsi;
  daily: TimeframeRsi | null;
  twelveh: TimeframeRsi | null;
  highs1h: number[];
  lows1h: number[];
  ema20: number;
  prevEma20: number;
  atr: number;
  volatilityPct: number;
  spreadPct: number;
  depthUsd: number;
  orderNotional: number;
  maxSpreadPct: number;
  regime: MarketRegime;
  structureBreakLong: boolean;
  structureBreakShort: boolean;
  volume24h: number;
  averageMarketVolume: number;
};

type OpenTrade = {
  symbol: string;
  signal: SignalType;
  direction: "LONG" | "SHORT";
  entry: number;
  tp: number; // kept for legacy API, but not used in analysis mode
  sl: number; // kept for legacy API, but not used in analysis mode
  openIndex: number;
  score: number;
  slippage: number;
};

export type SimulationTradeResult = {
  symbol: string;
  signal: SignalType;
  result: "WIN" | "LOSS" | "TIME_EXIT";
  entry: number;
  exit: number;
  pnlPct: number;
  durationCandles: number;
  score: number;
  priceHigh: number;
  priceLow: number;
  direction: "LONG" | "SHORT";
};

const TARGET_TRADE_COUNT = 1000;
const MIN_INDEX = 100;
const FORWARD_BUFFER = 50;
const SCORE_THRESHOLD = 4;
const ORDER_NOTIONAL_USD = 100;
const MAX_SPREAD_PCT = 0.06;
const TF_15M_MS = 900_000;
const ENABLE_SOFT_STRUCTURE_OVERRIDE = false;
const ENABLE_SOFT_SR_OVERRIDE = false;

export type SimulationDiagnostics = {
  targetTrades: number;
  symbolsInput: number;
  symbolsUsable: number;
  contextsBuilt: number;
  directionalSignals: number;
  passedFilters: number;
  tradesOpened: number;
  calibrationOverrides: {
    structure: number;
    supportResistance: number;
  };
  rejectionCounts: {
    scoreThreshold: number;
    structure: number;
    microTrend: number;
    supportResistance: number;
    execution: number;
    regime: number;
    riskReward: number;
    expectedValue: number;
    tpVsCosts: number;
  };
};

let lastSimulationDiagnostics: SimulationDiagnostics = {
  targetTrades: TARGET_TRADE_COUNT,
  symbolsInput: 0,
  symbolsUsable: 0,
  contextsBuilt: 0,
  directionalSignals: 0,
  passedFilters: 0,
  tradesOpened: 0,
  calibrationOverrides: {
    structure: 0,
    supportResistance: 0
  },
  rejectionCounts: {
    scoreThreshold: 0,
    structure: 0,
    microTrend: 0,
    supportResistance: 0,
    execution: 0,
    regime: 0,
    riskReward: 0,
    expectedValue: 0,
    tpVsCosts: 0
  }
};

export function getLastSimulationDiagnostics(): SimulationDiagnostics {
  return { ...lastSimulationDiagnostics };
}

let currentRejectionCounts: SimulationDiagnostics["rejectionCounts"] = {
  scoreThreshold: 0,
  structure: 0,
  microTrend: 0,
  supportResistance: 0,
  execution: 0,
  regime: 0,
  riskReward: 0,
  expectedValue: 0,
  tpVsCosts: 0
};

let currentCalibrationOverrides: SimulationDiagnostics["calibrationOverrides"] = {
  structure: 0,
  supportResistance: 0
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function validateCandle(candle: Candle, symbol: string, index: number): void {
  if (
    !Number.isFinite(candle.open) ||
    !Number.isFinite(candle.high) ||
    !Number.isFinite(candle.low) ||
    !Number.isFinite(candle.close) ||
    !Number.isFinite(candle.volume) ||
    !Number.isFinite(candle.timestamp)
  ) {
    throw new Error(`Invalid candle for ${symbol} at index ${index}`);
  }
}

function sortAndValidateCandles(candles: Candle[], symbol: string, label: string): Candle[] {
  const sorted = [...candles].sort((left, right) => left.timestamp - right.timestamp);
  sorted.forEach((candle, idx) => validateCandle(candle, `${symbol}:${label}`, idx));
  return sorted;
}

function indexAtOrBeforeTimestamp(candles: Candle[], timestamp: number): number {
  let left = 0;
  let right = candles.length - 1;
  let best = -1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const value = candles[mid].timestamp;
    if (value <= timestamp) {
      best = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return best;
}

function sliceHistoryToTimestamp(candles: Candle[], timestamp: number): Candle[] {
  const endIndex = indexAtOrBeforeTimestamp(candles, timestamp);
  if (endIndex < 0) {
    return [];
  }

  return candles.slice(0, endIndex + 1);
}

function inferBaseIntervalMs(candles: Candle[], symbol: string): number {
  const diffs: number[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const diff = candles[i].timestamp - candles[i - 1].timestamp;
    if (Number.isFinite(diff) && diff > 0) {
      diffs.push(diff);
    }
  }

  if (diffs.length === 0) {
    throw new Error(`Cannot infer candle interval for ${symbol}`);
  }

  diffs.sort((left, right) => left - right);
  const median = diffs[Math.floor(diffs.length / 2)];

  if (median > TF_15M_MS) {
    throw new Error(`Base interval for ${symbol} is too coarse (${median}ms). Required: <= 15m candles.`);
  }

  return median;
}

function aggregateCandles(candles: Candle[], barsPerCandle: number): Candle[] {
  if (barsPerCandle <= 1) {
    return candles.slice();
  }

  const output: Candle[] = [];
  for (let i = 0; i + barsPerCandle <= candles.length; i += barsPerCandle) {
    const chunk = candles.slice(i, i + barsPerCandle);
    const open = chunk[0].open;
    const close = chunk[chunk.length - 1].close;
    const high = chunk.reduce((max, candle) => Math.max(max, candle.high), Number.NEGATIVE_INFINITY);
    const low = chunk.reduce((min, candle) => Math.min(min, candle.low), Number.POSITIVE_INFINITY);
    const volume = chunk.reduce((sum, candle) => sum + candle.volume, 0);
    const timestamp = chunk[chunk.length - 1].timestamp;

    output.push({ open, high, low, close, volume, timestamp });
  }

  return output;
}

function buildTimeframeRsi(candles: Candle[], interval: TimeframeRsi["interval"]): TimeframeRsi | null {
  const closes = candles.map((candle) => candle.close);
  const rsi = calculateLatestRsi(closes);
  const macdHist = calculateLatestMacdHistogram(closes);
  const stoch = calculateStochasticRsi(closes);

  if (rsi == null || macdHist == null || stoch == null) {
    return null;
  }

  return {
    interval,
    rsi: Number(rsi.toFixed(2)),
    macdHist,
    stochRsi: stoch.stochRsi,
    stochK: stoch.k,
    stochD: stoch.d,
    prevStochK: stoch.prevK,
    prevStochD: stoch.prevD,
    trend: translateTimeframeTrend(stoch.k, stoch.d, stoch.prevK, stoch.prevD, Number(rsi.toFixed(2)))
  };
}

function calculateVolatilityPct(oneHourCandles: Candle[]): number {
  const window = oneHourCandles.slice(-24);
  if (window.length === 0) {
    return 0;
  }

  const highest = window.reduce((max, candle) => Math.max(max, candle.high), Number.NEGATIVE_INFINITY);
  const lowest = window.reduce((min, candle) => Math.min(min, candle.low), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(highest) || !Number.isFinite(lowest) || lowest <= 0) {
    return 0;
  }

  return Number((((highest - lowest) / lowest) * 100).toFixed(3));
}

function calculateTrendPersistence(fourHourCandles: Candle[]): number {
  const series = calculateStochasticRsiSeries(fourHourCandles.map((candle) => candle.close));
  if (series.length === 0) {
    return 0;
  }

  const window = series.slice(-6);
  let upCount = 0;
  let downCount = 0;

  for (const point of window) {
    if (point.k > point.d) {
      upCount += 1;
    } else if (point.k < point.d) {
      downCount += 1;
    }
  }

  return Math.max(upCount, downCount);
}

function getBarsPer(baseIntervalMs: number, targetIntervalMs: number): number {
  return Math.max(1, Math.round(targetIntervalMs / baseIntervalMs));
}

function computeAverageMarketVolume(candles: Candle[], baseIntervalMs: number): number {
  const bars24h = Math.max(1, Math.round(86_400_000 / baseIntervalMs));
  const windows: number[] = [];

  for (let i = bars24h; i <= candles.length; i += bars24h) {
    const slice = candles.slice(i - bars24h, i);
    const notional = slice.reduce((sum, candle) => sum + (candle.close * candle.volume), 0);
    windows.push(notional);
  }

  if (windows.length === 0) {
    return candles.reduce((sum, candle) => sum + (candle.close * candle.volume), 0);
  }

  return windows.reduce((sum, value) => sum + value, 0) / windows.length;
}

export function buildContext(
  candles: Candle[],
  index: number,
  symbol: string = "UNKNOWN",
  averageMarketVolume: number = 0
): SimulationContext | null {
  if (index < 0 || index >= candles.length) {
    return null;
  }

  const baseIntervalMs = inferBaseIntervalMs(candles, symbol);
  const history = candles.slice(0, index + 1);

  const bars15m = getBarsPer(baseIntervalMs, 900_000);
  const bars1h = getBarsPer(baseIntervalMs, 3_600_000);
  const bars4h = getBarsPer(baseIntervalMs, 14_400_000);
  const bars12h = getBarsPer(baseIntervalMs, 43_200_000);
  const bars1d = getBarsPer(baseIntervalMs, 86_400_000);

  const candles15m = aggregateCandles(history, bars15m);
  const candles1h = aggregateCandles(history, bars1h);
  const candles4h = aggregateCandles(history, bars4h);
  const candles12h = aggregateCandles(history, bars12h);
  const candles1d = aggregateCandles(history, bars1d);

  const micro = buildTimeframeRsi(candles15m, "15m");
  const intermediary = buildTimeframeRsi(candles1h, "1h");
  const macro = buildTimeframeRsi(candles4h, "4h");
  const twelveh = buildTimeframeRsi(candles12h, "12h");
  const daily = buildTimeframeRsi(candles1d, "1d");

  if (!micro || !intermediary || !macro) {
    return null;
  }

  const highs1h = candles1h.slice(-20).map((candle) => candle.high);
  const lows1h = candles1h.slice(-20).map((candle) => candle.low);
  if (highs1h.length < 20 || lows1h.length < 20) {
    return null;
  }

  const closes15m = candles15m.map((candle) => candle.close);
  const ema20 = calculateLatestEma(closes15m, 20);
  const prevEma20 = calculateLatestEma(closes15m.slice(0, -1), 20);
  if (ema20 == null || prevEma20 == null) {
    return null;
  }

  const highs1hAtr = candles1h.map((candle) => candle.high);
  const lows1hAtr = candles1h.map((candle) => candle.low);
  const closes1hAtr = candles1h.map((candle) => candle.close);
  const atr1h = calculateLatestAtr(highs1hAtr, lows1hAtr, closes1hAtr, 14);

  const highs4hAtr = candles4h.map((candle) => candle.high);
  const lows4hAtr = candles4h.map((candle) => candle.low);
  const closes4hAtr = candles4h.map((candle) => candle.close);
  const atr4h = calculateLatestAtr(highs4hAtr, lows4hAtr, closes4hAtr, 14);

  if (atr1h == null || atr4h == null || atr1h <= 0) {
    return null;
  }

  const recent1h = candles1h.slice(-12);
  const recentHigh1h = recent1h.reduce((max, candle) => Math.max(max, candle.high), Number.NEGATIVE_INFINITY);
  const recentLow1h = recent1h.reduce((min, candle) => Math.min(min, candle.low), Number.POSITIVE_INFINITY);

  if (!Number.isFinite(recentHigh1h) || !Number.isFinite(recentLow1h)) {
    return null;
  }

  const price = history[history.length - 1].close;
  const volatilityPct = calculateVolatilityPct(candles1h);
  const trendPersistence = calculateTrendPersistence(candles4h);
  const regime = detectRegime({
    price,
    atr1h,
    atr4h,
    recentHigh1h,
    recentLow1h,
    volatilityPct,
    trendPersistence
  }).regime;

  const bars24h = Math.max(1, Math.round(86_400_000 / baseIntervalMs));
  const notional24h = history
    .slice(-bars24h)
    .reduce((sum, candle) => sum + (candle.close * candle.volume), 0);

  const avgNotionalPerBar = history.length > 0
    ? history.reduce((sum, candle) => sum + (candle.close * candle.volume), 0) / history.length
    : 0;

  const depthUsd = clamp(avgNotionalPerBar * 20, 100_000, 1_000_000);
  const spreadPct = clamp(0.01 + (volatilityPct * 0.002), 0.01, 0.06);

  return {
    symbol,
    price,
    macro,
    intermediary,
    micro,
    daily,
    twelveh,
    highs1h,
    lows1h,
    ema20,
    prevEma20,
    atr: atr1h,
    volatilityPct,
    spreadPct,
    depthUsd,
    orderNotional: ORDER_NOTIONAL_USD,
    maxSpreadPct: MAX_SPREAD_PCT,
    regime,
    structureBreakLong: breakoutHigh(highs1h),
    structureBreakShort: breakdownLow(lows1h),
    volume24h: Number(notional24h.toFixed(2)),
    averageMarketVolume: Number(averageMarketVolume.toFixed(2))
  };
}

function buildContextFromMtf(
  symbolData: MultiTimeframeCandles,
  index15m: number,
  symbol: string,
  averageMarketVolume: number
): SimulationContext | null {
  if (index15m < 0 || index15m >= symbolData["15m"].length) {
    return null;
  }

  const currentCandle = symbolData["15m"][index15m];
  const currentTimestamp = currentCandle.timestamp;

  const candles15m = symbolData["15m"].slice(0, index15m + 1);
  const candles1h = sliceHistoryToTimestamp(symbolData["1h"], currentTimestamp);
  const candles4h = sliceHistoryToTimestamp(symbolData["4h"], currentTimestamp);
  const candles12h = sliceHistoryToTimestamp(symbolData["12h"], currentTimestamp);
  const candles1d = sliceHistoryToTimestamp(symbolData["1d"], currentTimestamp);

  if (candles15m.length < 40 || candles1h.length < 30 || candles4h.length < 20) {
    return null;
  }

  const micro = buildTimeframeRsi(candles15m, "15m");
  const intermediary = buildTimeframeRsi(candles1h, "1h");
  const macro = buildTimeframeRsi(candles4h, "4h");
  const twelveh = buildTimeframeRsi(candles12h, "12h");
  const daily = buildTimeframeRsi(candles1d, "1d");

  if (!micro || !intermediary || !macro) {
    return null;
  }

  const highs1h = candles1h.slice(-20).map((candle) => candle.high);
  const lows1h = candles1h.slice(-20).map((candle) => candle.low);
  if (highs1h.length < 20 || lows1h.length < 20) {
    return null;
  }

  const closes15m = candles15m.map((candle) => candle.close);
  const ema20 = calculateLatestEma(closes15m, 20);
  const prevEma20 = calculateLatestEma(closes15m.slice(0, -1), 20);
  if (ema20 == null || prevEma20 == null) {
    return null;
  }

  const highs1hAtr = candles1h.map((candle) => candle.high);
  const lows1hAtr = candles1h.map((candle) => candle.low);
  const closes1hAtr = candles1h.map((candle) => candle.close);
  const atr1h = calculateLatestAtr(highs1hAtr, lows1hAtr, closes1hAtr, 14);

  const highs4hAtr = candles4h.map((candle) => candle.high);
  const lows4hAtr = candles4h.map((candle) => candle.low);
  const closes4hAtr = candles4h.map((candle) => candle.close);
  const atr4h = calculateLatestAtr(highs4hAtr, lows4hAtr, closes4hAtr, 14);

  if (atr1h == null || atr4h == null || atr1h <= 0) {
    return null;
  }

  const recent1h = candles1h.slice(-12);
  const recentHigh1h = recent1h.reduce((max, candle) => Math.max(max, candle.high), Number.NEGATIVE_INFINITY);
  const recentLow1h = recent1h.reduce((min, candle) => Math.min(min, candle.low), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(recentHigh1h) || !Number.isFinite(recentLow1h)) {
    return null;
  }

  const price = currentCandle.close;
  const volatilityPct = calculateVolatilityPct(candles1h);
  const trendPersistence = calculateTrendPersistence(candles4h);
  const regime = detectRegime({
    price,
    atr1h,
    atr4h,
    recentHigh1h,
    recentLow1h,
    volatilityPct,
    trendPersistence
  }).regime;

  const notional24h = candles15m
    .slice(-96)
    .reduce((sum, candle) => sum + (candle.close * candle.volume), 0);

  const avgNotionalPerBar = candles15m.length > 0
    ? candles15m.reduce((sum, candle) => sum + (candle.close * candle.volume), 0) / candles15m.length
    : 0;

  const depthUsd = clamp(avgNotionalPerBar * 20, 100_000, 1_000_000);
  const spreadPct = clamp(0.01 + (volatilityPct * 0.002), 0.01, 0.06);

  return {
    symbol,
    price,
    macro,
    intermediary,
    micro,
    daily,
    twelveh,
    highs1h,
    lows1h,
    ema20,
    prevEma20,
    atr: atr1h,
    volatilityPct,
    spreadPct,
    depthUsd,
    orderNotional: ORDER_NOTIONAL_USD,
    maxSpreadPct: MAX_SPREAD_PCT,
    regime,
    structureBreakLong: breakoutHigh(highs1h),
    structureBreakShort: breakdownLow(lows1h),
    volume24h: Number(notional24h.toFixed(2)),
    averageMarketVolume: Number(averageMarketVolume.toFixed(2))
  };
}

function passesRegime(ctx: SimulationContext, signal: SignalType): boolean {
  if (ctx.regime === "CHOPPY" && signal.startsWith("STRONG")) {
    return false;
  }

  if (ctx.regime === "TRENDING" && signal.startsWith("REVERSAL")) {
    if (signal.includes("LONG") && !ctx.structureBreakLong) {
      return false;
    }
    if (signal.includes("SHORT") && !ctx.structureBreakShort) {
      return false;
    }
  }

  if (ctx.regime === "LOW_VOL" && !signal.startsWith("STRONG")) {
    return false;
  }

  if (ctx.regime === "EXPANSION" && !signal.startsWith("STRONG")) {
    return false;
  }

  return true;
}

function estimateTargets(entry: number, signal: SignalType, atr: number): { tp: number; sl: number } | null {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(atr) || atr <= 0) {
    return null;
  }

  if (signal.includes("LONG")) {
    return {
      tp: Number((entry + (atr * 2)).toFixed(6)),
      sl: Number((entry - (atr * 1.2)).toFixed(6))
    };
  }

  if (signal.includes("SHORT")) {
    return {
      tp: Number((entry - (atr * 2)).toFixed(6)),
      sl: Number((entry + (atr * 1.2)).toFixed(6))
    };
  }

  return null;
}

function hasSoftContinuationStructure(ctx: SimulationContext, signal: SignalType): boolean {
  if (!signal.startsWith("CONTINUATION")) {
    return false;
  }

  const lastLow = ctx.lows1h[ctx.lows1h.length - 1];
  const prevLow = ctx.lows1h[ctx.lows1h.length - 2];
  const lastHigh = ctx.highs1h[ctx.highs1h.length - 1];
  const prevHigh = ctx.highs1h[ctx.highs1h.length - 2];

  if (
    !Number.isFinite(lastLow) ||
    !Number.isFinite(prevLow) ||
    !Number.isFinite(lastHigh) ||
    !Number.isFinite(prevHigh)
  ) {
    return false;
  }

  if (signal.includes("LONG")) {
    // Allow minor retrace noise up to 0.3% in continuation structure.
    return lastLow >= prevLow * 0.997;
  }

  if (signal.includes("SHORT")) {
    // Allow minor bounce noise up to 0.3% in continuation structure.
    return lastHigh <= prevHigh * 1.003;
  }

  return false;
}

function passesSoftSupportResistance(ctx: SimulationContext, signal: SignalType): boolean {
  const high1h = ctx.highs1h[ctx.highs1h.length - 1];
  const low1h = ctx.lows1h[ctx.lows1h.length - 1];
  if (!Number.isFinite(high1h) || !Number.isFinite(low1h) || high1h <= low1h) {
    return true;
  }

  const range = high1h - low1h;
  const softBuffer = range * 0.05;
  const nearResistanceSoft = ctx.price >= high1h - softBuffer;
  const nearSupportSoft = ctx.price <= low1h + softBuffer;

  if (signal.includes("LONG")) {
    return !nearResistanceSoft;
  }

  if (signal.includes("SHORT")) {
    return !nearSupportSoft;
  }

  return true;
}

export function passesAllFilters(
  ctx: SimulationContext,
  signal: SignalType,
  confluence: { score: number; bias: "SHORT" | "LONG" | null; maxScore: number }
): boolean {
  const strongOrReversal = signal.startsWith("STRONG") || signal.startsWith("REVERSAL");
  const continuationSignal = signal.startsWith("CONTINUATION");

  if (!strongOrReversal && confluence.score < SCORE_THRESHOLD) {
    currentRejectionCounts.scoreThreshold += 1;
    return false;
  }

  const structureOk = evaluateStructure({ highs1h: ctx.highs1h, lows1h: ctx.lows1h }, signal);
  const microTrendOk = evaluateMicroTrend({ price: ctx.price, ema20: ctx.ema20, prevEma20: ctx.prevEma20 }, signal);

  if (continuationSignal) {
    if (!structureOk && !microTrendOk) {
      const softStructureOk = ENABLE_SOFT_STRUCTURE_OVERRIDE && hasSoftContinuationStructure(ctx, signal);
      if (!softStructureOk) {
        currentRejectionCounts.structure += 1;
        return false;
      }
      currentCalibrationOverrides.structure += 1;
    }
  } else {
    if (!structureOk) {
      currentRejectionCounts.structure += 1;
      return false;
    }

    if (!microTrendOk) {
      currentRejectionCounts.microTrend += 1;
      return false;
    }
  }

  const high1h = ctx.highs1h[ctx.highs1h.length - 1];
  const low1h = ctx.lows1h[ctx.lows1h.length - 1];
  if (!evaluateSupportResistance({ price: ctx.price, high1h, low1h }, signal)) {
    const softSrOk = ENABLE_SOFT_SR_OVERRIDE && passesSoftSupportResistance(ctx, signal);
    if (!softSrOk) {
      currentRejectionCounts.supportResistance += 1;
      return false;
    }
    currentCalibrationOverrides.supportResistance += 1;
  }

  const execution = validateExecution({
    spreadPct: ctx.spreadPct,
    depthUsd: ctx.depthUsd,
    orderNotional: ctx.orderNotional,
    maxSpread: ctx.maxSpreadPct
  });
  if (!execution.ok) {
    currentRejectionCounts.execution += 1;
    return false;
  }

  if (!passesRegime(ctx, signal)) {
    currentRejectionCounts.regime += 1;
    return false;
  }

  const targets = estimateTargets(ctx.price, signal, ctx.atr);
  if (!targets) {
    return false;
  }

  const tpDistance = Math.abs(targets.tp - ctx.price);
  const slDistance = Math.abs(targets.sl - ctx.price);
  if (!Number.isFinite(tpDistance) || !Number.isFinite(slDistance) || slDistance <= 0) {
    return false;
  }

  const riskReward = tpDistance / slDistance;
  if (riskReward < 1.5) {
    currentRejectionCounts.riskReward += 1;
    return false;
  }

  const winProb = confluence.score / 10;
  const expectedValue = (winProb * tpDistance) - ((1 - winProb) * slDistance);
  if (expectedValue <= 0) {
    currentRejectionCounts.expectedValue += 1;
    return false;
  }

  const slippagePct = execution.slippage * 100;
  const tpDistancePct = (tpDistance / ctx.price) * 100;
  if (tpDistancePct <= (ctx.spreadPct + (slippagePct * 2))) {
    currentRejectionCounts.tpVsCosts += 1;
    return false;
  }

  return true;
}

export function openTrade(
  ctx: SimulationContext,
  signal: SignalType,
  confluence: { score: number; bias: "SHORT" | "LONG" | null; maxScore: number },
  openIndex: number
): OpenTrade {
  if (!signal.includes("LONG") && !signal.includes("SHORT")) {
    throw new Error(`Cannot open non-directional trade for ${ctx.symbol}: ${signal}`);
  }

  const execution = validateExecution({
    spreadPct: ctx.spreadPct,
    depthUsd: ctx.depthUsd,
    orderNotional: ctx.orderNotional,
    maxSpread: ctx.maxSpreadPct
  });
  if (!execution.ok) {
    throw new Error(`Execution became invalid for ${ctx.symbol}`);
  }

  const adjustedEntry = effectiveEntryPrice(ctx.price, signal, execution.slippage);
  if (!Number.isFinite(adjustedEntry) || adjustedEntry <= 0) {
    throw new Error(`Invalid effective entry for ${ctx.symbol}`);
  }

  const targets = estimateTargets(adjustedEntry, signal, ctx.atr);
  if (!targets) {
    throw new Error(`Invalid trade targets for ${ctx.symbol}`);
  }

  return {
    symbol: ctx.symbol,
    signal,
    direction: signal.includes("LONG") ? "LONG" : "SHORT",
    entry: adjustedEntry,
    tp: targets.tp,
    sl: targets.sl,
    openIndex,
    score: confluence.score,
    slippage: execution.slippage
  };
}

// Analysis mode: track price extremes without exiting on TP/SL
export function simulateForward(candles: Candle[], startIndex: number, trade: OpenTrade): SimulationTradeResult {
  let priceHigh = trade.entry;
  let priceLow = trade.entry;
  let exitTime = candles.length - 1;

  for (let i = startIndex + 1; i < candles.length; i += 1) {
    const candle = candles[i];
    const elapsed = i - startIndex;

    // Track extremes
    priceHigh = Math.max(priceHigh, candle.high);
    priceLow = Math.min(priceLow, candle.low);

    // Time-based exits (same as before)
    if (trade.signal.startsWith("REVERSAL") && elapsed > 6) {
      exitTime = i;
      break;
    }

    if (trade.signal.startsWith("STRONG") && elapsed > 16) {
      exitTime = i;
      break;
    }

    if (elapsed > 24) {
      exitTime = i;
      break;
    }
  }

  const exitCandle = candles[exitTime];
  const exitPrice = exitCandle.close;
  const durationCandles = exitTime - startIndex;

  const pnlPct = trade.direction === "LONG"
    ? ((exitPrice - trade.entry) / trade.entry) * 100
    : ((trade.entry - exitPrice) / trade.entry) * 100;

  return {
    symbol: trade.symbol,
    signal: trade.signal,
    result: "TIME_EXIT", // All trades exit by time in analysis mode
    entry: trade.entry,
    exit: exitPrice,
    pnlPct: Number(pnlPct.toFixed(4)),
    durationCandles: Math.max(1, durationCandles),
    score: trade.score,
    priceHigh,
    priceLow,
    direction: trade.direction
  };
}

export async function runSimulation(candleDataBySymbol: CandleDataBySymbol): Promise<SimulationTradeResult[]> {
  const symbols = Object.keys(candleDataBySymbol);
  if (symbols.length === 0) {
    throw new Error("Simulation input is empty");
  }

  const diagnostics: SimulationDiagnostics = {
    targetTrades: TARGET_TRADE_COUNT,
    symbolsInput: symbols.length,
    symbolsUsable: 0,
    contextsBuilt: 0,
    directionalSignals: 0,
    passedFilters: 0,
    tradesOpened: 0,
    calibrationOverrides: {
      structure: 0,
      supportResistance: 0
    },
    rejectionCounts: {
      scoreThreshold: 0,
      structure: 0,
      microTrend: 0,
      supportResistance: 0,
      execution: 0,
      regime: 0,
      riskReward: 0,
      expectedValue: 0,
      tpVsCosts: 0
    }
  };

  currentRejectionCounts = {
    scoreThreshold: 0,
    structure: 0,
    microTrend: 0,
    supportResistance: 0,
    execution: 0,
    regime: 0,
    riskReward: 0,
    expectedValue: 0,
    tpVsCosts: 0
  };
  currentCalibrationOverrides = {
    structure: 0,
    supportResistance: 0
  };

  const averageVolumeBySymbol = new Map<string, number>();
  const normalized15mBySymbol = new Map<string, Candle[]>();
  const normalizedMtfBySymbol = new Map<string, MultiTimeframeCandles>();

  for (const symbol of symbols) {
    const raw = candleDataBySymbol[symbol];

    if (Array.isArray(raw)) {
      if (raw.length < MIN_INDEX + FORWARD_BUFFER + 1) {
        continue;
      }

      const candles = sortAndValidateCandles(raw, symbol, "15m");
      const baseMs = inferBaseIntervalMs(candles, symbol);
      averageVolumeBySymbol.set(symbol, computeAverageMarketVolume(candles, baseMs));
      normalized15mBySymbol.set(symbol, candles);
      diagnostics.symbolsUsable += 1;
      continue;
    }

    if (typeof raw === "object" && raw != null) {
      const mtf = raw as Partial<Record<SimulationInterval, Candle[]>>;
      const c15 = mtf["15m"];
      const c1h = mtf["1h"];
      const c4h = mtf["4h"];
      const c12h = mtf["12h"];
      const c1d = mtf["1d"];

      if (!Array.isArray(c15) || !Array.isArray(c1h) || !Array.isArray(c4h) || !Array.isArray(c12h) || !Array.isArray(c1d)) {
        continue;
      }

      if (c15.length < MIN_INDEX + FORWARD_BUFFER + 1) {
        continue;
      }

      const sorted15 = sortAndValidateCandles(c15, symbol, "15m");
      const sorted1h = sortAndValidateCandles(c1h, symbol, "1h");
      const sorted4h = sortAndValidateCandles(c4h, symbol, "4h");
      const sorted12h = sortAndValidateCandles(c12h, symbol, "12h");
      const sorted1d = sortAndValidateCandles(c1d, symbol, "1d");

      normalizedMtfBySymbol.set(symbol, {
        "15m": sorted15,
        "1h": sorted1h,
        "4h": sorted4h,
        "12h": sorted12h,
        "1d": sorted1d
      });
      normalized15mBySymbol.set(symbol, sorted15);
      averageVolumeBySymbol.set(symbol, computeAverageMarketVolume(sorted15, TF_15M_MS));
      diagnostics.symbolsUsable += 1;
    }
  }

  const results: SimulationTradeResult[] = [];

  for (const [symbol, candles15m] of normalized15mBySymbol.entries()) {
    const averageMarketVolume = averageVolumeBySymbol.get(symbol) ?? 0;
    const symbolMtf = normalizedMtfBySymbol.get(symbol);

    for (let index = MIN_INDEX; index < candles15m.length - FORWARD_BUFFER; index += 1) {
      const ctx = symbolMtf
        ? buildContextFromMtf(symbolMtf, index, symbol, averageMarketVolume)
        : buildContext(candles15m, index, symbol, averageMarketVolume);
      if (!ctx) {
        continue;
      }
      diagnostics.contextsBuilt += 1;

      const signal = determineSignal(ctx.macro, ctx.intermediary, ctx.micro, {
        daily: ctx.daily,
        twelveh: ctx.twelveh
      });

      if (signal === "NO SIGNAL") {
        continue;
      }
      diagnostics.directionalSignals += 1;

      const confluence = computeConfluenceScore({
        daily: ctx.daily,
        twelveh: ctx.twelveh,
        macro: ctx.macro,
        intermediary: ctx.intermediary,
        microTrigger: ctx.micro,
        signalType: signal,
        volume24h: ctx.volume24h,
        averageMarketVolume: ctx.averageMarketVolume,
        volatilityPct: ctx.volatilityPct
      });

      if (!passesAllFilters(ctx, signal, confluence)) {
        continue;
      }
      diagnostics.passedFilters += 1;

      const trade = openTrade(ctx, signal, confluence, index);
      const outcome = simulateForward(candles15m, index, trade);
      results.push(outcome);
      diagnostics.tradesOpened += 1;

      if (results.length >= TARGET_TRADE_COUNT) {
        diagnostics.calibrationOverrides = { ...currentCalibrationOverrides };
        diagnostics.rejectionCounts = { ...currentRejectionCounts };
        lastSimulationDiagnostics = diagnostics;
        return results;
      }
    }
  }

  diagnostics.calibrationOverrides = { ...currentCalibrationOverrides };
  diagnostics.rejectionCounts = { ...currentRejectionCounts };
  lastSimulationDiagnostics = diagnostics;
  console.warn(
    `[simulate] completed with ${results.length} trades; target ${TARGET_TRADE_COUNT} not reached`
  );
  return results;
}

export type LeveragedBacktestResult = {
  trade: number;
  direction: string;
  entry: number;
  exitPrice: number;
  exitType: "WIN" | "LOSS";
  positionSize: number;
  pnlAbsolute: number;
  pnlPct: number;
  feeOpen: number;
  feeClose: number;
  totalFees: number;
  balanceBefore: number;
  balanceAfter: number;
  durationCandles: number;
};

export type LeveragedBacktestSummary = {
  startingBalance: number;
  finalBalance: number;
  totalReturnPct: number;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  wins: LeveragedBacktestResult[];
  losses: LeveragedBacktestResult[];
  totalFeesCharged: number;
  totalRealizedPnl: number;
  sequence: LeveragedBacktestResult[];
};

export function runLeveragedBalanceBacktest(
  trades: SimulationTradeResult[],
  startingBalance: number = 500,
  leverage: number = 5,
  tpPct: number = 10,
  slPct: number = 10,
  feePerTradeOpen: number = 3,
  feePerTradeClose: number = 3
): LeveragedBacktestSummary {
  const sequence: LeveragedBacktestResult[] = [];
  let balance = startingBalance;
  let wins = 0;
  let losses = 0;
  let totalFees = 0;
  let totalPnl = 0;

  for (let i = 0; i < trades.length; i += 1) {
    const trade = trades[i];
    const tradeNum = i + 1;

    // Deduct opening fee
    const balanceBefore = balance;
    balance -= feePerTradeOpen;
    totalFees += feePerTradeOpen;

    // Calculate position size
    const positionSize = balance * leverage;

    // Determine if trade wins or loses (50/50 based on current data, but we could refine this)
    // For now, use entry and max/min prices reached
    let exitPrice: number;
    let exitType: "WIN" | "LOSS";
    let pnlPct: number;

    if (trade.direction === "LONG") {
      const maxPrice = trade.priceHigh;
      const minPrice = trade.priceLow;
      const upside = ((maxPrice - trade.entry) / trade.entry) * 100;
      const downside = ((trade.entry - minPrice) / trade.entry) * 100;

      // Whichever is hit first determines the result
      if (upside >= tpPct && downside < slPct) {
        // TP hit first
        exitPrice = trade.entry * (1 + tpPct / 100);
        exitType = "WIN";
        pnlPct = tpPct;
        wins += 1;
      } else if (downside >= slPct && upside < tpPct) {
        // SL hit first
        exitPrice = trade.entry * (1 - slPct / 100);
        exitType = "LOSS";
        pnlPct = -slPct;
        losses += 1;
      } else if (upside >= tpPct && downside >= slPct) {
        // Both hit same candle, SL prioritized (loss scenario)
        exitPrice = trade.entry * (1 - slPct / 100);
        exitType = "LOSS";
        pnlPct = -slPct;
        losses += 1;
      } else {
        // Neither hit, use time exit close
        pnlPct = ((trade.exit - trade.entry) / trade.entry) * 100;
        exitPrice = trade.exit;
        exitType = pnlPct >= 0 ? "WIN" : "LOSS";
        if (exitType === "WIN") {
          wins += 1;
        } else {
          losses += 1;
        }
      }
    } else {
      // SHORT
      const minPrice = trade.priceLow;
      const maxPrice = trade.priceHigh;
      const upside = ((maxPrice - trade.entry) / trade.entry) * 100;
      const downside = ((trade.entry - minPrice) / trade.entry) * 100;

      // For SHORT: TP is downside, SL is upside
      if (downside >= tpPct && upside < slPct) {
        // TP hit first
        exitPrice = trade.entry * (1 - tpPct / 100);
        exitType = "WIN";
        pnlPct = tpPct;
        wins += 1;
      } else if (upside >= slPct && downside < tpPct) {
        // SL hit first
        exitPrice = trade.entry * (1 + slPct / 100);
        exitType = "LOSS";
        pnlPct = -slPct;
        losses += 1;
      } else if (downside >= tpPct && upside >= slPct) {
        // Both hit same candle, SL prioritized (loss scenario)
        exitPrice = trade.entry * (1 + slPct / 100);
        exitType = "LOSS";
        pnlPct = -slPct;
        losses += 1;
      } else {
        // Neither hit, use time exit close
        pnlPct = ((trade.entry - trade.exit) / trade.entry) * 100;
        exitPrice = trade.exit;
        exitType = pnlPct >= 0 ? "WIN" : "LOSS";
        if (exitType === "WIN") {
          wins += 1;
        } else {
          losses += 1;
        }
      }
    }

    const pnlAbsolute = (pnlPct / 100) * positionSize;
    balance += pnlAbsolute;

    // Deduct closing fee
    balance -= feePerTradeClose;
    totalFees += feePerTradeClose;
    totalPnl += pnlAbsolute;

    sequence.push({
      trade: tradeNum,
      direction: trade.direction,
      entry: trade.entry,
      exitPrice,
      exitType,
      positionSize: Number(positionSize.toFixed(2)),
      pnlAbsolute: Number(pnlAbsolute.toFixed(2)),
      pnlPct: Number(pnlPct.toFixed(4)),
      feeOpen: feePerTradeOpen,
      feeClose: feePerTradeClose,
      totalFees: feePerTradeOpen + feePerTradeClose,
      balanceBefore: Number(balanceBefore.toFixed(2)),
      balanceAfter: Number(balance.toFixed(2)),
      durationCandles: trade.durationCandles
    });

    // Stop if balance depleted
    if (balance <= 0) {
      console.warn(`[backtest] Balance depleted at trade ${tradeNum}. Stopping.`);
      break;
    }
  }

  const winResults = sequence.filter((r) => r.exitType === "WIN");
  const lossResults = sequence.filter((r) => r.exitType === "LOSS");
  const winRate = sequence.length > 0 ? Number(((wins / sequence.length) * 100).toFixed(2)) : 0;
  const totalReturnPct = Number((((balance - startingBalance) / startingBalance) * 100).toFixed(2));

  return {
    startingBalance,
    finalBalance: Number(balance.toFixed(2)),
    totalReturnPct,
    totalTrades: sequence.length,
    winTrades: wins,
    lossTrades: losses,
    winRate,
    wins: winResults,
    losses: lossResults,
    totalFeesCharged: totalFees,
    totalRealizedPnl: Number(totalPnl.toFixed(2)),
    sequence
  };
}

export function analyzeTPSLStatistics(trades: SimulationTradeResult[]): {
  tp: {
    highest: number;
    percentile90: number;
    percentile75: number;
    median: number;
    percentile25: number;
    percentile10: number;
    lowest: number;
    mean: number;
  };
  sl: {
    highest: number;
    percentile90: number;
    percentile75: number;
    median: number;
    percentile25: number;
    percentile10: number;
    lowest: number;
    mean: number;
  };
  summary: string;
} {
  if (trades.length === 0) {
    throw new Error("No trades to analyze");
  }

  // Calculate TP and SL distances as percentages from entry
  const tpDistances = trades.map((trade) => {
    if (trade.direction === "LONG") {
      return ((trade.priceHigh - trade.entry) / trade.entry) * 100;
    } else {
      return ((trade.entry - trade.priceLow) / trade.entry) * 100;
    }
  });

  const slDistances = trades.map((trade) => {
    if (trade.direction === "LONG") {
      return ((trade.entry - trade.priceLow) / trade.entry) * 100;
    } else {
      return ((trade.priceHigh - trade.entry) / trade.entry) * 100;
    }
  });

  const calculateStats = (distances: number[]) => {
    const sorted = [...distances].sort((a, b) => a - b);
    const length = sorted.length;

    const getPercentile = (p: number) => {
      const index = (p / 100) * (length - 1);
      const lower = Math.floor(index);
      const upper = Math.ceil(index);
      const weight = index % 1;

      if (lower === upper) {
        return sorted[lower];
      }
      return sorted[lower] * (1 - weight) + sorted[upper] * weight;
    };

    const mean = distances.reduce((a, b) => a + b, 0) / distances.length;

    return {
      highest: sorted[length - 1],
      percentile90: getPercentile(90),
      percentile75: getPercentile(75),
      median: getPercentile(50),
      percentile25: getPercentile(25),
      percentile10: getPercentile(10),
      lowest: sorted[0],
      mean: Number(mean.toFixed(4))
    };
  };

  const tpStats = calculateStats(tpDistances);
  const slStats = calculateStats(slDistances);

  const summary = `
TP (Profit Target) Analysis:
  Highest: ${tpStats.highest.toFixed(4)}% | P90: ${tpStats.percentile90.toFixed(4)}% | P75: ${tpStats.percentile75.toFixed(4)}% | 
  Median: ${tpStats.median.toFixed(4)}% | Mean: ${tpStats.mean.toFixed(4)}% | 
  P25: ${tpStats.percentile25.toFixed(4)}% | P10: ${tpStats.percentile10.toFixed(4)}% | Lowest: ${tpStats.lowest.toFixed(4)}%

SL (Stop Loss) Analysis:
  Highest: ${slStats.highest.toFixed(4)}% | P90: ${slStats.percentile90.toFixed(4)}% | P75: ${slStats.percentile75.toFixed(4)}% | 
  Median: ${slStats.median.toFixed(4)}% | Mean: ${slStats.mean.toFixed(4)}% | 
  P25: ${slStats.percentile25.toFixed(4)}% | P10: ${slStats.percentile10.toFixed(4)}% | Lowest: ${slStats.lowest.toFixed(4)}%

Recommended Ranges (ATR Multiples):
  TP at median (${tpStats.median.toFixed(4)}%) ≈ 2.0× ATR for LONG / -2.0× ATR for SHORT
  SL at median (${slStats.median.toFixed(4)}%) ≈ 1.2× ATR for LONG / 1.2× ATR for SHORT

Conservative (P75 TP, P90 SL):
  TP at ${tpStats.percentile75.toFixed(4)}% | SL at ${slStats.percentile90.toFixed(4)}%

Aggressive (P50 TP, P25 SL):
  TP at ${tpStats.median.toFixed(4)}% | SL at ${slStats.percentile25.toFixed(4)}%
  `.trim();

  return {
    tp: tpStats,
    sl: slStats,
    summary
  };
}

export function analyzeResults(trades: SimulationTradeResult[]): {
  totalTrades: number;
  wins: number;
  losses: number;
  timeExits: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  expectedValue: number;
  maxDrawdown: number;
  avgDuration: number;
  distribution: {
    WIN: number;
    LOSS: number;
    TIME_EXIT: number;
  };
} {
  const totalTrades = trades.length;
  if (totalTrades === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      timeExits: 0,
      winRate: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      expectedValue: 0,
      maxDrawdown: 0,
      avgDuration: 0,
      distribution: {
        WIN: 0,
        LOSS: 0,
        TIME_EXIT: 0
      }
    };
  }

  const wins = trades.filter((trade) => trade.result === "WIN");
  const losses = trades.filter((trade) => trade.result === "LOSS");
  const timeExits = trades.filter((trade) => trade.result === "TIME_EXIT");

  const winRate = Number(((wins.length / totalTrades) * 100).toFixed(2));
  const avgWinPct = wins.length > 0
    ? Number((wins.reduce((sum, trade) => sum + trade.pnlPct, 0) / wins.length).toFixed(4))
    : 0;
  const avgLossPct = losses.length > 0
    ? Number((losses.reduce((sum, trade) => sum + trade.pnlPct, 0) / losses.length).toFixed(4))
    : 0;
  const expectedValue = Number((trades.reduce((sum, trade) => sum + trade.pnlPct, 0) / totalTrades).toFixed(4));
  const avgDuration = Number((trades.reduce((sum, trade) => sum + trade.durationCandles, 0) / totalTrades).toFixed(2));

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;

  for (const trade of trades) {
    equity *= (1 + (trade.pnlPct / 100));
    if (equity > peak) {
      peak = equity;
    }

    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return {
    totalTrades,
    wins: wins.length,
    losses: losses.length,
    timeExits: timeExits.length,
    winRate,
    avgWinPct,
    avgLossPct,
    expectedValue,
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    avgDuration,
    distribution: {
      WIN: wins.length,
      LOSS: losses.length,
      TIME_EXIT: timeExits.length
    }
  };
}

function parseCandleInput(value: unknown): CandleDataBySymbol {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error("Simulation input must be an object keyed by symbol");
  }

  const out: CandleDataBySymbol = {};
  for (const [symbol, candlesUnknown] of Object.entries(value)) {
    const parseCandles = (items: unknown, label: string): Candle[] => {
      if (!Array.isArray(items)) {
        throw new Error(`Invalid candle array for symbol ${symbol} ${label}`);
      }

      return items.map((item, index) => {
        if (typeof item !== "object" || item == null) {
          throw new Error(`Invalid candle object for ${symbol} ${label} at index ${index}`);
        }

        const candle = item as Record<string, unknown>;
        return {
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
          volume: Number(candle.volume),
          timestamp: Number(candle.timestamp)
        };
      });
    };

    if (Array.isArray(candlesUnknown)) {
      out[symbol] = parseCandles(candlesUnknown, "15m");
      continue;
    }

    if (typeof candlesUnknown !== "object" || candlesUnknown == null) {
      throw new Error(`Invalid candle payload for symbol ${symbol}`);
    }

    const byInterval = candlesUnknown as Record<string, unknown>;
    out[symbol] = {
      "15m": parseCandles(byInterval["15m"], "15m"),
      "1h": parseCandles(byInterval["1h"], "1h"),
      "4h": parseCandles(byInterval["4h"], "4h"),
      "12h": parseCandles(byInterval["12h"], "12h"),
      "1d": parseCandles(byInterval["1d"], "1d")
    };
  }

  return out;
}

async function runCli(): Promise<void> {
  const filePath = process.argv[2];
  if (filePath === "--help" || filePath === "-h") {
    console.log("Usage: npm run simulate --workspace @hype/api -- <path-to-candle-json>");
    return;
  }

  if (!filePath) {
    throw new Error("Usage: npm run simulate --workspace @hype/api -- <path-to-candle-json>");
  }

  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const candleData = parseCandleInput(parsed);

  const trades = await runSimulation(candleData);
  const summary = analyzeResults(trades);
  const diagnostics = getLastSimulationDiagnostics();
  const tpslAnalysis = analyzeTPSLStatistics(trades);

  // Run leveraged backtest with $500 starting balance, 5x leverage, 10% TP/SL
  const backtest = runLeveragedBalanceBacktest(
    trades,
    500,     // starting balance
    5,       // leverage
    10,      // TP %
    10,      // SL %
    3,       // fee open
    3        // fee close
  );

  console.log(
    JSON.stringify(
      {
        totalTrades: trades.length,
        targetTrades: diagnostics.targetTrades,
        targetReached: trades.length >= diagnostics.targetTrades,
        winRate: summary.winRate,
        avgWin: summary.avgWinPct,
        avgLoss: summary.avgLossPct,
        EV: summary.expectedValue,
        maxDrawdown: summary.maxDrawdown,
        distribution: summary.distribution,
        diagnostics,
        tpslAnalysis: {
          tp: tpslAnalysis.tp,
          sl: tpslAnalysis.sl
        },
        leveragedBacktest: {
          startingBalance: backtest.startingBalance,
          finalBalance: backtest.finalBalance,
          totalReturnPct: backtest.totalReturnPct,
          totalTrades: backtest.totalTrades,
          winTrades: backtest.winTrades,
          lossTrades: backtest.lossTrades,
          winRate: backtest.winRate,
          totalFeesCharged: backtest.totalFeesCharged,
          totalRealizedPnl: backtest.totalRealizedPnl
        }
      },
      null,
      2
    )
  );

  // Print the summary text to stdout (not JSON)
  console.log("\n" + tpslAnalysis.summary);

  // Print backtest summary
  console.log("\n========== LEVERAGED BACKTEST (5x, 10% TP/SL, $500 start) ==========");
  console.log(`Starting Balance: $${backtest.startingBalance}`);
  console.log(`Final Balance: $${backtest.finalBalance}`);
  console.log(`Total Return: ${backtest.totalReturnPct}%`);
  console.log(`Total Change: $${(backtest.finalBalance - backtest.startingBalance).toFixed(2)}`);
  console.log(`---`);
  console.log(`Total Trades: ${backtest.totalTrades}`);
  console.log(`Wins: ${backtest.winTrades} | Losses: ${backtest.lossTrades}`);
  console.log(`Win Rate: ${backtest.winRate}%`);
  console.log(`---`);
  console.log(`Total Fees Charged: $${backtest.totalFeesCharged}`);
  console.log(`Total Realized P&L (before fees): $${backtest.totalRealizedPnl}`);
  console.log(`P&L After Fees: $${(backtest.totalRealizedPnl - backtest.totalFeesCharged).toFixed(2)}`);
  console.log("=====================================================");

  // Print transaction log
  console.log("\nTrade Sequence (first 20 trades):");
  const logLimit = Math.min(20, backtest.sequence.length);
  for (let i = 0; i < logLimit; i += 1) {
    const t = backtest.sequence[i];
    console.log(
      `  Trade ${t.trade}: ${t.direction} | Entry: $${t.entry.toFixed(6)} | Exit: $${t.exitPrice.toFixed(6)} | ` +
      `P&L: ${t.pnlPct > 0 ? "+" : ""}${t.pnlPct.toFixed(2)}% ($${t.pnlAbsolute > 0 ? "+" : ""}${t.pnlAbsolute.toFixed(2)}) | ` +
      `Balance: $${t.balanceAfter.toFixed(2)} | ${t.exitType}`
    );
  }
  if (backtest.sequence.length > 20) {
    console.log(`  ... (${backtest.sequence.length - 20} more trades)`);
  }
}

const isMain = process.argv[1] != null && import.meta.url.endsWith(process.argv[1]);
if (isMain) {
  runCli().catch((error: unknown) => {
    if (error instanceof Error) {
      console.error(error.stack ?? error.message);
    } else {
      console.error(String(error));
    }
    process.exitCode = 1;
  });
}
