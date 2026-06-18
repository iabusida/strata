/**
 * Simple Momentum Strategy Engine
 * 
 * Strategy: RSI Oversold Bounces with Support Confirmation
 * - Detects RSI < 30 on 4h timeframe
 * - Confirms with support level (24h low or trendline)
 * - Entry at support with tight SL, 2:1 RR target
 * - Targets: BTC, ETH, SOL (Coinbase major pairs)
 */

import { MarketCandle } from "@prisma/client";

export interface SimpleMomentumSignal {
  symbol: string;
  side: "LONG" | "SHORT";
  confidence: number; // 0-100
  reason: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  riskPercentage: number; // 1% of account
}

export interface RsiData {
  rsi14: number;
  rsi: number;
  oversold: boolean;
  overbought: boolean;
}

/**
 * Calculate RSI(14) for a candle series
 */
export function calculateRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgGain === 0 ? 0 : avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  return rsi;
}

/**
 * Calculate RSI from recent candles
 */
export function calculateRsiFromCandles(candles: MarketCandle[]): RsiData {
  if (candles.length < 15) {
    return { rsi14: 50, rsi: 50, oversold: false, overbought: false };
  }

  const closes = candles.map((c) => Number(c.close)).reverse(); // oldest first
  const rsi14 = calculateRsi(closes, 14);

  return {
    rsi14,
    rsi: rsi14,
    oversold: rsi14 < 30,
    overbought: rsi14 > 70,
  };
}

/**
 * Calculate support level (24h low with slight buffer)
 */
export function calculateSupportLevel(candles: MarketCandle[]): number {
  if (candles.length === 0) return 0;

  const last24h = candles.slice(-24); // last 24 1h candles
  const lows = last24h.map((c) => Number(c.low));
  const support = Math.min(...lows);

  return support;
}

/**
 * Generate simple momentum entry signal
 * Entry on RSI oversold bounce at support
 */
export function generateMomentumSignal(
  symbol: string,
  candles: MarketCandle[],
  currentPrice: number
): SimpleMomentumSignal | null {
  if (candles.length < 15) return null;

  const rsiData = calculateRsiFromCandles(candles);
  const support = calculateSupportLevel(candles);

  // Condition 1: RSI oversold
  if (!rsiData.oversold) {
    return null;
  }

  // Condition 2: Price within 1% of support (bounce confirmation)
  const distanceToSupport = ((currentPrice - support) / support) * 100;
  if (distanceToSupport < -1 || distanceToSupport > 2) {
    return null;
  }

  // Condition 3: Uptrend signal (price above 20-candle MA)
  const last20Closes = candles
    .slice(-20)
    .map((c) => Number(c.close))
    .reverse();
  const ma20 = last20Closes.reduce((a, b) => a + b, 0) / 20;

  if (currentPrice < ma20 * 0.98) {
    // Price should be near or above MA20 for uptrend
    return null;
  }

  // ===== ENTRY GEOMETRY =====
  // Entry: at support or within 0.5% above
  const entryPrice = support * 1.002;

  // Stop Loss: 1.5% below entry (wick-based)
  const slPct = 0.015;
  const stopLoss = entryPrice * (1 - slPct);

  // Take Profit: 3% above entry (2:1 RR = TP should be 2x the risk)
  // Risk = entryPrice - SL = entryPrice * slPct
  // TP = entryPrice + (2 * risk) = entryPrice + entryPrice * slPct * 2
  const tpPct = slPct * 2;
  const takeProfit = entryPrice * (1 + tpPct);

  const riskRewardRatio = (takeProfit - entryPrice) / (entryPrice - stopLoss);
  const confidence = Math.min(
    100,
    40 + Math.max(0, 30 - rsiData.rsi14) * 2 // Lower RSI = higher confidence
  );

  return {
    symbol,
    side: "LONG",
    confidence,
    reason: `RSI oversold (${rsiData.rsi14.toFixed(1)}) + support bounce at $${support.toFixed(6)}`,
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: Number(riskRewardRatio.toFixed(2)),
    riskPercentage: 0.01, // 1% of account
  };
}

/**
 * Validate signal has acceptable risk/reward
 */
export function isValidSignal(signal: SimpleMomentumSignal): boolean {
  // Minimum 2:1 risk-reward
  if (signal.riskRewardRatio < 2.0) {
    return false;
  }

  // Confidence threshold
  if (signal.confidence < 40) {
    return false;
  }

  // SL must be below entry, TP must be above entry
  if (signal.stopLoss >= signal.entryPrice || signal.takeProfit <= signal.entryPrice) {
    return false;
  }

  return true;
}
