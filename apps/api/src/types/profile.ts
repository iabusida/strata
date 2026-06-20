/**
 * STRATA Profile System
 * 
 * Each user has a trading profile that determines:
 * - Signal thresholds
 * - Timeframe preferences
 * - Entry conditions
 * - Risk parameters
 * - UI recommendations
 */

export type TradingStyle = 'scalp' | 'day' | 'swing' | 'long_term';

export type RiskLevel = 'low' | 'medium' | 'high';

export type Decision = 'BUY' | 'SELL' | 'WAIT' | 'AVOID';

export type MarketStructure = 'bullish' | 'bearish' | 'mixed';

export interface UserProfile {
  id: string;
  userId: string;
  style: TradingStyle;
  riskLevel: RiskLevel;
  minConfidence: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Rules per trading profile
 * Each profile has different thresholds and expectations
 */
export interface ProfileRules {
  minConfidence: number;
  timeframes: string[];
  scoreThreshold: number;
  requireMomentum?: boolean;
  requireBreakout?: boolean;
  requireTrendAlignment?: boolean;
  ignoreShortNoise?: boolean;
  holdTime: 'minutes' | 'hours' | 'days' | 'months';
  maxHoldDuration: number; // in hours or days
}

export const PROFILE_RULES: Record<TradingStyle, ProfileRules> = {
  scalp: {
    minConfidence: 40,
    timeframes: ['5m', '15m'],
    scoreThreshold: 2,
    requireMomentum: true,
    holdTime: 'minutes',
    maxHoldDuration: 60, // minutes
  },
  day: {
    minConfidence: 50,
    timeframes: ['15m', '1h'],
    scoreThreshold: 3,
    requireBreakout: true,
    holdTime: 'hours',
    maxHoldDuration: 24, // hours
  },
  swing: {
    minConfidence: 60,
    timeframes: ['1h', '4h', '1d'],
    scoreThreshold: 4,
    requireTrendAlignment: true,
    holdTime: 'days',
    maxHoldDuration: 7, // days
  },
  long_term: {
    minConfidence: 65,
    timeframes: ['1d', '1w'],
    scoreThreshold: 5,
    ignoreShortNoise: true,
    holdTime: 'months',
    maxHoldDuration: 30, // days
  },
};

/**
 * Signal evaluation result adapted to user profile
 */
export interface SignalEvaluation {
  symbol: string;
  style: TradingStyle;
  score: number;
  confidence: number;
  decision: Decision;
  structure: MarketStructure;
  nextStep: string;
  reasons: string[];
  triggerCondition: string;
  actionSummary: string;
}

/**
 * Generate next step based on trading style and signal
 */
export function generateNextStep(
  style: TradingStyle,
  decision: Decision,
  structure: MarketStructure
): string {
  if (decision === 'AVOID') {
    return 'Stand aside until trend confirms';
  }

  if (decision === 'WAIT') {
    return 'Monitor for better entry setup';
  }

  switch (style) {
    case 'scalp':
      if (decision === 'BUY') {
        return 'Enter on short-term momentum spike with volume confirmation';
      }
      if (decision === 'SELL') {
        return 'Short on weakness with high-momentum confirmation';
      }
      break;

    case 'day':
      if (decision === 'BUY') {
        return 'Wait for breakout above resistance during session';
      }
      if (decision === 'SELL') {
        return 'Enter on break below support during session';
      }
      break;

    case 'swing':
      if (decision === 'BUY') {
        return 'Enter on pullback to support within trend';
      }
      if (decision === 'SELL') {
        return 'Short on recovery to resistance within downtrend';
      }
      break;

    case 'long_term':
      if (decision === 'BUY') {
        return 'Accumulate gradually over time, ignore short-term noise';
      }
      if (decision === 'SELL') {
        return 'Reduce position gradually on strength';
      }
      break;
  }

  return 'Monitor for clearer confirmation';
}

/**
 * Generate trigger condition for entry
 */
export function generateTriggerCondition(
  symbol: string,
  style: TradingStyle,
  decision: Decision,
  currentPrice?: number,
  resistance?: number,
  support?: number
): string {
  if (decision === 'AVOID') {
    return '🚫 No Safe Entry Right Now';
  }

  if (decision === 'WAIT') {
    return `Monitor ${symbol} for price confirmation`;
  }

  switch (style) {
    case 'scalp':
      if (decision === 'BUY') {
        return `Enter only on volume spike above current price with RSI 50-70`;
      }
      if (decision === 'SELL') {
        return `Enter only on volume spike below current price with RSI 30-50`;
      }
      break;

    case 'day':
      if (decision === 'BUY' && resistance) {
        return `Break above $${resistance.toFixed(2)} with volume`;
      }
      if (decision === 'SELL' && support) {
        return `Break below $${support.toFixed(2)} with volume`;
      }
      break;

    case 'swing':
      if (decision === 'BUY' && support) {
        return `Pullback to $${support.toFixed(2)} with bounce confirmation`;
      }
      if (decision === 'SELL' && resistance) {
        return `Recovery to $${resistance.toFixed(2)} with rejection`;
      }
      break;

    case 'long_term':
      if (decision === 'BUY') {
        return `Buy on any pullback, accumulate $500+ per position`;
      }
      if (decision === 'SELL') {
        return `Sell 25-50% on +15% moves`;
      }
      break;
  }

  return 'Wait for entry confirmation';
}
