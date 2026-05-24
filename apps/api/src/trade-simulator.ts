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

export type CandleDataBySymbol = Record<string, Candle[]>;

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
  tp: number;
  sl: number;
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
};

const TARGET_TRADE_COUNT = 1000;
const MIN_INDEX = 100;
const FORWARD_BUFFER = 50;
const SCORE_THRESHOLD = 7;
const ORDER_NOTIONAL_USD = 100;
const MAX_SPREAD_PCT = 0.06;
const TF_15M_MS = 900_000;

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

export function passesAllFilters(
  ctx: SimulationContext,
  signal: SignalType,
  confluence: { score: number; bias: "SHORT" | "LONG" | null; maxScore: number }
): boolean {
  if (confluence.score < SCORE_THRESHOLD) {
    return false;
  }

  if (!evaluateStructure({ highs1h: ctx.highs1h, lows1h: ctx.lows1h }, signal)) {
    return false;
  }

  if (!evaluateMicroTrend({ price: ctx.price, ema20: ctx.ema20, prevEma20: ctx.prevEma20 }, signal)) {
    return false;
  }

  const high1h = ctx.highs1h[ctx.highs1h.length - 1];
  const low1h = ctx.lows1h[ctx.lows1h.length - 1];
  if (!evaluateSupportResistance({ price: ctx.price, high1h, low1h }, signal)) {
    return false;
  }

  const execution = validateExecution({
    spreadPct: ctx.spreadPct,
    depthUsd: ctx.depthUsd,
    orderNotional: ctx.orderNotional,
    maxSpread: ctx.maxSpreadPct
  });
  if (!execution.ok) {
    return false;
  }

  if (!passesRegime(ctx, signal)) {
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
    return false;
  }

  const winProb = confluence.score / 10;
  const expectedValue = (winProb * tpDistance) - ((1 - winProb) * slDistance);
  if (expectedValue <= 0) {
    return false;
  }

  const slippagePct = execution.slippage * 100;
  const tpDistancePct = (tpDistance / ctx.price) * 100;
  if (tpDistancePct <= (ctx.spreadPct + (slippagePct * 2))) {
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

export function simulateForward(candles: Candle[], startIndex: number, trade: OpenTrade): SimulationTradeResult {
  for (let i = startIndex + 1; i < candles.length; i += 1) {
    const candle = candles[i];
    const elapsed = i - startIndex;

    if (trade.direction === "LONG") {
      const hitTp = candle.high >= trade.tp;
      const hitSl = candle.low <= trade.sl;

      if (hitTp && hitSl) {
        return {
          symbol: trade.symbol,
          signal: trade.signal,
          result: "LOSS",
          entry: trade.entry,
          exit: trade.sl,
          pnlPct: Number((((trade.sl - trade.entry) / trade.entry) * 100).toFixed(4)),
          durationCandles: elapsed,
          score: trade.score
        };
      }

      if (hitTp) {
        return {
          symbol: trade.symbol,
          signal: trade.signal,
          result: "WIN",
          entry: trade.entry,
          exit: trade.tp,
          pnlPct: Number((((trade.tp - trade.entry) / trade.entry) * 100).toFixed(4)),
          durationCandles: elapsed,
          score: trade.score
        };
      }

      if (hitSl) {
        return {
          symbol: trade.symbol,
          signal: trade.signal,
          result: "LOSS",
          entry: trade.entry,
          exit: trade.sl,
          pnlPct: Number((((trade.sl - trade.entry) / trade.entry) * 100).toFixed(4)),
          durationCandles: elapsed,
          score: trade.score
        };
      }
    } else {
      const hitTp = candle.low <= trade.tp;
      const hitSl = candle.high >= trade.sl;

      if (hitTp && hitSl) {
        return {
          symbol: trade.symbol,
          signal: trade.signal,
          result: "LOSS",
          entry: trade.entry,
          exit: trade.sl,
          pnlPct: Number((((trade.entry - trade.sl) / trade.entry) * 100).toFixed(4)),
          durationCandles: elapsed,
          score: trade.score
        };
      }

      if (hitTp) {
        return {
          symbol: trade.symbol,
          signal: trade.signal,
          result: "WIN",
          entry: trade.entry,
          exit: trade.tp,
          pnlPct: Number((((trade.entry - trade.tp) / trade.entry) * 100).toFixed(4)),
          durationCandles: elapsed,
          score: trade.score
        };
      }

      if (hitSl) {
        return {
          symbol: trade.symbol,
          signal: trade.signal,
          result: "LOSS",
          entry: trade.entry,
          exit: trade.sl,
          pnlPct: Number((((trade.entry - trade.sl) / trade.entry) * 100).toFixed(4)),
          durationCandles: elapsed,
          score: trade.score
        };
      }
    }

    if (trade.signal.startsWith("REVERSAL") && elapsed > 6) {
      return {
        symbol: trade.symbol,
        signal: trade.signal,
        result: "TIME_EXIT",
        entry: trade.entry,
        exit: candle.close,
        pnlPct: Number((trade.direction === "LONG"
          ? ((candle.close - trade.entry) / trade.entry) * 100
          : ((trade.entry - candle.close) / trade.entry) * 100).toFixed(4)),
        durationCandles: elapsed,
        score: trade.score
      };
    }

    if (trade.signal.startsWith("STRONG") && elapsed > 16) {
      return {
        symbol: trade.symbol,
        signal: trade.signal,
        result: "TIME_EXIT",
        entry: trade.entry,
        exit: candle.close,
        pnlPct: Number((trade.direction === "LONG"
          ? ((candle.close - trade.entry) / trade.entry) * 100
          : ((trade.entry - candle.close) / trade.entry) * 100).toFixed(4)),
        durationCandles: elapsed,
        score: trade.score
      };
    }

    if (elapsed > 24) {
      return {
        symbol: trade.symbol,
        signal: trade.signal,
        result: "TIME_EXIT",
        entry: trade.entry,
        exit: candle.close,
        pnlPct: Number((trade.direction === "LONG"
          ? ((candle.close - trade.entry) / trade.entry) * 100
          : ((trade.entry - candle.close) / trade.entry) * 100).toFixed(4)),
        durationCandles: elapsed,
        score: trade.score
      };
    }
  }

  const last = candles[candles.length - 1];
  return {
    symbol: trade.symbol,
    signal: trade.signal,
    result: "TIME_EXIT",
    entry: trade.entry,
    exit: last.close,
    pnlPct: Number((trade.direction === "LONG"
      ? ((last.close - trade.entry) / trade.entry) * 100
      : ((trade.entry - last.close) / trade.entry) * 100).toFixed(4)),
    durationCandles: Math.max(1, candles.length - 1 - startIndex),
    score: trade.score
  };
}

export async function runSimulation(candleDataBySymbol: CandleDataBySymbol): Promise<SimulationTradeResult[]> {
  const symbols = Object.keys(candleDataBySymbol);
  if (symbols.length === 0) {
    throw new Error("Simulation input is empty");
  }

  const averageVolumeBySymbol = new Map<string, number>();
  const normalizedData = new Map<string, Candle[]>();

  for (const symbol of symbols) {
    const candlesRaw = candleDataBySymbol[symbol];
    if (!Array.isArray(candlesRaw) || candlesRaw.length < MIN_INDEX + FORWARD_BUFFER + 1) {
      continue;
    }

    const candles = [...candlesRaw].sort((left, right) => left.timestamp - right.timestamp);
    candles.forEach((candle, idx) => validateCandle(candle, symbol, idx));

    const baseMs = inferBaseIntervalMs(candles, symbol);
    averageVolumeBySymbol.set(symbol, computeAverageMarketVolume(candles, baseMs));
    normalizedData.set(symbol, candles);
  }

  const results: SimulationTradeResult[] = [];

  for (const [symbol, candles] of normalizedData.entries()) {
    const averageMarketVolume = averageVolumeBySymbol.get(symbol) ?? 0;

    for (let index = MIN_INDEX; index < candles.length - FORWARD_BUFFER; index += 1) {
      const ctx = buildContext(candles, index, symbol, averageMarketVolume);
      if (!ctx) {
        continue;
      }

      const signal = determineSignal(ctx.macro, ctx.intermediary, ctx.micro, {
        daily: ctx.daily,
        twelveh: ctx.twelveh
      });

      if (signal === "NO SIGNAL") {
        continue;
      }

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

      const trade = openTrade(ctx, signal, confluence, index);
      const outcome = simulateForward(candles, index, trade);
      results.push(outcome);

      if (results.length >= TARGET_TRADE_COUNT) {
        return results;
      }
    }
  }

  throw new Error(`Simulation ended with ${results.length} trades. Required ${TARGET_TRADE_COUNT}.`);
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
    if (!Array.isArray(candlesUnknown)) {
      throw new Error(`Invalid candle array for symbol ${symbol}`);
    }

    const candles: Candle[] = candlesUnknown.map((item, index) => {
      if (typeof item !== "object" || item == null) {
        throw new Error(`Invalid candle object for ${symbol} at index ${index}`);
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

    out[symbol] = candles;
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

  console.log(
    JSON.stringify(
      {
        totalTrades: trades.length,
        winRate: summary.winRate,
        avgWin: summary.avgWinPct,
        avgLoss: summary.avgLossPct,
        EV: summary.expectedValue,
        maxDrawdown: summary.maxDrawdown,
        distribution: summary.distribution
      },
      null,
      2
    )
  );
}

const isMain = process.argv[1] != null && import.meta.url.endsWith(process.argv[1]);
if (isMain) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
