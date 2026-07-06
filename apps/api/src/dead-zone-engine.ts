/**
 * Capitulation -> Recovery -> Accumulation -> Pre-Pump engine.
 *
 * Returns multi-factor phase scores and stage classification.
 */

import { ATR, MACD, RSI } from "technicalindicators";
import { calculateStochasticRsiSeries } from "./rsi.js";

export type DeadZoneStage =
  | "IGNORE"
  | "CAPITULATION"
  | "RECOVERING_CAPITULATION"
  | "RECOVERY"
  | "ACCUMULATION"
  | "PRE_PUMP"
  | "ACTIVE_RUN"
  | "OVEREXTENDED"
  | "DEAD_CAPITULATION";

export interface DeadZoneResult {
  deadZoneScore: number; // legacy alias of capitulationScore
  capitulationScore: number;
  recoveryScore: number;
  accumulationScore: number;
  prePumpScore: number;
  breakoutScore: number; // legacy proxy used by fast-pump scan
  confluenceScore: number; // 0-11
  obsScore: number; // Order Book Strength (0-100)
  momentumRank: number; // 0-100
  riskRank: number; // 0-100 (higher is safer)
  stage: DeadZoneStage;
  confidence: number;
  reasons: string[];
  fundingRate: number;
  volumeDeltaPct: number;
  volumeSpikeX: number;
  openInterestDeltaPct: number | null;
  qualityRejected: boolean;
}

interface OhlcvCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface DeadZoneContext {
  dayNotionalVolumeUsd?: number | null;
  orderbookImbalance?: number | null;
  orderbookDelta?: number | null;
  bidDepthUsd?: number | null;
  askDepthUsd?: number | null;
  bidDepthDeltaPct?: number | null;
  askDepthDeltaPct?: number | null;
  openInterestDeltaPct?: number | null;
}

export interface ObsInput {
  currentImbalance: number;
  deltaImbalance: number;
  bidDepthGrowthPct: number;
  askDepthDecayPct: number;
  fundingRate: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeOrderBookStrengthScore(input: ObsInput): number {
  const currentImbalanceScore = clamp(((input.currentImbalance + 1) / 2) * 100, 0, 100);
  const deltaImbalanceScore = clamp(((input.deltaImbalance + 1) / 2) * 100, 0, 100);
  const bidDepthGrowthScore = clamp((input.bidDepthGrowthPct + 1) * 50, 0, 100);

  let fundingDivergenceScore = 50;
  if (input.fundingRate <= -0.0003) fundingDivergenceScore = 95;
  else if (input.fundingRate <= -0.0001) fundingDivergenceScore = 80;
  else if (input.fundingRate <= -0.00003) fundingDivergenceScore = 65;
  else if (input.fundingRate >= 0.00015) fundingDivergenceScore = 15;
  else if (input.fundingRate >= 0.00008) fundingDivergenceScore = 25;

  // Liquidity absorption proxy: increasing bids while asks decay reinforces genuine support.
  const absorptionBoost = clamp((input.bidDepthGrowthPct - input.askDepthDecayPct) * 8, -10, 10);

  const weighted =
    currentImbalanceScore * 0.4 +
    deltaImbalanceScore * 0.3 +
    bidDepthGrowthScore * 0.2 +
    fundingDivergenceScore * 0.1 +
    absorptionBoost;

  return Math.round(clamp(weighted, 0, 100));
}

function avg(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

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

function getAtrSeries(highs: number[], lows: number[], closes: number[], period: number = 14): number[] {
  if (closes.length < period + 1) return [];
  return ATR.calculate({ high: highs, low: lows, close: closes, period });
}

function getRsiSeries(closes: number[], period: number = 14): number[] {
  if (closes.length < period + 2) return [];
  return RSI.calculate({ period, values: closes });
}

function hasHigherLows(series: number[], lookback: number = 12): boolean {
  if (series.length < lookback) return false;
  const slice = series.slice(-lookback);
  let prevLocalLow = Number.POSITIVE_INFINITY;
  let improving = 0;
  for (let i = 1; i < slice.length - 1; i++) {
    const current = slice[i];
    if (current <= slice[i - 1] && current <= slice[i + 1]) {
      if (current > prevLocalLow) {
        improving++;
      }
      prevLocalLow = current;
    }
  }
  return improving >= 1;
}

function isMacdHistogramImproving(histograms: Array<number | undefined>, n: number = 3): boolean {
  const values = histograms.filter((v): v is number => typeof v === "number");
  if (values.length < n + 1) return false;
  const tail = values.slice(-n - 1);
  for (let i = 1; i < tail.length; i++) {
    if (tail[i] <= tail[i - 1]) {
      return false;
    }
  }
  return true;
}

function isAtrContracting(atrSeries: number[], n: number = 8): boolean {
  if (atrSeries.length < n) return false;
  const tail = atrSeries.slice(-n);
  const firstHalf = tail.slice(0, Math.floor(n / 2));
  const secondHalf = tail.slice(Math.floor(n / 2));
  return avg(secondHalf) < avg(firstHalf) * 0.9;
}

function hasBullishDivergence(closes: number[], rsiSeries: number[], lookback: number = 20): boolean {
  if (closes.length < lookback || rsiSeries.length < lookback) return false;
  const split = Math.floor(lookback / 2);
  const closeSlice = closes.slice(-lookback);
  const rsiSlice = rsiSeries.slice(-lookback);
  const priceMin1 = Math.min(...closeSlice.slice(0, split));
  const priceMin2 = Math.min(...closeSlice.slice(split));
  const rsiMin1 = Math.min(...rsiSlice.slice(0, split));
  const rsiMin2 = Math.min(...rsiSlice.slice(split));
  return priceMin2 < priceMin1 && rsiMin2 > rsiMin1 + 2;
}

function hasTrendlineBreak(closes: number[], highs: number[], lookback: number = 20): boolean {
  if (closes.length < lookback) return false;
  const priorHigh = Math.max(...highs.slice(-lookback, -1));
  const currentClose = closes.at(-1) ?? 0;
  return currentClose > priorHigh * 0.98;
}

export function scoreDeadZone(
  candles: OhlcvCandle[],
  currentPrice: number,
  yearlyLow: number,
  yearlyHigh: number,
  fundingRate: number = 0,
  context: DeadZoneContext = {},
): DeadZoneResult {
  if (candles.length < 30) {
    return {
      deadZoneScore: 0,
      capitulationScore: 0,
      recoveryScore: 0,
      accumulationScore: 0,
      prePumpScore: 0,
      breakoutScore: 0,
      confluenceScore: 0,
      obsScore: 0,
      momentumRank: 0,
      riskRank: 0,
      stage: "IGNORE",
      confidence: 0,
      reasons: ["Insufficient candles"],
      fundingRate,
      volumeDeltaPct: 0,
      volumeSpikeX: 1,
      openInterestDeltaPct: context.openInterestDeltaPct ?? null,
      qualityRejected: false,
    };
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const macdSeries = getMacdSeries(closes);
  const rsiSeries = getRsiSeries(closes);
  const atrSeries = getAtrSeries(highs, lows, closes);
  const stochSeries = calculateStochasticRsiSeries(closes);

  const latestRsi = rsiSeries.at(-1) ?? 50;
  const latestStochK = stochSeries.at(-1)?.k ?? 50;
  const histograms = macdSeries.map((d) => d.histogram);
  const latestHistogram = macdSeries.at(-1)?.histogram ?? 0;

  const distFromYearlyLow = yearlyLow > 0 ? ((currentPrice - yearlyLow) / yearlyLow) * 100 : 100;
  const rangePosition = yearlyHigh > yearlyLow
    ? ((currentPrice - yearlyLow) / (yearlyHigh - yearlyLow)) * 100
    : 0;

  const previousRsi = rsiSeries.length > 6 ? rsiSeries[rsiSeries.length - 6] : latestRsi;
  const rsiSlope = latestRsi - previousRsi;

  const recent7Vol = avg(volumes.slice(-7));
  const prior7Vol = avg(volumes.slice(-14, -7));
  const volumeDeltaPct = prior7Vol > 0 ? (recent7Vol - prior7Vol) / prior7Vol : 0;
  const volumeSpikeX = prior7Vol > 0 ? recent7Vol / prior7Vol : 1;

  const latestClose = closes.at(-1) ?? currentPrice;
  const prevClose = closes.at(-2) ?? latestClose;
  const priceChange1dPct = prevClose > 0 ? ((latestClose - prevClose) / prevClose) * 100 : 0;

  const high90 = Math.max(...highs.slice(-90));
  const drawdown90d = high90 > 0 ? ((high90 - currentPrice) / high90) * 100 : 0;

  let consecutiveRed = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) {
      consecutiveRed++;
      continue;
    }
    break;
  }

  const hasPriceHigherLows = hasHigherLows(closes, 14);
  const macdImproving = isMacdHistogramImproving(histograms, 3);
  const stochCrossUp = stochSeries.length >= 2
    ? (stochSeries.at(-2)?.k ?? 50) < (stochSeries.at(-2)?.d ?? 50) && latestStochK >= (stochSeries.at(-1)?.d ?? 50)
    : false;
  const low7 = Math.min(...lows.slice(-7));
  const holdAboveRecentLow = latestClose >= low7 * 1.03;

  const greenCandles = candles.slice(-10).filter((c) => c.close > c.open);
  const redCandles = candles.slice(-10).filter((c) => c.close <= c.open);
  const greenVolAvg = greenCandles.length > 0 ? avg(greenCandles.map((c) => c.volume)) : 0;
  const redVolAvg = redCandles.length > 0 ? avg(redCandles.map((c) => c.volume)) : 0;

  const atrContracting = isAtrContracting(atrSeries);
  const oiDelta = context.openInterestDeltaPct ?? null;
  const orderbookImbalance = context.orderbookImbalance ?? 0;
  const orderbookDelta = context.orderbookDelta ?? 0;
  const bidDepthDeltaPct = context.bidDepthDeltaPct ?? 0;
  const askDepthDeltaPct = context.askDepthDeltaPct ?? 0;
  const dayNotionalVolumeUsd = context.dayNotionalVolumeUsd ?? 0;

  const obsScore = computeOrderBookStrengthScore({
    currentImbalance: orderbookImbalance,
    deltaImbalance: orderbookDelta,
    bidDepthGrowthPct: bidDepthDeltaPct,
    askDepthDecayPct: askDepthDeltaPct,
    fundingRate,
  });

  const reasons: string[] = [];

  let capitulationScore = 0;
  if (distFromYearlyLow <= 15) {
    capitulationScore += 14;
    reasons.push("Near yearly low");
  } else if (distFromYearlyLow <= 25) {
    capitulationScore += 8;
  }
  if (latestRsi <= 32) {
    capitulationScore += 14;
    reasons.push("RSI deeply weak");
  } else if (latestRsi <= 40) {
    capitulationScore += 8;
  }
  if (drawdown90d >= 65) {
    capitulationScore += 14;
    reasons.push("Large 90d drawdown");
  } else if (drawdown90d >= 45) {
    capitulationScore += 8;
  }
  if (consecutiveRed >= 4) {
    capitulationScore += 10;
  } else if (consecutiveRed >= 2) {
    capitulationScore += 5;
  }
  if (volumeDeltaPct < -0.15) {
    capitulationScore += 10;
    reasons.push("Volume contraction");
  }
  if (fundingRate <= -0.0003) {
    capitulationScore += 14;
    reasons.push("Funding deeply negative");
  } else if (fundingRate < -0.00008) {
    capitulationScore += 8;
  }
  if (oiDelta !== null && oiDelta <= -0.12) {
    capitulationScore += 8;
  }
  capitulationScore = Math.max(0, Math.min(100, capitulationScore));

  let recoveryScore = 0;
  if (rsiSlope > 2) recoveryScore += 18;
  else if (rsiSlope > 0.8) recoveryScore += 10;
  if (macdImproving) {
    recoveryScore += 14;
    reasons.push("MACD histogram improving");
  }
  if (stochCrossUp) recoveryScore += 12;
  if (hasPriceHigherLows) recoveryScore += 16;
  if (holdAboveRecentLow) recoveryScore += 10;
  if (volumeDeltaPct > 0.15) recoveryScore += 14;
  if (oiDelta !== null && oiDelta > -0.03) recoveryScore += 8;
  recoveryScore = Math.max(0, Math.min(100, recoveryScore));

  let accumulationScore = 0;
  if (hasPriceHigherLows) accumulationScore += 16;
  if (drawdown90d >= 45 && distFromYearlyLow <= 25) accumulationScore += 12;
  if (greenVolAvg > 0 && redVolAvg > 0 && greenVolAvg > redVolAvg * 1.1) {
    accumulationScore += 16;
    reasons.push("Green-candle volume leadership");
  }
  if (fundingRate < -0.00008 && priceChange1dPct > 0) {
    accumulationScore += 12;
    reasons.push("Price up while funding stays negative");
  }
  if (orderbookImbalance > 0.08) accumulationScore += 8;
  if (orderbookDelta > 0.05) accumulationScore += 8;
  if (atrContracting) {
    accumulationScore += 12;
    reasons.push("Volatility compression");
  }
  accumulationScore = Math.max(0, Math.min(100, accumulationScore));

  let prePumpScore = 0;
  prePumpScore += recoveryScore * 0.42;
  prePumpScore += accumulationScore * 0.38;
  if (volumeDeltaPct > 0.25) prePumpScore += 8;
  if (atrContracting && macdImproving) prePumpScore += 8;
  if (orderbookDelta > 0.05) prePumpScore += 6;
  if (hasBullishDivergence(closes, rsiSeries)) prePumpScore += 6;
  prePumpScore = Math.max(0, Math.min(100, Math.round(prePumpScore)));

  let breakoutScore = 0;
  if (hasTrendlineBreak(closes, highs)) breakoutScore += 25;
  if (latestRsi > 62) breakoutScore += 15;
  if (volumeDeltaPct > 0.35) breakoutScore += 15;
  if (rangePosition > 70) breakoutScore += 20;
  if (latestHistogram > 0) breakoutScore += 10;
  breakoutScore = Math.max(0, Math.min(100, breakoutScore));

  let confluenceScore = 0;
  if (capitulationScore >= 55) confluenceScore++;
  if (fundingRate < -0.00008) confluenceScore++;
  if (latestRsi < 40) confluenceScore++;
  if (rsiSlope > 0) confluenceScore++;
  if (macdImproving) confluenceScore++;
  if (hasPriceHigherLows) confluenceScore++;
  if (volumeDeltaPct > 0.15) confluenceScore++;
  if (oiDelta !== null && oiDelta > -0.05) confluenceScore++;
  if (accumulationScore >= 55) confluenceScore++;
  if (prePumpScore >= 60) confluenceScore++;
  if (obsScore > 60) confluenceScore++;

  const momentumRank = Math.max(0, Math.min(100, Math.round(
    recoveryScore * 0.45 + prePumpScore * 0.35 + (latestHistogram > 0 ? 12 : 0) + (rsiSlope > 0 ? 8 : 0)
  )));

  const riskPenalty =
    (distFromYearlyLow > 40 ? 18 : 0) +
    (latestRsi > 72 ? 18 : 0) +
    (rangePosition > 85 ? 22 : 0) +
    (volumeDeltaPct < -0.2 ? 12 : 0);
  const riskRank = Math.max(0, Math.min(100, Math.round(100 - riskPenalty)));

  const noMomentum14d = !hasHigherLows(rsiSeries, 14) && !macdImproving && Math.abs(rsiSlope) < 0.8;
  const neutralFundingNoAccum = Math.abs(fundingRate) <= 0.00003 && accumulationScore < 45;
  const lowVolume = dayNotionalVolumeUsd > 0 && dayNotionalVolumeUsd < 250_000;
  const collapsingOi = oiDelta !== null && oiDelta <= -0.2;
  const deadBehavior = drawdown90d > 70 && volumeDeltaPct < -0.25 && momentumRank < 35;
  const qualityRejected = lowVolume || collapsingOi || noMomentum14d || neutralFundingNoAccum || deadBehavior;

  let stage: DeadZoneStage = "IGNORE";
  if (qualityRejected) {
    stage = "DEAD_CAPITULATION";
    reasons.push("Failed capitulation quality filter");
  } else if (latestRsi > 74 && rangePosition > 82) {
    stage = "OVEREXTENDED";
  } else if (prePumpScore >= 72 && breakoutScore >= 55) {
    stage = "ACTIVE_RUN";
  } else if (prePumpScore >= 60 && accumulationScore >= 55 && recoveryScore >= 50) {
    stage = "PRE_PUMP";
  } else if (accumulationScore >= 50 && recoveryScore >= 45) {
    stage = "ACCUMULATION";
  } else if (recoveryScore >= 50) {
    stage = "RECOVERY";
  } else if (recoveryScore >= 40 && (orderbookDelta > 0 || volumeDeltaPct > 0)) {
    stage = "RECOVERING_CAPITULATION";
  } else if (capitulationScore >= 50) {
    stage = "CAPITULATION";
  }

  const signalCount = confluenceScore + (qualityRejected ? 0 : 2);
  const dataDepth = Math.min(100, (candles.length / 365) * 100);
  const confidence = Math.min(100, Math.round(dataDepth * 0.35 + Math.min(100, signalCount * 9) * 0.65));

  return {
    deadZoneScore: capitulationScore,
    capitulationScore,
    recoveryScore,
    accumulationScore,
    prePumpScore,
    breakoutScore,
    confluenceScore,
    obsScore,
    momentumRank,
    riskRank,
    stage,
    confidence,
    reasons,
    fundingRate,
    volumeDeltaPct,
    volumeSpikeX,
    openInterestDeltaPct: oiDelta,
    qualityRejected,
  };
}
