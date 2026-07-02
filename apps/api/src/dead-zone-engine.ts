/**
 * Dead Zone / Pre-Pump Detection Engine
 *
 * Scores assets on their probability of transitioning through:
 *   Capitulation → Accumulation → Early Accumulation → Pre-Pump → Breakout
 *
 * Returns three scores + stage classification per symbol.
 * Does NOT give buy signals — estimates probability of phase transition.
 */

import { MACD, EMA, RSI, ATR } from "technicalindicators";
import { calculateStochasticRsiSeries, calculateLatestRsi } from "./rsi.js";

export type DeadZoneStage =
  | "IGNORE"
  | "WATCHLIST"
  | "DEAD_ZONE"
  | "EARLY_ACCUMULATION"
  | "PRE_PUMP"
  | "CONFIRMED_BREAKOUT";

export interface DeadZoneResult {
  deadZoneScore: number;   // 0-100: how deep in exhaustion/accumulation
  prePumpScore: number;    // 0-100: how close to a breakout trigger
  breakoutScore: number;   // 0-100: how confirmed the breakout is
  stage: DeadZoneStage;
  confidence: number;      // 0-100
  reasons: string[];
  fundingRate: number;     // raw funding rate (negative = shorts paying longs)
}

interface OhlcvCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getMacdSeries(closes: number[]) {
  if (closes.length < 35) return [];
  return MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
}

function getEmaSeries(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  return EMA.calculate({ period, values: closes });
}

function getAtrSeries(highs: number[], lows: number[], closes: number[], period: number = 14): number[] {
  if (closes.length < period + 1) return [];
  return ATR.calculate({ high: highs, low: lows, close: closes, period });
}

function getRsiSeries(closes: number[], period: number = 14): number[] {
  if (closes.length < period + 2) return [];
  return RSI.calculate({ period, values: closes });
}

/**
 * Detect if series is making higher lows over last N points
 * (each local min is higher than previous local min)
 */
function hasHigherLows(series: number[], lookback: number = 10): boolean {
  if (series.length < lookback) return false;
  const slice = series.slice(-lookback);
  let prevLow = Infinity;
  let higherLowCount = 0;
  let lowerLowCount = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i] < slice[i - 1] && slice[i - 1] <= (slice[i - 2] ?? slice[i - 1])) {
      // local low
      if (slice[i] > prevLow) higherLowCount++;
      else lowerLowCount++;
      prevLow = slice[i];
    }
  }
  return higherLowCount > lowerLowCount && higherLowCount >= 1;
}

/**
 * Is the series slope flattening? Compare last N-candle slope to prior N-candle slope
 */
function isSlopeFlattening(series: number[], window: number = 5): boolean {
  if (series.length < window * 2) return false;
  const recent = series.slice(-window);
  const prior = series.slice(-window * 2, -window);
  const recentSlope = (recent[recent.length - 1] - recent[0]) / window;
  const priorSlope = (prior[prior.length - 1] - prior[0]) / window;
  // Flattening = recent slope less negative (or less positive) than prior
  return Math.abs(recentSlope) < Math.abs(priorSlope) * 0.7;
}

/**
 * Is the histogram improving (becoming less negative / more positive) for N candles?
 */
function isMacdHistogramImproving(histograms: (number | undefined)[], n: number = 3): boolean {
  const valid = histograms.filter((h): h is number => typeof h === "number");
  if (valid.length < n + 1) return false;
  const tail = valid.slice(-n - 1);
  let improving = true;
  for (let i = 1; i < tail.length; i++) {
    if (tail[i] <= tail[i - 1]) { improving = false; break; }
  }
  return improving;
}

/**
 * Is ATR contracting over last N candles?
 */
function isAtrContracting(atrSeries: number[], n: number = 7): boolean {
  if (atrSeries.length < n) return false;
  const tail = atrSeries.slice(-n);
  const firstHalf = tail.slice(0, Math.floor(n / 2));
  const secondHalf = tail.slice(Math.floor(n / 2));
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  return avgSecond < avgFirst * 0.9; // 10%+ contraction
}

/**
 * Is ATR expanding after contraction? (volatility expansion signal)
 */
function isAtrExpandingAfterContraction(atrSeries: number[], window: number = 14): boolean {
  if (atrSeries.length < window) return false;
  const tail = atrSeries.slice(-window);
  const minIdx = tail.indexOf(Math.min(...tail));
  // Contraction then expansion: min is not in last 2 candles
  if (minIdx >= tail.length - 2) return false;
  // Last value is greater than min by at least 15%
  return tail[tail.length - 1] > tail[minIdx] * 1.15;
}

/**
 * Is volume compressing? (recent avg < prior avg)
 */
function isVolumeCompressing(volumes: number[], n: number = 14): boolean {
  if (volumes.length < n * 2) return false;
  const recent = volumes.slice(-n).reduce((a, b) => a + b, 0) / n;
  const prior = volumes.slice(-n * 2, -n).reduce((a, b) => a + b, 0) / n;
  return recent < prior * 0.85;
}

/**
 * Is volume beginning to increase? (last 7d avg > prior 7d avg)
 */
function isVolumeIncreasing(volumes: number[], n: number = 7): boolean {
  if (volumes.length < n * 2) return false;
  const recent = volumes.slice(-n).reduce((a, b) => a + b, 0) / n;
  const prior = volumes.slice(-n * 2, -n).reduce((a, b) => a + b, 0) / n;
  return recent > prior * 1.15;
}

/**
 * Is selling momentum decreasing? (bearish candle body sizes shrinking)
 */
function isSellingMomentumDecreasing(candles: OhlcvCandle[], n: number = 10): boolean {
  if (candles.length < n * 2) return false;
  const bearishBody = (c: OhlcvCandle) =>
    c.close < c.open ? c.open - c.close : 0;

  const recent = candles.slice(-n).map(bearishBody);
  const prior = candles.slice(-n * 2, -n).map(bearishBody);

  const recentAvg = recent.reduce((a, b) => a + b, 0) / n;
  const priorAvg = prior.reduce((a, b) => a + b, 0) / n;

  return recentAvg < priorAvg * 0.8;
}

/**
 * Has MACD line crossed above signal (bullish crossover in last 3 candles)?
 */
function hasMacdBullishCrossover(macdSeries: ReturnType<typeof getMacdSeries>, n: number = 3): boolean {
  if (macdSeries.length < n + 1) return false;
  const tail = macdSeries.slice(-n - 1);
  // Look for crossing: prev MACD < signal, current MACD > signal
  for (let i = 1; i < tail.length; i++) {
    const prev = tail[i - 1];
    const curr = tail[i];
    if (
      typeof prev.MACD === "number" && typeof prev.signal === "number" &&
      typeof curr.MACD === "number" && typeof curr.signal === "number" &&
      prev.MACD < prev.signal && curr.MACD >= curr.signal
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Is MACD approaching a crossover? (MACD below signal but histogram gap closing)
 */
function isMacdApproachingCrossover(macdSeries: ReturnType<typeof getMacdSeries>): boolean {
  if (macdSeries.length < 5) return false;
  const tail = macdSeries.slice(-5);
  const latest = tail[tail.length - 1];
  if (typeof latest.MACD !== "number" || typeof latest.signal !== "number") return false;
  if (latest.MACD >= latest.signal) return false; // already crossed
  // Gap narrowing
  const gaps = tail
    .filter(d => typeof d.MACD === "number" && typeof d.signal === "number")
    .map(d => (d.signal as number) - (d.MACD as number));
  return gaps.length >= 3 && gaps[gaps.length - 1] < gaps[0] * 0.6;
}

/**
 * Bullish divergence: RSI making higher lows while price making lower lows
 */
function hasBullishDivergence(closes: number[], rsiSeries: number[], lookback: number = 20): boolean {
  if (closes.length < lookback || rsiSeries.length < lookback) return false;
  const priceSlice = closes.slice(-lookback);
  const rsiSlice = rsiSeries.slice(-lookback);

  const priceMin1 = Math.min(...priceSlice.slice(0, lookback / 2));
  const priceMin2 = Math.min(...priceSlice.slice(lookback / 2));
  const rsiMin1 = Math.min(...rsiSlice.slice(0, lookback / 2));
  const rsiMin2 = Math.min(...rsiSlice.slice(lookback / 2));

  // Price making lower lows, RSI making higher lows
  return priceMin2 < priceMin1 && rsiMin2 > rsiMin1 + 2;
}

/**
 * Break of descending trendline: price closes above recent swing highs
 */
function hasTrendlineBreak(closes: number[], highs: number[], lookback: number = 20): boolean {
  if (closes.length < lookback) return false;
  const recentHighs = highs.slice(-lookback, -1);
  const maxHighInPrior = Math.max(...recentHighs);
  const currentClose = closes[closes.length - 1];
  // If current close breaks above the prior N-candle high zone
  return currentClose > maxHighInPrior * 0.98;
}

// ─── Main Scorer ─────────────────────────────────────────────────────────────

export function scoreDeadZone(
  candles: OhlcvCandle[],
  currentPrice: number,
  yearlyLow: number,
  yearlyHigh: number,
  fundingRate: number = 0
): DeadZoneResult {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const macdSeries = getMacdSeries(closes);
  const ema20Series = getEmaSeries(closes, 20);
  const ema50Series = getEmaSeries(closes, 50);
  const atrSeries = getAtrSeries(highs, lows, closes);
  const rsiSeries = getRsiSeries(closes);
  const stochSeries = calculateStochasticRsiSeries(closes);

  const latestRsi = rsiSeries.at(-1) ?? 50;
  const latestStochK = stochSeries.at(-1)?.k ?? 50;
  const latestHistogram = macdSeries.at(-1)?.histogram;
  const histograms = macdSeries.map(d => d.histogram);

  const distFromYearlyLow = yearlyLow > 0
    ? ((currentPrice - yearlyLow) / yearlyLow) * 100
    : 100;

  // ── Dead Zone Score ────────────────────────────────────────────────────────
  let deadScore = 0;
  const deadReasons: string[] = [];

  if (latestRsi < 30) {
    deadScore += 10;
    deadReasons.push("RSI oversold");
  } else if (latestRsi < 40) {
    deadScore += 5;
    deadReasons.push("RSI near oversold");
  }

  if (latestStochK < 20) {
    deadScore += 10;
    deadReasons.push("StochRSI deeply oversold");
  } else if (latestStochK < 35) {
    deadScore += 5;
    deadReasons.push("StochRSI oversold");
  }

  if (isMacdHistogramImproving(histograms, 3)) {
    deadScore += 15;
    deadReasons.push("MACD histogram improving 3+ candles");
  } else if (isMacdHistogramImproving(histograms, 2)) {
    deadScore += 8;
    deadReasons.push("MACD histogram improving");
  }

  if (distFromYearlyLow <= 10) {
    deadScore += 15;
    deadReasons.push("Within 10% of yearly low");
  } else if (distFromYearlyLow <= 20) {
    deadScore += 8;
    deadReasons.push("Within 20% of yearly low");
  }

  if (isSlopeFlattening(ema20Series, 5)) {
    deadScore += 15;
    deadReasons.push("EMA20 slope flattening");
  }

  if (isAtrContracting(atrSeries)) {
    deadScore += 10;
    deadReasons.push("ATR contracting (volatility squeeze)");
  }

  if (isVolumeCompressing(volumes)) {
    deadScore += 10;
    deadReasons.push("Volume compressing");
  }

  if (isSellingMomentumDecreasing(candles)) {
    deadScore += 15;
    deadReasons.push("Selling momentum decreasing");
  }

  // Funding rate: negative = shorts paying longs = accumulation signal
  // Typically expressed as decimal e.g. -0.0001 = -0.01%
  if (fundingRate <= -0.0003) {
    deadScore += 20;
    deadReasons.push(`Funding deeply negative (${(fundingRate * 100).toFixed(4)}%)`);
  } else if (fundingRate <= -0.0001) {
    deadScore += 12;
    deadReasons.push(`Funding negative (${(fundingRate * 100).toFixed(4)}%)`);
  } else if (fundingRate < 0) {
    deadScore += 6;
    deadReasons.push(`Funding slightly negative (${(fundingRate * 100).toFixed(4)}%)`);
  } else if (fundingRate > 0.0003) {
    // Crowded longs = risk, reduce dead zone confidence
    deadScore -= 10;
    deadReasons.push(`Funding positive — crowded longs (${(fundingRate * 100).toFixed(4)}%)`);
  }

  deadScore = Math.min(100, Math.max(0, deadScore));

  // ── Pre-Pump Score ─────────────────────────────────────────────────────────
  let prePumpScore = 0;
  const prePumpReasons: string[] = [];

  if (isMacdApproachingCrossover(macdSeries)) {
    prePumpScore += 20;
    prePumpReasons.push("MACD approaching bullish crossover");
  }

  if (hasHigherLows(rsiSeries, 12)) {
    prePumpScore += 20;
    prePumpReasons.push("RSI making higher lows");
  }

  if (hasHigherLows(closes, 12)) {
    prePumpScore += 15;
    prePumpReasons.push("Price making higher lows");
  }

  if (isSlopeFlattening(ema20Series, 5)) {
    prePumpScore += 10;
    prePumpReasons.push("EMA20 flattening");
  }

  if (isVolumeIncreasing(volumes)) {
    prePumpScore += 15;
    prePumpReasons.push("Volume beginning to increase");
  }

  if (hasBullishDivergence(closes, rsiSeries)) {
    prePumpScore += 10;
    prePumpReasons.push("Bullish RSI divergence");
  }

  if (isAtrExpandingAfterContraction(atrSeries)) {
    prePumpScore += 10;
    prePumpReasons.push("Volatility expanding after contraction");
  }

  // Negative funding + pre-pump signals = short squeeze potential
  if (fundingRate < -0.0001 && prePumpScore >= 20) {
    prePumpScore += 15;
    prePumpReasons.push("Negative funding + momentum building = short squeeze risk");
  }

  prePumpScore = Math.min(100, prePumpScore);

  // ── Breakout Score ─────────────────────────────────────────────────────────
  let breakoutScore = 0;
  const breakoutReasons: string[] = [];

  const avgVol30 = volumes.slice(-30).reduce((a, b) => a + b, 0) / 30;
  const latestVol = volumes.at(-1) ?? 0;
  if (latestVol > avgVol30 * 2) {
    breakoutScore += 20;
    breakoutReasons.push("Volume 2x+ average");
  } else if (latestVol > avgVol30 * 1.5) {
    breakoutScore += 10;
    breakoutReasons.push("Volume elevated");
  }

  if (hasTrendlineBreak(closes, highs)) {
    breakoutScore += 20;
    breakoutReasons.push("Trendline break");
  }

  const latestEma20 = ema20Series.at(-1);
  if (latestEma20 && currentPrice > latestEma20) {
    breakoutScore += 20;
    breakoutReasons.push("Close above EMA20");
  }

  if (hasMacdBullishCrossover(macdSeries)) {
    breakoutScore += 20;
    breakoutReasons.push("MACD bullish crossover");
  }

  if (latestRsi > 55) {
    breakoutScore += 10;
    breakoutReasons.push("RSI above 55");
  }

  // Higher high
  const recentCloses = closes.slice(-10);
  const prevHigh = Math.max(...closes.slice(-20, -10));
  if (Math.max(...recentCloses) > prevHigh) {
    breakoutScore += 10;
    breakoutReasons.push("Higher high formed");
  }

  breakoutScore = Math.min(100, breakoutScore);

  // ── Stage Classification ───────────────────────────────────────────────────
  let stage: DeadZoneStage;

  if (breakoutScore >= 60) {
    stage = "CONFIRMED_BREAKOUT";
  } else if (prePumpScore >= 55 && deadScore >= 40) {
    stage = "PRE_PUMP";
  } else if (prePumpScore >= 35 && deadScore >= 50) {
    stage = "EARLY_ACCUMULATION";
  } else if (deadScore >= 50) {
    stage = "DEAD_ZONE";
  } else if (deadScore >= 30 || prePumpScore >= 25) {
    stage = "WATCHLIST";
  } else {
    stage = "IGNORE";
  }

  // ── Confidence ────────────────────────────────────────────────────────────
  // Based on data depth and signal agreement
  const dataDepth = Math.min(100, (candles.length / 365) * 100);
  const signalCount = deadReasons.length + prePumpReasons.length + breakoutReasons.length;
  const signalConfidence = Math.min(100, signalCount * 8);
  const confidence = Math.round((dataDepth * 0.3 + signalConfidence * 0.7));

  // ── Reasons (top signals only) ─────────────────────────────────────────────
  const allReasons = [...deadReasons, ...prePumpReasons, ...breakoutReasons];

  return {
    deadZoneScore: deadScore,
    prePumpScore,
    breakoutScore,
    stage,
    confidence: Math.min(100, confidence),
    reasons: allReasons,
    fundingRate,
  };
}
