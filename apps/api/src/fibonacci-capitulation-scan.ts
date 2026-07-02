/**
 * Fibonacci Capitulation Bounce Scan
 * 
 * Identifies tokens trading 5-10% above their all-time low (0 fib level)
 * Useful for mean-reversion bounces and oversold reversals
 */

import { calculateFibonacciLevels, type FibonacciLevels } from "./fibonacci-engine.js";
import { calculateLatestRsi, calculateLatestAtr } from "./rsi.js";
import { scoreDeadZone, type DeadZoneStage, type DeadZoneResult } from "./dead-zone-engine.js";
import type { MarketCandle } from "@prisma/client";

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
  prePumpScore: number;
  breakoutScore: number;
  stage: DeadZoneStage;
  stageConfidence: number;
  stageReasons: string[];
  fundingRate: number; // negative = shorts paying longs (bullish bias)
}

export interface CapitulationScanResult {
  scannedAt: Date;
  bounceZoneCandidates: CapitulationBounceCandidate[];
  nearBounceZone: CapitulationBounceCandidate[]; // 3-15% above 0 fib
  totalScanned: number;
  skipped: Array<{ symbol: string; reason: string }>;
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
  fundingRate: number = 0
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
  const deadZone = scoreDeadZone(ohlcv, currentPrice, yearlyLow, yearlyHigh, fundingRate);

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
    prePumpScore: deadZone.prePumpScore,
    breakoutScore: deadZone.breakoutScore,
    stage: deadZone.stage,
    stageConfidence: deadZone.confidence,
    stageReasons: deadZone.reasons,
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
    .sort((a, b) => b.strength - a.strength);

  const nearZone = valid
    .filter((c) => !c.inBounceZone && c.distanceFromZeroFib >= 3 && c.distanceFromZeroFib <= 15)
    .sort((a, b) => b.strength - a.strength);

  return {
    scannedAt,
    bounceZoneCandidates: bounceZone,
    nearBounceZone: nearZone,
    totalScanned: valid.length,
    skipped: [],
  };
}
