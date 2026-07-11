/**
 * Fibonacci Capitulation Bounce Scan
 * 
 * Identifies tokens trading 5-10% above their all-time low (0 fib level)
 * Useful for mean-reversion bounces and oversold reversals
 */

import { calculateFibonacciLevels } from "./fibonacci-engine.js";
import { calculateLatestRsi } from "./rsi.js";
import { scoreDeadZone, type DeadZoneStage, type LifecycleAction, type MarketCycleStage } from "./dead-zone-engine.js";
import type { MarketCandle } from "@prisma/client";

export interface CapitulationContext {
  dayNotionalVolumeUsd?: number | null;
  orderbookImbalance?: number | null;
  orderbookDelta?: number | null;
  bidDepthUsd?: number | null;
  askDepthUsd?: number | null;
  bidDepthDeltaPct?: number | null;
  askDepthDeltaPct?: number | null;
  obsScoreRolling?: number | null;
  orderbookImbalance1m?: number | null;
  orderbookImbalance5m?: number | null;
  orderbookImbalance15m?: number | null;
  absorptionScore?: number | null;
  distributionScore?: number | null;
  askWallScore?: number | null;
  bidWallScore?: number | null;
  liquidityDivergence?: "BULLISH" | "BEARISH" | "NONE" | null;
  supportDefenseScore?: number | null;
  priceConfirmationScore?: number | null;
  finalLiquidityScore?: number | null;
  actionRecommendation?: "BUY" | "WAIT" | "SELL" | null;
  actionConfidencePct?: number | null;
  actionEvidencePositive?: string[] | null;
  actionEvidenceWarnings?: string[] | null;
  actionMissingConditions?: string[] | null;
  actionPrimaryBlocker?: string | null;
  actionReason?: string | null;
  liquidityRegime?: "BUYER_DOMINATED" | "SELLER_DOMINATED" | "POTENTIAL_ABSORPTION" | "ABSORPTION" | "DISTRIBUTION" | "SHORT_FUEL" | "NEUTRAL" | null;
  openInterestDeltaPct?: number | null;
}

export interface CapitulationBounceCandidate {
  symbol: string;
  currentPrice: number;
  distanceFromZeroFib: number; // percentage above 0 fib level
  inBounceZone: boolean; // true if 5-10% above 0 fib
  allTimeHigh: number;
  allTimeLow: number;
  fib0: number;
  fib236: number;
  fib382: number;
  fib50: number;
  fib618: number;
  drawdownFromHigh: number; // percentage below ATH
  rsi14: number;
  volatility: number; // annualized volatility
  strength: number; // 0-100, confidence score
  launchAge: "YOUNG" | "ESTABLISHED" | "VETERAN"; // based on candle count
  // Dead Zone engine results
  deadZoneScore: number;
  capitulationScore: number;
  recoveryScore: number;
  accumulationScore: number;
  prePumpScore: number;
  breakoutScore: number;
  burstProbabilityScore: number;
  confirmationScore: number;
  marketCycle: MarketCycleStage;
  lifecycleAction: LifecycleAction;
  confluenceScore: number;
  obsScore: number;
  absorptionScore: number;
  distributionScore: number;
  askWallScore: number;
  bidWallScore: number;
  liquidityDivergence: "BULLISH" | "BEARISH" | "NONE";
  supportDefenseScore: number;
  priceConfirmationScore: number;
  finalLiquidityScore: number;
  actionRecommendation: "BUY" | "WAIT" | "SELL";
  actionConfidencePct: number;
  actionEvidencePositive: string[];
  actionEvidenceWarnings: string[];
  actionMissingConditions: string[];
  actionPrimaryBlocker: string;
  actionReason: string;
  liquidityRegime: "BUYER_DOMINATED" | "SELLER_DOMINATED" | "POTENTIAL_ABSORPTION" | "ABSORPTION" | "DISTRIBUTION" | "SHORT_FUEL" | "NEUTRAL";
  orderbookImbalance1m: number;
  orderbookImbalance5m: number;
  orderbookImbalance15m: number;
  bidDepthUsd: number | null;
  askDepthUsd: number | null;
  momentumRank: number;
  riskRank: number;
  deltaScore24h: number;
  deltaVolumePct: number;
  volumeSpikeX: number;
  deltaOpenInterestPct: number | null;
  signalAgeHours: number;
  stage: DeadZoneStage;
  stageConfidence: number;
  stageReasons: string[];
  fundingRate: number; // negative = shorts paying longs (bullish bias)
}

export interface CapitulationScanResult {
  scannedAt: Date;
  bounceZoneCandidates: CapitulationBounceCandidate[];
  nearBounceZone: CapitulationBounceCandidate[]; // 3-15% above 0 fib
  ultraCapitulationCandidates: CapitulationBounceCandidate[]; // 0-3% above 0 fib
  topNextRunCandidates: Array<{
    symbol: string;
    score: number;
    confluenceScore: number;
    stage: DeadZoneStage;
    distanceFromZeroFib: number;
    rsi14: number;
    capitulationScore: number;
    recoveryScore: number;
    accumulationScore: number;
    prePumpScore: number;
    burstProbabilityScore: number;
    confirmationScore: number;
    marketCycle: MarketCycleStage;
    lifecycleAction: LifecycleAction;
    obsScore: number;
    absorptionScore: number;
    distributionScore: number;
    askWallScore: number;
    bidWallScore: number;
    liquidityDivergence: "BULLISH" | "BEARISH" | "NONE";
    supportDefenseScore: number;
    priceConfirmationScore: number;
    finalLiquidityScore: number;
    actionRecommendation: "BUY" | "WAIT" | "SELL";
    actionConfidencePct: number;
    actionEvidencePositive: string[];
    actionEvidenceWarnings: string[];
    actionMissingConditions: string[];
    actionPrimaryBlocker: string;
    actionReason: string;
    liquidityRegime: "BUYER_DOMINATED" | "SELLER_DOMINATED" | "POTENTIAL_ABSORPTION" | "ABSORPTION" | "DISTRIBUTION" | "SHORT_FUEL" | "NEUTRAL";
    orderbookImbalance1m: number;
    orderbookImbalance5m: number;
    orderbookImbalance15m: number;
    deltaScore24h: number;
    deltaVolumePct: number;
    deltaOpenInterestPct: number | null;
    signalAgeHours: number;
    momentumRank: number;
    riskRank: number;
    fundingRate: number;
  }>;
  totalScanned: number;
  skipped: Array<{ symbol: string; reason: string }>;
}

const AGE_24H = 24;
const AGE_48H = 48;
const AGE_72H = 72;

function resolveSignalAgePenalty(signalAgeHours: number): { confluencePenalty: number; prePumpPenalty: number; scoreMultiplier: number } {
  if (signalAgeHours <= AGE_24H) {
    return { confluencePenalty: 0, prePumpPenalty: 0, scoreMultiplier: 1 };
  }
  if (signalAgeHours <= AGE_48H) {
    return { confluencePenalty: 0.5, prePumpPenalty: 4, scoreMultiplier: 0.97 };
  }
  if (signalAgeHours <= AGE_72H) {
    return { confluencePenalty: 1, prePumpPenalty: 8, scoreMultiplier: 0.92 };
  }
  return { confluencePenalty: 2, prePumpPenalty: 15, scoreMultiplier: 0.84 };
}

function computeNextRunScore(candidate: CapitulationBounceCandidate): number {
  const fundingScore = candidate.fundingRate < -0.0003
    ? 100
    : candidate.fundingRate < -0.0001
    ? 82
    : candidate.fundingRate < -0.00003
    ? 64
    : candidate.fundingRate > 0.00015
    ? 18
    : 42;

  const distanceScore = candidate.distanceFromZeroFib <= 12
    ? Math.max(0, 100 - candidate.distanceFromZeroFib * 3.5)
    : Math.max(0, 58 - (candidate.distanceFromZeroFib - 12) * 2.6);

  const rsiScore = candidate.rsi14 <= 45
    ? 100 - Math.max(0, (candidate.rsi14 - 20) * 1.8)
    : Math.max(12, 70 - (candidate.rsi14 - 45) * 2.2);

  const anticipationBase =
    candidate.burstProbabilityScore * 0.45 +
    candidate.accumulationScore * 0.16 +
    candidate.recoveryScore * 0.11 +
    candidate.absorptionScore * 0.1 +
    candidate.obsScore * 0.1 +
    fundingScore * 0.08;

  const latePenalty =
    Math.max(0, candidate.volumeSpikeX - 4) * 5 +
    Math.max(0, candidate.breakoutScore - 60) * 0.6 +
    Math.max(0, candidate.rsi14 - 68) * 1.1 +
    Math.max(0, candidate.distanceFromZeroFib - 18) * 1.2 +
    (candidate.marketCycle === "EXTENDED" ? 14 : 0) +
    (candidate.marketCycle === "EXHAUSTION" ? 24 : 0);

  const agePenalty = resolveSignalAgePenalty(candidate.signalAgeHours);
  const adjustedPrePump = Math.max(0, candidate.prePumpScore - agePenalty.prePumpPenalty);
  const adjustedConfluence = Math.max(0, candidate.confluenceScore - agePenalty.confluencePenalty);

  const rawScore =
    anticipationBase +
    distanceScore * 0.08 +
    rsiScore * 0.06 +
    adjustedPrePump * 0.08 +
    adjustedConfluence * 1.2 -
    latePenalty;

  const score = rawScore * agePenalty.scoreMultiplier;

  return Number(score.toFixed(1));
}

/**
 * Calculate distance from 0 fib level as percentage
 */
function calculateDistanceFromZeroFib(
  currentPrice: number,
  fib0: number
): number {
  if (fib0 === 0) return 0;
  return ((currentPrice - fib0) / fib0) * 100;
}

/**
 * Calculate annualized volatility from returns
 */
function calculateVolatility(closes: number[]): number {
  if (closes.length < 2) return 0;

  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const ret = Math.log(closes[i] / closes[i - 1]);
    returns.push(ret);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Annualize: stdDev * sqrt(365) for daily data
  return stdDev * Math.sqrt(365) * 100;
}

/**
 * Score bounce candidate based on:
 * - RSI oversold (lower is better for bounce)
 * - Proximity to 0 fib (5-10% is ideal)
 * - Volatility (higher volatility = more edge)
 * - Established token (more history = more reliable)
 */
function scoreCandidate(
  distance: number,
  rsi: number,
  volatility: number,
  candleCount: number
): number {
  let score = 0;

  // Distance scoring: ideal zone is 5-10%
  if (distance >= 5 && distance <= 10) {
    score += 40;
  } else if (distance >= 3 && distance <= 15) {
    score += 25;
  } else if (distance >= 1 && distance <= 20) {
    score += 10;
  } else {
    score += 0;
  }

  // RSI scoring: oversold is better for bounce
  if (rsi < 30) {
    score += 30;
  } else if (rsi < 40) {
    score += 20;
  } else if (rsi < 50) {
    score += 10;
  }

  // Volatility scoring: higher vol = more edge
  if (volatility > 50) {
    score += 20;
  } else if (volatility > 30) {
    score += 15;
  } else if (volatility > 15) {
    score += 10;
  }

  // Candle count (history) scoring
  if (candleCount >= 365) {
    score += 10; // Full year+ of data
  } else if (candleCount >= 180) {
    score += 7;
  } else if (candleCount >= 60) {
    score += 4;
  }

  return Math.min(100, score);
}

/**
 * Classify token age based on candle count
 */
function classifyAge(candleCount: number): "YOUNG" | "ESTABLISHED" | "VETERAN" {
  if (candleCount >= 365) return "VETERAN"; // 1+ year
  if (candleCount >= 180) return "ESTABLISHED"; // 6+ months
  return "YOUNG"; // Less than 6 months
}

/**
 * Analyze a single token for capitulation bounce setup
 */
export function analyzeCapitulationCandidate(
  symbol: string,
  candles: MarketCandle[],
  currentPrice: number,
  fundingRate: number = 0,
  context: CapitulationContext = {}
): CapitulationBounceCandidate | null {
  if (candles.length < 10) {
    return null; // Not enough data
  }

  const closes = candles.map((c) => Number(c.close));
  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));

  // Find all-time high and low
  const allTimeHigh = Math.max(...highs);
  const allTimeLow = Math.min(...lows);

  if (allTimeHigh <= allTimeLow) {
    return null; // Invalid data
  }

  // Calculate fibonacci levels (downtrend: measuring from high to low)
  const fibs = calculateFibonacciLevels(allTimeHigh, allTimeLow, "downtrend");

  // Calculate distance from 0 fib (the low)
  const distance = calculateDistanceFromZeroFib(currentPrice, fibs.level0);

  // Calculate drawdown from ATH
  const drawdownFromHigh = ((allTimeHigh - currentPrice) / allTimeHigh) * 100;

  // Calculate RSI and volatility
  const rsi = calculateLatestRsi(closes) ?? 50; // Default to 50 if null
  const volatility = calculateVolatility(closes);

  // Score the candidate
  const strength = scoreCandidate(distance, rsi, volatility, candles.length);

  // Check if in bounce zone (5-10% above 0 fib)
  const inBounceZone = distance >= 5 && distance <= 10;

  // Dead zone / pre-pump stage scoring
  const yearlyCandles = candles.slice(-365);
  const yearlyLow = Math.min(...yearlyCandles.map(c => Number(c.low)));
  const yearlyHigh = Math.max(...yearlyCandles.map(c => Number(c.high)));
  const ohlcv = candles.map(c => ({
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
  }));
  const deadZone = scoreDeadZone(ohlcv, currentPrice, yearlyLow, yearlyHigh, fundingRate, context);

  const priorDayCandles = candles.slice(0, -1);
  let deltaScore24h = 0;
  if (priorDayCandles.length >= 30) {
    const priorOhlcv = priorDayCandles.map(c => ({
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    }));
    const priorPrice = Number(priorDayCandles[priorDayCandles.length - 1].close);
    const priorLow = Math.min(...priorDayCandles.slice(-365).map(c => Number(c.low)));
    const priorHigh = Math.max(...priorDayCandles.slice(-365).map(c => Number(c.high)));
    const priorScores = scoreDeadZone(priorOhlcv, priorPrice, priorLow, priorHigh, fundingRate, context);

    const currentComposite =
      deadZone.prePumpScore * 0.30 +
      deadZone.accumulationScore * 0.25 +
      deadZone.recoveryScore * 0.20 +
      deadZone.confluenceScore * 2.5;
    const priorComposite =
      priorScores.prePumpScore * 0.30 +
      priorScores.accumulationScore * 0.25 +
      priorScores.recoveryScore * 0.20 +
      priorScores.confluenceScore * 2.5;
    deltaScore24h = Number((currentComposite - priorComposite).toFixed(1));
  }

  let stage = deadZone.stage;
  const recoveryThreshold = 50;
  if (
    deadZone.recoveryScore >= 40 &&
    deadZone.recoveryScore < recoveryThreshold &&
    (deltaScore24h > 0 || deadZone.volumeDeltaPct > 0)
  ) {
    stage = "RECOVERING_CAPITULATION";
  }

  const stageReasons = [...deadZone.reasons];
  if (stage === "RECOVERING_CAPITULATION") {
    stageReasons.push("Recovery metrics improving inside capitulation");
  }

  return {
    symbol,
    currentPrice,
    distanceFromZeroFib: distance,
    inBounceZone,
    allTimeHigh,
    allTimeLow,
    fib0: fibs.level0,
    fib236: fibs.level236,
    fib382: fibs.level382,
    fib50: fibs.level50,
    fib618: fibs.level618,
    drawdownFromHigh,
    rsi14: rsi,
    volatility,
    strength: Math.round(strength),
    launchAge: classifyAge(candles.length),
    deadZoneScore: deadZone.deadZoneScore,
    capitulationScore: deadZone.capitulationScore,
    recoveryScore: deadZone.recoveryScore,
    accumulationScore: deadZone.accumulationScore,
    prePumpScore: deadZone.prePumpScore,
    breakoutScore: deadZone.breakoutScore,
    burstProbabilityScore: deadZone.burstProbabilityScore,
    confirmationScore: deadZone.confirmationScore,
    marketCycle: deadZone.marketCycle,
    lifecycleAction: deadZone.lifecycleAction,
    confluenceScore: deadZone.confluenceScore,
    obsScore: context.obsScoreRolling ?? deadZone.obsScore,
    absorptionScore: context.absorptionScore ?? 50,
    distributionScore: context.distributionScore ?? 50,
    askWallScore: context.askWallScore ?? 50,
    bidWallScore: context.bidWallScore ?? 50,
    liquidityDivergence: context.liquidityDivergence ?? "NONE",
    supportDefenseScore: context.supportDefenseScore ?? 50,
    priceConfirmationScore: context.priceConfirmationScore ?? 50,
    finalLiquidityScore: context.finalLiquidityScore ?? 50,
    actionRecommendation: context.actionRecommendation ?? "WAIT",
    actionConfidencePct: context.actionConfidencePct ?? 50,
    actionEvidencePositive: context.actionEvidencePositive ?? [],
    actionEvidenceWarnings: context.actionEvidenceWarnings ?? [],
    actionMissingConditions: context.actionMissingConditions ?? [],
    actionPrimaryBlocker: context.actionPrimaryBlocker ?? "Confirmation is incomplete.",
    actionReason: context.actionReason ?? "Liquidity context incomplete",
    liquidityRegime: context.liquidityRegime ?? "NEUTRAL",
    orderbookImbalance1m: context.orderbookImbalance1m ?? (context.orderbookImbalance ?? 0),
    orderbookImbalance5m: context.orderbookImbalance5m ?? (context.orderbookImbalance ?? 0),
    orderbookImbalance15m: context.orderbookImbalance15m ?? (context.orderbookImbalance ?? 0),
    bidDepthUsd: context.bidDepthUsd ?? null,
    askDepthUsd: context.askDepthUsd ?? null,
    momentumRank: deadZone.momentumRank,
    riskRank: deadZone.riskRank,
    deltaScore24h,
    deltaVolumePct: deadZone.volumeDeltaPct,
    volumeSpikeX: deadZone.volumeSpikeX,
    deltaOpenInterestPct: deadZone.openInterestDeltaPct,
    signalAgeHours: 0,
    stage,
    stageConfidence: deadZone.confidence,
    stageReasons,
    fundingRate: deadZone.fundingRate,
  };
}

/**
 * Process scan results: filter and rank candidates
 */
export function processCapitulationResults(
  candidates: (CapitulationBounceCandidate | null)[],
  scannedAt: Date = new Date()
): CapitulationScanResult {
  const valid = candidates.filter((c) => c !== null) as CapitulationBounceCandidate[];

  // Split into bounce zone and near zone
  const bounceZone = valid
    .filter((c) => c.inBounceZone)
    .sort((a, b) => computeNextRunScore(b) - computeNextRunScore(a));

  const nearZone = valid
    .filter((c) => !c.inBounceZone && c.distanceFromZeroFib >= 3 && c.distanceFromZeroFib <= 15)
    .sort((a, b) => computeNextRunScore(b) - computeNextRunScore(a));

  const ultraCapZone = valid
    .filter((c) => c.distanceFromZeroFib >= 0 && c.distanceFromZeroFib < 3)
    .filter((c) => c.stage !== "IGNORE")
    .filter((c) => c.stage !== "DEAD_CAPITULATION")
    .sort((a, b) => computeNextRunScore(b) - computeNextRunScore(a));

  const topNextRun = valid
    .filter((c) => c.marketCycle !== "EXHAUSTION" && c.marketCycle !== "EXTENDED")
    .filter((c) => c.burstProbabilityScore >= 58)
    .filter((c) => c.lifecycleAction === "EARLY_ENTRY" || c.lifecycleAction === "BUY" || c.lifecycleAction === "HOLD")
    .map((c) => ({
      symbol: c.symbol,
      score: computeNextRunScore(c),
      confluenceScore: c.confluenceScore,
      stage: c.stage,
      burstProbabilityScore: c.burstProbabilityScore,
      confirmationScore: c.confirmationScore,
      marketCycle: c.marketCycle,
      lifecycleAction: c.lifecycleAction,
      distanceFromZeroFib: c.distanceFromZeroFib,
      rsi14: c.rsi14,
      capitulationScore: c.capitulationScore,
      recoveryScore: c.recoveryScore,
      accumulationScore: c.accumulationScore,
      prePumpScore: c.prePumpScore,
      obsScore: c.obsScore,
      absorptionScore: c.absorptionScore,
      distributionScore: c.distributionScore,
      askWallScore: c.askWallScore,
      bidWallScore: c.bidWallScore,
      liquidityDivergence: c.liquidityDivergence,
      supportDefenseScore: c.supportDefenseScore,
      priceConfirmationScore: c.priceConfirmationScore,
      finalLiquidityScore: c.finalLiquidityScore,
      actionRecommendation: c.actionRecommendation,
      actionConfidencePct: c.actionConfidencePct,
      actionEvidencePositive: c.actionEvidencePositive,
      actionEvidenceWarnings: c.actionEvidenceWarnings,
      actionMissingConditions: c.actionMissingConditions,
      actionPrimaryBlocker: c.actionPrimaryBlocker,
      actionReason: c.actionReason,
      liquidityRegime: c.liquidityRegime,
      orderbookImbalance1m: c.orderbookImbalance1m,
      orderbookImbalance5m: c.orderbookImbalance5m,
      orderbookImbalance15m: c.orderbookImbalance15m,
      deltaScore24h: c.deltaScore24h,
      deltaVolumePct: c.deltaVolumePct,
      deltaOpenInterestPct: c.deltaOpenInterestPct,
      signalAgeHours: c.signalAgeHours,
      momentumRank: c.momentumRank,
      riskRank: c.riskRank,
      fundingRate: c.fundingRate,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  return {
    scannedAt,
    bounceZoneCandidates: bounceZone,
    nearBounceZone: nearZone,
    ultraCapitulationCandidates: ultraCapZone,
    topNextRunCandidates: topNextRun,
    totalScanned: valid.length,
    skipped: [],
  };
}
