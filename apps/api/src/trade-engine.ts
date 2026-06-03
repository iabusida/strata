import "./env.js";
import { getAppAccessState } from "./app-access.js";
import {
  fetchLatestOhlc,
  fetchOrderBookExecutionRead,
  fetchPerpContexts,
  MARKET_DATA_PROVIDER,
  type LatestOhlc,
  type PerpAssetContext
} from "./market-data-service.js";
import type { TokenRsiResult } from "./rsi.js";
import { loadTradeRuntimeState, persistTradeRuntimeState } from "./simulation-store.js";
import { notifyTelegramEntry } from "./telegram-service.js";
import type { MarketRegime } from "./regime-engine.js";
import { effectiveEntryPrice, validateExecution } from "./execution-engine.js";
import { simulateTrade } from "./trade-lifecycle-engine.js";
import { classifyEntryTiming, isEntryTimingAllowed, type EntryTiming, type EntryTimingMax } from "./entry-timing.js";
import {
  classifyReversalPhase,
  isReversalPhaseAllowed,
  type ReversalPhase,
  type ReversalPhaseMin
} from "./reversal-phase.js";
import {
  appendSessionOpportunity,
  appendSessionTradeOpened,
  ensureActiveTradingSession,
  hasRecentSessionOpportunity,
  markSessionTradeClosed,
  updateActiveSessionBalance
} from "./trading-session-prisma.js";
import { getBackfillStatus } from "./backfill-token-tracking.js";
import { PrismaClient } from "@prisma/client";
import {
  calculateFibonacciLevels,
  getNearestFibLevel,
  scoreFibSetup,
  type FibonacciLevels
} from "./fibonacci-engine.js";
import { getStrategyConfig, type StrategySettings } from "./strategy-config.js";
import {
  logTradeRejection as appendTradeRejection,
  getTradeRejectionLog as readTradeRejectionLog,
  clearTradeRejectionLog as resetTradeRejectionLog,
  type TradeRejectionEntry
} from "./trade-rejection-log.js";
import {
  changeBitunixLeverage,
  fetchBitunixLeverageCheck,
  fetchBitunixPendingPositions,
  flashCloseBitunixPosition,
  placeBitunixMarketOrder,
  type BitunixPendingPosition
} from "./bitunix-service.js";
import { recordDryRunExecutionPlan } from "./dry-run-execution.js";

export type TradeDirection = "LONG" | "SHORT";
export type TradeStatus = "OPEN" | "WIN" | "LOSS";
export type TradeEntryType = "STRONG" | "CONTINUATION" | "REVERSAL" | "SCORE_BASED";
export type AssetType = "LARGE_CAP" | "ALT";

export type Trade = {
  id: string;
  token: string;
  direction: TradeDirection;
  signalType: string;
  signalCategory: TradeEntryType;
  entryTiming?: EntryTiming;
  reversalPhase?: ReversalPhase;
  entryType: TradeEntryType;
  entryScore: number;
  riskPctUsed: number;
  volatilityPct: number;
  volume24h: number;
  passedVolatility: boolean;
  passedLiquidity: boolean;
  assetType: AssetType;
  marketCondition: "TRENDING" | "RANGING";
  regime: MarketRegime;
  cluster: "L1" | "L2" | "DEFI" | "OTHER";
  stakeUsd: number;
  takeProfitPct: number;
  stopLossPct: number;
  atr: number;
  tpDistance: number;
  slDistance: number;
  expectedValue: number;
  slippageEstimate: number;
  entryPrice: number;
  effectiveEntryPrice?: number;
  currentPrice: number;
  tpPrice: number;
  slPrice: number;
  leverage: number;
  status: TradeStatus;
  openTime: string;
  closeTime?: string;
  result?: number;
  resultUsd?: number;
  openFeeUsd?: number;
  closeFeeUsd?: number;
  currentPnlPct: number;
  currentPnlUsd: number;
  positionValueUsd: number;
  distanceToTP: number;
  distanceToSL: number;
  markPrice?: number;
  roePct?: number;
  sizeBaseUnits?: number;
  marginUsedUsd?: number;
  fundingRate?: number;
  fundingAccruedUsd?: number;
  estimatedLiqPrice?: number;
  openInterestUsd?: number;
  maxDrawdown?: number;
  timeToClose?: number;
  entryContextJson?: string;
  closeContextJson?: string;
  closeReason?: string;
  isLiveTrade?: boolean;
  liveOrderId?: string;
  liveClientId?: string;
  livePositionId?: string;
};

export type TradeStats = {
  totalTrades: number;
  activeTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgMinutesToWin: number;
  avgMinutesToLoss: number;
  totalSimulatedPnl: number;
  totalSimulatedPnlUsd: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  unrealizedPnlUsd: number;
  equityUsd: number;
  accountBalanceUsd: number;
  totalFeesPaidUsd: number;
  initialCapitalUsd: number;
  stakePerTradeUsd: number;
  estimatedBalanceUsd: number;
  maxActiveTrades: number;
  leverage: number;
  targetReturnPct: number;
  stopReturnPct: number;
  equityCurve: Array<{ at: string; balanceUsd: number }>;
  maxDrawdown: number;
  longWinRate: number;
  shortWinRate: number;
  avgTradeDuration: number;
  tradesPerDay: number;
  byDirection: {
    long: { total: number; wins: number; losses: number; winRate: number };
    short: { total: number; wins: number; losses: number; winRate: number };
  };
  byToken: Array<{
    token: string;
    total: number;
    wins: number;
    losses: number;
    winRate: number;
    pnl: number;
  }>;
  sentimentShiftClosedTrades: number;
  closeReasonCounts: Record<string, number>;
};

export type TradeSimulationSnapshot = {
  stats: TradeStats;
  activeTrades: Trade[];
  recentClosedTrades: Trade[];
};

export type TradeEngineProfile = {
  testOpenMode: boolean;
  fixedStakeEnabled: boolean;
  simSignalOnlyMode: boolean;
  risk: {
    minRiskReward: number;
    earlyReversalMinRiskReward: number;
    minExpectedValuePct: number;
    maxSlippagePct: number;
    maxConcurrentRiskPct: number;
    maxDailyDrawdownPct: number;
    rollingDrawdownLimitPct: number;
  };
  entry: {
    entryTimingMax: EntryTimingMax;
    strongSignalEntryTimingMax: EntryTimingMax;
    reversalPhaseMin: ReversalPhaseMin;
    enforceResolvedReversalPhase: boolean;
    unresolvedReversalRequireEarly: boolean;
    unresolvedReversalMinScore: number;
  };
  exposure: {
    signalSimMaxActiveTrades: number;
    maxActiveTradesUnder1000: number;
    maxActiveTradesAtOrAbove1000: number;
    maxClusterDirectionActiveTrades: number;
  };
  setupPolicy: {
    enabled: boolean;
    tpSlMode: "ROE" | "ATR";
    defaultsBySetup: {
      trend: { takeProfitPct: number; stopLossPct: number };
      reversal: { takeProfitPct: number; stopLossPct: number };
      breakout: { takeProfitPct: number; stopLossPct: number };
    };
    leverageCaps: {
      BTC: { trend: number; reversal: number; breakout: number };
      ETH: { trend: number; reversal: number; breakout: number };
      MAJOR: { trend: number; reversal: number; breakout: number };
      SMALL: { trend: number; reversal: number; breakout: number };
    };
  };
  liquidityHunt: {
    enabled: boolean;
    onlyMode: boolean;
    mode: "FADE" | "BREAKOUT_FLIP";
    distancePctThreshold: number;
    minBreakPct: number;
    leverage: number;
    takeProfitPct: number;
    stopLossPct: number;
  };
};

function logRejection(entry: Omit<TradeRejectionEntry, "rejectedAt">): void {
  appendTradeRejection(entry);
}

export function getTradeRejectionLog(): TradeRejectionEntry[] {
  return readTradeRejectionLog();
}

export function clearTradeRejections(): void {
  resetTradeRejectionLog();
}

export function getTradeEngineProfile(): TradeEngineProfile {
  return {
    testOpenMode: TEST_OPEN_MODE,
    fixedStakeEnabled: FIXED_STAKE_ENABLED,
    simSignalOnlyMode: SIM_SIGNAL_ONLY_MODE,
    risk: {
      minRiskReward: MIN_RISK_REWARD,
      earlyReversalMinRiskReward: EARLY_REVERSAL_MIN_RR,
      minExpectedValuePct: EXPECTED_VALUE_MIN,
      maxSlippagePct: MAX_SLIPPAGE_PCT,
      maxConcurrentRiskPct: Number((MAX_CONCURRENT_RISK * 100).toFixed(3)),
      maxDailyDrawdownPct: Number((MAX_DAILY_DRAWDOWN_PCT * 100).toFixed(3)),
      rollingDrawdownLimitPct: ROLLING_DRAWDOWN_LIMIT_PCT
    },
    entry: {
      entryTimingMax: ENTRY_TIMING_MAX,
      strongSignalEntryTimingMax: STRONG_SIGNAL_ENTRY_TIMING_MAX,
      reversalPhaseMin: REVERSAL_PHASE_MIN,
      enforceResolvedReversalPhase: ENFORCE_RESOLVED_REVERSAL_PHASE,
      unresolvedReversalRequireEarly: UNRESOLVED_REVERSAL_REQUIRE_EARLY,
      unresolvedReversalMinScore: UNRESOLVED_REVERSAL_MIN_SCORE
    },
    exposure: {
      signalSimMaxActiveTrades: SIGNAL_SIM_MAX_ACTIVE_TRADES,
      maxActiveTradesUnder1000: MAX_ACTIVE_TRADES_UNDER_1000,
      maxActiveTradesAtOrAbove1000: MAX_ACTIVE_TRADES_AT_OR_ABOVE_1000,
      maxClusterDirectionActiveTrades: MAX_CLUSTER_DIRECTION_ACTIVE_TRADES
    },
    setupPolicy: {
      enabled: SETUP_POLICY_ENABLED,
      tpSlMode: TP_SL_MODE,
      defaultsBySetup: {
        trend: { takeProfitPct: SETUP_TP_PCT_TREND, stopLossPct: SETUP_SL_PCT_TREND },
        reversal: { takeProfitPct: SETUP_TP_PCT_REVERSAL, stopLossPct: SETUP_SL_PCT_REVERSAL },
        breakout: { takeProfitPct: SETUP_TP_PCT_BREAKOUT, stopLossPct: SETUP_SL_PCT_BREAKOUT }
      },
      leverageCaps: {
        BTC: { trend: LEVERAGE_CAP_BTC_TREND, reversal: LEVERAGE_CAP_BTC_REVERSAL, breakout: LEVERAGE_CAP_BTC_BREAKOUT },
        ETH: { trend: LEVERAGE_CAP_ETH_TREND, reversal: LEVERAGE_CAP_ETH_REVERSAL, breakout: LEVERAGE_CAP_ETH_BREAKOUT },
        MAJOR: { trend: LEVERAGE_CAP_MAJOR_TREND, reversal: LEVERAGE_CAP_MAJOR_REVERSAL, breakout: LEVERAGE_CAP_MAJOR_BREAKOUT },
        SMALL: { trend: LEVERAGE_CAP_SMALL_TREND, reversal: LEVERAGE_CAP_SMALL_REVERSAL, breakout: LEVERAGE_CAP_SMALL_BREAKOUT }
      }
    },
    liquidityHunt: {
      enabled: LIQUIDITY_HUNT_ENTRY_ENABLED,
      onlyMode: LIQUIDITY_HUNT_ONLY_MODE,
      mode: LIQUIDITY_HUNT_ENTRY_MODE,
      distancePctThreshold: LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT,
      minBreakPct: LIQUIDITY_HUNT_MIN_BREAK_PCT,
      leverage: LIQUIDITY_HUNT_ENTRY_LEVERAGE,
      takeProfitPct: LIQUIDITY_HUNT_ENTRY_TP_PCT,
      stopLossPct: LIQUIDITY_HUNT_ENTRY_SL_PCT
    }
  };
}

function resolveNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env ${name}: ${raw}`);
  }

  return parsed;
}

function resolveSymbolSetEnv(name: string, defaultValue: string): Set<string> {
  const raw = process.env[name] ?? defaultValue;
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter((item) => item.length > 0)
  );
}

function resolveEnumEnv<T extends string>(name: string, allowed: readonly T[], defaultValue: T): T {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }

  const normalized = raw.trim().toUpperCase() as T;
  if (!allowed.includes(normalized)) {
    throw new Error(`Invalid enum env ${name}: ${raw}. Allowed: ${allowed.join(", ")}`);
  }

  return normalized;
}

const LEVERAGE = resolveNumberEnv("LEVERAGE", 3);
const SIM_INITIAL_CAPITAL_USD = resolveNumberEnv("SIM_INITIAL_CAPITAL_USD", 100);
const RISK_PER_TRADE = 0.02;
const LARGE_CAP_LEVERAGE = Math.max(1, resolveNumberEnv("LARGE_CAP_LEVERAGE", Math.max(1, LEVERAGE - 1)));
const LARGE_CAP_RISK_PER_TRADE = Math.max(
  0.001,
  Math.min(RISK_PER_TRADE, resolveNumberEnv("LARGE_CAP_RISK_PER_TRADE", 0.012))
);
const MAX_CONCURRENT_RISK = Math.max(0.01, Math.min(0.5, resolveNumberEnv("MAX_CONCURRENT_RISK_PCT", 10) / 100));
const MAX_DAILY_DRAWDOWN_PCT = Math.max(0.01, Math.min(0.5, resolveNumberEnv("MAX_DAILY_DRAWDOWN_PCT", 6) / 100));
const MAX_LOSS_STREAK = 3;
const COOLDOWN_DURATION_MS = 60 * 60 * 1000;
const DEFAULT_SL_DISTANCE_PCT = 0.02;
const TRADING_FEE_RATE = 0.0005;
const TAKE_PROFIT_PCT = resolveNumberEnv("TAKE_PROFIT_PCT", 5);
const STOP_LOSS_PCT = resolveNumberEnv("STOP_LOSS_PCT", 5);
const LARGE_CAP_TAKE_PROFIT_PCT = Math.max(0.5, resolveNumberEnv("LARGE_CAP_TAKE_PROFIT_PCT", TAKE_PROFIT_PCT));
const LARGE_CAP_STOP_LOSS_PCT = Math.max(0.5, resolveNumberEnv("LARGE_CAP_STOP_LOSS_PCT", STOP_LOSS_PCT));
const TP_SL_MODE = resolveEnumEnv("TP_SL_MODE", ["ROE", "ATR"] as const, "ROE");
const SETUP_POLICY_ENABLED = String(process.env.SETUP_POLICY_ENABLED ?? "true").toLowerCase() !== "false";
const MIN_RISK_REWARD = resolveNumberEnv("MIN_RISK_REWARD", TP_SL_MODE === "ROE" ? 1 : 1.5);
const SCORE_ENTRY_THRESHOLD = resolveNumberEnv("SCORE_ENTRY_THRESHOLD", 5);
const BTC_SCORE_ENTRY_THRESHOLD = resolveNumberEnv("BTC_SCORE_ENTRY_THRESHOLD", 5);
const PRIORITY_SCORE_ENTRY_THRESHOLD = resolveNumberEnv("PRIORITY_SCORE_ENTRY_THRESHOLD", 7);
const PRIORITY_BTC_SCORE_ENTRY_THRESHOLD = resolveNumberEnv("PRIORITY_BTC_SCORE_ENTRY_THRESHOLD", 8);
const ENTRY_TIMING_MAX = resolveEnumEnv<EntryTimingMax>("ENTRY_TIMING_MAX", ["EARLY", "MID", "LATE"] as const, "MID");
const STRONG_SIGNAL_ENTRY_TIMING_MAX = resolveEnumEnv<EntryTimingMax>(
  "STRONG_SIGNAL_ENTRY_TIMING_MAX",
  ["EARLY", "MID", "LATE"] as const,
  "LATE"
);
const REVERSAL_MAX_HOLD_MINUTES = Math.max(15, Math.trunc(resolveNumberEnv("REVERSAL_MAX_HOLD_MINUTES", 360)));
const STRONG_MAX_HOLD_MINUTES = Math.max(15, Math.trunc(resolveNumberEnv("STRONG_MAX_HOLD_MINUTES", 720)));
const DEFAULT_MAX_HOLD_MINUTES = Math.max(15, Math.trunc(resolveNumberEnv("DEFAULT_MAX_HOLD_MINUTES", 1440)));
const ABSOLUTE_MAX_HOLD_MINUTES = Math.max(
  DEFAULT_MAX_HOLD_MINUTES,
  Math.trunc(resolveNumberEnv("ABSOLUTE_MAX_HOLD_MINUTES", 1440))
);
const REVERSAL_PHASE_MIN = resolveEnumEnv<ReversalPhaseMin>(
  "REVERSAL_PHASE_MIN",
  ["COUNTER_TREND_BOUNCE", "TRANSITION_REVERSAL", "CONFIRMED_REVERSAL"] as const,
  "TRANSITION_REVERSAL"
);
const ENFORCE_RESOLVED_REVERSAL_PHASE = String(process.env.ENFORCE_RESOLVED_REVERSAL_PHASE ?? "true").toLowerCase() !== "false";
const UNRESOLVED_REVERSAL_ALLOW_HIGH_SCORE = String(process.env.UNRESOLVED_REVERSAL_ALLOW_HIGH_SCORE ?? "true").toLowerCase() !== "false";
const UNRESOLVED_REVERSAL_MIN_SCORE = resolveNumberEnv("UNRESOLVED_REVERSAL_MIN_SCORE", 6);
const UNRESOLVED_REVERSAL_REQUIRE_EARLY = String(process.env.UNRESOLVED_REVERSAL_REQUIRE_EARLY ?? "true").toLowerCase() !== "false";
const REVERSAL_VOLATILITY_GATE_ENABLED = String(process.env.REVERSAL_VOLATILITY_GATE_ENABLED ?? "true").toLowerCase() !== "false";
const REVERSAL_MAX_VOLATILITY_PCT = Math.max(0, resolveNumberEnv("REVERSAL_MAX_VOLATILITY_PCT", 35));
const SYMBOL_FAST_SL_COOLDOWN_ENABLED = String(process.env.SYMBOL_FAST_SL_COOLDOWN_ENABLED ?? "true").toLowerCase() !== "false";
const SYMBOL_FAST_SL_HITS_THRESHOLD = Math.max(1, Math.trunc(resolveNumberEnv("SYMBOL_FAST_SL_HITS_THRESHOLD", 2)));
const SYMBOL_FAST_SL_MAX_HOLD_MINUTES = Math.max(0, resolveNumberEnv("SYMBOL_FAST_SL_MAX_HOLD_MINUTES", 5));
const SYMBOL_FAST_SL_LOOKBACK_MINUTES = Math.max(1, Math.trunc(resolveNumberEnv("SYMBOL_FAST_SL_LOOKBACK_MINUTES", 1440)));
const SYMBOL_FAST_SL_COOLDOWN_MINUTES = Math.max(1, Math.trunc(resolveNumberEnv("SYMBOL_FAST_SL_COOLDOWN_MINUTES", 360)));
const FIB_TOUCH_MEMORY_ENABLED = String(process.env.FIB_TOUCH_MEMORY_ENABLED ?? "true").toLowerCase() !== "false";
const FIB_TOUCH_MEMORY_WINDOW_MINUTES = Math.max(1, Math.trunc(resolveNumberEnv("FIB_TOUCH_MEMORY_WINDOW_MINUTES", 3)));
const FIB_TOUCH_MEMORY_MAX_DISTANCE_PCT = Math.max(0.05, resolveNumberEnv("FIB_TOUCH_MEMORY_MAX_DISTANCE_PCT", 0.4));
const MIN_VOLATILITY_PCT = resolveNumberEnv("MIN_VOLATILITY_PCT", 1.5);
const MIN_VOLUME_USD = resolveNumberEnv("MIN_VOLUME_USD", 7_000_000);
const MIN_VOLUME_USD_MAJOR_ALT = resolveNumberEnv("MIN_VOLUME_USD_MAJOR_ALT", 3_000_000);
const LARGE_CAP_SYMBOLS = resolveSymbolSetEnv(
  "LARGE_CAP_SYMBOLS",
  "BTC,ETH,SOL,BNB,XRP,ADA,DOGE,TRX,TON,AVAX,DOT,LINK,POL,LTC,BCH,ATOM,NEAR,ICP,APT,SUI"
);
const MAJOR_ALT_SYMBOLS = resolveSymbolSetEnv(
  "MAJOR_ALT_SYMBOLS",
  "SOL,BNB,XRP,DOGE,ADA,TON,AVAX,LINK,DOT,LTC,TRX,BCH,APT,ARB,OP,INJ,ONDO,SUI,NEAR"
);
type SetupType = "TREND" | "REVERSAL" | "BREAKOUT";
type AssetRiskBucket = "BTC" | "ETH" | "MAJOR" | "SMALL";
type SetupRiskPolicy = {
  setupType: SetupType;
  assetBucket: AssetRiskBucket;
  leverage: number;
  takeProfitPct: number;
  stopLossPct: number;
};

const SETUP_TP_PCT_TREND = Math.max(0.1, resolveNumberEnv("SETUP_TP_PCT_TREND", 5));
const SETUP_SL_PCT_TREND = Math.max(0.1, resolveNumberEnv("SETUP_SL_PCT_TREND", 2));
const SETUP_TP_PCT_REVERSAL = Math.max(0.1, resolveNumberEnv("SETUP_TP_PCT_REVERSAL", 6));
const SETUP_SL_PCT_REVERSAL = Math.max(0.1, resolveNumberEnv("SETUP_SL_PCT_REVERSAL", 2.5));
const SETUP_TP_PCT_BREAKOUT = Math.max(0.1, resolveNumberEnv("SETUP_TP_PCT_BREAKOUT", 3.3));
const SETUP_SL_PCT_BREAKOUT = Math.max(0.1, resolveNumberEnv("SETUP_SL_PCT_BREAKOUT", 1.5));

const LEVERAGE_CAP_BTC_TREND = Math.max(1, resolveNumberEnv("LEVERAGE_CAP_BTC_TREND", 3));
const LEVERAGE_CAP_BTC_REVERSAL = Math.max(1, resolveNumberEnv("LEVERAGE_CAP_BTC_REVERSAL", 2));
const LEVERAGE_CAP_BTC_BREAKOUT = Math.max(1, resolveNumberEnv("LEVERAGE_CAP_BTC_BREAKOUT", 2.5));
const LEVERAGE_CAP_ETH_TREND = Math.max(1, resolveNumberEnv("LEVERAGE_CAP_ETH_TREND", 2.5));
const LEVERAGE_CAP_ETH_REVERSAL = Math.max(1, resolveNumberEnv("LEVERAGE_CAP_ETH_REVERSAL", 2));
const LEVERAGE_CAP_ETH_BREAKOUT = Math.max(1, resolveNumberEnv("LEVERAGE_CAP_ETH_BREAKOUT", 2));
const LEVERAGE_CAP_MAJOR_TREND = Math.max(1, resolveNumberEnv("LEVERAGE_CAP_MAJOR_TREND", 2));
const LEVERAGE_CAP_MAJOR_REVERSAL = Math.max(1, resolveNumberEnv("LEVERAGE_CAP_MAJOR_REVERSAL", 1.5));
const LEVERAGE_CAP_MAJOR_BREAKOUT = Math.max(1, resolveNumberEnv("LEVERAGE_CAP_MAJOR_BREAKOUT", 1.5));
const LEVERAGE_CAP_SMALL_TREND = Math.max(1, resolveNumberEnv("LEVERAGE_CAP_SMALL_TREND", 1.5));
const LEVERAGE_CAP_SMALL_REVERSAL = Math.max(1, resolveNumberEnv("LEVERAGE_CAP_SMALL_REVERSAL", 1));
const LEVERAGE_CAP_SMALL_BREAKOUT = Math.max(1, resolveNumberEnv("LEVERAGE_CAP_SMALL_BREAKOUT", 1));
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_CLOSED_TRADES = 500;
const MAX_EQUITY_POINTS = 1000;
const GLOBAL_TRADE_THROTTLE_WINDOW_MINUTES = Math.max(
  1,
  Math.trunc(resolveNumberEnv("GLOBAL_TRADE_THROTTLE_WINDOW_MINUTES", 30))
);
const GLOBAL_TRADE_THROTTLE_WINDOW_MS = GLOBAL_TRADE_THROTTLE_WINDOW_MINUTES * 60 * 1000;
const MAX_TRADES_LAST_WINDOW = Math.max(0, Math.trunc(resolveNumberEnv("GLOBAL_TRADE_THROTTLE_MAX_TRADES", 3)));
const LOW_VOLATILITY_PCT_THRESHOLD = 1;
const LOW_VOLATILITY_TP_FEASIBILITY_MIN = 0.8;
const NORMAL_TP_FEASIBILITY_MIN = 0.6;
const EARLY_DRAWDOWN_EXIT_PCT = -6;
const SESSION_BLOCK_START_UTC = 2;
const SESSION_BLOCK_END_UTC = 5;
const GLOBAL_KILL_SWITCH_DRAWDOWN_PCT = 0.15;
const MAX_ROLLING_PERFORMANCE_TRADES = 20;
const ORDERBOOK_MAX_SPREAD_PCT_LARGE = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_LARGE", 0.03));
const ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT", 0.08));
const ORDERBOOK_MAX_SPREAD_PCT_ALT = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_ALT", 0.06));
const ORDERBOOK_MIN_DEPTH_MULTIPLIER = Math.max(1, resolveNumberEnv("ORDERBOOK_MIN_DEPTH_MULTIPLIER", 2));
const ORDERBOOK_MAX_AGAINST_IMBALANCE = Math.max(0, Math.min(1, resolveNumberEnv("ORDERBOOK_MAX_AGAINST_IMBALANCE", 0.25)));
const ORDERBOOK_MAX_AGAINST_IMBALANCE_MAJOR_ALT = Math.max(
  0,
  Math.min(1, resolveNumberEnv("ORDERBOOK_MAX_AGAINST_IMBALANCE_MAJOR_ALT", 0.35))
);
const MAX_CLUSTER_ACTIVE_TRADES = 2;
const MAX_CLUSTER_DIRECTION_ACTIVE_TRADES = Math.max(
  1,
  Math.trunc(resolveNumberEnv("MAX_CLUSTER_DIRECTION_ACTIVE_TRADES", 1))
);
const VOLATILITY_STAKE_SCALING_ENABLED = String(process.env.VOLATILITY_STAKE_SCALING_ENABLED ?? "true").toLowerCase() !== "false";
const STAKE_VOL_MID_PCT = Math.max(0, resolveNumberEnv("STAKE_VOL_MID_PCT", 3));
const STAKE_VOL_HIGH_PCT = Math.max(STAKE_VOL_MID_PCT, resolveNumberEnv("STAKE_VOL_HIGH_PCT", 6));
const STAKE_VOL_LOW_MULT = Math.max(0.1, resolveNumberEnv("STAKE_VOL_LOW_MULT", 1));
const STAKE_VOL_MID_MULT = Math.max(0.1, resolveNumberEnv("STAKE_VOL_MID_MULT", 0.85));
const STAKE_VOL_HIGH_MULT = Math.max(0.1, resolveNumberEnv("STAKE_VOL_HIGH_MULT", 0.7));
const ROLLING_DRAWDOWN_WINDOW_MS = Math.max(1, Math.trunc(resolveNumberEnv("ROLLING_DRAWDOWN_WINDOW_HOURS", 24))) * 60 * 60 * 1000;
const ROLLING_DRAWDOWN_LIMIT_PCT = Math.max(0, resolveNumberEnv("ROLLING_DRAWDOWN_LIMIT_PCT", 8));
const ROLLING_DRAWDOWN_COOLDOWN_MS = Math.max(1, Math.trunc(resolveNumberEnv("ROLLING_DRAWDOWN_COOLDOWN_MINUTES", 120))) * 60 * 1000;
const MAX_SLIPPAGE_PCT = Math.max(0, resolveNumberEnv("MAX_SLIPPAGE_PCT", 0.2));
const ADAPTIVE_UPDATE_WINDOW_TRADES = 50;
const EXPECTED_VALUE_MIN = resolveNumberEnv(
  "EXPECTED_VALUE_MIN_PCT",
  resolveNumberEnv("EXPECTED_VALUE_MIN", 0.02)
);
const SENTIMENT_SHIFT_EXIT_ENABLED = String(process.env.SENTIMENT_SHIFT_EXIT_ENABLED ?? "true").toLowerCase() !== "false";
const SENTIMENT_SHIFT_MIN_HOLD_MINUTES = Math.max(0, Math.trunc(resolveNumberEnv("SENTIMENT_SHIFT_MIN_HOLD_MINUTES", 5)));
const SENTIMENT_SHIFT_MIN_CONFLUENCE_SCORE = resolveNumberEnv("SENTIMENT_SHIFT_MIN_CONFLUENCE_SCORE", 6.5);
const SENTIMENT_SHIFT_REQUIRE_BIAS_ALIGNMENT = String(process.env.SENTIMENT_SHIFT_REQUIRE_BIAS_ALIGNMENT ?? "true").toLowerCase() !== "false";
const VIOLENT_MOVE_ALERT_ENABLED = String(process.env.VIOLENT_MOVE_ALERT_ENABLED ?? "true").toLowerCase() !== "false";
const VIOLENT_MOVE_MIN_VOLATILITY_PCT = Math.max(0.1, resolveNumberEnv("VIOLENT_MOVE_MIN_VOLATILITY_PCT", 5));
const VIOLENT_MOVE_MIN_VOLATILITY_PERCENTILE = Math.max(0, Math.min(100, resolveNumberEnv("VIOLENT_MOVE_MIN_VOLATILITY_PERCENTILE", 85)));
const VIOLENT_MOVE_MIN_VOLUME_MULTIPLIER = Math.max(1, resolveNumberEnv("VIOLENT_MOVE_MIN_VOLUME_MULTIPLIER", 2));
const VIOLENT_MOVE_STOCH_MIN_K = Math.max(0, Math.min(100, resolveNumberEnv("VIOLENT_MOVE_STOCH_MIN_K", 55)));
const VIOLENT_MOVE_DROP_CAUTION_ENABLED = String(process.env.VIOLENT_MOVE_DROP_CAUTION_ENABLED ?? "true").toLowerCase() !== "false";
const VIOLENT_MOVE_DROP_WINDOW_MINUTES = Math.max(1, Math.trunc(resolveNumberEnv("VIOLENT_MOVE_DROP_WINDOW_MINUTES", 90)));
const VIOLENT_MOVE_DROP_RATIO = Math.max(0.1, Math.min(0.95, resolveNumberEnv("VIOLENT_MOVE_DROP_RATIO", 0.55)));
const VIOLENT_MOVE_DROP_ABS_VOLATILITY_PCT = Math.max(0.1, resolveNumberEnv("VIOLENT_MOVE_DROP_ABS_VOLATILITY_PCT", 2.2));
const VIOLENT_MOVE_DROP_REQUIRE_STOCH_ROLLOVER = String(process.env.VIOLENT_MOVE_DROP_REQUIRE_STOCH_ROLLOVER ?? "true").toLowerCase() !== "false";
const PRE_PUMP_WATCH_ENABLED = String(process.env.PRE_PUMP_WATCH_ENABLED ?? "true").toLowerCase() !== "false";
const PRE_PUMP_WATCH_MAX_VOLUME_USD = Math.max(100_000, resolveNumberEnv("PRE_PUMP_WATCH_MAX_VOLUME_USD", 40_000_000));
const PRE_PUMP_WATCH_MIN_VOLUME_RATIO = Math.max(1, resolveNumberEnv("PRE_PUMP_WATCH_MIN_VOLUME_RATIO", 1.35));
const PRE_PUMP_WATCH_MIN_VOLATILITY_PERCENTILE = Math.max(
  0,
  Math.min(100, resolveNumberEnv("PRE_PUMP_WATCH_MIN_VOLATILITY_PERCENTILE", 70))
);
const PRE_PUMP_WATCH_MIN_INTERMEDIARY_RSI = Math.max(
  0,
  Math.min(100, resolveNumberEnv("PRE_PUMP_WATCH_MIN_INTERMEDIARY_RSI", 55))
);
const PRE_PUMP_WATCH_MAX_INTERMEDIARY_RSI = Math.max(
  PRE_PUMP_WATCH_MIN_INTERMEDIARY_RSI,
  Math.min(100, resolveNumberEnv("PRE_PUMP_WATCH_MAX_INTERMEDIARY_RSI", 78))
);
const PRE_PUMP_WATCH_REQUIRE_EMA_TREND = String(process.env.PRE_PUMP_WATCH_REQUIRE_EMA_TREND ?? "true").toLowerCase() !== "false";
const LIQUIDITY_HUNT_ENTRY_ENABLED = String(process.env.LIQUIDITY_HUNT_ENTRY_ENABLED ?? "true").toLowerCase() !== "false";
const LIQUIDITY_HUNT_ENTRY_MODE = resolveEnumEnv<"FADE" | "BREAKOUT_FLIP">(
  "LIQUIDITY_HUNT_ENTRY_MODE",
  ["FADE", "BREAKOUT_FLIP"] as const,
  "BREAKOUT_FLIP"
);
const LIQUIDITY_HUNT_ENTRY_LEVERAGE = Math.max(1, resolveNumberEnv("LIQUIDITY_HUNT_ENTRY_LEVERAGE", 10));
const LIQUIDITY_HUNT_ENTRY_TP_PCT = Math.max(0.1, resolveNumberEnv("LIQUIDITY_HUNT_ENTRY_TP_PCT", 15));
const LIQUIDITY_HUNT_ENTRY_SL_PCT = Math.max(0.1, resolveNumberEnv("LIQUIDITY_HUNT_ENTRY_SL_PCT", STOP_LOSS_PCT));
const LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT = Math.max(0.05, resolveNumberEnv("LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT", 1.5));
const LIQUIDITY_HUNT_MIN_BREAK_PCT = Math.max(0, resolveNumberEnv("LIQUIDITY_HUNT_MIN_BREAK_PCT", 0.5));
const LIQUIDITY_HUNT_ONLY_MODE = String(process.env.LIQUIDITY_HUNT_ONLY_MODE ?? "true").toLowerCase() !== "false";
const PRE_PUMP_WATCH_MIN_EMA_SLOPE = resolveNumberEnv("PRE_PUMP_WATCH_MIN_EMA_SLOPE", 0);
const PRE_PUMP_WATCH_REQUIRE_STOCH_UP = String(process.env.PRE_PUMP_WATCH_REQUIRE_STOCH_UP ?? "true").toLowerCase() !== "false";
const PRE_PUMP_WATCH_COOLDOWN_MINUTES = Math.max(1, Math.trunc(resolveNumberEnv("PRE_PUMP_WATCH_COOLDOWN_MINUTES", 180)));
const HTF_MOMENTUM_ALIGNMENT_ENABLED = String(process.env.HTF_MOMENTUM_ALIGNMENT_ENABLED ?? "true").toLowerCase() !== "false";
const HTF_MOMENTUM_BLOCK_SCORE_MIN = Math.max(2, Math.trunc(resolveNumberEnv("HTF_MOMENTUM_BLOCK_SCORE_MIN", 3)));
const EARLY_REVERSAL_MIN_RR = Math.max(0.5, resolveNumberEnv("EARLY_REVERSAL_MIN_RR", 1.2));
const EARLY_REVERSAL_EV_TOLERANCE = Math.max(0, resolveNumberEnv("EARLY_REVERSAL_EV_TOLERANCE", 0));
const IGNORE_SLIPPAGE_GUARD = String(process.env.IGNORE_SLIPPAGE_GUARD ?? "false").toLowerCase() === "true";
const TEST_OPEN_MODE = String(process.env.TEST_OPEN_MODE ?? "false").toLowerCase() === "true";
const CAP_EARLY_DRAWDOWN_TO_SL = String(process.env.CAP_EARLY_DRAWDOWN_TO_SL ?? "true").toLowerCase() !== "false";
const SIM_SIGNAL_ONLY_MODE = String(process.env.SIM_SIGNAL_ONLY_MODE ?? "false").toLowerCase() !== "false";
const FIXED_STAKE_ENABLED = String(process.env.FIXED_STAKE_ENABLED ?? "true").toLowerCase() !== "false";
const SIGNAL_SIM_STAKE_USD = Math.max(1, resolveNumberEnv("SIGNAL_SIM_STAKE_USD", 300));
const SIGNAL_SIM_MAX_ACTIVE_TRADES = Math.max(1, Math.trunc(resolveNumberEnv("SIGNAL_SIM_MAX_ACTIVE_TRADES", 3)));
const MAX_ACTIVE_TRADES_UNDER_1000 = Math.max(1, Math.trunc(resolveNumberEnv("MAX_ACTIVE_TRADES_UNDER_1000", 1)));
const MAX_ACTIVE_TRADES_AT_OR_ABOVE_1000 = Math.max(
  MAX_ACTIVE_TRADES_UNDER_1000,
  Math.trunc(resolveNumberEnv("MAX_ACTIVE_TRADES_AT_OR_ABOVE_1000", 3))
);
const TRADE_FLIP_COOLDOWN_MS = Math.max(0, Math.trunc(resolveNumberEnv("TRADE_FLIP_COOLDOWN_MINUTES", 20))) * 60 * 1000;
const TELEGRAM_ALERT_DEDUPE_MINUTES = Math.max(
  1,
  Math.trunc(resolveNumberEnv("TELEGRAM_ALERT_DEDUPE_MINUTES", 15))
);
const TRADE_OHLC_CACHE_TTL_MS = Math.max(1_000, Math.trunc(resolveNumberEnv("TRADE_OHLC_CACHE_TTL_MS", 10_000)));
const TRADE_OHLC_RATE_LIMIT_COOLDOWN_MS = Math.max(
  1_000,
  Math.trunc(resolveNumberEnv("TRADE_OHLC_RATE_LIMIT_COOLDOWN_MS", 15_000))
);
const TRADE_OHLC_RATE_LIMIT_WARN_INTERVAL_MS = Math.max(
  1_000,
  Math.trunc(resolveNumberEnv("TRADE_OHLC_RATE_LIMIT_WARN_INTERVAL_MS", 30_000))
);
const BITUNIX_DRY_RUN_ENABLED = String(process.env.BITUNIX_DRY_RUN_ENABLED ?? "true").toLowerCase() !== "false";
const BITUNIX_DRY_RUN_MARGIN_COIN = (process.env.BITUNIX_DRY_RUN_MARGIN_COIN ?? "USDT").trim().toUpperCase() || "USDT";
const BITUNIX_DRY_RUN_MIN_LEVERAGE = Math.max(1, Math.trunc(resolveNumberEnv("BITUNIX_DRY_RUN_MIN_LEVERAGE", 10)));
const BITUNIX_DRY_RUN_ENFORCE_MIN_LEVERAGE = String(process.env.BITUNIX_DRY_RUN_ENFORCE_MIN_LEVERAGE ?? "true").toLowerCase() !== "false";
const BITUNIX_DRY_RUN_BLOCK_ON_ERROR = String(process.env.BITUNIX_DRY_RUN_BLOCK_ON_ERROR ?? "false").toLowerCase() === "true";
const FORCE_SINGLE_ACTIVE_TRADE = String(process.env.FORCE_SINGLE_ACTIVE_TRADE ?? "true").toLowerCase() !== "false";
const LIVE_TRADING_ENABLED = String(process.env.LIVE_TRADING_ENABLED ?? "false").toLowerCase() === "true";
const LIVE_ENFORCE_TELEGRAM_OPEN_CLOSE_FROM_LIVE =
  String(process.env.LIVE_ENFORCE_TELEGRAM_OPEN_CLOSE_FROM_LIVE ?? "true").toLowerCase() !== "false";
const LIVE_MAX_ACCOUNT_DRAWDOWN_PCT = Math.max(
  1,
  Math.min(50, resolveNumberEnv("LIVE_MAX_ACCOUNT_DRAWDOWN_PCT", 10))
);
const LIVE_FORCE_CLOSE_ON_MAX_DRAWDOWN =
  String(process.env.LIVE_FORCE_CLOSE_ON_MAX_DRAWDOWN ?? "true").toLowerCase() !== "false";
const LIVE_BITUNIX_MARGIN_COIN = (process.env.LIVE_BITUNIX_MARGIN_COIN ?? "USDT").trim().toUpperCase() || "USDT";
const LIVE_REQUIRE_POSITION_ID_ON_OPEN =
  String(process.env.LIVE_REQUIRE_POSITION_ID_ON_OPEN ?? "true").toLowerCase() !== "false";
const LIVE_TELEGRAM_ALERT_ON_EXECUTION_FAILURE =
  String(process.env.LIVE_TELEGRAM_ALERT_ON_EXECUTION_FAILURE ?? "true").toLowerCase() !== "false";

function getEntryTypeMaxHoldMinutes(entryType: Trade["entryType"]): number {
  if (entryType === "REVERSAL") {
    return REVERSAL_MAX_HOLD_MINUTES;
  }
  if (entryType === "STRONG") {
    return STRONG_MAX_HOLD_MINUTES;
  }
  return DEFAULT_MAX_HOLD_MINUTES;
}

function isBitunixLiveTradingMode(): boolean {
  return LIVE_TRADING_ENABLED && MARKET_DATA_PROVIDER === "BITUNIX";
}

function shouldSendTradeLifecycleTelegram(stage: "OPENED" | "CLOSED", isLiveTrade: boolean): boolean {
  if (!LIVE_TRADING_ENABLED || !LIVE_ENFORCE_TELEGRAM_OPEN_CLOSE_FROM_LIVE) {
    return true;
  }

  if (stage === "OPENED" || stage === "CLOSED") {
    return isLiveTrade;
  }

  return true;
}

function sendTradeLifecycleTelegram(
  payload: Parameters<typeof notifyTelegramEntry>[0],
  isLiveTrade: boolean
): void {
  if (
    (payload.stage === "OPENED" || payload.stage === "CLOSED") &&
    !shouldSendTradeLifecycleTelegram(payload.stage, isLiveTrade)
  ) {
    return;
  }

  notifyTelegramEntry(payload);
}

function alertLiveExecutionFailure(input: {
  symbol: string;
  direction: TradeDirection;
  phase: "OPEN" | "CLOSE";
  reason: string;
  signalType?: string;
  entryPrice?: number;
  tpPrice?: number;
  slPrice?: number;
}): void {
  if (!LIVE_TRADING_ENABLED || !LIVE_TELEGRAM_ALERT_ON_EXECUTION_FAILURE) {
    return;
  }

  const normalizedSymbol = normalizePerpSymbol(input.symbol);
  notifyTelegramEntry({
    stage: "CAUTION",
    symbol: normalizedSymbol,
    direction: input.direction,
    entryTiming: "MID",
    reversalPhase: "UNRESOLVED",
    signalType: input.signalType ?? `LIVE_EXECUTION_${input.phase}_FAILED`,
    entryScore: 0,
    weightedScore: 0,
    signalStrength: 0,
    tpFeasibility: 0,
    structureConfidence: 0,
    volatilityPct: 0,
    takeProfitPct: 0,
    stopLossPct: 0,
    marketCondition: "RANGING",
    entryPrice: input.entryPrice,
    tpPrice: input.tpPrice,
    slPrice: input.slPrice,
    setupConflictNote: `Live ${input.phase.toLowerCase()} failed: ${input.reason}`,
    dedupeKey: `LIVE_EXECUTION_${input.phase}_FAILED:${normalizedSymbol}:${input.direction}:${input.reason.slice(0, 80)}`
  });
}

function resolveLiveQtyBaseUnits(entryPrice: number, stakeUsd: number, leverage: number): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return 0;
  }

  const qty = (stakeUsd * leverage) / entryPrice;
  return Number(qty.toFixed(8));
}

function getBitunixOrderSide(direction: TradeDirection): "BUY" | "SELL" {
  return direction === "LONG" ? "BUY" : "SELL";
}

function getBitunixPositionSide(direction: TradeDirection): "LONG" | "SHORT" {
  return direction === "LONG" ? "LONG" : "SHORT";
}

function pickBestLivePositionMatch(
  positions: BitunixPendingPosition[],
  symbol: string,
  direction: TradeDirection,
  expectedQty: number
): BitunixPendingPosition | null {
  const normalizedSymbol = normalizePerpSymbol(symbol).replace("-PERP", "USDT");
  const expectedSide = getBitunixPositionSide(direction);
  const matches = positions.filter(
    (position) => position.symbol === normalizedSymbol && position.side === expectedSide
  );
  if (matches.length === 0) {
    return null;
  }

  if (!Number.isFinite(expectedQty) || expectedQty <= 0) {
    return matches[0] ?? null;
  }

  return matches
    .slice()
    .sort((left, right) => Math.abs(left.qty - expectedQty) - Math.abs(right.qty - expectedQty))[0] ?? null;
}

async function executeLiveOpenOrder(input: {
  symbol: string;
  direction: TradeDirection;
  leverage: number;
  entryPrice: number;
  stakeUsd: number;
  localTradeId: string;
}): Promise<{
  orderId: string;
  clientId: string;
  positionId?: string;
  qty: number;
}> {
  if (!isBitunixLiveTradingMode()) {
    return {
      orderId: "",
      clientId: "",
      qty: 0
    };
  }

  const qty = resolveLiveQtyBaseUnits(input.entryPrice, input.stakeUsd, input.leverage);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`Live open aborted for ${input.symbol}: invalid qty ${qty}`);
  }

  await changeBitunixLeverage(input.symbol, input.leverage, LIVE_BITUNIX_MARGIN_COIN);
  const order = await placeBitunixMarketOrder({
    symbol: input.symbol,
    side: getBitunixOrderSide(input.direction),
    qty,
    clientId: `hype-${input.localTradeId.slice(-24)}`
  });

  const positions = await fetchBitunixPendingPositions(input.symbol);
  const matched = pickBestLivePositionMatch(positions, input.symbol, input.direction, qty);
  if (LIVE_REQUIRE_POSITION_ID_ON_OPEN && !matched?.positionId) {
    throw new Error(
      `Live order submitted (${order.orderId}) but no matching open position found for ${normalizePerpSymbol(input.symbol)} ${input.direction}`
    );
  }

  return {
    orderId: order.orderId,
    clientId: order.clientId,
    positionId: matched?.positionId,
    qty
  };
}

async function resolveLivePositionIdForTrade(trade: Trade): Promise<string | null> {
  if (!isBitunixLiveTradingMode() || !trade.isLiveTrade) {
    return null;
  }

  if (trade.livePositionId) {
    return trade.livePositionId;
  }

  const qtyGuess = resolveLiveQtyBaseUnits(trade.entryPrice, trade.stakeUsd, trade.leverage);
  const positions = await fetchBitunixPendingPositions(trade.token);
  const matched = pickBestLivePositionMatch(positions, trade.token, trade.direction, qtyGuess);
  if (matched?.positionId) {
    trade.livePositionId = matched.positionId;
    return matched.positionId;
  }

  return null;
}

async function executeLiveCloseForTrade(trade: Trade): Promise<void> {
  if (!isBitunixLiveTradingMode() || !trade.isLiveTrade) {
    return;
  }

  const positionId = await resolveLivePositionIdForTrade(trade);
  if (!positionId) {
    throw new Error(
      `Live close aborted for ${trade.token} ${trade.direction}: no exchange position id found for trade ${trade.id}`
    );
  }

  await flashCloseBitunixPosition(positionId);
}

function getEntryTypeMaxHoldMinutesByMode(
  entryType: Trade["entryType"],
  modeMaxHoldMinutes: number
): number {
  const base = getEntryTypeMaxHoldMinutes(entryType);
  if (!Number.isFinite(modeMaxHoldMinutes) || modeMaxHoldMinutes <= 0) {
    return base;
  }

  return Math.max(15, Math.min(base, Math.trunc(modeMaxHoldMinutes)));
}

function resolveEntryTimingMaxForSignal(signalType: string): EntryTimingMax {
  if (signalType.startsWith("STRONG")) {
    return STRONG_SIGNAL_ENTRY_TIMING_MAX;
  }

  return ENTRY_TIMING_MAX;
}

function resolveMinRiskRewardForCandidate(candidate: RankedTradeCandidate, signalType: string): number {
  const isEarlyReversal = signalType.startsWith("REVERSAL") && candidate.entryTiming === "EARLY";
  if (isEarlyReversal) {
    return Math.min(MIN_RISK_REWARD, EARLY_REVERSAL_MIN_RR);
  }

  return MIN_RISK_REWARD;
}

const openTrades = new Map<string, Trade>();
const closedTrades: Trade[] = [];
const lastOpenedByKey = new Map<string, number>();
const lastSignalDirectionBySymbol = new Map<string, TradeDirection>();
const lastFibTouchBySymbol = new Map<string, { direction: TradeDirection; touchedAtMs: number; signalType: string; score: number }>();
const lastViolentMoveBySymbol = new Map<string, {
  atMs: number;
  direction: TradeDirection;
  volatilityPct: number;
  volume24h: number;
  score: number;
}>();
const lastPrePumpWatchBySymbol = new Map<string, number>();
const latestOhlcByToken = new Map<string, { ohlc: LatestOhlc; at: number }>();
const ohlcCooldownUntilByToken = new Map<string, number>();
const ohlcRateLimitWarnedAtByToken = new Map<string, number>();
let backfillPrisma: PrismaClient | null = null;
let accountBalanceUsd = SIM_INITIAL_CAPITAL_USD;
let dailyStartBalanceUsd = SIM_INITIAL_CAPITAL_USD;
let dailyStartKeyUtc = new Date().toISOString().slice(0, 10);
let lossStreakCount = 0;
let cooldownUntilMs = 0;
let rollingCircuitUntilMs = 0;
let killSwitchActivated = false;
let hydratedFromStorage = false;
const equityCurve: Array<{ at: string; balanceUsd: number }> = [
  { at: new Date().toISOString(), balanceUsd: Number(SIM_INITIAL_CAPITAL_USD.toFixed(2)) }
];

function nowIso(): string {
  return new Date().toISOString();
}

function getBackfillPrisma(): PrismaClient {
  if (!backfillPrisma) {
    backfillPrisma = new PrismaClient();
  }

  return backfillPrisma;
}

type DryRunTradeInput = {
  source: "AUTO_SIGNAL" | "MANUAL_OPEN";
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  leverage: number;
  stakeUsd: number;
};

async function runBitunixDryRunTradePlan(input: DryRunTradeInput): Promise<{ blocked: boolean; reason?: string }> {
  if (MARKET_DATA_PROVIDER !== "BITUNIX" || !BITUNIX_DRY_RUN_ENABLED) {
    return { blocked: false };
  }

  const orderNotionalUsd = Number((input.stakeUsd * input.leverage).toFixed(2));
  const planId = `dryrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const leverageCheck = await fetchBitunixLeverageCheck(
      input.symbol,
      BITUNIX_DRY_RUN_MIN_LEVERAGE,
      BITUNIX_DRY_RUN_MARGIN_COIN
    );

    const blocked = BITUNIX_DRY_RUN_ENFORCE_MIN_LEVERAGE && !leverageCheck.meetsMinLeverage;
    const reason = blocked
      ? `10x verification failed for ${leverageCheck.symbol}: current leverage ${leverageCheck.currentLeverage}x`
      : undefined;

    recordDryRunExecutionPlan({
      id: planId,
      createdAt: nowIso(),
      source: input.source,
      symbol: normalizePerpSymbol(input.symbol),
      side: input.direction,
      entryPrice: Number(input.entryPrice.toFixed(6)),
      tpPrice: Number(input.tpPrice.toFixed(6)),
      slPrice: Number(input.slPrice.toFixed(6)),
      leverageRequested: input.leverage,
      stakeUsd: Number(input.stakeUsd.toFixed(2)),
      orderNotionalUsd,
      status: blocked ? "BLOCKED" : "PLANNED",
      reason,
      leverageCheck: {
        symbol: leverageCheck.symbol,
        marginCoin: leverageCheck.marginCoin,
        currentLeverage: leverageCheck.currentLeverage,
        marginMode: leverageCheck.marginMode,
        minRequiredLeverage: leverageCheck.minRequiredLeverage,
        meetsMinLeverage: leverageCheck.meetsMinLeverage
      }
    });

    return { blocked, reason };
  } catch (error) {
    const reason = `Bitunix dry-run leverage check unavailable: ${error instanceof Error ? error.message : String(error)}`;
    const blocked = BITUNIX_DRY_RUN_BLOCK_ON_ERROR;

    recordDryRunExecutionPlan({
      id: planId,
      createdAt: nowIso(),
      source: input.source,
      symbol: normalizePerpSymbol(input.symbol),
      side: input.direction,
      entryPrice: Number(input.entryPrice.toFixed(6)),
      tpPrice: Number(input.tpPrice.toFixed(6)),
      slPrice: Number(input.slPrice.toFixed(6)),
      leverageRequested: input.leverage,
      stakeUsd: Number(input.stakeUsd.toFixed(2)),
      orderNotionalUsd,
      status: blocked ? "BLOCKED" : "PLANNED",
      reason
    });

    return { blocked, reason };
  }
}

function toNumber(value: number): number {
  return Number(value.toFixed(6));
}

function isRateLimitFetchErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("request too frequently") ||
    lower.includes("too many requests") ||
    lower.includes("429")
  );
}

function readCachedLifecycleOhlc(token: string): LatestOhlc | null {
  const cached = latestOhlcByToken.get(token);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.at > TRADE_OHLC_CACHE_TTL_MS) {
    return null;
  }

  return cached.ohlc;
}

function writeCachedLifecycleOhlc(token: string, ohlc: LatestOhlc): void {
  latestOhlcByToken.set(token, { ohlc, at: Date.now() });
}

async function fetchLifecycleOhlc(token: string): Promise<LatestOhlc | null> {
  const now = Date.now();
  const cached = readCachedLifecycleOhlc(token);
  const cooldownUntil = ohlcCooldownUntilByToken.get(token) ?? 0;
  if (cooldownUntil > now) {
    return cached;
  }

  try {
    const live = await fetchLatestOhlc(token, "1m");
    if (live) {
      writeCachedLifecycleOhlc(token, live);
      ohlcCooldownUntilByToken.delete(token);
      return live;
    }

    return cached;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isRateLimitFetchErrorMessage(message)) {
      throw error;
    }

    ohlcCooldownUntilByToken.set(token, now + TRADE_OHLC_RATE_LIMIT_COOLDOWN_MS);
    const lastWarnAt = ohlcRateLimitWarnedAtByToken.get(token) ?? 0;
    if (now - lastWarnAt >= TRADE_OHLC_RATE_LIMIT_WARN_INTERVAL_MS) {
      ohlcRateLimitWarnedAtByToken.set(token, now);
      console.warn("[trade-engine] 1m candle fetch rate-limited; using cache/cooldown", {
        token,
        cooldownMs: TRADE_OHLC_RATE_LIMIT_COOLDOWN_MS,
        hasCached: cached != null,
        error: message
      });
    }

    return cached;
  }
}

function getTradeKey(token: string, direction: TradeDirection): string {
  return `${token}:${direction}`;
}

function normalizePerpSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (!upper) {
    return upper;
  }

  return upper.endsWith("-PERP") ? upper : `${upper}-PERP`;
}

function getBaseSymbol(symbol: string): string {
  const normalized = normalizePerpSymbol(symbol);
  return normalized.endsWith("-PERP") ? normalized.slice(0, -5) : normalized;
}

function isLargeCap(symbol: string): boolean {
  const base = getBaseSymbol(symbol);
  return LARGE_CAP_SYMBOLS.has(base);
}

function getLeverageForSymbol(symbol: string): number {
  return isLargeCap(symbol) ? LARGE_CAP_LEVERAGE : LEVERAGE;
}

function getRiskPerTradeForSymbol(symbol: string): number {
  return isLargeCap(symbol) ? LARGE_CAP_RISK_PER_TRADE : RISK_PER_TRADE;
}

function isMajorAlt(symbol: string): boolean {
  const base = getBaseSymbol(symbol);
  return MAJOR_ALT_SYMBOLS.has(base);
}

function getAssetRiskBucket(symbol: string): AssetRiskBucket {
  const base = getBaseSymbol(symbol);
  if (base === "BTC") {
    return "BTC";
  }

  if (base === "ETH") {
    return "ETH";
  }

  if (isMajorAlt(symbol) || isLargeCap(symbol)) {
    return "MAJOR";
  }

  return "SMALL";
}

function resolveSetupType(signalType: string, structureState: StructureState): SetupType {
  if (signalType.startsWith("REVERSAL") || structureState === "REVERSAL") {
    return "REVERSAL";
  }

  if (structureState === "BREAKOUT") {
    return "BREAKOUT";
  }

  return "TREND";
}

function getSetupLeverageCap(bucket: AssetRiskBucket, setup: SetupType): number {
  if (bucket === "BTC") {
    if (setup === "TREND") return LEVERAGE_CAP_BTC_TREND;
    if (setup === "REVERSAL") return LEVERAGE_CAP_BTC_REVERSAL;
    return LEVERAGE_CAP_BTC_BREAKOUT;
  }

  if (bucket === "ETH") {
    if (setup === "TREND") return LEVERAGE_CAP_ETH_TREND;
    if (setup === "REVERSAL") return LEVERAGE_CAP_ETH_REVERSAL;
    return LEVERAGE_CAP_ETH_BREAKOUT;
  }

  if (bucket === "MAJOR") {
    if (setup === "TREND") return LEVERAGE_CAP_MAJOR_TREND;
    if (setup === "REVERSAL") return LEVERAGE_CAP_MAJOR_REVERSAL;
    return LEVERAGE_CAP_MAJOR_BREAKOUT;
  }

  if (setup === "TREND") return LEVERAGE_CAP_SMALL_TREND;
  if (setup === "REVERSAL") return LEVERAGE_CAP_SMALL_REVERSAL;
  return LEVERAGE_CAP_SMALL_BREAKOUT;
}

function getSetupTpSlDefaults(setup: SetupType): { takeProfitPct: number; stopLossPct: number } {
  if (setup === "REVERSAL") {
    return { takeProfitPct: SETUP_TP_PCT_REVERSAL, stopLossPct: SETUP_SL_PCT_REVERSAL };
  }

  if (setup === "BREAKOUT") {
    return { takeProfitPct: SETUP_TP_PCT_BREAKOUT, stopLossPct: SETUP_SL_PCT_BREAKOUT };
  }

  return { takeProfitPct: SETUP_TP_PCT_TREND, stopLossPct: SETUP_SL_PCT_TREND };
}

function resolveSetupRiskPolicy(symbol: string, signalType: string, structureState: StructureState): SetupRiskPolicy {
  const setupType = resolveSetupType(signalType, structureState);
  const assetBucket = getAssetRiskBucket(symbol);
  const baseLeverage = getLeverageForSymbol(symbol);
  const leverageCap = getSetupLeverageCap(assetBucket, setupType);
  const leverage = SETUP_POLICY_ENABLED ? Math.max(1, Math.min(baseLeverage, leverageCap)) : baseLeverage;
  const defaults = getSetupTpSlDefaults(setupType);

  return {
    setupType,
    assetBucket,
    leverage,
    takeProfitPct: defaults.takeProfitPct,
    stopLossPct: defaults.stopLossPct
  };
}

function getMinVolumeUsdForSymbol(symbol: string): number {
  if (isLargeCap(symbol)) {
    return MIN_VOLUME_USD;
  }

  if (isMajorAlt(symbol)) {
    return MIN_VOLUME_USD_MAJOR_ALT;
  }

  return MIN_VOLUME_USD;
}

function getOrderBookSpreadLimitPct(symbol: string): number {
  if (isLargeCap(symbol)) {
    return ORDERBOOK_MAX_SPREAD_PCT_LARGE;
  }

  if (isMajorAlt(symbol)) {
    return ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT;
  }

  return ORDERBOOK_MAX_SPREAD_PCT_ALT;
}

function getOrderBookMaxAgainstImbalance(symbol: string): number {
  if (isMajorAlt(symbol) && !isLargeCap(symbol)) {
    return ORDERBOOK_MAX_AGAINST_IMBALANCE_MAJOR_ALT;
  }

  return ORDERBOOK_MAX_AGAINST_IMBALANCE;
}

function getCluster(symbol: string): "L1" | "L2" | "DEFI" | "OTHER" {
  const base = getBaseSymbol(symbol);
  if (base === "BTC" || base === "ETH") {
    return "L1";
  }

  if (["SOL", "AVAX", "NEAR", "SUI", "ADA"].includes(base)) {
    return "L2";
  }

  if (["LINK", "AAVE", "UNI"].includes(base)) {
    return "DEFI";
  }

  return "OTHER";
}

function countClusterActiveTrades(cluster: "L1" | "L2" | "DEFI" | "OTHER"): number {
  return Array.from(openTrades.values()).filter((trade) => trade.status === "OPEN" && trade.cluster === cluster).length;
}

function countClusterDirectionActiveTrades(
  cluster: "L1" | "L2" | "DEFI" | "OTHER",
  direction: TradeDirection
): number {
  return Array.from(openTrades.values()).filter(
    (trade) => trade.status === "OPEN" && trade.cluster === cluster && trade.direction === direction
  ).length;
}

function scaleStakeByVolatility(baseStakeUsd: number, volatilityPct: number): number {
  if (!VOLATILITY_STAKE_SCALING_ENABLED) {
    return baseStakeUsd;
  }

  if (!Number.isFinite(volatilityPct) || volatilityPct <= 0) {
    return Number((baseStakeUsd * STAKE_VOL_MID_MULT).toFixed(2));
  }

  if (volatilityPct >= STAKE_VOL_HIGH_PCT) {
    return Number((baseStakeUsd * STAKE_VOL_HIGH_MULT).toFixed(2));
  }

  if (volatilityPct >= STAKE_VOL_MID_PCT) {
    return Number((baseStakeUsd * STAKE_VOL_MID_MULT).toFixed(2));
  }

  return Number((baseStakeUsd * STAKE_VOL_LOW_MULT).toFixed(2));
}

function applyEntrySlippage(entryPrice: number, direction: TradeDirection, slippagePct: number): number {
  const ratio = slippagePct / 100;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(ratio) || ratio <= 0) {
    return Number(entryPrice.toFixed(6));
  }

  return direction === "LONG"
    ? Number((entryPrice * (1 + ratio)).toFixed(6))
    : Number((entryPrice * (1 - ratio)).toFixed(6));
}

function passesRegimeEntryRules(row: TokenRsiResult, direction: TradeDirection): boolean {
  const regime = row.tradeContext?.regime ?? "CHOPPY";
  const signalType = row.signal.type;
  const structureState = row.tradeContext?.structureState ?? "CHOP";
  const confluenceScore = row.confluence.score;

  if (regime === "CHOPPY" && signalType.startsWith("STRONG")) {
    return false;
  }

  // Allow REVERSAL in TRENDING when timing is EARLY and confidence is high, or when structure is already REVERSAL
  if (regime === "TRENDING" && signalType.startsWith("REVERSAL") && structureState !== "REVERSAL") {
    const entryTiming = row.entryTiming ?? classifyEntryTiming({
      direction,
      price: row.close,
      atr: Number(row.tradeContext?.atr ?? 0),
      supportDistancePct: Number(row.levels.supportDistancePct ?? 0),
      resistanceDistancePct: Number(row.levels.resistanceDistancePct ?? 0),
      ema20: Number(row.tradeContext?.ema20 ?? 0)
    });

    // Allow if EARLY timing with sufficient confluence score (meets base threshold)
    const isEarlyWithHighConfluence = entryTiming === "EARLY" && confluenceScore >= SCORE_ENTRY_THRESHOLD;
    if (isEarlyWithHighConfluence) {
      console.info("[trade-engine] Trade allowed: trending reversal with early timing and high confidence", {
        symbol: row.symbol,
        signal: row.signal.type,
        entryTiming,
        confluenceScore,
        threshold: SCORE_ENTRY_THRESHOLD
      });
      return true;
    }
    return false;
  }

  if (regime === "LOW_VOL" && !signalType.startsWith("STRONG")) {
    return false;
  }

  if (regime === "EXPANSION" && !signalType.startsWith("STRONG")) {
    return false;
  }

  if (direction === "LONG" && signalType.includes("SHORT")) {
    return false;
  }

  if (direction === "SHORT" && signalType.includes("LONG")) {
    return false;
  }

  return true;
}

function getTradeLevels(
  entryPrice: number,
  direction: TradeDirection,
  symbol: string,
  atr: number,
  policy?: SetupRiskPolicy
): { tpPrice: number; slPrice: number; takeProfitPct: number; stopLossPct: number } {
  const leverage = policy?.leverage ?? getLeverageForSymbol(symbol);

  if (TP_SL_MODE === "ROE") {
    const takeProfitPct = Number((
      policy?.takeProfitPct ?? (isLargeCap(symbol) ? LARGE_CAP_TAKE_PROFIT_PCT : TAKE_PROFIT_PCT)
    ).toFixed(3));
    const stopLossPct = Number((
      policy?.stopLossPct ?? (isLargeCap(symbol) ? LARGE_CAP_STOP_LOSS_PCT : STOP_LOSS_PCT)
    ).toFixed(3));
    const tpMoveAbs = entryPrice * (takeProfitPct / 100 / leverage);
    const slMoveAbs = entryPrice * (stopLossPct / 100 / leverage);

    if (direction === "LONG") {
      return {
        tpPrice: toNumber(entryPrice + tpMoveAbs),
        slPrice: toNumber(entryPrice - slMoveAbs),
        takeProfitPct,
        stopLossPct
      };
    }

    return {
      tpPrice: toNumber(entryPrice - tpMoveAbs),
      slPrice: toNumber(entryPrice + slMoveAbs),
      takeProfitPct,
      stopLossPct
    };
  }

  const atrValue = Number.isFinite(atr) && atr > 0 ? atr : entryPrice * 0.005;
  const isLarge = isLargeCap(symbol);
  const isMajor = isMajorAlt(symbol);
  const tpMult = isLarge ? 1.5 : isMajor ? 2 : 2.5;
  const slMult = isLarge ? 1.0 : isMajor ? 1.2 : 1.5;

  const tpMoveAbs = atrValue * tpMult;
  const slMoveAbs = atrValue * slMult;

  const takeProfitPctRaw = Number((((tpMoveAbs / entryPrice) * leverage) * 100).toFixed(3));
  const stopLossPctRaw = Number((((slMoveAbs / entryPrice) * leverage) * 100).toFixed(3));
  const takeProfitPct = Number((policy ? Math.min(takeProfitPctRaw, policy.takeProfitPct) : takeProfitPctRaw).toFixed(3));
  const stopLossPct = Number((policy ? Math.min(stopLossPctRaw, policy.stopLossPct) : stopLossPctRaw).toFixed(3));
  const tpMoveCappedAbs = entryPrice * (takeProfitPct / 100 / leverage);
  const slMoveCappedAbs = entryPrice * (stopLossPct / 100 / leverage);

  if (direction === "LONG") {
    return {
      tpPrice: toNumber(entryPrice + tpMoveCappedAbs),
      slPrice: toNumber(entryPrice - slMoveCappedAbs),
      takeProfitPct,
      stopLossPct
    };
  }

  return {
    tpPrice: toNumber(entryPrice - tpMoveCappedAbs),
    slPrice: toNumber(entryPrice + slMoveCappedAbs),
    takeProfitPct,
    stopLossPct
  };
}

type HigherTimeframeTrend = "BULLISH" | "BEARISH" | "NEUTRAL";
type StructureState = "TRENDING" | "BREAKOUT" | "REVERSAL" | "CHOP";

type RankedTradeCandidate = {
  row: TokenRsiResult;
  direction: TradeDirection;
  entryTiming: EntryTiming;
  reversalPhase: ReversalPhase;
  takeProfitPct: number;
  stopLossPct: number;
  expectedMove: number;
  signalStrength: number;
  higherTimeframeTrend: HigherTimeframeTrend;
  structureState: StructureState;
  structureConfidence: number;
  regime: MarketRegime;
  riskReward: number;
  expectedValue: number;
  liquidityQuality: number;
  volatilityPotential: number;
  signalTypeBonus: number;
  fibScore?: number;
  fibNearestLevel?: string;
  fibTouchMemoryEligible?: boolean;
  fibTouchDistancePct?: number;
  setupType: SetupType;
  assetBucket: AssetRiskBucket;
  leverage: number;
  score: number;
};

type AdaptiveFeedback = {
  tightenedReversal: boolean;
  reduceChoppyFrequency: boolean;
  downrankedSymbols: Set<string>;
  signalWinRate: Map<string, number>;
  regimeWinRate: Map<string, number>;
  symbolWinRate: Map<string, number>;
  volatilityBucketWinRate: Map<string, number>;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function resolveHigherTimeframeTrend(row: TokenRsiResult): HigherTimeframeTrend {
  const macroDirection = row.timeframes.macro.trend.direction;
  const intermediaryDirection = row.timeframes.intermediary.trend.direction;

  if (macroDirection === "UP" && intermediaryDirection === "UP") {
    return "BULLISH";
  }

  if (macroDirection === "DOWN" && intermediaryDirection === "DOWN") {
    return "BEARISH";
  }

  return "NEUTRAL";
}

function resolveStructureState(row: TokenRsiResult, direction: TradeDirection): StructureState {
  const macroDirection = row.timeframes.macro.trend.direction;
  const intermediaryDirection = row.timeframes.intermediary.trend.direction;
  const microDirection = row.timeframes.microTrigger.trend.direction;
  const targetTrend = direction === "LONG" ? "UP" : "DOWN";
  const alignedTimeframes = [macroDirection, intermediaryDirection, microDirection].filter(
    (item) => item === targetTrend
  ).length;

  if (alignedTimeframes >= 2) {
    return "TRENDING";
  }

  if (row.signal.type.startsWith("REVERSAL")) {
    return "REVERSAL";
  }

  if (
    microDirection === targetTrend ||
    row.signal.type.startsWith("CONTINUATION")
  ) {
    return "BREAKOUT";
  }

  return "CHOP";
}

function resolveReversalPhase(row: TokenRsiResult, direction: TradeDirection): ReversalPhase {
  return classifyReversalPhase({
    direction,
    dailyTrend: row.timeframes.daily?.trend.direction ?? null,
    twelvehTrend: row.timeframes.twelveh?.trend.direction ?? null,
    macroTrend: row.timeframes.macro.trend.direction,
    intermediaryTrend: row.timeframes.intermediary.trend.direction,
    microTrend: row.timeframes.microTrigger.trend.direction,
    structureState: row.tradeContext?.structureState ?? null
  });
}

function resolveStructureConfidence(
  higherTimeframeTrend: HigherTimeframeTrend,
  structureState: StructureState,
  direction: TradeDirection
): number {
  const trendAligned =
    (direction === "LONG" && higherTimeframeTrend === "BULLISH") ||
    (direction === "SHORT" && higherTimeframeTrend === "BEARISH");

  if (trendAligned && structureState === "TRENDING") {
    return 1;
  }

  if (structureState === "REVERSAL") {
    return higherTimeframeTrend === "NEUTRAL" ? 0.7 : 0.6;
  }

  if (structureState === "BREAKOUT") {
    return 0.7;
  }

  if (structureState === "CHOP") {
    return 0.3;
  }

  return 0.5;
}

function resolveSignalStrength(row: TokenRsiResult): number {
  const normalizedScore = clamp01(
    row.confluence.maxScore > 0 ? row.confluence.score / row.confluence.maxScore : 0
  );

  if (row.signal.type.startsWith("STRONG")) {
    return Math.max(0.95, normalizedScore);
  }

  if (row.signal.type.startsWith("CONTINUATION")) {
    return Math.max(0.75, normalizedScore);
  }

  if (row.signal.type.startsWith("REVERSAL")) {
    return Math.max(0.85, normalizedScore);
  }

  return normalizedScore;
}

function volatilityBucket(volatilityPct: number): string {
  if (!Number.isFinite(volatilityPct) || volatilityPct < 1.5) {
    return "LOW";
  }
  if (volatilityPct < 3) {
    return "MID";
  }
  return "HIGH";
}

function getAdaptiveFeedback(): AdaptiveFeedback {
  const settled = closedTrades.filter((trade) => trade.status === "WIN" || trade.status === "LOSS");
  const lastWindow = settled
    .sort((left, right) => Date.parse(right.closeTime ?? right.openTime) - Date.parse(left.closeTime ?? left.openTime))
    .slice(0, ADAPTIVE_UPDATE_WINDOW_TRADES);

  const signalMap = new Map<string, { wins: number; total: number }>();
  const regimeMap = new Map<string, { wins: number; total: number }>();
  const symbolMap = new Map<string, { wins: number; total: number }>();
  const volBucketMap = new Map<string, { wins: number; total: number }>();

  for (const trade of lastWindow) {
    const isWin = trade.status === "WIN";
    const signalKey = trade.entryType;
    const regimeKey = trade.regime;
    const symbolKey = trade.token;
    const volKey = volatilityBucket(trade.volatilityPct);

    const signalAgg = signalMap.get(signalKey) ?? { wins: 0, total: 0 };
    signalAgg.total += 1;
    if (isWin) signalAgg.wins += 1;
    signalMap.set(signalKey, signalAgg);

    const regimeAgg = regimeMap.get(regimeKey) ?? { wins: 0, total: 0 };
    regimeAgg.total += 1;
    if (isWin) regimeAgg.wins += 1;
    regimeMap.set(regimeKey, regimeAgg);

    const symbolAgg = symbolMap.get(symbolKey) ?? { wins: 0, total: 0 };
    symbolAgg.total += 1;
    if (isWin) symbolAgg.wins += 1;
    symbolMap.set(symbolKey, symbolAgg);

    const volAgg = volBucketMap.get(volKey) ?? { wins: 0, total: 0 };
    volAgg.total += 1;
    if (isWin) volAgg.wins += 1;
    volBucketMap.set(volKey, volAgg);
  }

  const signalWinRate = new Map<string, number>();
  const regimeWinRate = new Map<string, number>();
  const symbolWinRate = new Map<string, number>();
  const volatilityBucketWinRate = new Map<string, number>();

  for (const [key, value] of signalMap.entries()) {
    signalWinRate.set(key, value.total > 0 ? (value.wins / value.total) * 100 : 0);
  }
  for (const [key, value] of regimeMap.entries()) {
    regimeWinRate.set(key, value.total > 0 ? (value.wins / value.total) * 100 : 0);
  }
  for (const [key, value] of symbolMap.entries()) {
    symbolWinRate.set(key, value.total > 0 ? (value.wins / value.total) * 100 : 0);
  }
  for (const [key, value] of volBucketMap.entries()) {
    volatilityBucketWinRate.set(key, value.total > 0 ? (value.wins / value.total) * 100 : 0);
  }

  const reversalWinRate = signalWinRate.get("REVERSAL") ?? 50;
  const choppyWinRate = regimeWinRate.get("CHOPPY") ?? 50;
  const downrankedSymbols = new Set(
    Array.from(symbolWinRate.entries())
      .filter(([, winRate]) => winRate < 35)
      .map(([symbol]) => symbol)
  );

  return {
    tightenedReversal: settled.length >= ADAPTIVE_UPDATE_WINDOW_TRADES && reversalWinRate < 40,
    reduceChoppyFrequency: settled.length >= ADAPTIVE_UPDATE_WINDOW_TRADES && choppyWinRate < 45,
    downrankedSymbols,
    signalWinRate,
    regimeWinRate,
    symbolWinRate,
    volatilityBucketWinRate
  };
}

function resolveRegimeAlignment(regime: MarketRegime, signalType: string): number {
  if (regime === "LOW_VOL") {
    return -1;
  }

  if (regime === "TRENDING") {
    if (signalType.startsWith("CONTINUATION") || signalType.startsWith("STRONG")) {
      return 1.5;
    }
    if (signalType.startsWith("REVERSAL")) {
      return -1;
    }
  }

  if (regime === "CHOPPY") {
    if (signalType.startsWith("REVERSAL")) {
      return 1.5;
    }
    if (signalType.startsWith("STRONG")) {
      return -1;
    }
  }

  if (regime === "EXPANSION") {
    if (signalType.startsWith("STRONG")) {
      return 1.5;
    }
    if (signalType.startsWith("REVERSAL")) {
      return 0.6;
    }
    if (signalType.startsWith("CONTINUATION")) {
      return -1;
    }
  }

  return 0;
}

function historicalExpectedValue(row: TokenRsiResult): number | null {
  const settled = closedTrades.filter((trade) => trade.status === "WIN" || trade.status === "LOSS");
  if (settled.length < 10) {
    return null;
  }

  const sameSignal = settled.filter((trade) => trade.entryType === (row.signal.type.startsWith("STRONG")
    ? "STRONG"
    : row.signal.type.startsWith("CONTINUATION")
      ? "CONTINUATION"
      : row.signal.type.startsWith("REVERSAL")
        ? "REVERSAL"
        : "SCORE_BASED"));

  if (sameSignal.length < 5) {
    return null;
  }

  const wins = sameSignal.filter((trade) => trade.status === "WIN");
  const losses = sameSignal.filter((trade) => trade.status === "LOSS");
  if (wins.length === 0 || losses.length === 0) {
    return null;
  }

  const winRate = wins.length / sameSignal.length;
  const avgWin = wins.reduce((sum, trade) => sum + Math.max(trade.result ?? 0, 0), 0) / wins.length;
  const avgLoss = Math.abs(losses.reduce((sum, trade) => sum + Math.min(trade.result ?? 0, 0), 0) / losses.length);
  return Number(((winRate * avgWin) - ((1 - winRate) * avgLoss)).toFixed(6));
}

function passesRuntimeOrderBookGate(
  symbol: string,
  direction: TradeDirection,
  spreadPct: number,
  combinedDepthUsd: number,
  imbalance: number,
  orderNotionalUsd: number
): boolean {
  const maxSpreadPct = getOrderBookSpreadLimitPct(symbol);
  const maxAgainstImbalance = getOrderBookMaxAgainstImbalance(symbol);
  const minDepthUsd = Math.max(orderNotionalUsd, 0) * ORDERBOOK_MIN_DEPTH_MULTIPLIER;
  const spreadPass = Number.isFinite(spreadPct) && spreadPct > 0 && spreadPct <= maxSpreadPct;
  const depthPass = Number.isFinite(combinedDepthUsd) && combinedDepthUsd >= minDepthUsd;
  const imbalancePass =
    direction === "LONG"
      ? imbalance >= -maxAgainstImbalance
      : imbalance <= maxAgainstImbalance;

  return spreadPass && depthPass && imbalancePass;
}

function buildFibonacciLevels(row: TokenRsiResult, direction: TradeDirection): FibonacciLevels | null {
  const support = Number(row.levels.localSupport ?? 0);
  const resistance = Number(row.levels.localResistance ?? 0);
  const close = Number(row.close ?? 0);

  const highPoint = Math.max(support, resistance, close);
  const lowPoint = Math.min(support, resistance, close);
  const range = highPoint - lowPoint;

  if (!Number.isFinite(highPoint) || !Number.isFinite(lowPoint) || range <= 0) {
    return null;
  }

  if (range / Math.max(close, 1) < 0.0025) {
    return null;
  }

  return calculateFibonacciLevels(highPoint, lowPoint, direction === "LONG" ? "uptrend" : "downtrend");
}

function calcLeveragedMovePct(entry: number, target: number, leverage: number): number {
  if (!Number.isFinite(entry) || !Number.isFinite(target) || entry <= 0 || leverage <= 0) {
    return 0;
  }

  return Number((Math.abs((target - entry) / entry) * leverage * 100).toFixed(3));
}

function pickNearestLevel(levels: number[], target: number): number | null {
  if (levels.length === 0) {
    return null;
  }

  let best = levels[0];
  let bestDist = Math.abs(best - target);
  for (const value of levels) {
    const dist = Math.abs(value - target);
    if (dist < bestDist) {
      best = value;
      bestDist = dist;
    }
  }

  return best;
}

function getTradeLevelsWithStrategy(
  entryPrice: number,
  direction: TradeDirection,
  row: TokenRsiResult,
  strategyConfig: StrategySettings | null,
  policy?: SetupRiskPolicy
): { tpPrice: number; slPrice: number; takeProfitPct: number; stopLossPct: number } {
  const effectivePolicy = policy ?? resolveSetupRiskPolicy(
    row.symbol,
    row.signal.type,
    resolveStructureState(row, direction)
  );
  const baseLevels = getTradeLevels(entryPrice, direction, row.symbol, Number(row.tradeContext?.atr ?? 0), effectivePolicy);
  if (!strategyConfig?.enableFibonacci) {
    return baseLevels;
  }

  const fibLevels = buildFibonacciLevels(row, direction);
  if (!fibLevels) {
    return baseLevels;
  }

  const ladder = [
    fibLevels.level0,
    fibLevels.level236,
    fibLevels.level382,
    fibLevels.level50,
    fibLevels.level618,
    fibLevels.level786,
    fibLevels.level100
  ].filter((value) => Number.isFinite(value));

  if (ladder.length === 0) {
    return baseLevels;
  }

  const leverage = effectivePolicy.leverage;
  const aboveEntry = ladder.filter((value) => value > entryPrice).sort((a, b) => a - b);
  const belowEntry = ladder.filter((value) => value < entryPrice).sort((a, b) => a - b);

  if (direction === "LONG") {
    const tpCandidate = pickNearestLevel(aboveEntry, baseLevels.tpPrice);
    const slCandidate = pickNearestLevel(belowEntry, baseLevels.slPrice);

    if (tpCandidate == null || slCandidate == null || tpCandidate <= entryPrice || slCandidate >= entryPrice) {
      return baseLevels;
    }

    return {
      tpPrice: toNumber(tpCandidate),
      slPrice: toNumber(slCandidate),
      takeProfitPct: calcLeveragedMovePct(entryPrice, tpCandidate, leverage),
      stopLossPct: calcLeveragedMovePct(entryPrice, slCandidate, leverage)
    };
  }

  const tpCandidate = pickNearestLevel(belowEntry, baseLevels.tpPrice);
  const slCandidate = pickNearestLevel(aboveEntry, baseLevels.slPrice);
  if (tpCandidate == null || slCandidate == null || tpCandidate >= entryPrice || slCandidate <= entryPrice) {
    return baseLevels;
  }

  return {
    tpPrice: toNumber(tpCandidate),
    slPrice: toNumber(slCandidate),
    takeProfitPct: calcLeveragedMovePct(entryPrice, tpCandidate, leverage),
    stopLossPct: calcLeveragedMovePct(entryPrice, slCandidate, leverage)
  };
}

function buildRankedTradeCandidate(
  row: TokenRsiResult,
  direction: TradeDirection,
  feedback: AdaptiveFeedback,
  strategyConfig: StrategySettings | null
): RankedTradeCandidate {
  const atr = Number(row.tradeContext?.atr ?? 0);
  const structureState = resolveStructureState(row, direction);
  const setupPolicy = resolveSetupRiskPolicy(row.symbol, row.signal.type, structureState);
  const levels = getTradeLevelsWithStrategy(row.close, direction, row, strategyConfig, setupPolicy);
  const tpDistance = Math.abs(levels.tpPrice - row.close);
  const slDistance = Math.abs(levels.slPrice - row.close);
  const riskReward = slDistance > 0 ? tpDistance / slDistance : 0;
  const expectedMove = row.close > 0 ? tpDistance / row.close : 0;
  const signalStrength = resolveSignalStrength(row);
  const higherTimeframeTrend = resolveHigherTimeframeTrend(row);
  const structureConfidence = resolveStructureConfidence(higherTimeframeTrend, structureState, direction);
  const normalizedTakeProfitPct = Number(levels.takeProfitPct.toFixed(3));
  const normalizedStopLossPct = Number(levels.stopLossPct.toFixed(3));
  const regime = row.tradeContext?.regime ?? "CHOPPY";
  const regimeAlignment = resolveRegimeAlignment(regime, row.signal.type);
  const liquidityQuality = clamp01((row.tradeContext?.liquidityPercentile ?? 0) / 100);
  const volatilityPotential = clamp01((row.tradeContext?.volatilityPercentile ?? 0) / 100);
  const signalTypeBonus = row.signal.type.startsWith("STRONG") ? 1 : row.signal.type.startsWith("REVERSAL") ? 0.8 : 0.6;
  const resistanceBuffer = direction === "LONG" ? row.levels.resistanceDistancePct : row.levels.supportDistancePct;
  const distancePenalty = resistanceBuffer < 0.7 ? -1 : resistanceBuffer < 1.2 ? -0.4 : 0;
  const fibLevels = strategyConfig?.enableFibonacci ? buildFibonacciLevels(row, direction) : null;
  const fibScore = fibLevels ? scoreFibSetup(row.close, fibLevels, levels.tpPrice, levels.slPrice) : 0;
  const nearestFib = fibLevels ? getNearestFibLevel(row.close, fibLevels) : null;
  const fibTouchMemoryEligible = Boolean(nearestFib && nearestFib.distancePct <= FIB_TOUCH_MEMORY_MAX_DISTANCE_PCT);

  let fibRetestBoost = 0;
  if (nearestFib && nearestFib.distancePct <= 0.4) {
    fibRetestBoost += 0.6;
  }

  let scoreRaw =
    regimeAlignment +
    Math.min(riskReward, 3) +
    (volatilityPotential * 1.5) +
    (liquidityQuality * 1.5) +
    distancePenalty +
    signalTypeBonus +
    ((fibScore / 100) * 1.2) +
    fibRetestBoost;

  if (riskReward < 1.5) {
    scoreRaw -= 2;
  }

  if (feedback.tightenedReversal && row.signal.type.startsWith("REVERSAL")) {
    scoreRaw -= 1;
  }
  if (feedback.reduceChoppyFrequency && regime === "CHOPPY") {
    scoreRaw -= 0.8;
  }
  if (feedback.downrankedSymbols.has(row.symbol)) {
    scoreRaw -= 0.7;
  }

  const entryTiming = row.entryTiming ?? classifyEntryTiming({
    direction,
    price: row.close,
    atr: Number(row.tradeContext?.atr ?? 0),
    supportDistancePct: Number(row.levels.supportDistancePct ?? 0),
    resistanceDistancePct: Number(row.levels.resistanceDistancePct ?? 0),
    ema20: Number(row.tradeContext?.ema20 ?? 0)
  });
  let adjustedEntryTiming = entryTiming;
  if (strategyConfig?.enableFibonacci && nearestFib && nearestFib.distancePct <= 0.4) {
    if (entryTiming === "MID") {
      adjustedEntryTiming = "EARLY";
    } else if (entryTiming === "LATE") {
      adjustedEntryTiming = "MID";
    }
  }
  const reversalPhase = resolveReversalPhase(row, direction);

  if (reversalPhase === "UNRESOLVED") {
    scoreRaw -= 2;
  } else if (reversalPhase === "COUNTER_TREND_BOUNCE") {
    scoreRaw -= 1.2;
  } else if (reversalPhase === "TRANSITION_REVERSAL") {
    scoreRaw -= 0.4;
  } else if (reversalPhase === "CONFIRMED_REVERSAL") {
    scoreRaw += 0.5;
  }

  const score = Math.max(0, Math.min(10, Number(scoreRaw.toFixed(6))));

  const winProb = score / 10;
  const expectedValueRaw = (winProb * normalizedTakeProfitPct) - ((1 - winProb) * normalizedStopLossPct);
  const expectedValue = Number(expectedValueRaw.toFixed(6));

  return {
    row,
    direction,
    entryTiming: adjustedEntryTiming,
    reversalPhase,
    takeProfitPct: normalizedTakeProfitPct,
    stopLossPct: normalizedStopLossPct,
    expectedMove,
    signalStrength,
    higherTimeframeTrend,
    structureState,
    structureConfidence,
    regime,
    riskReward: Number(riskReward.toFixed(6)),
    expectedValue,
    liquidityQuality,
    volatilityPotential,
    signalTypeBonus,
    fibScore: fibScore > 0 ? Number(fibScore.toFixed(3)) : undefined,
    fibNearestLevel: nearestFib?.level,
    fibTouchMemoryEligible,
    fibTouchDistancePct: nearestFib?.distancePct,
    setupType: setupPolicy.setupType,
    assetBucket: setupPolicy.assetBucket,
    leverage: setupPolicy.leverage,
    score
  };
}

function compareTradeCandidates(left: RankedTradeCandidate, right: RankedTradeCandidate): number {
  if (left.expectedValue !== right.expectedValue) {
    return right.expectedValue - left.expectedValue;
  }

  if (left.liquidityQuality !== right.liquidityQuality) {
    return right.liquidityQuality - left.liquidityQuality;
  }

  if (left.structureConfidence !== right.structureConfidence) {
    return right.structureConfidence - left.structureConfidence;
  }

  return left.row.symbol.localeCompare(right.row.symbol);
}

function signalToDirection(signal: string): TradeDirection | null {
  if (signal === "STRONG LONG") return "LONG";
  if (signal === "STRONG SHORT") return "SHORT";
  if (signal === "CONTINUATION LONG") return "LONG";
  if (signal === "CONTINUATION SHORT") return "SHORT";
  if (signal === "REVERSAL LONG") return "LONG";
  if (signal === "REVERSAL SHORT") return "SHORT";
  return null;
}

function getTelegramSetupConflictNote(row: TokenRsiResult, direction: TradeDirection): string | undefined {
  if (direction === "LONG" && row.status === "OVERBOUGHT") {
    return "Overbought vs long reversal: setup is contested";
  }

  if (direction === "SHORT" && row.status === "OVERSOLD") {
    return "Oversold vs short reversal: setup is contested";
  }

  return undefined;
}

function evaluatePrePumpWatch(row: TokenRsiResult, volume24h: number, minVolumeUsd: number): {
  eligible: boolean;
  reason?: string;
  details?: Record<string, unknown>;
} {
  if (!PRE_PUMP_WATCH_ENABLED) {
    return { eligible: false, reason: "watch disabled" };
  }

  const signalDirection = signalToDirection(row.signal.type);
  if (signalDirection) {
    return { eligible: false, reason: "already directional signal" };
  }

  if (row.status === "OVERBOUGHT") {
    return { eligible: false, reason: "already overbought" };
  }

  if (volume24h > PRE_PUMP_WATCH_MAX_VOLUME_USD) {
    return { eligible: false, reason: "not low-liquidity bucket" };
  }

  const volumeRatio = volume24h / Math.max(1, minVolumeUsd);
  if (volumeRatio < PRE_PUMP_WATCH_MIN_VOLUME_RATIO) {
    return {
      eligible: false,
      reason: "volume ratio below threshold",
      details: {
        volumeRatio: Number(volumeRatio.toFixed(3)),
        minRequired: PRE_PUMP_WATCH_MIN_VOLUME_RATIO
      }
    };
  }

  const volatilityPercentile = Number(row.tradeContext?.volatilityPercentile ?? 0);
  if (volatilityPercentile < PRE_PUMP_WATCH_MIN_VOLATILITY_PERCENTILE) {
    return {
      eligible: false,
      reason: "volatility percentile below threshold",
      details: {
        volatilityPercentile,
        minRequired: PRE_PUMP_WATCH_MIN_VOLATILITY_PERCENTILE
      }
    };
  }

  const intermediaryRsi = Number(row.timeframes.intermediary.rsi ?? 0);
  if (intermediaryRsi < PRE_PUMP_WATCH_MIN_INTERMEDIARY_RSI || intermediaryRsi > PRE_PUMP_WATCH_MAX_INTERMEDIARY_RSI) {
    return {
      eligible: false,
      reason: "intermediary RSI outside watch band",
      details: {
        intermediaryRsi,
        minRsi: PRE_PUMP_WATCH_MIN_INTERMEDIARY_RSI,
        maxRsi: PRE_PUMP_WATCH_MAX_INTERMEDIARY_RSI
      }
    };
  }

  const ema20 = Number(row.tradeContext?.ema20 ?? 0);
  const emaSlope = Number(row.tradeContext?.emaSlope ?? 0);
  if (PRE_PUMP_WATCH_REQUIRE_EMA_TREND) {
    if (!(Number.isFinite(ema20) && ema20 > 0 && row.close > ema20)) {
      return { eligible: false, reason: "price not above ema20" };
    }
    if (emaSlope < PRE_PUMP_WATCH_MIN_EMA_SLOPE) {
      return {
        eligible: false,
        reason: "ema slope below threshold",
        details: {
          emaSlope,
          minEmaSlope: PRE_PUMP_WATCH_MIN_EMA_SLOPE
        }
      };
    }
  }

  if (PRE_PUMP_WATCH_REQUIRE_STOCH_UP) {
    const stochK = Number(row.timeframes.intermediary.stochK ?? 0);
    const prevStochK = Number(row.timeframes.intermediary.prevStochK ?? 0);
    if (!(stochK > prevStochK)) {
      return {
        eligible: false,
        reason: "intermediary stoch not rising",
        details: {
          stochK,
          prevStochK
        }
      };
    }
  }

  return {
    eligible: true,
    details: {
      volumeRatio: Number(volumeRatio.toFixed(3)),
      volume24h,
      minVolumeUsd,
      volatilityPercentile,
      intermediaryRsi,
      ema20,
      emaSlope,
      status: row.status
    }
  };
}

function maybeNotifyPrePumpWatch(
  row: TokenRsiResult,
  nowMs: number,
  volume24h: number,
  volatilityPct: number,
  minVolumeUsd: number
): void {
  const evaluation = evaluatePrePumpWatch(row, volume24h, minVolumeUsd);
  if (!evaluation.eligible) {
    return;
  }

  const normalizedSymbol = normalizePerpSymbol(row.symbol);
  const cooldownMs = PRE_PUMP_WATCH_COOLDOWN_MINUTES * 60 * 1000;
  const previousAlertAt = lastPrePumpWatchBySymbol.get(normalizedSymbol) ?? 0;
  if (nowMs - previousAlertAt < cooldownMs) {
    return;
  }

  const direction: TradeDirection = "LONG";
  const atr = Number(row.tradeContext?.atr ?? 0);
  const levels = getTradeLevels(row.close, direction, row.symbol, atr);
  const entryTiming = row.entryTiming ?? classifyEntryTiming({
    direction,
    price: row.close,
    atr,
    supportDistancePct: Number(row.levels.supportDistancePct ?? 0),
    resistanceDistancePct: Number(row.levels.resistanceDistancePct ?? 0),
    ema20: Number(row.tradeContext?.ema20 ?? 0)
  });
  const reversalPhase = resolveReversalPhase(row, direction);
  const higherTimeframeTrend = resolveHigherTimeframeTrend(row);
  const structureState = resolveStructureState(row, direction);
  const structureConfidence = resolveStructureConfidence(higherTimeframeTrend, structureState, direction);

  notifyTelegramEntry({
    stage: "CAUTION",
    symbol: row.symbol,
    direction,
    entryTiming,
    reversalPhase,
    signalType: "PRE_PUMP_WATCH_LONG",
    entryScore: row.confluence.score,
    weightedScore: row.confluence.score,
    signalStrength: resolveSignalStrength(row),
    tpFeasibility: 0.7,
    structureConfidence,
    volatilityPct,
    takeProfitPct: levels.takeProfitPct,
    stopLossPct: levels.stopLossPct,
    marketCondition: classifyMarketCondition(row.timeframes.macro.macdHist, row.close),
    entryPrice: row.close,
    tpPrice: levels.tpPrice,
    slPrice: levels.slPrice,
    marketStatus: row.status,
    setupConflictNote: "Pre-pump watch: volume creep + trend persistence on low liquidity",
    dedupeKey: `PRE_PUMP_WATCH:${normalizedSymbol}`
  });

  lastPrePumpWatchBySymbol.set(normalizedSymbol, nowMs);
}

function isStrongSignal(signal: string): boolean {
  return signal === "STRONG LONG" || signal === "STRONG SHORT";
}

function classifyMarketCondition(macdHist: number, price: number): "TRENDING" | "RANGING" {
  if (!Number.isFinite(macdHist) || !Number.isFinite(price) || price <= 0) {
    return "RANGING";
  }

  const normalizedStrengthPct = (Math.abs(macdHist) / price) * 100;
  return normalizedStrengthPct >= 0.1 ? "TRENDING" : "RANGING";
}

function evaluateHigherTimeframeMomentumConflict(
  row: TokenRsiResult,
  direction: TradeDirection
): {
  conflictScore: number;
  hasHigherTimeframeConflict: boolean;
  hasReversalPressure: boolean;
  macroTrend: "UP" | "DOWN" | "MIXED";
  intermediaryTrend: "UP" | "DOWN" | "MIXED";
  emaSlope: number;
  details: string[];
} {
  const macro = row.timeframes.macro;
  const intermediary = row.timeframes.intermediary;
  const twelveh = row.timeframes.twelveh;
  const daily = row.timeframes.daily;
  const emaSlope = Number(row.tradeContext?.emaSlope ?? 0);

  const againstUp = direction === "SHORT";
  const againstDown = direction === "LONG";

  const macroTrendAgainst = (againstUp && macro.trend.direction === "UP") || (againstDown && macro.trend.direction === "DOWN");
  const macroMacdAgainst = (againstUp && macro.macdHist > 0) || (againstDown && macro.macdHist < 0);
  const macroStochAgainst = (againstUp && macro.stochK >= macro.stochD) || (againstDown && macro.stochK <= macro.stochD);
  const intermediaryTrendAgainst =
    (againstUp && intermediary.trend.direction === "UP") ||
    (againstDown && intermediary.trend.direction === "DOWN");
  const intermediaryMomentumAgainst =
    (againstUp && intermediary.stochK > intermediary.prevStochK && intermediary.rsi >= 50) ||
    (againstDown && intermediary.stochK < intermediary.prevStochK && intermediary.rsi <= 50);
  const emaSlopeAgainst = (againstUp && emaSlope > 0) || (againstDown && emaSlope < 0);

  const twelvehTrendAgainst = twelveh
    ? (againstUp && twelveh.trend.direction === "UP") || (againstDown && twelveh.trend.direction === "DOWN")
    : false;
  const twelvehMacdAgainst = twelveh
    ? (againstUp && twelveh.macdHist > 0) || (againstDown && twelveh.macdHist < 0)
    : false;
  const twelvehMomentumAgainst = twelveh
    ? (againstUp && twelveh.stochK >= twelveh.stochD) || (againstDown && twelveh.stochK <= twelveh.stochD)
    : false;

  const dailyTrendAgainst = daily
    ? (againstUp && daily.trend.direction === "UP") || (againstDown && daily.trend.direction === "DOWN")
    : false;
  const dailyMacdAgainst = daily
    ? (againstUp && daily.macdHist > 0) || (againstDown && daily.macdHist < 0)
    : false;
  const dailyMomentumAgainst = daily
    ? (againstUp && daily.stochK >= daily.stochD) || (againstDown && daily.stochK <= daily.stochD)
    : false;

  // Strong HTF exhaustion + rollover should block short-lived lower-TF continuation entries.
  const dailyExhaustionReversalPressure = daily
    ? (
        (direction === "LONG" && daily.rsi >= 72 && daily.stochK >= 82 && daily.stochK < daily.prevStochK) ||
        (direction === "SHORT" && daily.rsi <= 28 && daily.stochK <= 18 && daily.stochK > daily.prevStochK)
      )
    : false;
  const twelvehExhaustionReversalPressure = twelveh
    ? (
        (direction === "LONG" && twelveh.rsi >= 66 && twelveh.stochK >= 75 && twelveh.stochK < twelveh.prevStochK) ||
        (direction === "SHORT" && twelveh.rsi <= 34 && twelveh.stochK <= 25 && twelveh.stochK > twelveh.prevStochK)
      )
    : false;

  const details: string[] = [];
  let conflictScore = 0;
  if (macroTrendAgainst) {
    conflictScore += 1;
    details.push("macro trend against entry");
  }
  if (macroMacdAgainst) {
    conflictScore += 1;
    details.push("macro MACD against entry");
  }
  if (macroStochAgainst) {
    conflictScore += 1;
    details.push("macro stochastic against entry");
  }
  if (intermediaryTrendAgainst) {
    conflictScore += 1;
    details.push("1h trend against entry");
  }
  if (intermediaryMomentumAgainst) {
    conflictScore += 1;
    details.push("1h momentum build against entry");
  }
  if (emaSlopeAgainst) {
    conflictScore += 1;
    details.push("EMA slope against entry");
  }
  if (twelvehTrendAgainst) {
    conflictScore += 1;
    details.push("12h trend against entry");
  }
  if (twelvehMacdAgainst) {
    conflictScore += 1;
    details.push("12h MACD against entry");
  }
  if (twelvehMomentumAgainst) {
    conflictScore += 1;
    details.push("12h stochastic against entry");
  }
  if (dailyTrendAgainst) {
    conflictScore += 1;
    details.push("1d trend against entry");
  }
  if (dailyMacdAgainst) {
    conflictScore += 1;
    details.push("1d MACD against entry");
  }
  if (dailyMomentumAgainst) {
    conflictScore += 1;
    details.push("1d stochastic against entry");
  }
  if (twelvehExhaustionReversalPressure) {
    conflictScore += 2;
    details.push("12h exhaustion rollover risk");
  }
  if (dailyExhaustionReversalPressure) {
    conflictScore += 2;
    details.push("1d exhaustion rollover risk");
  }

  const hasReversalPressure = twelvehExhaustionReversalPressure || dailyExhaustionReversalPressure;
  const hasHigherTimeframeConflict =
    macroTrendAgainst ||
    macroMacdAgainst ||
    macroStochAgainst ||
    intermediaryTrendAgainst ||
    intermediaryMomentumAgainst ||
    emaSlopeAgainst ||
    twelvehTrendAgainst ||
    twelvehMacdAgainst ||
    twelvehMomentumAgainst ||
    dailyTrendAgainst ||
    dailyMacdAgainst ||
    dailyMomentumAgainst ||
    hasReversalPressure;

  return {
    conflictScore,
    hasHigherTimeframeConflict,
    hasReversalPressure,
    macroTrend: macro.trend.direction,
    intermediaryTrend: intermediary.trend.direction,
    emaSlope,
    details
  };
}

function getMaxActiveTrades(balance: number): number {
  if (FORCE_SINGLE_ACTIVE_TRADE) {
    return 1;
  }

  const planLimit = getAppAccessState().limits.maxActiveTrades;

  if (SIM_SIGNAL_ONLY_MODE || FIXED_STAKE_ENABLED) {
    return planLimit > 0 ? Math.min(SIGNAL_SIM_MAX_ACTIVE_TRADES, planLimit) : SIGNAL_SIM_MAX_ACTIVE_TRADES;
  }

  const baseLimit = balance < 1000 ? MAX_ACTIVE_TRADES_UNDER_1000 : MAX_ACTIVE_TRADES_AT_OR_ABOVE_1000;
  return planLimit > 0 ? Math.min(baseLimit, planLimit) : baseLimit;
}

function getPositionSizeUsd(
  balance: number,
  currentOpenCount: number,
  stopLossPct: number,
  leverage: number,
  riskPerTrade: number
): number {
  if (SIM_SIGNAL_ONLY_MODE || FIXED_STAKE_ENABLED) {
    return SIGNAL_SIM_STAKE_USD;
  }

  const maxActiveTrades = getMaxActiveTrades(balance);
  const remainingSlots = Math.max(1, maxActiveTrades - currentOpenCount);
  const reservedFees = balance * TRADING_FEE_RATE * 2 * remainingSlots;
  const availableAfterFees = Math.max(0, balance - reservedFees);
  const perTradeBudget = availableAfterFees / remainingSlots;

  const riskUsd = perTradeBudget * riskPerTrade;
  const stopDistanceRatio = Math.max(0.001, stopLossPct / 100 / Math.max(1, leverage));
  const rawSize = riskUsd / stopDistanceRatio;

  // Never exceed actual account balance or per-trade budget.
  return Number(Math.min(rawSize, perTradeBudget, balance).toFixed(2));
}

function computeLivePnlMetrics(trade: Trade): {
  currentPnlPct: number;
  currentPnlUsd: number;
  positionValueUsd: number;
  distanceToTP: number;
  distanceToSL: number;
} {
  const longMovePct = (trade.currentPrice - trade.entryPrice) / trade.entryPrice;
  const shortMovePct = (trade.entryPrice - trade.currentPrice) / trade.entryPrice;
  const movePct = trade.direction === "LONG" ? longMovePct : shortMovePct;
  const currentPnlPct = Number((movePct * trade.leverage * 100).toFixed(3));
  const currentPnlUsd = Number((trade.stakeUsd * (currentPnlPct / 100)).toFixed(2));
  const positionValueUsd = Number(
    (
      trade.direction === "LONG"
        ? trade.stakeUsd * (trade.currentPrice / trade.entryPrice)
        : trade.stakeUsd * (trade.entryPrice / trade.currentPrice)
    ).toFixed(2)
  );
  const distanceToTP = Number(
    (
      trade.direction === "LONG"
        ? ((trade.tpPrice - trade.currentPrice) / trade.currentPrice) * 100
        : ((trade.currentPrice - trade.tpPrice) / trade.currentPrice) * 100
    ).toFixed(3)
  );
  const distanceToSL = Number(
    (
      trade.direction === "LONG"
        ? ((trade.currentPrice - trade.slPrice) / trade.currentPrice) * 100
        : ((trade.slPrice - trade.currentPrice) / trade.currentPrice) * 100
    ).toFixed(3)
  );

  return {
    currentPnlPct,
    currentPnlUsd,
    positionValueUsd,
    distanceToTP,
    distanceToSL
  };
}

function computeEstimatedLiqPrice(entryPrice: number, direction: TradeDirection, leverage: number): number {
  // Approximation for isolated-style liquidation with a conservative maintenance margin.
  const maintenanceMarginRate = 0.005;
  const liqMovePct = Math.max((1 / Math.max(1, leverage)) - maintenanceMarginRate, 0.01);

  if (direction === "LONG") {
    return Number((entryPrice * (1 - liqMovePct)).toFixed(6));
  }

  return Number((entryPrice * (1 + liqMovePct)).toFixed(6));
}

function enrichTradeWithProductionRead(trade: Trade, perpContext: PerpAssetContext | null): void {
  const markPriceCandidate = perpContext?.markPrice ?? trade.currentPrice;
  const markPrice = Number.isFinite(markPriceCandidate) && markPriceCandidate > 0
    ? markPriceCandidate
    : trade.currentPrice;

  const initialNotionalUsd = trade.stakeUsd * trade.leverage;
  const sizeBaseUnits =
    Number.isFinite(trade.entryPrice) && trade.entryPrice > 0
      ? Number((initialNotionalUsd / trade.entryPrice).toFixed(4))
      : 0;
  const positionValueUsd = Number((sizeBaseUnits * markPrice).toFixed(2));

  const hoursOpen = Math.max(0, (Date.now() - Date.parse(trade.openTime)) / 3_600_000);
  const fundingPeriods = hoursOpen / 8;
  const fundingRate = Number(perpContext?.fundingRate ?? 0);
  const fundingDirectionMultiplier = trade.direction === "LONG" ? -1 : 1;
  const fundingAccruedUsd = Number((positionValueUsd * fundingRate * fundingPeriods * fundingDirectionMultiplier).toFixed(4));

  trade.markPrice = Number(markPrice.toFixed(6));
  trade.roePct = Number((trade.currentPnlPct ?? 0).toFixed(3));
  trade.sizeBaseUnits = sizeBaseUnits;
  trade.marginUsedUsd = Number(trade.stakeUsd.toFixed(2));
  trade.fundingRate = Number(fundingRate.toFixed(8));
  trade.fundingAccruedUsd = fundingAccruedUsd;
  trade.estimatedLiqPrice = computeEstimatedLiqPrice(trade.entryPrice, trade.direction, trade.leverage);
  trade.openInterestUsd = perpContext?.openInterestUsd ?? 0;
  trade.positionValueUsd = positionValueUsd;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function buildEntryContextJson(
  row: TokenRsiResult,
  score: number,
  extras?: {
    regime?: MarketRegime;
    atr?: number;
    tpDistance?: number;
    slDistance?: number;
    expectedValue?: number;
    cluster?: "L1" | "L2" | "DEFI" | "OTHER";
    slippageEstimate?: number;
  }
): string {
  return safeJsonStringify({
    at: new Date().toISOString(),
    signal: row.signal.type,
    signalCategory: row.signalCategory,
    confluence: {
      score,
      bias: row.confluence.bias,
      maxScore: row.confluence.maxScore
    },
    status: row.status,
    levels: row.levels,
    tradeContext: row.tradeContext,
    regime: extras?.regime ?? row.tradeContext?.regime,
    atr: extras?.atr ?? row.tradeContext?.atr,
    tpDistance: extras?.tpDistance,
    slDistance: extras?.slDistance,
    expectedValue: extras?.expectedValue,
    cluster: extras?.cluster,
    slippageEstimate: extras?.slippageEstimate,
    timeframes: row.timeframes
  });
}

function buildCloseContextJson(trade: Trade, reason: string, extras?: { sentimentShift?: Record<string, unknown> }): string {
  return safeJsonStringify({
    at: new Date().toISOString(),
    reason,
    status: trade.status,
    resultPct: trade.result,
    resultUsd: trade.resultUsd,
    currentPnlPct: trade.currentPnlPct,
    currentPnlUsd: trade.currentPnlUsd,
    entryPrice: trade.entryPrice,
    closePrice: trade.currentPrice,
    tpPrice: trade.tpPrice,
    slPrice: trade.slPrice,
    distanceToTP: trade.distanceToTP,
    distanceToSL: trade.distanceToSL,
    tpDistance: trade.tpDistance,
    slDistance: trade.slDistance,
    expectedValue: trade.expectedValue,
    regime: trade.regime,
    cluster: trade.cluster,
    atr: trade.atr,
    slippageEstimate: trade.slippageEstimate,
    maxDrawdown: trade.maxDrawdown,
    marketCondition: trade.marketCondition,
    fundingRate: trade.fundingRate,
    fundingAccruedUsd: trade.fundingAccruedUsd,
    openInterestUsd: trade.openInterestUsd,
    sentimentShift: extras?.sentimentShift
  });
}

function buildLatestSignalBySymbol(results?: TokenRsiResult[]): Map<string, TokenRsiResult> {
  const latestSignalBySymbol = new Map<string, TokenRsiResult>();
  if (!results || results.length === 0) {
    return latestSignalBySymbol;
  }

  for (const row of results) {
    const symbol = normalizePerpSymbol(row.symbol);
    const existing = latestSignalBySymbol.get(symbol);
    if (!existing || row.confluence.score > existing.confluence.score) {
      latestSignalBySymbol.set(symbol, row);
    }
  }

  return latestSignalBySymbol;
}

function evaluateSentimentShiftExit(
  trade: Trade,
  row: TokenRsiResult,
  elapsedMinutes: number
): { shouldClose: boolean; details?: Record<string, unknown> } {
  if (!SENTIMENT_SHIFT_EXIT_ENABLED) {
    return { shouldClose: false };
  }

  if (elapsedMinutes < SENTIMENT_SHIFT_MIN_HOLD_MINUTES) {
    return { shouldClose: false };
  }

  const signalDirection = signalToDirection(row.signal.type);
  if (!signalDirection || signalDirection === trade.direction) {
    return { shouldClose: false };
  }

  if (row.confluence.score < SENTIMENT_SHIFT_MIN_CONFLUENCE_SCORE) {
    return { shouldClose: false };
  }

  const oppositeBias: "LONG" | "SHORT" = trade.direction === "LONG" ? "SHORT" : "LONG";
  const biasAligned = row.confluence.bias === oppositeBias;
  if (SENTIMENT_SHIFT_REQUIRE_BIAS_ALIGNMENT && !biasAligned) {
    return { shouldClose: false };
  }

  return {
    shouldClose: true,
    details: {
      tradeDirection: trade.direction,
      oppositeDirection: signalDirection,
      signalType: row.signal.type,
      signalBias: row.confluence.bias,
      signalScore: row.confluence.score,
      minScoreRequired: SENTIMENT_SHIFT_MIN_CONFLUENCE_SCORE,
      elapsedMinutes,
      minHoldMinutes: SENTIMENT_SHIFT_MIN_HOLD_MINUTES,
      requiresBiasAlignment: SENTIMENT_SHIFT_REQUIRE_BIAS_ALIGNMENT,
      biasAligned
    }
  };
}

function isMicroStochCrossUp(row: TokenRsiResult): boolean {
  const micro = row.timeframes.microTrigger;
  return (
    micro.stochK > micro.stochD &&
    micro.prevStochK <= micro.prevStochD &&
    micro.stochK >= VIOLENT_MOVE_STOCH_MIN_K
  );
}

function isMicroStochRolloverDown(row: TokenRsiResult): boolean {
  const micro = row.timeframes.microTrigger;
  return micro.stochK < micro.prevStochK || micro.stochK < micro.stochD;
}

function maybeNotifyViolentMoveAlerts(
  row: TokenRsiResult,
  nowMs: number,
  volatilityPct: number,
  volume24h: number,
  minVolumeUsd: number
): void {
  const normalizedSymbol = normalizePerpSymbol(row.symbol);
  const volatilityPercentile = Number(row.tradeContext?.volatilityPercentile ?? 0);
  const signalDirection = signalToDirection(row.signal.type);
  const hasLongBias = signalDirection === "LONG" || (!signalDirection && row.confluence.bias === "LONG");
  const marketCondition = classifyMarketCondition(row.timeframes.macro.macdHist, row.close);
  const atr = Number(row.tradeContext?.atr ?? 0);
  const longLevels = getTradeLevels(row.close, "LONG", row.symbol, atr);
  const entryTiming = row.entryTiming ?? classifyEntryTiming({
    direction: "LONG",
    price: row.close,
    atr,
    supportDistancePct: Number(row.levels.supportDistancePct ?? 0),
    resistanceDistancePct: Number(row.levels.resistanceDistancePct ?? 0),
    ema20: Number(row.tradeContext?.ema20 ?? 0)
  });
  const higherTimeframeTrend = resolveHigherTimeframeTrend(row);
  const structureState = resolveStructureState(row, "LONG");
  const structureConfidence = resolveStructureConfidence(higherTimeframeTrend, structureState, "LONG");
  const signalStrength = resolveSignalStrength(row);
  const reversalPhase = resolveReversalPhase(row, "LONG");

  if (VIOLENT_MOVE_ALERT_ENABLED) {
    const hasVolatilityExpansion =
      volatilityPct >= VIOLENT_MOVE_MIN_VOLATILITY_PCT &&
      volatilityPercentile >= VIOLENT_MOVE_MIN_VOLATILITY_PERCENTILE;
    const hasVolumeExpansion = volume24h >= (minVolumeUsd * VIOLENT_MOVE_MIN_VOLUME_MULTIPLIER);

    if (hasLongBias && isMicroStochCrossUp(row) && hasVolatilityExpansion && hasVolumeExpansion) {
      notifyTelegramEntry({
        stage: "READY",
        symbol: row.symbol,
        direction: "LONG",
        entryTiming,
        reversalPhase,
        signalType: "VIOLENT_MOVE_LONG_STOCH_UP",
        entryScore: row.confluence.score,
        weightedScore: row.confluence.score,
        signalStrength,
        tpFeasibility: 1,
        structureConfidence,
        volatilityPct,
        takeProfitPct: longLevels.takeProfitPct,
        stopLossPct: longLevels.stopLossPct,
        marketCondition,
        entryPrice: row.close,
        tpPrice: longLevels.tpPrice,
        slPrice: longLevels.slPrice,
        marketStatus: row.status,
        setupConflictNote: getTelegramSetupConflictNote(row, "LONG"),
        dedupeKey: `VIOLENT_MOVE_LONG:${normalizedSymbol}`
      });

      lastViolentMoveBySymbol.set(normalizedSymbol, {
        atMs: nowMs,
        direction: "LONG",
        volatilityPct,
        volume24h,
        score: row.confluence.score
      });
      return;
    }
  }

  if (!VIOLENT_MOVE_DROP_CAUTION_ENABLED) {
    return;
  }

  const priorMove = lastViolentMoveBySymbol.get(normalizedSymbol);
  if (!priorMove) {
    return;
  }

  if (nowMs - priorMove.atMs > VIOLENT_MOVE_DROP_WINDOW_MINUTES * 60 * 1000) {
    lastViolentMoveBySymbol.delete(normalizedSymbol);
    return;
  }

  const dropByRatio = volatilityPct <= (priorMove.volatilityPct * VIOLENT_MOVE_DROP_RATIO);
  const dropByAbsolute = volatilityPct <= VIOLENT_MOVE_DROP_ABS_VOLATILITY_PCT;
  const stochRolloverSatisfied = !VIOLENT_MOVE_DROP_REQUIRE_STOCH_ROLLOVER || isMicroStochRolloverDown(row);

  if (!dropByRatio || !dropByAbsolute || !stochRolloverSatisfied) {
    return;
  }

  notifyTelegramEntry({
    stage: "CAUTION",
    symbol: row.symbol,
    direction: priorMove.direction,
    entryTiming,
    reversalPhase,
    signalType: "VIOLENT_MOVE_VOLATILITY_COOLDOWN",
    entryScore: row.confluence.score,
    weightedScore: row.confluence.score,
    signalStrength,
    tpFeasibility: 0.9,
    structureConfidence,
    volatilityPct,
    takeProfitPct: longLevels.takeProfitPct,
    stopLossPct: longLevels.stopLossPct,
    marketCondition,
    entryPrice: row.close,
    tpPrice: longLevels.tpPrice,
    slPrice: longLevels.slPrice,
    marketStatus: row.status,
    setupConflictNote: getTelegramSetupConflictNote(row, priorMove.direction),
    dedupeKey: `VIOLENT_MOVE_DROP:${normalizedSymbol}:${priorMove.atMs}`
  });

  lastViolentMoveBySymbol.delete(normalizedSymbol);
}

type OpenTradeDecision = {
  allow: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

function evaluateOpenTradeEligibility(token: string, direction: TradeDirection, nowMs: number): OpenTradeDecision {
  const key = getTradeKey(token, direction);
  const currentOpen = openTrades.get(key);
  if (currentOpen) {
    return {
      allow: false,
      reason: "duplicate active trade",
      details: { token, direction }
    };
  }

  const lastOpened = lastOpenedByKey.get(key);
  if (typeof lastOpened === "number" && nowMs - lastOpened < DUPLICATE_WINDOW_MS) {
    return {
      allow: false,
      reason: "duplicate window cooldown",
      details: {
        token,
        direction,
        duplicateWindowMinutes: Math.round(DUPLICATE_WINDOW_MS / 60000),
        cooldownRemainingMs: DUPLICATE_WINDOW_MS - (nowMs - lastOpened)
      }
    };
  }

  if (TEST_OPEN_MODE) {
    return { allow: true };
  }

  if (TRADE_FLIP_COOLDOWN_MS > 0) {
    const oppositeDirection: TradeDirection = direction === "LONG" ? "SHORT" : "LONG";
    const oppositeKey = getTradeKey(token, oppositeDirection);
    const oppositeOpened = lastOpenedByKey.get(oppositeKey);
    if (typeof oppositeOpened === "number" && nowMs - oppositeOpened < TRADE_FLIP_COOLDOWN_MS) {
      return {
        allow: false,
        reason: "flip cooldown active",
        details: {
          token,
          direction,
          oppositeDirection,
          flipCooldownMinutes: Math.round(TRADE_FLIP_COOLDOWN_MS / 60000),
          cooldownRemainingMs: TRADE_FLIP_COOLDOWN_MS - (nowMs - oppositeOpened)
        }
      };
    }
  }

  return { allow: true };
}

function getSymbolFastSlCooldownUntilMs(symbol: string, nowMs: number): number | null {
  if (!SYMBOL_FAST_SL_COOLDOWN_ENABLED) {
    return null;
  }

  const normalizedSymbol = normalizePerpSymbol(symbol);
  const lookbackStartMs = nowMs - (SYMBOL_FAST_SL_LOOKBACK_MINUTES * 60 * 1000);
  let fastStopLossHits = 0;
  let latestFastStopLossCloseMs = 0;

  for (let index = closedTrades.length - 1; index >= 0; index -= 1) {
    const trade = closedTrades[index];
    if (normalizePerpSymbol(trade.token) !== normalizedSymbol) {
      continue;
    }

    if (trade.status !== "LOSS" || !String(trade.closeReason ?? "").startsWith("SL_HIT")) {
      continue;
    }

    const closeMs = Date.parse(trade.closeTime ?? trade.openTime);
    if (!Number.isFinite(closeMs) || closeMs < lookbackStartMs) {
      continue;
    }

    const openMs = Date.parse(trade.openTime);
    if (!Number.isFinite(openMs)) {
      continue;
    }

    const holdMinutes = (closeMs - openMs) / 60000;
    if (holdMinutes > SYMBOL_FAST_SL_MAX_HOLD_MINUTES) {
      continue;
    }

    fastStopLossHits += 1;
    latestFastStopLossCloseMs = Math.max(latestFastStopLossCloseMs, closeMs);

    if (fastStopLossHits >= SYMBOL_FAST_SL_HITS_THRESHOLD) {
      return latestFastStopLossCloseMs + (SYMBOL_FAST_SL_COOLDOWN_MINUTES * 60 * 1000);
    }
  }

  return null;
}

function getFibTouchMemory(
  symbol: string,
  nowMs: number
): { direction: TradeDirection; touchedAtMs: number; signalType: string; score: number } | null {
  if (!FIB_TOUCH_MEMORY_ENABLED) {
    return null;
  }

  const memory = lastFibTouchBySymbol.get(symbol);
  if (!memory) {
    return null;
  }

  if (nowMs - memory.touchedAtMs > FIB_TOUCH_MEMORY_WINDOW_MINUTES * 60 * 1000) {
    lastFibTouchBySymbol.delete(symbol);
    return null;
  }

  return memory;
}

function countTradesOpenedLastWindow(nowMs: number, windowMs: number): number {
  const recentOpenCount = Array.from(openTrades.values()).filter((trade) => {
    const openedAt = Date.parse(trade.openTime);
    return Number.isFinite(openedAt) && nowMs - openedAt <= windowMs;
  }).length;

  const recentClosedCount = closedTrades.filter((trade) => {
    const openedAt = Date.parse(trade.openTime);
    return Number.isFinite(openedAt) && nowMs - openedAt <= windowMs;
  }).length;

  return recentOpenCount + recentClosedCount;
}

function isSessionBlocked(nowMs: number): boolean {
  const utcHour = new Date(nowMs).getUTCHours();
  return utcHour >= SESSION_BLOCK_START_UTC && utcHour < SESSION_BLOCK_END_UTC;
}

function getAdaptiveScoreThreshold(baseThreshold: number): number {
  const rolling = [...closedTrades]
    .sort((a, b) => Date.parse(b.closeTime ?? b.openTime) - Date.parse(a.closeTime ?? a.openTime))
    .slice(0, MAX_ROLLING_PERFORMANCE_TRADES)
    .filter((trade) => trade.status === "WIN" || trade.status === "LOSS");

  if (rolling.length < MAX_ROLLING_PERFORMANCE_TRADES) {
    return baseThreshold;
  }

  const wins = rolling.filter((trade) => trade.status === "WIN").length;
  const winRate = (wins / rolling.length) * 100;

  if (winRate < 40) {
    return baseThreshold + 1;
  }

  if (winRate > 60) {
    return Math.max(baseThreshold, baseThreshold - 0.5);
  }

  return baseThreshold;
}

function getCurrentEquityUsd(): number {
  const unrealized = Array.from(openTrades.values()).reduce((sum, trade) => sum + (trade.currentPnlUsd ?? 0), 0);
  return Number((accountBalanceUsd + unrealized).toFixed(2));
}

function isKillSwitchTriggered(nowMs: number): boolean {
  if (SIM_SIGNAL_ONLY_MODE) {
    return false;
  }

  if (killSwitchActivated) {
    return true;
  }

  const currentEquity = getCurrentEquityUsd();
  let peakEquity = currentEquity;
  for (const point of equityCurve) {
    if (point.balanceUsd > peakEquity) {
      peakEquity = point.balanceUsd;
    }
  }

  if (peakEquity <= 0) {
    return false;
  }

  const drawdown = (peakEquity - currentEquity) / peakEquity;
  const thresholdPct = getEffectiveKillSwitchDrawdownPct();
  if (drawdown >= thresholdPct) {
    killSwitchActivated = true;
    console.error("[trade-engine] Kill switch activated", {
      at: new Date(nowMs).toISOString(),
      drawdownPct: Number((drawdown * 100).toFixed(2)),
      thresholdPct: thresholdPct * 100,
      peakEquity,
      currentEquity
    });
    return true;
  }

  return false;
}

function getEffectiveKillSwitchDrawdownPct(): number {
  if (!LIVE_TRADING_ENABLED) {
    return GLOBAL_KILL_SWITCH_DRAWDOWN_PCT;
  }

  return Math.min(GLOBAL_KILL_SWITCH_DRAWDOWN_PCT, LIVE_MAX_ACCOUNT_DRAWDOWN_PCT / 100);
}

function isBtcSymbol(symbol: string): boolean {
  return symbol.trim().toUpperCase().startsWith("BTC");
}

function getUtcDayKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function resetDailyStartIfNeeded(nowMs: number): void {
  const dayKey = getUtcDayKey(nowMs);
  if (dayKey !== dailyStartKeyUtc) {
    dailyStartKeyUtc = dayKey;
    dailyStartBalanceUsd = accountBalanceUsd;
  }
}

function isCooldownActive(nowMs: number): boolean {
  return nowMs < cooldownUntilMs;
}

function isRollingDrawdownCircuitActive(nowMs: number): boolean {
  if (nowMs < rollingCircuitUntilMs) {
    return true;
  }

  const windowStartMs = nowMs - ROLLING_DRAWDOWN_WINDOW_MS;
  const points = equityCurve.filter((point) => {
    const ts = Date.parse(point.at);
    return Number.isFinite(ts) && ts >= windowStartMs;
  });

  if (points.length === 0) {
    return false;
  }

  let peak = 0;
  for (const point of points) {
    if (point.balanceUsd > peak) {
      peak = point.balanceUsd;
    }
  }

  if (!Number.isFinite(peak) || peak <= 0) {
    return false;
  }

  const currentEquity = getCurrentEquityUsd();
  const drawdownPct = ((peak - currentEquity) / peak) * 100;
  if (drawdownPct >= ROLLING_DRAWDOWN_LIMIT_PCT) {
    rollingCircuitUntilMs = nowMs + ROLLING_DRAWDOWN_COOLDOWN_MS;
    console.warn("[trade-engine] Entry blocked: rolling drawdown circuit breaker activated", {
      drawdownPct: Number(drawdownPct.toFixed(2)),
      thresholdPct: ROLLING_DRAWDOWN_LIMIT_PCT,
      windowHours: Number((ROLLING_DRAWDOWN_WINDOW_MS / 3_600_000).toFixed(1)),
      cooldownMinutes: Number((ROLLING_DRAWDOWN_COOLDOWN_MS / 60_000).toFixed(1)),
      blockedUntil: new Date(rollingCircuitUntilMs).toISOString()
    });
    return true;
  }

  return false;
}

function hitDailyDrawdownLimit(): boolean {
  if (SIM_SIGNAL_ONLY_MODE) {
    return false;
  }

  if (!Number.isFinite(dailyStartBalanceUsd) || dailyStartBalanceUsd <= 0) {
    return false;
  }

  const dailyPnlPct = (accountBalanceUsd - dailyStartBalanceUsd) / dailyStartBalanceUsd;
  return dailyPnlPct <= -MAX_DAILY_DRAWDOWN_PCT;
}

function getTradeRiskPct(trade: Trade): number {
  if (Number.isFinite(trade.riskPctUsed) && trade.riskPctUsed > 0) {
    return trade.riskPctUsed / 100;
  }

  return getRiskPerTradeForSymbol(trade.token);
}

function wouldExceedConcurrentRisk(additionalRiskPct: number = RISK_PER_TRADE): boolean {
  if (SIM_SIGNAL_ONLY_MODE) {
    return false;
  }

  const currentOpenRisk = Array.from(openTrades.values()).reduce((sum, trade) => sum + getTradeRiskPct(trade), 0);
  return currentOpenRisk + additionalRiskPct > MAX_CONCURRENT_RISK;
}

function updateMaxDrawdown(trade: Trade, low: number, high: number): void {
  const current = trade.maxDrawdown ?? 0;

  if (trade.direction === "LONG") {
    const dd = Math.max(0, ((trade.entryPrice - low) / trade.entryPrice) * 100);
    trade.maxDrawdown = Number(Math.max(current, dd).toFixed(3));
    return;
  }

  const dd = Math.max(0, ((high - trade.entryPrice) / trade.entryPrice) * 100);
  trade.maxDrawdown = Number(Math.max(current, dd).toFixed(3));
}

function resolveAmbiguousHit(
  direction: TradeDirection,
  candleOpen: number,
  tpPrice: number,
  slPrice: number
): "WIN" | "LOSS" {
  // Deterministic tie-breaker when both TP and SL are touched in a single candle.
  const toTp = Math.abs(candleOpen - tpPrice);
  const toSl = Math.abs(candleOpen - slPrice);

  if (toTp < toSl) {
    return "WIN";
  }
  if (toSl < toTp) {
    return "LOSS";
  }

  return direction === "LONG" ? "LOSS" : "LOSS";
}

function normalizePersistedTrade(trade: Trade, migrateOpenTradeLevels: boolean): void {
  if (!Number.isFinite(trade.takeProfitPct) || trade.takeProfitPct <= 0) {
    trade.takeProfitPct = TAKE_PROFIT_PCT;
  }

  if (!Number.isFinite(trade.stopLossPct) || trade.stopLossPct <= 0) {
    trade.stopLossPct = STOP_LOSS_PCT;
  }

  if (!Number.isFinite(trade.leverage) || trade.leverage <= 0) {
    trade.leverage = getLeverageForSymbol(trade.token);
  }

  if (typeof trade.assetType !== "string") {
    trade.assetType = isLargeCap(trade.token) ? "LARGE_CAP" : "ALT";
  }

  if (typeof trade.regime !== "string") {
    trade.regime = "CHOPPY";
  }

  if (typeof trade.cluster !== "string") {
    trade.cluster = getCluster(trade.token);
  }

  if (!Number.isFinite(trade.atr) || trade.atr <= 0) {
    trade.atr = Math.abs((trade.entryPrice || 0) * 0.005);
  }

  if (!Number.isFinite(trade.slippageEstimate)) {
    trade.slippageEstimate = 0;
  }

  if (!Number.isFinite(trade.expectedValue)) {
    trade.expectedValue = 0;
  }

  if (migrateOpenTradeLevels) {
    const levels = getTradeLevels(
      trade.entryPrice,
      trade.direction,
      trade.token,
      Number(trade.atr ?? 0)
    );
    trade.tpPrice = levels.tpPrice;
    trade.slPrice = levels.slPrice;
    trade.takeProfitPct = levels.takeProfitPct;
    trade.stopLossPct = levels.stopLossPct;
  }

  trade.tpDistance = Math.abs((trade.tpPrice ?? 0) - (trade.entryPrice ?? 0));
  trade.slDistance = Math.abs((trade.slPrice ?? 0) - (trade.entryPrice ?? 0));

  const live = computeLivePnlMetrics(trade);
  trade.currentPnlPct = live.currentPnlPct;
  trade.currentPnlUsd = live.currentPnlUsd;
  trade.positionValueUsd = live.positionValueUsd;
  trade.distanceToTP = live.distanceToTP;
  trade.distanceToSL = live.distanceToSL;
}

function persistRuntimeState(): void {
  const active = Array.from(openTrades.values());
  const recentClosed = [...closedTrades]
    .sort((a, b) => Date.parse(b.closeTime ?? b.openTime) - Date.parse(a.closeTime ?? a.openTime))
    .slice(0, MAX_CLOSED_TRADES);
  const stats = computeStats(active, closedTrades);

  void persistTradeRuntimeState({
    accountBalanceUsd,
    dailyStartBalanceUsd,
    openTrades: active,
    recentClosedTrades: recentClosed,
    metrics: {
      totalTrades: stats.totalTrades,
      winRate: stats.winRate,
      totalPnlUsd: stats.totalPnlUsd,
      totalPnlPct: stats.totalPnlPct,
      maxDrawdown: stats.maxDrawdown
    }
  }).catch((error) => {
    console.error("[trade-engine] Failed to persist runtime state", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

function reconcileAccountBalanceFromLedger(): void {
  if (SIM_SIGNAL_ONLY_MODE) {
    accountBalanceUsd = Number(SIM_INITIAL_CAPITAL_USD.toFixed(2));
    return;
  }

  let reconciled = SIM_INITIAL_CAPITAL_USD;

  for (const trade of openTrades.values()) {
    const openFeeUsd = Number.isFinite(trade.openFeeUsd)
      ? Number(trade.openFeeUsd)
      : Number((trade.stakeUsd * TRADING_FEE_RATE).toFixed(2));
    reconciled -= openFeeUsd;
  }

  for (const trade of closedTrades) {
    const openFeeUsd = Number.isFinite(trade.openFeeUsd)
      ? Number(trade.openFeeUsd)
      : Number((trade.stakeUsd * TRADING_FEE_RATE).toFixed(2));
    const closeFeeUsd = Number.isFinite(trade.closeFeeUsd)
      ? Number(trade.closeFeeUsd)
      : Number((trade.stakeUsd * TRADING_FEE_RATE).toFixed(2));
    const resultUsd = Number.isFinite(trade.resultUsd)
      ? Number(trade.resultUsd)
      : Number((trade.stakeUsd * ((trade.result ?? 0) / 100)).toFixed(2));

    reconciled -= openFeeUsd;
    reconciled += resultUsd;
    reconciled -= closeFeeUsd;
  }

  accountBalanceUsd = Number(reconciled.toFixed(2));
}

async function hydrateRuntimeStateFromStorage(): Promise<void> {
  if (hydratedFromStorage) {
    return;
  }

  const persisted = await loadTradeRuntimeState();
  hydratedFromStorage = true;
  if (!persisted) {
    return;
  }

  accountBalanceUsd = Number((persisted.accountBalanceUsd || SIM_INITIAL_CAPITAL_USD).toFixed(2));
  dailyStartBalanceUsd = Number((persisted.dailyStartBalanceUsd || accountBalanceUsd).toFixed(2));
  dailyStartKeyUtc = new Date().toISOString().slice(0, 10);

  openTrades.clear();
  closedTrades.length = 0;
  lastOpenedByKey.clear();

  for (const trade of persisted.openTrades) {
    if (!(trade as Trade).entryType) {
      (trade as Trade).entryType = (trade.signalCategory ?? "SCORE_BASED") as TradeEntryType;
    }
    if (!Number.isFinite((trade as Trade).entryScore)) {
      (trade as Trade).entryScore = 0;
    }
    if (!Number.isFinite((trade as Trade).riskPctUsed)) {
      (trade as Trade).riskPctUsed = Number((getRiskPerTradeForSymbol((trade as Trade).token) * 100).toFixed(2));
    }
    if (!Number.isFinite((trade as Trade).volatilityPct)) {
      (trade as Trade).volatilityPct = 0;
    }
    if (!Number.isFinite((trade as Trade).volume24h)) {
      (trade as Trade).volume24h = 0;
    }
    if (typeof (trade as Trade).passedVolatility !== "boolean") {
      (trade as Trade).passedVolatility = (trade as Trade).volatilityPct >= MIN_VOLATILITY_PCT;
    }
    if (typeof (trade as Trade).passedLiquidity !== "boolean") {
      (trade as Trade).passedLiquidity = (trade as Trade).volume24h >= getMinVolumeUsdForSymbol((trade as Trade).token);
    }

    normalizePersistedTrade(trade as Trade, true);

    const key = getTradeKey(trade.token, trade.direction);
    openTrades.set(key, trade);
    const openTs = Date.parse(trade.openTime);
    if (Number.isFinite(openTs)) {
      const current = lastOpenedByKey.get(key) ?? 0;
      if (openTs > current) {
        lastOpenedByKey.set(key, openTs);
      }
    }
  }

  for (const trade of persisted.recentClosedTrades) {
    if (!(trade as Trade).entryType) {
      (trade as Trade).entryType = (trade.signalCategory ?? "SCORE_BASED") as TradeEntryType;
    }
    if (!Number.isFinite((trade as Trade).entryScore)) {
      (trade as Trade).entryScore = 0;
    }
    if (!Number.isFinite((trade as Trade).riskPctUsed)) {
      (trade as Trade).riskPctUsed = Number((getRiskPerTradeForSymbol((trade as Trade).token) * 100).toFixed(2));
    }
    if (!Number.isFinite((trade as Trade).volatilityPct)) {
      (trade as Trade).volatilityPct = 0;
    }
    if (!Number.isFinite((trade as Trade).volume24h)) {
      (trade as Trade).volume24h = 0;
    }
    if (typeof (trade as Trade).passedVolatility !== "boolean") {
      (trade as Trade).passedVolatility = (trade as Trade).volatilityPct >= MIN_VOLATILITY_PCT;
    }
    if (typeof (trade as Trade).passedLiquidity !== "boolean") {
      (trade as Trade).passedLiquidity = (trade as Trade).volume24h >= getMinVolumeUsdForSymbol((trade as Trade).token);
    }

    normalizePersistedTrade(trade as Trade, false);

    closedTrades.push(trade);
    const key = getTradeKey(trade.token, trade.direction);
    const openTs = Date.parse(trade.openTime);
    if (Number.isFinite(openTs)) {
      const current = lastOpenedByKey.get(key) ?? 0;
      if (openTs > current) {
        lastOpenedByKey.set(key, openTs);
      }
    }
  }

  equityCurve.length = 0;
  const anchorAt = persisted.metrics?.lastUpdated ?? nowIso();
  equityCurve.push({ at: anchorAt, balanceUsd: accountBalanceUsd });
}

async function closeTrade(trade: Trade, status: "WIN" | "LOSS", closeTime: string, reason: string): Promise<void> {
  if (trade.isLiveTrade) {
    try {
      await executeLiveCloseForTrade(trade);
    } catch (error) {
      const liveCloseReason = error instanceof Error ? error.message : String(error);
      alertLiveExecutionFailure({
        symbol: trade.token,
        direction: trade.direction,
        phase: "CLOSE",
        reason: liveCloseReason,
        signalType: trade.signalType,
        entryPrice: trade.entryPrice,
        tpPrice: trade.tpPrice,
        slPrice: trade.slPrice
      });
      throw error;
    }
  }

  console.info("[trade-engine] Trade closed", {
    symbol: trade.token,
    direction: trade.direction,
    status,
    reason,
    resultPct: status === "WIN" ? trade.takeProfitPct : -trade.stopLossPct,
    openTime: trade.openTime,
    closeTime
  });

  trade.status = status;
  trade.closeTime = closeTime;
  trade.closeReason = reason;
  trade.result = status === "WIN" ? trade.takeProfitPct : -trade.stopLossPct;
  trade.resultUsd = SIM_SIGNAL_ONLY_MODE ? 0 : Number((trade.stakeUsd * ((trade.result ?? 0) / 100)).toFixed(2));
  trade.closeFeeUsd = SIM_SIGNAL_ONLY_MODE ? 0 : Number((trade.stakeUsd * TRADING_FEE_RATE).toFixed(2));

  const openMs = Date.parse(trade.openTime);
  const closeMs = Date.parse(closeTime);
  if (Number.isFinite(openMs) && Number.isFinite(closeMs)) {
    trade.timeToClose = Math.max(0, Math.round((closeMs - openMs) / 60000));
  }

  trade.closeContextJson = buildCloseContextJson(trade, reason);

  openTrades.delete(getTradeKey(trade.token, trade.direction));
  closedTrades.push({ ...trade });
  if (!SIM_SIGNAL_ONLY_MODE) {
    const netClosePnlUsd = Number(((trade.resultUsd ?? 0) - (trade.closeFeeUsd ?? 0)).toFixed(2));
    accountBalanceUsd = Number((accountBalanceUsd + netClosePnlUsd).toFixed(2));
  }

  sendTradeLifecycleTelegram({
    stage: "CLOSED",
    symbol: trade.token,
    direction: trade.direction,
    entryTiming: trade.entryTiming ?? "MID",
    reversalPhase: trade.reversalPhase ?? "UNRESOLVED",
    signalType: trade.signalType,
    entryScore: trade.entryScore,
    weightedScore: trade.entryScore,
    signalStrength: 0,
    tpFeasibility: 1,
    structureConfidence: 0,
    volatilityPct: trade.volatilityPct,
    takeProfitPct: trade.takeProfitPct,
    stopLossPct: trade.stopLossPct,
    marketCondition: trade.marketCondition,
    entryPrice: trade.entryPrice,
    tpPrice: trade.tpPrice,
    slPrice: trade.slPrice,
    closeReason: reason,
    resultPct: trade.result,
    resultUsd: trade.resultUsd,
    dedupeKey: `CLOSED:${trade.id}`
  }, Boolean(trade.isLiveTrade));

  if (status === "LOSS") {
    lossStreakCount += 1;
    if (lossStreakCount >= MAX_LOSS_STREAK) {
      cooldownUntilMs = Date.parse(closeTime) + COOLDOWN_DURATION_MS;
      lossStreakCount = 0;
    }
  } else {
    lossStreakCount = 0;
  }

  equityCurve.push({ at: closeTime, balanceUsd: accountBalanceUsd });
  if (equityCurve.length > MAX_EQUITY_POINTS) {
    equityCurve.splice(0, equityCurve.length - MAX_EQUITY_POINTS);
  }

  if (closedTrades.length > MAX_CLOSED_TRADES) {
    closedTrades.splice(0, closedTrades.length - MAX_CLOSED_TRADES);
  }

  void markSessionTradeClosed({
    externalTradeId: trade.id,
    status,
    closedAt: closeTime,
    resultPct: trade.result ?? 0,
    resultUsd: trade.resultUsd ?? 0,
    closeReason: reason
  }).catch((error) => {
    console.error("[trade-engine] Failed to persist closed session trade", {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  void updateActiveSessionBalance(accountBalanceUsd, getMaxActiveTrades(accountBalanceUsd)).catch((error) => {
    console.error("[trade-engine] Failed to update session balance after close", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

  persistRuntimeState();
}

// ============= LIQUIDITY HUNT ENTRY LOGIC =============
// Proactive entry strategy: enter at predicted stop-loss levels (support/resistance)
// Expecting quick market maker reversal for 1-2% profit targets

function resolveLiquidityHuntDirectionalBias(row: TokenRsiResult): {
  likelySide: "UPPER_SWEEP" | "LOWER_SWEEP" | "BALANCED";
  huntScore: number;
  longStopLiquidityUsd: number;
  shortStopLiquidityUsd: number;
} {
  const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
  const supportDistance = Number(row.levels.supportDistancePct ?? 100);
  const resistanceDistance = Number(row.levels.resistanceDistancePct ?? 100);
  const supportCloseness = clamp01(1 - supportDistance / 2.5);
  const resistanceCloseness = clamp01(1 - resistanceDistance / 2.5);

  const volatilityPctile = Number(row.tradeContext?.volatilityPercentile ?? 0);
  const volatilityFactor = clamp01(volatilityPctile / 100);
  const imbalance = Math.max(-1, Math.min(1, Number(row.tradeContext?.orderBookImbalance ?? 0)));
  const bidDominance = Math.max(0, imbalance);
  const askDominance = Math.max(0, -imbalance);
  const intermediaryRsi = Number(row.timeframes.intermediary?.rsi ?? 50);
  const upperMomentum = intermediaryRsi < 45 ? 0.08 : intermediaryRsi > 70 ? -0.06 : 0;
  const lowerMomentum = intermediaryRsi > 60 ? 0.08 : intermediaryRsi < 30 ? -0.06 : 0;
  const emaSlope = Number(row.tradeContext?.emaSlope ?? 0);
  const trendForUpper = emaSlope > 0 ? 0.05 : 0;
  const trendForLower = emaSlope < 0 ? 0.05 : 0;

  const upperScore = clamp01(
    resistanceCloseness * 0.45
    + askDominance * 0.2
    + volatilityFactor * 0.2
    + trendForUpper
    + upperMomentum
    + (row.levels.nearResistance ? 0.1 : 0)
  );
  const lowerScore = clamp01(
    supportCloseness * 0.45
    + bidDominance * 0.2
    + volatilityFactor * 0.2
    + trendForLower
    + lowerMomentum
    + (row.levels.nearSupportFloor ? 0.1 : 0)
  );

  const diff = upperScore - lowerScore;
  const likelySide = Math.abs(diff) < 0.08
    ? "BALANCED"
    : diff > 0
      ? "UPPER_SWEEP"
      : "LOWER_SWEEP";

  const orderBookLongTilt = clamp01((imbalance + 1) / 2);
  const estimatedLongRaw = lowerScore * 0.72 + orderBookLongTilt * 0.28;
  const estimatedShortRaw = upperScore * 0.72 + (1 - orderBookLongTilt) * 0.28;
  const estimateTotal = Math.max(0.0001, estimatedLongRaw + estimatedShortRaw);
  const estimatedLongPct = Math.round((estimatedLongRaw / estimateTotal) * 100);
  const estimatedShortPct = Math.max(0, 100 - estimatedLongPct);

  const orderBookCombinedDepthUsd = Number(row.tradeContext?.orderBookCombinedDepthUsd ?? 0);
  const liquidityPctile = clamp01(Number(row.tradeContext?.liquidityPercentile ?? 0) / 100);
  const volume24h = Math.max(0, Number(row.tradeContext?.volume24h ?? row.volume24h ?? 0));
  const estimatedProxyDepthUsd = volume24h > 0 ? volume24h * (0.015 + (liquidityPctile * 0.045)) : 0;
  const totalStopLiquidityUsd = orderBookCombinedDepthUsd > 0 ? orderBookCombinedDepthUsd : estimatedProxyDepthUsd;
  const longStopLiquidityUsd = totalStopLiquidityUsd * (estimatedLongPct / 100);
  const shortStopLiquidityUsd = totalStopLiquidityUsd * (estimatedShortPct / 100);

  return {
    likelySide,
    huntScore: Math.round(Math.max(upperScore, lowerScore) * 100),
    longStopLiquidityUsd,
    shortStopLiquidityUsd
  };
}

function evaluateLiquidityHuntEntry(
  row: TokenRsiResult,
  nowMs: number
): {
  shouldOpen: boolean;
  direction: TradeDirection | null;
  slLevel: number;
  triggerZone: "SUPPORT" | "RESISTANCE" | null;
  breakPct: number;
  huntScore: number;
  likelySweepSide: "UPPER_SWEEP" | "LOWER_SWEEP" | "BALANCED";
  longStopLiquidityUsd: number;
  shortStopLiquidityUsd: number;
} {
  void nowMs;
  const directionalBias = resolveLiquidityHuntDirectionalBias(row);
  if (!LIQUIDITY_HUNT_ENTRY_ENABLED) {
    return {
      shouldOpen: false,
      direction: null,
      slLevel: 0,
      triggerZone: null,
      breakPct: 0,
      huntScore: directionalBias.huntScore,
      likelySweepSide: directionalBias.likelySide,
      longStopLiquidityUsd: directionalBias.longStopLiquidityUsd,
      shortStopLiquidityUsd: directionalBias.shortStopLiquidityUsd
    };
  }

  const close = Number(row.close ?? 0);
  const support = Number(row.levels.localSupport ?? 0);
  const resistance = Number(row.levels.localResistance ?? 0);

  if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(support) || support <= 0 || !Number.isFinite(resistance) || resistance <= 0) {
    return {
      shouldOpen: false,
      direction: null,
      slLevel: 0,
      triggerZone: null,
      breakPct: 0,
      huntScore: directionalBias.huntScore,
      likelySweepSide: directionalBias.likelySide,
      longStopLiquidityUsd: directionalBias.longStopLiquidityUsd,
      shortStopLiquidityUsd: directionalBias.shortStopLiquidityUsd
    };
  }

  // Support trigger: mode decides whether to fade (LONG) or flip to continuation (SHORT).
  const supportDistancePct = Math.abs((support - close) / close) * 100;
  const supportBreakPct = Math.max(0, ((support - close) / close) * 100);
  if (supportDistancePct <= LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT && close <= support) {
    if (LIQUIDITY_HUNT_ENTRY_MODE === "BREAKOUT_FLIP" && supportBreakPct < LIQUIDITY_HUNT_MIN_BREAK_PCT) {
      return {
        shouldOpen: false,
        direction: null,
        slLevel: 0,
        triggerZone: null,
        breakPct: supportBreakPct,
        huntScore: directionalBias.huntScore,
        likelySweepSide: directionalBias.likelySide,
        longStopLiquidityUsd: directionalBias.longStopLiquidityUsd,
        shortStopLiquidityUsd: directionalBias.shortStopLiquidityUsd
      };
    }
    if (LIQUIDITY_HUNT_ENTRY_MODE === "BREAKOUT_FLIP" && directionalBias.likelySide === "UPPER_SWEEP") {
      return {
        shouldOpen: false,
        direction: null,
        slLevel: 0,
        triggerZone: null,
        breakPct: supportBreakPct,
        huntScore: directionalBias.huntScore,
        likelySweepSide: directionalBias.likelySide,
        longStopLiquidityUsd: directionalBias.longStopLiquidityUsd,
        shortStopLiquidityUsd: directionalBias.shortStopLiquidityUsd
      };
    }
    const direction: TradeDirection = LIQUIDITY_HUNT_ENTRY_MODE === "BREAKOUT_FLIP" ? "SHORT" : "LONG";
    const symbol = normalizePerpSymbol(row.symbol);
    if (!openTrades.has(getTradeKey(symbol, direction))) {
      return {
        shouldOpen: true,
        direction,
        slLevel: support,
        triggerZone: "SUPPORT",
        breakPct: supportBreakPct,
        huntScore: directionalBias.huntScore,
        likelySweepSide: directionalBias.likelySide,
        longStopLiquidityUsd: directionalBias.longStopLiquidityUsd,
        shortStopLiquidityUsd: directionalBias.shortStopLiquidityUsd
      };
    }
  }

  // Resistance trigger: mode decides whether to fade (SHORT) or flip to continuation (LONG).
  const resistanceDistancePct = Math.abs((resistance - close) / close) * 100;
  const resistanceBreakPct = Math.max(0, ((close - resistance) / close) * 100);
  if (resistanceDistancePct <= LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT && close >= resistance) {
    if (LIQUIDITY_HUNT_ENTRY_MODE === "BREAKOUT_FLIP" && resistanceBreakPct < LIQUIDITY_HUNT_MIN_BREAK_PCT) {
      return {
        shouldOpen: false,
        direction: null,
        slLevel: 0,
        triggerZone: null,
        breakPct: resistanceBreakPct,
        huntScore: directionalBias.huntScore,
        likelySweepSide: directionalBias.likelySide,
        longStopLiquidityUsd: directionalBias.longStopLiquidityUsd,
        shortStopLiquidityUsd: directionalBias.shortStopLiquidityUsd
      };
    }
    if (LIQUIDITY_HUNT_ENTRY_MODE === "BREAKOUT_FLIP" && directionalBias.likelySide === "LOWER_SWEEP") {
      return {
        shouldOpen: false,
        direction: null,
        slLevel: 0,
        triggerZone: null,
        breakPct: resistanceBreakPct,
        huntScore: directionalBias.huntScore,
        likelySweepSide: directionalBias.likelySide,
        longStopLiquidityUsd: directionalBias.longStopLiquidityUsd,
        shortStopLiquidityUsd: directionalBias.shortStopLiquidityUsd
      };
    }
    const direction: TradeDirection = LIQUIDITY_HUNT_ENTRY_MODE === "BREAKOUT_FLIP" ? "LONG" : "SHORT";
    const symbol = normalizePerpSymbol(row.symbol);
    if (!openTrades.has(getTradeKey(symbol, direction))) {
      return {
        shouldOpen: true,
        direction,
        slLevel: resistance,
        triggerZone: "RESISTANCE",
        breakPct: resistanceBreakPct,
        huntScore: directionalBias.huntScore,
        likelySweepSide: directionalBias.likelySide,
        longStopLiquidityUsd: directionalBias.longStopLiquidityUsd,
        shortStopLiquidityUsd: directionalBias.shortStopLiquidityUsd
      };
    }
  }

  return {
    shouldOpen: false,
    direction: null,
    slLevel: 0,
    triggerZone: null,
    breakPct: 0,
    huntScore: directionalBias.huntScore,
    likelySweepSide: directionalBias.likelySide,
    longStopLiquidityUsd: directionalBias.longStopLiquidityUsd,
    shortStopLiquidityUsd: directionalBias.shortStopLiquidityUsd
  };
}

async function openLiquidityHuntEntry(
  row: TokenRsiResult,
  direction: TradeDirection,
  slLevel: number,
  nowMs: number,
  triggerZone: "SUPPORT" | "RESISTANCE" | null,
  breakPct: number,
  huntScore: number,
  likelySweepSide: "UPPER_SWEEP" | "LOWER_SWEEP" | "BALANCED",
  longStopLiquidityUsd: number,
  shortStopLiquidityUsd: number
): Promise<void> {
  const symbol = normalizePerpSymbol(row.symbol);
  const key = getTradeKey(symbol, direction);

  if (openTrades.has(key)) {
    return;
  }

  // Entry at the SL level (liquidity hunt setup)
  const entryPrice = Number(slLevel.toFixed(6));
  const leverage = LIQUIDITY_HUNT_ENTRY_LEVERAGE;
  const takeProfitPct = LIQUIDITY_HUNT_ENTRY_TP_PCT;
  const stopLossPct = LIQUIDITY_HUNT_ENTRY_SL_PCT;
  const tpMoveAbs = entryPrice * (takeProfitPct / 100 / leverage);
  const slMoveAbs = entryPrice * (stopLossPct / 100 / leverage);

  const tpPrice = direction === "LONG"
    ? toNumber(entryPrice + tpMoveAbs)
    : toNumber(entryPrice - tpMoveAbs);
  const slPrice = direction === "LONG"
    ? toNumber(entryPrice - slMoveAbs)
    : toNumber(entryPrice + slMoveAbs);

  const riskPerTrade = getRiskPerTradeForSymbol(symbol);
  const stakeUsd = getPositionSizeUsd(accountBalanceUsd, openTrades.size, stopLossPct, leverage, riskPerTrade);
  const openFeeUsd = SIM_SIGNAL_ONLY_MODE ? 0 : Number((stakeUsd * TRADING_FEE_RATE).toFixed(2));

  if (!Number.isFinite(stakeUsd) || stakeUsd <= 0 || (!SIM_SIGNAL_ONLY_MODE && accountBalanceUsd - openFeeUsd <= 0)) {
    logRejection({
      symbol,
      signal: "LIQUIDITY_HUNT_ENTRY",
      score: 0,
      direction,
      reason: "liquidity hunt entry insufficient balance",
      details: {
        stakeUsd,
        openFeeUsd,
        accountBalanceUsd,
        leverage,
        stopLossPct
      }
    });
    return;
  }

  const isLarge = isLargeCap(symbol);
  const tradeId = `${symbol}-${direction}-${Date.now()}-LIQ_HUNT`;
  const signalType = `LIQUIDITY_HUNT_ENTRY_${direction}`;
  const dryRunDecision = await runBitunixDryRunTradePlan({
    source: "AUTO_SIGNAL",
    symbol,
    direction,
    entryPrice,
    tpPrice,
    slPrice,
    leverage,
    stakeUsd
  });
  if (dryRunDecision.blocked) {
    logRejection({
      symbol,
      signal: signalType,
      score: 0,
      direction,
      reason: dryRunDecision.reason ?? "dry-run leverage verification failed",
      details: {
        requiredMinLeverage: BITUNIX_DRY_RUN_MIN_LEVERAGE,
        enforceMinLeverage: BITUNIX_DRY_RUN_ENFORCE_MIN_LEVERAGE
      }
    });
    return;
  }

  const trade: Trade = {
    id: tradeId,
    token: symbol,
    direction,
    signalType,
    signalCategory: "SCORE_BASED",
    entryTiming: "MID",
    reversalPhase: "UNRESOLVED",
    entryType: "SCORE_BASED",
    entryScore: 0,
    riskPctUsed: Number((riskPerTrade * 100).toFixed(2)),
    volatilityPct: Number(row.volatilityPct ?? 0),
    volume24h: Number(row.volume24h ?? 0),
    passedVolatility: true,
    passedLiquidity: true,
    assetType: isLarge ? "LARGE_CAP" : "ALT",
    marketCondition: "TRENDING",
    regime: row.tradeContext?.regime ?? "CHOPPY",
    cluster: getCluster(symbol),
    stakeUsd: Number(stakeUsd.toFixed(2)),
    takeProfitPct,
    stopLossPct,
    atr: Number(row.tradeContext?.atr ?? 0),
    tpDistance: Math.abs(tpPrice - entryPrice),
    slDistance: Math.abs(slPrice - entryPrice),
    expectedValue: 0,
    slippageEstimate: 0,
    entryPrice,
    effectiveEntryPrice: entryPrice,
    currentPrice: entryPrice,
    tpPrice,
    slPrice,
    leverage,
    status: "OPEN",
    openTime: new Date(nowMs).toISOString(),
    openFeeUsd,
    currentPnlPct: 0,
    currentPnlUsd: 0,
    positionValueUsd: Number((stakeUsd * leverage).toFixed(2)),
    distanceToTP: Number(
      (
        direction === "LONG"
          ? ((tpPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - tpPrice) / entryPrice) * 100
      ).toFixed(3)
    ),
    distanceToSL: Number(
      (
        direction === "LONG"
          ? ((entryPrice - slPrice) / entryPrice) * 100
          : ((slPrice - entryPrice) / entryPrice) * 100
      ).toFixed(3)
    ),
    maxDrawdown: 0,
    entryContextJson: safeJsonStringify({
      mode: "LIQUIDITY_HUNT_ENTRY",
      strategy:
        LIQUIDITY_HUNT_ENTRY_MODE === "BREAKOUT_FLIP"
          ? "Flip liquidity-hunt trigger into breakout continuation"
          : "Enter at stop-loss level for quick market maker reversal",
      slLevelAtEntry: slLevel,
      triggerZone,
      breakPct,
      entryMode: LIQUIDITY_HUNT_ENTRY_MODE,
      huntScore,
      likelySweepSide,
      longStopLiquidityUsd,
      shortStopLiquidityUsd,
      distancePctThreshold: LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT,
      minBreakPct: LIQUIDITY_HUNT_MIN_BREAK_PCT,
      configuredLeverage: leverage,
      configuredTakeProfitPct: takeProfitPct,
      configuredStopLossPct: stopLossPct
    })
  };

  if (isBitunixLiveTradingMode()) {
    try {
      const liveOrder = await executeLiveOpenOrder({
        symbol,
        direction,
        leverage,
        entryPrice,
        stakeUsd,
        localTradeId: trade.id
      });
      trade.isLiveTrade = true;
      trade.liveOrderId = liveOrder.orderId;
      trade.liveClientId = liveOrder.clientId;
      trade.livePositionId = liveOrder.positionId;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      alertLiveExecutionFailure({
        symbol,
        direction,
        phase: "OPEN",
        reason,
        signalType,
        entryPrice,
        tpPrice,
        slPrice
      });
      logRejection({
        symbol,
        signal: signalType,
        score: 0,
        direction,
        reason: `live open failed: ${reason}`,
        details: {
          liveTradingEnabled: true
        }
      });
      return;
    }
  }

  if (!SIM_SIGNAL_ONLY_MODE) {
    accountBalanceUsd = Number((accountBalanceUsd - openFeeUsd).toFixed(2));
  }

  openTrades.set(key, trade);
  lastOpenedByKey.set(key, nowMs);

  void appendSessionTradeOpened({
    externalTradeId: trade.id,
    symbol: trade.token,
    direction: trade.direction,
    signalType: trade.signalType,
    entryScore: trade.entryScore,
    weightedScore: trade.entryScore,
    takeProfitPct: trade.takeProfitPct,
    stopLossPct: trade.stopLossPct,
    stakeUsd: trade.stakeUsd,
    entryPrice: trade.entryPrice,
    tpPrice: trade.tpPrice,
    slPrice: trade.slPrice,
    leverage: trade.leverage,
    openedAt: trade.openTime
  }).catch((error) => {
    console.error("[trade-engine] Failed to persist liquidity-hunt entry open", {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  sendTradeLifecycleTelegram({
    stage: "OPENED",
    symbol: trade.token,
    direction: trade.direction,
    entryTiming: "MID",
    reversalPhase: "UNRESOLVED",
    signalType: trade.signalType,
    entryScore: 0,
    weightedScore: 0,
    signalStrength: 100,
    tpFeasibility: 1,
    structureConfidence: 0,
    volatilityPct: trade.volatilityPct,
    takeProfitPct: trade.takeProfitPct,
    stopLossPct: trade.stopLossPct,
    marketCondition: trade.marketCondition,
    entryPrice: trade.entryPrice,
    tpPrice: trade.tpPrice,
    slPrice: trade.slPrice,
    setupConflictNote:
      LIQUIDITY_HUNT_ENTRY_MODE === "BREAKOUT_FLIP"
        ? `Flipped liquidity-hunt at ${triggerZone?.toLowerCase() ?? "level"}. Break ${Number.isFinite(breakPct) ? breakPct.toFixed(3) : "0.000"}% >= ${LIQUIDITY_HUNT_MIN_BREAK_PCT.toFixed(3)}%.`
        : `Entered at predicted ${direction === "LONG" ? "support" : "resistance"} (SL zone). Expecting quick market maker reversal with 1-2% profit target.`,
    dedupeKey: `LIQ_HUNT_ENTRY:${trade.id}`
  }, Boolean(trade.isLiveTrade));

  console.info("[trade-engine] Liquidity hunt entry opened at SL level", {
    symbol: trade.token,
    direction: trade.direction,
    entryPrice: trade.entryPrice,
    slLevel,
    leverage: trade.leverage,
    takeProfitPct: trade.takeProfitPct,
    stopLossPct: trade.stopLossPct,
    tpPrice: trade.tpPrice,
    slPrice: trade.slPrice,
    mode: LIQUIDITY_HUNT_ENTRY_MODE,
    triggerZone,
    breakPct,
    huntScore,
    likelySweepSide,
    longStopLiquidityUsd,
    shortStopLiquidityUsd,
    expectedReversalMinutes: "< 5 (quick MM reversal)"
  });
}

async function closeTradeAtMarket(
  trade: Trade,
  closeTime: string,
  reason: string,
  contextExtras?: { sentimentShift?: Record<string, unknown> }
): Promise<void> {
  if (trade.isLiveTrade) {
    try {
      await executeLiveCloseForTrade(trade);
    } catch (error) {
      const liveCloseReason = error instanceof Error ? error.message : String(error);
      alertLiveExecutionFailure({
        symbol: trade.token,
        direction: trade.direction,
        phase: "CLOSE",
        reason: liveCloseReason,
        signalType: trade.signalType,
        entryPrice: trade.entryPrice,
        tpPrice: trade.tpPrice,
        slPrice: trade.slPrice
      });
      throw error;
    }
  }

  const rawMarketResultPct = Number((trade.currentPnlPct ?? 0).toFixed(2));
  const cappedByEarlyDrawdown =
    reason === "EARLY_DRAWDOWN_PROTECTION" &&
    CAP_EARLY_DRAWDOWN_TO_SL &&
    rawMarketResultPct < 0;
  const marketResultPct = cappedByEarlyDrawdown
    ? Number(Math.max(rawMarketResultPct, -Math.abs(trade.stopLossPct)).toFixed(2))
    : rawMarketResultPct;
  const status: "WIN" | "LOSS" = marketResultPct >= 0 ? "WIN" : "LOSS";

  console.info("[trade-engine] Trade closed at market", {
    symbol: trade.token,
    direction: trade.direction,
    status,
    reason,
    rawMarketResultPct,
    marketResultPct,
    cappedByEarlyDrawdown,
    openTime: trade.openTime,
    closeTime
  });

  trade.status = status;
  trade.closeTime = closeTime;
  trade.closeReason = reason;
  trade.result = marketResultPct;
  trade.resultUsd = SIM_SIGNAL_ONLY_MODE ? 0 : Number((trade.stakeUsd * (marketResultPct / 100)).toFixed(2));
  trade.closeFeeUsd = SIM_SIGNAL_ONLY_MODE ? 0 : Number((trade.stakeUsd * TRADING_FEE_RATE).toFixed(2));

  const openMs = Date.parse(trade.openTime);
  const closeMs = Date.parse(closeTime);
  if (Number.isFinite(openMs) && Number.isFinite(closeMs)) {
    trade.timeToClose = Math.max(0, Math.round((closeMs - openMs) / 60000));
  }

  trade.closeContextJson = buildCloseContextJson(trade, reason, contextExtras);

  openTrades.delete(getTradeKey(trade.token, trade.direction));
  closedTrades.push({ ...trade });

  if (!SIM_SIGNAL_ONLY_MODE) {
    const netClosePnlUsd = Number(((trade.resultUsd ?? 0) - (trade.closeFeeUsd ?? 0)).toFixed(2));
    accountBalanceUsd = Number((accountBalanceUsd + netClosePnlUsd).toFixed(2));
  }

  sendTradeLifecycleTelegram({
    stage: "CLOSED",
    symbol: trade.token,
    direction: trade.direction,
    entryTiming: trade.entryTiming ?? "MID",
    reversalPhase: trade.reversalPhase ?? "UNRESOLVED",
    signalType: trade.signalType,
    entryScore: trade.entryScore,
    weightedScore: trade.entryScore,
    signalStrength: 0,
    tpFeasibility: 1,
    structureConfidence: 0,
    volatilityPct: trade.volatilityPct,
    takeProfitPct: trade.takeProfitPct,
    stopLossPct: trade.stopLossPct,
    marketCondition: trade.marketCondition,
    entryPrice: trade.entryPrice,
    tpPrice: trade.tpPrice,
    slPrice: trade.slPrice,
    closeReason: reason,
    resultPct: trade.result,
    resultUsd: trade.resultUsd,
    dedupeKey: `CLOSED:${trade.id}`
  }, Boolean(trade.isLiveTrade));

  if (status === "LOSS") {
    lossStreakCount += 1;
    if (lossStreakCount >= MAX_LOSS_STREAK) {
      cooldownUntilMs = Date.parse(closeTime) + COOLDOWN_DURATION_MS;
      lossStreakCount = 0;
    }
  } else {
    lossStreakCount = 0;
  }

  equityCurve.push({ at: closeTime, balanceUsd: accountBalanceUsd });
  if (equityCurve.length > MAX_EQUITY_POINTS) {
    equityCurve.splice(0, equityCurve.length - MAX_EQUITY_POINTS);
  }

  if (closedTrades.length > MAX_CLOSED_TRADES) {
    closedTrades.splice(0, closedTrades.length - MAX_CLOSED_TRADES);
  }

  void markSessionTradeClosed({
    externalTradeId: trade.id,
    status,
    closedAt: closeTime,
    resultPct: trade.result ?? 0,
    resultUsd: trade.resultUsd ?? 0,
    closeReason: reason
  }).catch((error) => {
    console.error("[trade-engine] Failed to persist market-closed session trade", {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  void updateActiveSessionBalance(accountBalanceUsd, getMaxActiveTrades(accountBalanceUsd)).catch((error) => {
    console.error("[trade-engine] Failed to update session balance after market close", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

async function updateOpenTradesFromMarket(results?: TokenRsiResult[]): Promise<void> {
  let strategyConfig: StrategySettings | null = null;
  try {
    strategyConfig = await getStrategyConfig();
  } catch (error) {
    console.error("[trade-engine] Failed to load strategy config for lifecycle update", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const openList = Array.from(openTrades.values());
  if (openList.length === 0) {
    return;
  }

  if (LIVE_FORCE_CLOSE_ON_MAX_DRAWDOWN && isBitunixLiveTradingMode() && isKillSwitchTriggered(Date.now())) {
    const emergencyCloseTime = nowIso();
    for (const trade of openList) {
      if (trade.status !== "OPEN") {
        continue;
      }

      try {
        await closeTradeAtMarket(trade, emergencyCloseTime, "LIVE_DRAWDOWN_KILL_SWITCH");
      } catch (error) {
        console.error("[trade-engine] Live drawdown emergency close failed", {
          tradeId: trade.id,
          symbol: trade.token,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    persistRuntimeState();
    return;
  }

  const latestSignalBySymbol = buildLatestSignalBySymbol(results);

  const byToken = new Map<string, Trade[]>();
  for (const trade of openList) {
    const existing = byToken.get(trade.token);
    if (existing) {
      existing.push(trade);
    } else {
      byToken.set(trade.token, [trade]);
    }
  }

  const tokenEntries = Array.from(byToken.entries());
  const fetchedByToken = new Map<string, LatestOhlc | null>();
  for (const [token] of tokenEntries) {
    const ohlc = await fetchLifecycleOhlc(token);
    fetchedByToken.set(token, ohlc);
  }
  const perpContexts = await fetchPerpContexts(tokenEntries.map(([token]) => token));

  for (const [token, trades] of byToken.entries()) {
    const ohlc = fetchedByToken.get(token);
    if (!ohlc) {
      continue;
    }

    const perpContext = perpContexts.get(normalizePerpSymbol(token)) ?? null;

    for (const trade of trades) {
      if (trade.status !== "OPEN") {
        continue;
      }

      trade.currentPrice = ohlc.close;
      updateMaxDrawdown(trade, ohlc.low, ohlc.high);
      const live = computeLivePnlMetrics(trade);
      trade.currentPnlPct = live.currentPnlPct;
      trade.currentPnlUsd = live.currentPnlUsd;
      trade.positionValueUsd = live.positionValueUsd;
      trade.distanceToTP = live.distanceToTP;
      trade.distanceToSL = live.distanceToSL;
      enrichTradeWithProductionRead(trade, perpContext);

      const elapsedMinutes = Math.max(0, Math.round((Date.now() - Date.parse(trade.openTime)) / 60000));
      const liveSignal = latestSignalBySymbol.get(normalizePerpSymbol(trade.token));
      if (liveSignal) {
        const sentimentShift = evaluateSentimentShiftExit(trade, liveSignal, elapsedMinutes);
        if (sentimentShift.shouldClose) {
          await closeTradeAtMarket(trade, nowIso(), "SENTIMENT_SHIFT_OPPOSITE_SIGNAL", {
            sentimentShift: sentimentShift.details
          });
          continue;
        }
      }

      if (trade.currentPnlPct <= EARLY_DRAWDOWN_EXIT_PCT) {
        await closeTradeAtMarket(trade, nowIso(), "EARLY_DRAWDOWN_PROTECTION");
        continue;
      }

      const lifecycle = simulateTrade(
        {
          direction: trade.direction,
          tpPrice: trade.tpPrice,
          slPrice: trade.slPrice,
          entryType: trade.entryType
        },
        [
          {
            open: ohlc.open,
            high: ohlc.high,
            low: ohlc.low,
            close: ohlc.close,
            elapsedMinutes
          }
        ]
      );

      if (lifecycle.outcome === "TIME_EXIT") {
        const modeMaxHoldMinutes = strategyConfig
          ? (strategyConfig.tradingMode === "DAY_TRADING"
            ? strategyConfig.dayTradingMaxHoldTime
            : strategyConfig.swingTradingMaxHoldTime)
          : DEFAULT_MAX_HOLD_MINUTES;
        const entryTypeMaxHoldMinutes = getEntryTypeMaxHoldMinutesByMode(trade.entryType, modeMaxHoldMinutes);

        if (trade.entryType === "REVERSAL" && elapsedMinutes >= entryTypeMaxHoldMinutes && (trade.currentPnlPct ?? 0) < 2) {
          await closeTradeAtMarket(trade, nowIso(), "TIME_EXIT_REVERSAL_STALE");
          continue;
        }
        if (trade.entryType === "STRONG" && elapsedMinutes >= entryTypeMaxHoldMinutes && (trade.currentPnlPct ?? 0) < 3) {
          await closeTradeAtMarket(trade, nowIso(), "TIME_EXIT_STRONG_STALE");
          continue;
        }
        if (elapsedMinutes >= ABSOLUTE_MAX_HOLD_MINUTES) {
          await closeTradeAtMarket(trade, nowIso(), "TIME_EXIT_MAX_HOLD");
          continue;
        }

        await closeTradeAtMarket(trade, nowIso(), "TIME_EXIT_STALE_SIGNAL");
        continue;
      }

      if (lifecycle.outcome === "WIN") {
        await closeTrade(trade, "WIN", nowIso(), trade.direction === "LONG" ? "TP_HIT_LONG" : "TP_HIT_SHORT");
        continue;
      }

      if (lifecycle.outcome === "LOSS") {
        await closeTrade(trade, "LOSS", nowIso(), trade.direction === "LONG" ? "SL_HIT_LONG" : "SL_HIT_SHORT");
      }
    }
  }

  persistRuntimeState();
}

async function openTradesFromSignals(results: TokenRsiResult[]): Promise<void> {
  if (LIVE_TRADING_ENABLED && MARKET_DATA_PROVIDER !== "BITUNIX") {
    logRejection({
      symbol: "SYSTEM",
      signal: "SYSTEM",
      score: 0,
      reason: "live trading requires Bitunix provider",
      details: {
        marketDataProvider: MARKET_DATA_PROVIDER
      }
    });
    return;
  }

  const nowMs = Date.now();
  let openedAnyTrade = false;
  const persistenceTasks: Array<Promise<void>> = [];
  const rankedCandidates: RankedTradeCandidate[] = [];
  const feedback = getAdaptiveFeedback();
  let strategyConfig: StrategySettings | null = null;

  try {
    strategyConfig = await getStrategyConfig();
  } catch (error) {
    console.error("[trade-engine] Entry blocked: strategy config unavailable", {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  // Required execution order of system-level guardrails.
  resetDailyStartIfNeeded(nowMs);
  if (!TEST_OPEN_MODE && isKillSwitchTriggered(nowMs)) {
    logRejection({
      symbol: "SYSTEM",
      signal: "SYSTEM",
      score: 0,
      reason: "global kill switch active",
      details: {
        maxDrawdownPct: getEffectiveKillSwitchDrawdownPct()
      }
    });
    console.warn("[trade-engine] Entry blocked: kill switch active");
    return;
  }
  if (!TEST_OPEN_MODE && isSessionBlocked(nowMs)) {
    logRejection({
      symbol: "SYSTEM",
      signal: "SYSTEM",
      score: 0,
      reason: "session block",
      details: {
        hourUtc: new Date(nowMs).getUTCHours(),
        startUtc: SESSION_BLOCK_START_UTC,
        endUtc: SESSION_BLOCK_END_UTC
      }
    });
    console.info("[trade-engine] Entry blocked: low-liquidity UTC session", {
      hourUtc: new Date(nowMs).getUTCHours()
    });
    return;
  }
  if (
    !TEST_OPEN_MODE &&
    MAX_TRADES_LAST_WINDOW > 0 &&
    countTradesOpenedLastWindow(nowMs, GLOBAL_TRADE_THROTTLE_WINDOW_MS) >= MAX_TRADES_LAST_WINDOW
  ) {
    logRejection({
      symbol: "SYSTEM",
      signal: "SYSTEM",
      score: 0,
      reason: "global trade throttle",
      details: {
        windowMinutes: GLOBAL_TRADE_THROTTLE_WINDOW_MINUTES,
        maxTrades: MAX_TRADES_LAST_WINDOW
      }
    });
    console.info("[trade-engine] Entry blocked: trade throttle", {
      windowMinutes: GLOBAL_TRADE_THROTTLE_WINDOW_MINUTES,
      maxTrades: MAX_TRADES_LAST_WINDOW
    });
    return;
  }
  if (!TEST_OPEN_MODE && isCooldownActive(nowMs)) {
    logRejection({
      symbol: "SYSTEM",
      signal: "SYSTEM",
      score: 0,
      reason: "global cooldown active",
      details: {
        cooldownUntil: new Date(cooldownUntilMs).toISOString()
      }
    });
    console.info("[trade-engine] Entry blocked: cooldown active", {
      cooldownUntil: new Date(cooldownUntilMs).toISOString()
    });
    return;
  }
  if (!TEST_OPEN_MODE && isRollingDrawdownCircuitActive(nowMs)) {
    logRejection({
      symbol: "SYSTEM",
      signal: "SYSTEM",
      score: 0,
      reason: "rolling drawdown circuit active",
      details: {
        blockedUntil: new Date(rollingCircuitUntilMs).toISOString()
      }
    });
    console.info("[trade-engine] Entry blocked: rolling drawdown circuit active", {
      blockedUntil: new Date(rollingCircuitUntilMs).toISOString()
    });
    return;
  }
  if (!TEST_OPEN_MODE && hitDailyDrawdownLimit()) {
    logRejection({
      symbol: "SYSTEM",
      signal: "SYSTEM",
      score: 0,
      reason: "daily drawdown limit reached",
      details: {
        maxDailyDrawdownPct: MAX_DAILY_DRAWDOWN_PCT
      }
    });
    console.info("[trade-engine] Entry blocked: daily drawdown limit reached");
    return;
  }
  if (!TEST_OPEN_MODE && wouldExceedConcurrentRisk()) {
    logRejection({
      symbol: "SYSTEM",
      signal: "SYSTEM",
      score: 0,
      reason: "concurrent risk cap",
      details: {
        maxConcurrentRiskPct: MAX_CONCURRENT_RISK
      }
    });
    console.info("[trade-engine] Entry blocked: concurrent risk cap");
    return;
  }
  if (openTrades.size >= getMaxActiveTrades(accountBalanceUsd)) {
    console.info("[trade-engine] Entry open blocked: max active trades reached; scanning for opportunities", {
      openTrades: openTrades.size,
      maxActiveTrades: getMaxActiveTrades(accountBalanceUsd)
    });
  }

  for (const row of results) {
    const baseSymbol = getBaseSymbol(row.symbol);
    try {
      const tracking = await getBackfillStatus(getBackfillPrisma(), baseSymbol);
      const backfillStatus = tracking?.status ?? "PENDING";
      if (backfillStatus !== "COMPLETED") {
        logRejection({
          symbol: row.symbol,
          signal: row.signal.type,
          score: row.confluence.score,
          reason: "backfill not complete",
          details: {
            price: row.close,
            priceSource: "row.close",
            backfillStatus,
            candleCount: tracking?.candleCount ?? 0,
            dataAvailableFrom: tracking?.dataAvailableFrom?.toISOString() ?? null,
            lastError: tracking?.lastError ?? null
          }
        });
        continue;
      }
    } catch (error) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        reason: "backfill status lookup failed",
        details: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      continue;
    }

    // Check for liquidity hunt entry opportunity
    const liquidityHuntEntry = evaluateLiquidityHuntEntry(row, nowMs);
    if (liquidityHuntEntry.shouldOpen && liquidityHuntEntry.direction) {
      void openLiquidityHuntEntry(
        row,
        liquidityHuntEntry.direction,
        liquidityHuntEntry.slLevel,
        nowMs,
        liquidityHuntEntry.triggerZone,
        liquidityHuntEntry.breakPct,
        liquidityHuntEntry.huntScore,
        liquidityHuntEntry.likelySweepSide,
        liquidityHuntEntry.longStopLiquidityUsd,
        liquidityHuntEntry.shortStopLiquidityUsd
      ).catch((error) => {
        console.error("[trade-engine] Failed to open liquidity hunt entry", {
          symbol: row.symbol,
          direction: liquidityHuntEntry.direction,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      continue;
    }

    // Skip normal entry logic if in liquidity hunt only mode
    if (LIQUIDITY_HUNT_ONLY_MODE) {
      continue;
    }

    const isLarge = isLargeCap(row.symbol);
    const baseScoreThreshold = isLarge ? BTC_SCORE_ENTRY_THRESHOLD : SCORE_ENTRY_THRESHOLD;
    const minScoreThreshold = getAdaptiveScoreThreshold(baseScoreThreshold);
    const strongSignal = isStrongSignal(row.signal.type);
    const lowVolRegime = row.tradeContext?.regime === "LOW_VOL";
    const scoreQualified = row.confluence.score >= minScoreThreshold;
    let signalDirection = signalToDirection(row.signal.type);
    const fibTouchMemory = getFibTouchMemory(row.symbol, nowMs);
    const volatilityPct = Number(row.tradeContext?.volatilityPct ?? row.volatilityPct ?? 0);
    const volume24h = Number(row.tradeContext?.volume24h ?? row.volume24h ?? 0);
    const passedVolatility = row.tradeContext?.passedVolatility ?? volatilityPct >= MIN_VOLATILITY_PCT;
    const minVolumeUsd = getMinVolumeUsdForSymbol(row.symbol);
    const passedLiquidity = row.tradeContext?.passedLiquidity ?? volume24h >= minVolumeUsd;
    const passedStructure = row.tradeContext?.passedStructure ?? true;
    const passedMicroTrend = row.tradeContext?.passedMicroTrend ?? true;
    const symbolFastSlCooldownUntilMs = getSymbolFastSlCooldownUntilMs(row.symbol, nowMs);

    maybeNotifyPrePumpWatch(row, nowMs, volume24h, volatilityPct, minVolumeUsd);
    maybeNotifyViolentMoveAlerts(row, nowMs, volatilityPct, volume24h, minVolumeUsd);

    const directSignalQualified = strongSignal || row.signal.type.startsWith("REVERSAL") || fibTouchMemory != null;
    const structureMomentumOk = passedStructure || passedMicroTrend;

    if (signalDirection) {
      const previousDirection = lastSignalDirectionBySymbol.get(row.symbol);
      if (previousDirection && previousDirection !== signalDirection) {
        const shiftLevels = getTradeLevels(row.close, signalDirection, row.symbol, Number(row.tradeContext?.atr ?? 0));
        notifyTelegramEntry({
          stage: "CAUTION",
          symbol: row.symbol,
          direction: signalDirection,
          entryTiming: row.entryTiming ?? classifyEntryTiming({
            direction: signalDirection,
            price: row.close,
            atr: Number(row.tradeContext?.atr ?? 0),
            supportDistancePct: Number(row.levels.supportDistancePct ?? 0),
            resistanceDistancePct: Number(row.levels.resistanceDistancePct ?? 0),
            ema20: Number(row.tradeContext?.ema20 ?? 0)
          }),
          reversalPhase: resolveReversalPhase(row, signalDirection),
          signalType: `DIRECTION_SHIFT_${previousDirection}_TO_${signalDirection}`,
          entryScore: row.confluence.score,
          weightedScore: row.confluence.score,
          signalStrength: resolveSignalStrength(row),
          tpFeasibility: 1,
          structureConfidence: 0,
          volatilityPct,
          takeProfitPct: shiftLevels.takeProfitPct,
          stopLossPct: shiftLevels.stopLossPct,
          marketCondition: classifyMarketCondition(row.timeframes.macro.macdHist, row.close),
          entryPrice: row.close,
          tpPrice: shiftLevels.tpPrice,
          slPrice: shiftLevels.slPrice,
          marketStatus: row.status,
          setupConflictNote: getTelegramSetupConflictNote(row, signalDirection),
          dedupeKey: `SHIFT:${row.symbol}:${previousDirection}->${signalDirection}`
        });
      }
      lastSignalDirectionBySymbol.set(row.symbol, signalDirection);

      const oppositeDirection: TradeDirection = signalDirection === "LONG" ? "SHORT" : "LONG";
      const oppositeOpenTrade = openTrades.get(getTradeKey(row.symbol, oppositeDirection));

      if (oppositeOpenTrade && oppositeOpenTrade.status === "OPEN") {
        const atr = Number(row.tradeContext?.atr ?? 0);
        const cautionLevels = getTradeLevels(row.close, signalDirection, row.symbol, atr);
        const cautionTpDistance = Math.abs(cautionLevels.tpPrice - row.close);
        const cautionSlDistance = Math.abs(cautionLevels.slPrice - row.close);
        const cautionRr = cautionSlDistance > 0 ? cautionTpDistance / cautionSlDistance : 0;
        const cautionTpFeasibility = cautionRr >= 1.5 ? 1 : cautionRr / 1.5;
        const higherTimeframeTrend = resolveHigherTimeframeTrend(row);
        const structureState = resolveStructureState(row, signalDirection);
        const structureConfidence = resolveStructureConfidence(higherTimeframeTrend, structureState, signalDirection);
        const marketCondition = classifyMarketCondition(row.timeframes.macro.macdHist, row.close);

        notifyTelegramEntry({
          stage: "CAUTION",
          symbol: row.symbol,
          direction: signalDirection,
          entryTiming: row.entryTiming ?? classifyEntryTiming({
            direction: signalDirection,
            price: row.close,
            atr: Number(row.tradeContext?.atr ?? 0),
            supportDistancePct: Number(row.levels.supportDistancePct ?? 0),
            resistanceDistancePct: Number(row.levels.resistanceDistancePct ?? 0),
            ema20: Number(row.tradeContext?.ema20 ?? 0)
          }),
          reversalPhase: resolveReversalPhase(row, signalDirection),
          signalType: row.signal.type,
          entryScore: row.confluence.score,
          weightedScore: row.confluence.score,
          signalStrength: resolveSignalStrength(row),
          tpFeasibility: Number(cautionTpFeasibility.toFixed(3)),
          structureConfidence,
          volatilityPct,
          takeProfitPct: cautionLevels.takeProfitPct,
          stopLossPct: cautionLevels.stopLossPct,
          marketCondition,
          entryPrice: row.close,
          tpPrice: cautionLevels.tpPrice,
          slPrice: cautionLevels.slPrice,
          marketStatus: row.status,
          setupConflictNote: getTelegramSetupConflictNote(row, signalDirection)
        });
      }
    }

    if (!directSignalQualified && !scoreQualified) {
      continue;
    }

    if (lowVolRegime && !strongSignal) {
      continue;
    }

    if (!structureMomentumOk) {
      logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction: signalDirection ?? undefined, reason: "structure/micro alignment", details: { passedStructure, passedMicroTrend } });
      console.info("[trade-engine] Trade rejected: structure/micro alignment", { symbol: row.symbol, signal: row.signal.type, passedStructure, passedMicroTrend });
      continue;
    }

    if (!signalDirection && fibTouchMemory) {
      signalDirection = fibTouchMemory.direction;
      console.info("[trade-engine] Fib touch memory reused", {
        symbol: row.symbol,
        direction: signalDirection,
        touchedAtMs: new Date(fibTouchMemory.touchedAtMs).toISOString(),
        signalType: fibTouchMemory.signalType,
        memoryAgeMinutes: Number(((nowMs - fibTouchMemory.touchedAtMs) / 60000).toFixed(2))
      });
    }

    if (!signalDirection) {
      logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, reason: "no directional signal", details: { bias: row.confluence.bias, minScoreThreshold } });
      console.info("[trade-engine] Trade rejected: no directional signal", { symbol: row.symbol, signal: row.signal.type, bias: row.confluence.bias, score: row.confluence.score, minScoreThreshold });
      continue;
    }

    if (HTF_MOMENTUM_ALIGNMENT_ENABLED) {
      const htfConflict = evaluateHigherTimeframeMomentumConflict(row, signalDirection);
      const shouldBlock = htfConflict.hasHigherTimeframeConflict && htfConflict.conflictScore >= HTF_MOMENTUM_BLOCK_SCORE_MIN;
      if (shouldBlock) {
        logRejection({
          symbol: row.symbol,
          signal: row.signal.type,
          score: row.confluence.score,
          direction: signalDirection,
          reason: "higher timeframe momentum conflict",
          details: {
            conflictScore: htfConflict.conflictScore,
            blockScoreMin: HTF_MOMENTUM_BLOCK_SCORE_MIN,
            hasReversalPressure: htfConflict.hasReversalPressure,
            macroTrend: htfConflict.macroTrend,
            intermediaryTrend: htfConflict.intermediaryTrend,
            emaSlope: htfConflict.emaSlope,
            triggers: htfConflict.details
          }
        });
        console.info("[trade-engine] Trade rejected: higher timeframe momentum conflict", {
          symbol: row.symbol,
          signal: row.signal.type,
          direction: signalDirection,
          conflictScore: htfConflict.conflictScore,
          blockScoreMin: HTF_MOMENTUM_BLOCK_SCORE_MIN,
          triggers: htfConflict.details
        });
        continue;
      }
    }

    if (symbolFastSlCooldownUntilMs != null && nowMs < symbolFastSlCooldownUntilMs) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction: signalDirection,
        reason: "symbol instability cooldown",
        details: {
          thresholdHits: SYMBOL_FAST_SL_HITS_THRESHOLD,
          maxHoldMinutes: SYMBOL_FAST_SL_MAX_HOLD_MINUTES,
          lookbackMinutes: SYMBOL_FAST_SL_LOOKBACK_MINUTES,
          cooldownMinutes: SYMBOL_FAST_SL_COOLDOWN_MINUTES,
          blockedUntil: new Date(symbolFastSlCooldownUntilMs).toISOString()
        }
      });
      console.info("[trade-engine] Trade rejected: symbol instability cooldown", {
        symbol: row.symbol,
        blockedUntil: new Date(symbolFastSlCooldownUntilMs).toISOString(),
        thresholdHits: SYMBOL_FAST_SL_HITS_THRESHOLD,
        maxHoldMinutes: SYMBOL_FAST_SL_MAX_HOLD_MINUTES,
        lookbackMinutes: SYMBOL_FAST_SL_LOOKBACK_MINUTES
      });
      continue;
    }

    if (REVERSAL_VOLATILITY_GATE_ENABLED && row.signal.type.startsWith("REVERSAL") && volatilityPct > REVERSAL_MAX_VOLATILITY_PCT) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction: signalDirection,
        reason: "reversal volatility cap",
        details: {
          volatilityPct,
          maxVolatilityPct: REVERSAL_MAX_VOLATILITY_PCT
        }
      });
      console.info("[trade-engine] Trade rejected: reversal volatility cap", {
        symbol: row.symbol,
        signal: row.signal.type,
        volatilityPct,
        maxVolatilityPct: REVERSAL_MAX_VOLATILITY_PCT
      });
      continue;
    }

    if (!TEST_OPEN_MODE && !passesRegimeEntryRules(row, signalDirection)) {
      const isReversalInTrending =
        (row.tradeContext?.regime ?? "CHOPPY") === "TRENDING" &&
        row.signal.type.startsWith("REVERSAL") &&
        (row.tradeContext?.structureState ?? "CHOP") !== "REVERSAL";

      const rejectionLog: Record<string, unknown> = {
        symbol: row.symbol,
        regime: row.tradeContext?.regime ?? "CHOPPY",
        signal: row.signal.type,
        structureState: row.tradeContext?.structureState
      };

      if (isReversalInTrending) {
        const entryTiming = row.entryTiming ?? classifyEntryTiming({
          direction: signalDirection,
          price: row.close,
          atr: Number(row.tradeContext?.atr ?? 0),
          supportDistancePct: Number(row.levels.supportDistancePct ?? 0),
          resistanceDistancePct: Number(row.levels.resistanceDistancePct ?? 0),
          ema20: Number(row.tradeContext?.ema20 ?? 0)
        });
        rejectionLog.reason = "trending-reversal: not early timing or low confidence";
        rejectionLog.entryTiming = entryTiming;
        rejectionLog.confluenceScore = row.confluence.score;
        rejectionLog.requiredScore = SCORE_ENTRY_THRESHOLD;
      }

      logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction: signalDirection, reason: "regime rules", details: rejectionLog });
      console.info("[trade-engine] Trade rejected: regime rules", rejectionLog);
      continue;
    }

    if (!passedVolatility) {
      logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction: signalDirection, reason: "low volatility", details: { volatilityPct, minVolatilityPct: MIN_VOLATILITY_PCT } });
      console.info("[trade-engine] Trade rejected: low volatility", { symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, volatilityPct, minVolatilityPct: MIN_VOLATILITY_PCT });
      continue;
    }

    if (!passedLiquidity) {
      logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction: signalDirection, reason: "low liquidity", details: { volume24h, minVolumeUsd: MIN_VOLUME_USD } });
      console.info("[trade-engine] Trade rejected: low liquidity", { symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, volume24h, minVolumeUsd: MIN_VOLUME_USD });
      continue;
    }

    const candidate = buildRankedTradeCandidate(row, signalDirection, feedback, strategyConfig);

    if (strategyConfig?.enableFibonacci && candidate.fibTouchMemoryEligible) {
      lastFibTouchBySymbol.set(row.symbol, {
        direction: signalDirection,
        touchedAtMs: nowMs,
        signalType: row.signal.type,
        score: row.confluence.score
      });
    }

    if (ENFORCE_RESOLVED_REVERSAL_PHASE && row.signal.type.startsWith("REVERSAL") && candidate.reversalPhase === "UNRESOLVED") {
      const highScoreUnresolvedAllowed =
        UNRESOLVED_REVERSAL_ALLOW_HIGH_SCORE &&
        row.confluence.score >= UNRESOLVED_REVERSAL_MIN_SCORE &&
        (!UNRESOLVED_REVERSAL_REQUIRE_EARLY || candidate.entryTiming === "EARLY");

      if (highScoreUnresolvedAllowed) {
        console.info("[trade-engine] Trade allowed: unresolved reversal high-score exception", {
          symbol: row.symbol,
          signal: row.signal.type,
          score: row.confluence.score,
          minScore: UNRESOLVED_REVERSAL_MIN_SCORE,
          entryTiming: candidate.entryTiming,
          requireEarly: UNRESOLVED_REVERSAL_REQUIRE_EARLY
        });
      } else {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction: signalDirection,
        reason: "unresolved reversal phase",
        details: {
          reversalPhase: candidate.reversalPhase,
          minScoreForException: UNRESOLVED_REVERSAL_MIN_SCORE,
          requireEarlyForException: UNRESOLVED_REVERSAL_REQUIRE_EARLY,
          entryTiming: candidate.entryTiming
        }
      });
      console.info("[trade-engine] Trade rejected: unresolved reversal phase", {
        symbol: row.symbol,
        signal: row.signal.type,
        reversalPhase: candidate.reversalPhase
      });
      continue;
      }
    }

    if (!TEST_OPEN_MODE && candidate.expectedValue < EXPECTED_VALUE_MIN) {
      const allowEarlyReversalEvTolerance =
        row.signal.type.startsWith("REVERSAL") &&
        candidate.entryTiming === "EARLY" &&
        row.confluence.score >= SCORE_ENTRY_THRESHOLD &&
        candidate.expectedValue >= (EXPECTED_VALUE_MIN - EARLY_REVERSAL_EV_TOLERANCE);

      if (allowEarlyReversalEvTolerance) {
        console.info("[trade-engine] Trade allowed: early reversal EV tolerance", {
          symbol: row.symbol,
          signal: row.signal.type,
          expectedValue: candidate.expectedValue,
          minExpectedValue: EXPECTED_VALUE_MIN,
          tolerance: EARLY_REVERSAL_EV_TOLERANCE,
          entryTiming: candidate.entryTiming,
          confluenceScore: row.confluence.score,
          threshold: SCORE_ENTRY_THRESHOLD
        });
      } else {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction: signalDirection,
        reason: "non-positive EV",
        details: {
          expectedValue: candidate.expectedValue,
          minExpectedValue: EXPECTED_VALUE_MIN,
          expectedValuePct: candidate.expectedValue,
          minExpectedValuePct: EXPECTED_VALUE_MIN,
          units: "pct"
        }
      });
      console.info("[trade-engine] Trade rejected: non-positive EV", {
        symbol: row.symbol,
        expectedValuePct: candidate.expectedValue,
        minExpectedValuePct: EXPECTED_VALUE_MIN,
        signal: row.signal.type
      });
      continue;
      }
    }

    const entryTimingMaxForSignal = resolveEntryTimingMaxForSignal(row.signal.type);
    if (!TEST_OPEN_MODE && !isEntryTimingAllowed(candidate.entryTiming, entryTimingMaxForSignal)) {
      logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction: signalDirection, reason: "entry timing", details: { entryTiming: candidate.entryTiming, maxAllowed: entryTimingMaxForSignal } });
      console.info("[trade-engine] Trade rejected: entry timing", { symbol: row.symbol, signal: row.signal.type, entryTiming: candidate.entryTiming, maxAllowed: entryTimingMaxForSignal });
      continue;
    }

    if (!TEST_OPEN_MODE && !isReversalPhaseAllowed(candidate.reversalPhase, REVERSAL_PHASE_MIN)) {
      logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction: signalDirection, reason: "reversal phase below minimum", details: { reversalPhase: candidate.reversalPhase, minAllowed: REVERSAL_PHASE_MIN } });
      console.info("[trade-engine] Trade rejected: reversal phase", { symbol: row.symbol, signal: row.signal.type, reversalPhase: candidate.reversalPhase, minAllowed: REVERSAL_PHASE_MIN });
      continue;
    }

    if (!TEST_OPEN_MODE && candidate.reversalPhase === "COUNTER_TREND_BOUNCE" && candidate.entryTiming !== "EARLY") {
      logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction: signalDirection, reason: "counter-trend requires EARLY timing", details: { reversalPhase: candidate.reversalPhase, entryTiming: candidate.entryTiming } });
      console.info("[trade-engine] Trade rejected: counter-trend requires EARLY timing", { symbol: row.symbol, signal: row.signal.type, reversalPhase: candidate.reversalPhase, entryTiming: candidate.entryTiming });
      continue;
    }

    const minRiskRewardForCandidate = resolveMinRiskRewardForCandidate(candidate, row.signal.type);
    if (!TEST_OPEN_MODE && candidate.riskReward < minRiskRewardForCandidate) {
      logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction: signalDirection, reason: "RR below threshold", details: { riskReward: Number(candidate.riskReward.toFixed(3)), minRiskReward: minRiskRewardForCandidate } });
      console.info("[trade-engine] Trade rejected: RR below threshold", { symbol: row.symbol, signal: row.signal.type, riskReward: Number(candidate.riskReward.toFixed(3)), minRiskReward: minRiskRewardForCandidate });
      continue;
    }
    const tpFeasibility = candidate.riskReward >= minRiskRewardForCandidate ? 1 : candidate.riskReward / Math.max(0.001, minRiskRewardForCandidate);
    const tpFeasibilityMin = lowVolRegime || volatilityPct < LOW_VOLATILITY_PCT_THRESHOLD
      ? LOW_VOLATILITY_TP_FEASIBILITY_MIN
      : NORMAL_TP_FEASIBILITY_MIN;
    if (!TEST_OPEN_MODE && tpFeasibility < tpFeasibilityMin) {
      console.info("[trade-engine] Trade rejected: low TP feasibility", {
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        signalStrength: Number(candidate.signalStrength.toFixed(3)),
        tpFeasibility: Number(tpFeasibility.toFixed(3)),
        requiredTpFeasibility: tpFeasibilityMin,
        structureConfidence: Number(candidate.structureConfidence.toFixed(3)),
        takeProfitPct: candidate.takeProfitPct
      });
      continue;
    }

    rankedCandidates.push(candidate);

    const marketCondition = classifyMarketCondition(row.timeframes.macro.macdHist, row.close);
    const hasRecentReadyOpportunity = await hasRecentSessionOpportunity({
      symbol: row.symbol,
      direction: signalDirection,
      signalType: row.signal.type,
      withinMinutes: TELEGRAM_ALERT_DEDUPE_MINUTES,
      reason: "ENTRY_AVAILABLE"
    });

    if (!hasRecentReadyOpportunity) {
      const readyLevels = getTradeLevelsWithStrategy(row.close, signalDirection, row, strategyConfig);
      notifyTelegramEntry({
        stage: "READY",
        symbol: row.symbol,
        direction: signalDirection,
        entryTiming: candidate.entryTiming,
        reversalPhase: candidate.reversalPhase,
        signalType: row.signal.type,
        entryScore: row.confluence.score,
        weightedScore: candidate.score,
        signalStrength: candidate.signalStrength,
        tpFeasibility,
        structureConfidence: candidate.structureConfidence,
        volatilityPct,
        takeProfitPct: candidate.takeProfitPct,
        stopLossPct: candidate.stopLossPct,
        marketCondition,
        entryPrice: row.close,
        tpPrice: readyLevels.tpPrice,
        slPrice: readyLevels.slPrice,
        marketStatus: row.status,
        setupConflictNote: getTelegramSetupConflictNote(row, signalDirection)
      });
    } else {
      console.info("[trade-engine] READY telegram suppressed: duplicate opportunity within dedupe window", {
        symbol: row.symbol,
        direction: signalDirection,
        signalType: row.signal.type,
        dedupeMinutes: TELEGRAM_ALERT_DEDUPE_MINUTES
      });
    }

    persistenceTasks.push(
      appendSessionOpportunity({
        symbol: row.symbol,
        direction: signalDirection,
        signalType: row.signal.type,
        entryScore: row.confluence.score,
        weightedScore: candidate.score,
        takeProfitPct: candidate.takeProfitPct,
        stopLossPct: candidate.stopLossPct,
        volatilityPct,
        marketCondition,
        availableForEntry: openTrades.size < getMaxActiveTrades(accountBalanceUsd),
        reason: openTrades.size >= getMaxActiveTrades(accountBalanceUsd)
          ? "MAX_ACTIVE_TRADE_REACHED"
          : "ENTRY_AVAILABLE"
      }).catch((error) => {
        console.error("[trade-engine] Failed to persist session opportunity", {
          symbol: row.symbol,
          error: error instanceof Error ? error.message : String(error)
        });
      })
    );
  }

  const prioritizedResults = rankedCandidates.sort(compareTradeCandidates);

  for (const candidate of prioritizedResults) {
    const row = candidate.row;
    const direction = candidate.direction;
    const strongSignal = isStrongSignal(row.signal.type);
    const isLarge = isLargeCap(row.symbol);
    const scoreQualified = row.confluence.score >= (isLarge ? PRIORITY_BTC_SCORE_ENTRY_THRESHOLD : PRIORITY_SCORE_ENTRY_THRESHOLD);
    const volatilityPct = Number(row.tradeContext?.volatilityPct ?? row.volatilityPct ?? 0);
    const volume24h = Number(row.tradeContext?.volume24h ?? row.volume24h ?? 0);
    const passedVolatility = row.tradeContext?.passedVolatility ?? volatilityPct >= MIN_VOLATILITY_PCT;
    const passedLiquidity = row.tradeContext?.passedLiquidity ?? volume24h >= MIN_VOLUME_USD;
    const marketCondition = classifyMarketCondition(row.timeframes.macro.macdHist, row.close);
    const cluster = getCluster(row.symbol);

    if (
      !TEST_OPEN_MODE &&
      marketCondition === "RANGING" &&
      (row.signal.type === "CONTINUATION LONG" || row.signal.type === "CONTINUATION SHORT")
    ) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: "regime rules",
        details: {
          reason: "continuation blocked in ranging regime",
          marketCondition
        }
      });
      console.info("[trade-engine] Trade rejected: continuation blocked in ranging regime", {
        symbol: row.symbol,
        signal: row.signal.type,
        marketCondition
      });
      continue;
    }

    if (!Number.isFinite(row.close) || row.close <= 0) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: "invalid price data",
        details: { close: row.close }
      });
      continue;
    }

    if (!TEST_OPEN_MODE && isKillSwitchTriggered(nowMs)) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: "global kill switch active",
        details: { drawdownPct: getEffectiveKillSwitchDrawdownPct() }
      });
      break;
    }

    if (!TEST_OPEN_MODE && isRollingDrawdownCircuitActive(nowMs)) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: "rolling drawdown circuit active",
        details: {
          rollingWindowHours: Number((ROLLING_DRAWDOWN_WINDOW_MS / (60 * 60 * 1000)).toFixed(2)),
          cooldownMinutes: Number((ROLLING_DRAWDOWN_COOLDOWN_MS / 60000).toFixed(2))
        }
      });
      break;
    }

    if (
      !TEST_OPEN_MODE &&
      MAX_TRADES_LAST_WINDOW > 0 &&
      countTradesOpenedLastWindow(nowMs, GLOBAL_TRADE_THROTTLE_WINDOW_MS) >= MAX_TRADES_LAST_WINDOW
    ) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: "global trade throttle",
        details: {
          windowMinutes: GLOBAL_TRADE_THROTTLE_WINDOW_MINUTES,
          maxTrades: MAX_TRADES_LAST_WINDOW
        }
      });
      console.info("[trade-engine] Entry blocked mid-loop: trade throttle", {
        windowMinutes: GLOBAL_TRADE_THROTTLE_WINDOW_MINUTES,
        maxTrades: MAX_TRADES_LAST_WINDOW
      });
      break;
    }

    // Re-check risk cap per accepted trade because exposure changes during this loop.
    const tradeRiskPct = getRiskPerTradeForSymbol(row.symbol);
    if (!TEST_OPEN_MODE && wouldExceedConcurrentRisk(tradeRiskPct)) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: "concurrent risk cap",
        details: {
          tradeRiskPct,
          maxConcurrentRiskPct: MAX_CONCURRENT_RISK
        }
      });
      break;
    }
    if (openTrades.size >= getMaxActiveTrades(accountBalanceUsd)) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: "max active trades reached",
        details: {
          activeTrades: openTrades.size,
          maxActiveTrades: getMaxActiveTrades(accountBalanceUsd)
        }
      });
      break;
    }

    const openDecision = evaluateOpenTradeEligibility(row.symbol, direction, nowMs);
    if (!openDecision.allow) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: openDecision.reason ?? "open trade blocked",
        details: openDecision.details ?? {}
      });
      continue;
    }

    if (!TEST_OPEN_MODE && countClusterActiveTrades(cluster) >= MAX_CLUSTER_ACTIVE_TRADES) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: "cluster exposure cap",
        details: {
          cluster,
          maxPerCluster: MAX_CLUSTER_ACTIVE_TRADES
        }
      });
      console.info("[trade-engine] Trade rejected: cluster exposure cap", {
        symbol: row.symbol,
        cluster,
        maxPerCluster: MAX_CLUSTER_ACTIVE_TRADES
      });
      continue;
    }

    if (!TEST_OPEN_MODE && countClusterDirectionActiveTrades(cluster, direction) >= MAX_CLUSTER_DIRECTION_ACTIVE_TRADES) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: "directional cluster exposure cap",
        details: {
          cluster,
          direction,
          maxPerClusterDirection: MAX_CLUSTER_DIRECTION_ACTIVE_TRADES
        }
      });
      console.info("[trade-engine] Trade rejected: directional cluster exposure cap", {
        symbol: row.symbol,
        cluster,
        direction,
        maxPerClusterDirection: MAX_CLUSTER_DIRECTION_ACTIVE_TRADES
      });
      continue;
    }

    const leverageForTrade = candidate.leverage;
    const riskPerTrade = getRiskPerTradeForSymbol(row.symbol);
    const basePositionSizeUsd = getPositionSizeUsd(
      accountBalanceUsd,
      openTrades.size,
      candidate.stopLossPct,
      leverageForTrade,
      riskPerTrade
    );
    const positionSizeUsd = scaleStakeByVolatility(basePositionSizeUsd, volatilityPct);
    if (!Number.isFinite(positionSizeUsd) || positionSizeUsd <= 0) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: "invalid position size",
        details: {
          basePositionSizeUsd,
          positionSizeUsd,
          volatilityPct
        }
      });
      continue;
    }

    const orderNotionalUsd = positionSizeUsd * leverageForTrade;
    const openFeeUsd = SIM_SIGNAL_ONLY_MODE ? 0 : Number((positionSizeUsd * TRADING_FEE_RATE).toFixed(2));
    if (accountBalanceUsd - openFeeUsd <= 0) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: "insufficient balance for fees",
        details: {
          accountBalanceUsd,
          openFeeUsd
        }
      });
      continue;
    }

    let simulatedSlippagePct = 0;
    let appliedSlippagePct = 0;
    let effectiveEntry = row.close;

    if (!TEST_OPEN_MODE) {
      const orderBookRead = await fetchOrderBookExecutionRead(row.symbol);
      if (!orderBookRead) {
        logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction, reason: "order book unavailable", details: {} });
        console.info("[trade-engine] Trade rejected: order book unavailable", { symbol: row.symbol, signal: row.signal.type });
        continue;
      }

      const runtimeOrderBookPass = passesRuntimeOrderBookGate(
        row.symbol,
        direction,
        orderBookRead.spreadPct,
        orderBookRead.combinedDepthUsd,
        orderBookRead.imbalance,
        orderNotionalUsd
      );
      if (!runtimeOrderBookPass) {
        logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction, reason: "order book execution guard", details: { spreadPct: orderBookRead.spreadPct, depthUsd: orderBookRead.combinedDepthUsd, imbalance: orderBookRead.imbalance, orderNotionalUsd } });
        console.info("[trade-engine] Trade rejected: runtime order book execution guard", { symbol: row.symbol, signal: row.signal.type, spreadPct: orderBookRead.spreadPct, depthUsd: orderBookRead.combinedDepthUsd, imbalance: orderBookRead.imbalance, orderNotionalUsd, maxSpreadPct: isLargeCap(row.symbol) ? ORDERBOOK_MAX_SPREAD_PCT_LARGE : ORDERBOOK_MAX_SPREAD_PCT_ALT, minDepthUsd: orderNotionalUsd * ORDERBOOK_MIN_DEPTH_MULTIPLIER, maxAgainstImbalance: ORDERBOOK_MAX_AGAINST_IMBALANCE });
        continue;
      }

      const executionValidation = validateExecution({
        spreadPct: orderBookRead.spreadPct,
        depthUsd: Math.max(orderBookRead.combinedDepthUsd, 0),
        orderNotional: orderNotionalUsd,
        maxSpread: getOrderBookSpreadLimitPct(row.symbol),
        ignoreSlippageGuard: IGNORE_SLIPPAGE_GUARD
      });
      simulatedSlippagePct = Number((executionValidation.slippage * 100).toFixed(4));
      const appliedSlippage = IGNORE_SLIPPAGE_GUARD ? 0 : executionValidation.slippage;
      appliedSlippagePct = Number((appliedSlippage * 100).toFixed(4));

      const slippageExceeded = simulatedSlippagePct > MAX_SLIPPAGE_PCT;
      if (!executionValidation.ok || (!IGNORE_SLIPPAGE_GUARD && slippageExceeded)) {
        logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction, reason: "slippage protection", details: { slippagePct: simulatedSlippagePct, maxSlippagePct: MAX_SLIPPAGE_PCT, depthUsd: orderBookRead.combinedDepthUsd, orderNotionalUsd } });
        console.info("[trade-engine] Trade rejected: slippage protection", { symbol: row.symbol, depthUsdAt10bps: orderBookRead.combinedDepthUsd, orderNotionalUsd, slippagePct: simulatedSlippagePct, maxSlippagePct: MAX_SLIPPAGE_PCT, ignoreSlippageGuard: IGNORE_SLIPPAGE_GUARD });
        continue;
      }

      effectiveEntry = effectiveEntryPrice(row.close, row.signal.type, appliedSlippage);
    }

    const setupPolicyForExecution = resolveSetupRiskPolicy(row.symbol, row.signal.type, candidate.structureState);
    const levelsForValidation = getTradeLevelsWithStrategy(
      effectiveEntry,
      direction,
      row,
      strategyConfig,
      {
        ...setupPolicyForExecution,
        leverage: leverageForTrade
      }
    );
    const tpDistance = Math.abs(levelsForValidation.tpPrice - effectiveEntry);
    const slDistance = Math.abs(levelsForValidation.slPrice - effectiveEntry);
    const rr = slDistance > 0 ? tpDistance / slDistance : 0;
    const spreadCostPct = 0;
    const spreadAndSlippagePct = IGNORE_SLIPPAGE_GUARD
      ? spreadCostPct
      : spreadCostPct + (simulatedSlippagePct * 2);
    const tpDistancePct = effectiveEntry > 0 ? Number(((tpDistance / effectiveEntry) * 100).toFixed(4)) : 0;

    const minExecutionRiskReward = resolveMinRiskRewardForCandidate(candidate, row.signal.type);
    if (!TEST_OPEN_MODE && (rr < minExecutionRiskReward || tpDistancePct <= spreadAndSlippagePct)) {
      logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction, reason: "execution-adjusted TP viability", details: { rr: Number(rr.toFixed(3)), minRiskReward: minExecutionRiskReward, tpDistancePct, spreadAndSlippagePct, spreadPct: spreadCostPct, slippagePct: simulatedSlippagePct } });
      console.info("[trade-engine] Trade rejected: execution-adjusted TP viability", { symbol: row.symbol, rr: Number(rr.toFixed(3)), minRiskReward: minExecutionRiskReward, tpDistancePct, spreadAndSlippagePct, spreadPct: spreadCostPct, slippagePct: simulatedSlippagePct, ignoreSlippageGuard: IGNORE_SLIPPAGE_GUARD });
      continue;
    }

    console.info("[trade-engine] Trade selected", {
      symbol: row.symbol,
      score: Number(candidate.score.toFixed(3)),
      expectedValue: candidate.expectedValue,
      signalStrength: Number(candidate.signalStrength.toFixed(3)),
      tpFeasibility: Number((candidate.riskReward >= 1.5 ? 1 : candidate.riskReward / 1.5).toFixed(3)),
      structureConfidence: Number(candidate.structureConfidence.toFixed(3)),
      signalType: row.signal.type,
      confluenceScore: row.confluence.score,
      structureState: candidate.structureState,
      reversalPhase: candidate.reversalPhase,
      regime: candidate.regime,
      cluster,
      volatilityPct,
      tpMovePct: candidate.takeProfitPct,
      slMovePct: candidate.stopLossPct,
      executionMode: "LIMIT_SIMULATED",
      slippagePct: appliedSlippagePct,
      slippageObservedPct: simulatedSlippagePct,
      ignoreSlippageGuard: IGNORE_SLIPPAGE_GUARD,
      entryReason: "RANKED_CANDIDATE_SELECTED"
    });

    const levels = getTradeLevelsWithStrategy(
      effectiveEntry,
      direction,
      row,
      strategyConfig,
      {
        ...setupPolicyForExecution,
        leverage: leverageForTrade
      }
    );
    const dryRunDecision = await runBitunixDryRunTradePlan({
      source: "AUTO_SIGNAL",
      symbol: row.symbol,
      direction,
      entryPrice: effectiveEntry,
      tpPrice: levels.tpPrice,
      slPrice: levels.slPrice,
      leverage: leverageForTrade,
      stakeUsd: positionSizeUsd
    });
    if (dryRunDecision.blocked) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: dryRunDecision.reason ?? "dry-run leverage verification failed",
        details: {
          requiredMinLeverage: BITUNIX_DRY_RUN_MIN_LEVERAGE,
          enforceMinLeverage: BITUNIX_DRY_RUN_ENFORCE_MIN_LEVERAGE
        }
      });
      continue;
    }

    const signalCategory: TradeEntryType = row.signal.type.startsWith("STRONG")
      ? "STRONG"
      : row.signal.type.startsWith("REVERSAL")
        ? "REVERSAL"
      : row.signal.type.startsWith("CONTINUATION") && scoreQualified
        ? "CONTINUATION"
        : "SCORE_BASED";
    const assetType: AssetType = isLarge ? "LARGE_CAP" : "ALT";

    const trade: Trade = {
      id: `${row.symbol}-${direction}-${nowMs}`,
      token: row.symbol,
      direction,
      signalType:
        signalCategory === "SCORE_BASED"
          ? row.confluence.bias === null
            ? "SCORE_BASED_NEUTRAL"
            : `SCORE_BASED_${row.confluence.bias}`
          : row.signal.type,
      signalCategory,
      entryTiming: candidate.entryTiming,
      reversalPhase: candidate.reversalPhase,
      entryType: signalCategory,
      entryScore: row.confluence.score,
      riskPctUsed: Number((riskPerTrade * 100).toFixed(2)),
      volatilityPct,
      volume24h,
      passedVolatility,
      passedLiquidity,
      assetType,
      marketCondition,
      regime: candidate.regime,
      cluster,
      stakeUsd: positionSizeUsd,
      takeProfitPct: levels.takeProfitPct,
      stopLossPct: levels.stopLossPct,
      atr: Number(row.tradeContext?.atr ?? 0),
      tpDistance: Math.abs(levels.tpPrice - effectiveEntry),
      slDistance: Math.abs(levels.slPrice - effectiveEntry),
      expectedValue: candidate.expectedValue,
      slippageEstimate: appliedSlippagePct,
      openFeeUsd,
      entryPrice: effectiveEntry,
      effectiveEntryPrice: effectiveEntry,
      currentPrice: effectiveEntry,
      tpPrice: levels.tpPrice,
      slPrice: levels.slPrice,
      leverage: leverageForTrade,
      status: "OPEN",
      openTime: new Date(nowMs).toISOString(),
      currentPnlPct: 0,
      currentPnlUsd: 0,
      positionValueUsd: positionSizeUsd,
      distanceToTP: Number(
        (
          direction === "LONG"
            ? ((levels.tpPrice - effectiveEntry) / effectiveEntry) * 100
            : ((effectiveEntry - levels.tpPrice) / effectiveEntry) * 100
        ).toFixed(3)
      ),
      distanceToSL: Number(
        (
          direction === "LONG"
            ? ((effectiveEntry - levels.slPrice) / effectiveEntry) * 100
            : ((levels.slPrice - effectiveEntry) / effectiveEntry) * 100
        ).toFixed(3)
      ),
      maxDrawdown: 0
    };

    trade.entryContextJson = buildEntryContextJson(row, candidate.score, {
      regime: trade.regime,
      atr: trade.atr,
      tpDistance: trade.tpDistance,
      slDistance: trade.slDistance,
      expectedValue: trade.expectedValue,
      cluster: trade.cluster,
      slippageEstimate: trade.slippageEstimate
    });

    if (isBitunixLiveTradingMode()) {
      try {
        const liveOrder = await executeLiveOpenOrder({
          symbol: row.symbol,
          direction,
          leverage: leverageForTrade,
          entryPrice: effectiveEntry,
          stakeUsd: positionSizeUsd,
          localTradeId: trade.id
        });
        trade.isLiveTrade = true;
        trade.liveOrderId = liveOrder.orderId;
        trade.liveClientId = liveOrder.clientId;
        trade.livePositionId = liveOrder.positionId;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        alertLiveExecutionFailure({
          symbol: row.symbol,
          direction,
          phase: "OPEN",
          reason,
          signalType: row.signal.type,
          entryPrice: effectiveEntry,
          tpPrice: levels.tpPrice,
          slPrice: levels.slPrice
        });
        logRejection({
          symbol: row.symbol,
          signal: row.signal.type,
          score: row.confluence.score,
          direction,
          reason: `live open failed: ${reason}`,
          details: {
            leverage: leverageForTrade,
            stakeUsd: positionSizeUsd
          }
        });
        continue;
      }
    }

    enrichTradeWithProductionRead(trade, null);

    if (!SIM_SIGNAL_ONLY_MODE) {
      accountBalanceUsd = Number((accountBalanceUsd - openFeeUsd).toFixed(2));
    }

    const key = getTradeKey(row.symbol, direction);
    openTrades.set(key, trade);
    lastOpenedByKey.set(key, nowMs);
    openedAnyTrade = true;

    sendTradeLifecycleTelegram({
      stage: "OPENED",
      symbol: row.symbol,
      direction,
      entryTiming: candidate.entryTiming,
      reversalPhase: candidate.reversalPhase,
      signalType: row.signal.type,
      entryScore: row.confluence.score,
      weightedScore: candidate.score,
      signalStrength: candidate.signalStrength,
      tpFeasibility: candidate.riskReward >= 1.5 ? 1 : candidate.riskReward / 1.5,
      structureConfidence: candidate.structureConfidence,
      volatilityPct,
      takeProfitPct: candidate.takeProfitPct,
      stopLossPct: candidate.stopLossPct,
      marketCondition,
      entryPrice: effectiveEntry,
      tpPrice: levelsForValidation.tpPrice,
      slPrice: levelsForValidation.slPrice,
      marketStatus: row.status,
      setupConflictNote: getTelegramSetupConflictNote(row, direction)
    }, Boolean(trade.isLiveTrade));

    persistenceTasks.push(
      appendSessionTradeOpened({
        externalTradeId: trade.id,
        symbol: trade.token,
        direction: trade.direction,
        signalType: trade.signalType,
        entryScore: trade.entryScore,
        weightedScore: candidate.score,
        takeProfitPct: trade.takeProfitPct,
        stopLossPct: trade.stopLossPct,
        stakeUsd: trade.stakeUsd,
        entryPrice: trade.entryPrice,
        tpPrice: trade.tpPrice,
        slPrice: trade.slPrice,
        leverage: trade.leverage,
        openedAt: trade.openTime
      }).catch((error) => {
        console.error("[trade-engine] Failed to persist opened session trade", {
          symbol: trade.token,
          tradeId: trade.id,
          error: error instanceof Error ? error.message : String(error)
        });
      })
    );
  }

  if (persistenceTasks.length > 0) {
    await Promise.all(persistenceTasks);
  }

  if (openedAnyTrade) {
    await updateActiveSessionBalance(accountBalanceUsd, getMaxActiveTrades(accountBalanceUsd)).catch((error) => {
      console.error("[trade-engine] Failed to update session balance after opening trade", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    persistRuntimeState();
  }
}

function computeStats(active: Trade[], closed: Trade[]): TradeStats {
  const wins = closed.filter((trade) => trade.status === "WIN");
  const losses = closed.filter((trade) => trade.status === "LOSS");
  const settledCount = wins.length + losses.length;

  const avgMinutesToWin =
    wins.length > 0
      ? Number((wins.reduce((sum, trade) => sum + (trade.timeToClose ?? 0), 0) / wins.length).toFixed(2))
      : 0;
  const avgMinutesToLoss =
    losses.length > 0
      ? Number((losses.reduce((sum, trade) => sum + (trade.timeToClose ?? 0), 0) / losses.length).toFixed(2))
      : 0;

  const totalSimulatedPnl = Number(
    closed.reduce((sum, trade) => sum + (trade.result ?? 0), 0).toFixed(2)
  );
  const totalSimulatedPnlUsd = Number(
    closed.reduce((sum, trade) => sum + (trade.resultUsd ?? 0), 0).toFixed(2)
  );
  const unrealizedPnlUsd = Number(active.reduce((sum, trade) => sum + (trade.currentPnlUsd ?? 0), 0).toFixed(2));
  const equityUsd = Number((accountBalanceUsd + unrealizedPnlUsd).toFixed(2));
  const realizedPnlUsd = Number((accountBalanceUsd - SIM_INITIAL_CAPITAL_USD).toFixed(2));
  const totalPnlUsd = Number((realizedPnlUsd + unrealizedPnlUsd).toFixed(2));
  const totalPnlPct =
    SIM_INITIAL_CAPITAL_USD > 0
      ? Number(((totalPnlUsd / SIM_INITIAL_CAPITAL_USD) * 100).toFixed(2))
      : 0;
  const totalFeesPaidUsd = Number(
    ([...active, ...closed].reduce((sum, trade) => sum + (trade.openFeeUsd ?? 0) + (trade.closeFeeUsd ?? 0), 0)).toFixed(2)
  );

  const settledDurations = closed
    .map((trade) => trade.timeToClose ?? 0)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const avgTradeDuration =
    settledDurations.length > 0
      ? Number((settledDurations.reduce((sum, value) => sum + value, 0) / settledDurations.length).toFixed(2))
      : 0;

  const startedAtMs = Date.parse(equityCurve[0]?.at ?? nowIso());
  const nowMs = Date.now();
  const elapsedDays = Math.max((nowMs - startedAtMs) / 86_400_000, 1 / 24);
  const tradesPerDay = Number((((active.length + closed.length) / elapsedDays)).toFixed(2));

  let peakBalance = equityCurve[0]?.balanceUsd ?? SIM_INITIAL_CAPITAL_USD;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    if (point.balanceUsd > peakBalance) {
      peakBalance = point.balanceUsd;
    }
    if (peakBalance > 0) {
      const dd = ((peakBalance - point.balanceUsd) / peakBalance) * 100;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
      }
    }
  }
  maxDrawdown = Number(maxDrawdown.toFixed(3));

  const directionStats = {
    long: { total: 0, wins: 0, losses: 0, winRate: 0 },
    short: { total: 0, wins: 0, losses: 0, winRate: 0 }
  };

  for (const trade of [...active, ...closed]) {
    const bucket = trade.direction === "LONG" ? directionStats.long : directionStats.short;
    bucket.total += 1;
    if (trade.status === "WIN") bucket.wins += 1;
    if (trade.status === "LOSS") bucket.losses += 1;
  }

  if (directionStats.long.wins + directionStats.long.losses > 0) {
    directionStats.long.winRate = Number(
      (
        (directionStats.long.wins / (directionStats.long.wins + directionStats.long.losses)) *
        100
      ).toFixed(2)
    );
  }

  if (directionStats.short.wins + directionStats.short.losses > 0) {
    directionStats.short.winRate = Number(
      (
        (directionStats.short.wins / (directionStats.short.wins + directionStats.short.losses)) *
        100
      ).toFixed(2)
    );
  }

  const tokenMap = new Map<string, { total: number; wins: number; losses: number; pnl: number }>();
  for (const trade of [...active, ...closed]) {
    const current = tokenMap.get(trade.token) ?? { total: 0, wins: 0, losses: 0, pnl: 0 };
    current.total += 1;
    if (trade.status === "WIN") current.wins += 1;
    if (trade.status === "LOSS") current.losses += 1;
    current.pnl += trade.result ?? 0;
    tokenMap.set(trade.token, current);
  }

  const byToken = Array.from(tokenMap.entries())
    .map(([token, item]) => {
      const settled = item.wins + item.losses;
      const winRate = settled > 0 ? Number(((item.wins / settled) * 100).toFixed(2)) : 0;
      return {
        token,
        total: item.total,
        wins: item.wins,
        losses: item.losses,
        winRate,
        pnl: Number(item.pnl.toFixed(2))
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 15);

  const closeReasonCounts = closed.reduce<Record<string, number>>((acc, trade) => {
    const reason = (trade.closeReason ?? "UNKNOWN").trim() || "UNKNOWN";
    acc[reason] = (acc[reason] ?? 0) + 1;
    return acc;
  }, {});
  const sentimentShiftClosedTrades = closeReasonCounts.SENTIMENT_SHIFT_OPPOSITE_SIGNAL ?? 0;

  return {
    totalTrades: active.length + closed.length,
    activeTrades: active.length,
    wins: wins.length,
    losses: losses.length,
    winRate: settledCount > 0 ? Number(((wins.length / settledCount) * 100).toFixed(2)) : 0,
    avgMinutesToWin,
    avgMinutesToLoss,
    avgTradeDuration,
    tradesPerDay,
    totalSimulatedPnl,
    totalSimulatedPnlUsd,
    totalPnlUsd,
    totalPnlPct,
    unrealizedPnlUsd,
    equityUsd,
    accountBalanceUsd,
    totalFeesPaidUsd,
    initialCapitalUsd: SIM_INITIAL_CAPITAL_USD,
    stakePerTradeUsd: Number(getPositionSizeUsd(accountBalanceUsd, active.length, STOP_LOSS_PCT, LEVERAGE, RISK_PER_TRADE).toFixed(2)),
    estimatedBalanceUsd: accountBalanceUsd,
    maxActiveTrades: getMaxActiveTrades(accountBalanceUsd),
    leverage: LEVERAGE,
    targetReturnPct: TAKE_PROFIT_PCT,
    stopReturnPct: -STOP_LOSS_PCT,
    equityCurve,
    maxDrawdown,
    longWinRate: directionStats.long.winRate,
    shortWinRate: directionStats.short.winRate,
    byDirection: directionStats,
    byToken,
    sentimentShiftClosedTrades,
    closeReasonCounts
  };
}

function buildSnapshot(): TradeSimulationSnapshot {
  const active = Array.from(openTrades.values()).sort((a, b) => Date.parse(b.openTime) - Date.parse(a.openTime));
  const recentClosed = [...closedTrades]
    .sort((a, b) => Date.parse(b.closeTime ?? b.openTime) - Date.parse(a.closeTime ?? a.openTime))
    .slice(0, 50);

  return {
    stats: computeStats(active, closedTrades),
    activeTrades: active,
    recentClosedTrades: recentClosed
  };
}

export async function processTradeSimulation(results: TokenRsiResult[]): Promise<TradeSimulationSnapshot> {
  await hydrateRuntimeStateFromStorage();
  reconcileAccountBalanceFromLedger();
  await ensureActiveTradingSession({
    startingBalanceUsd: SIM_INITIAL_CAPITAL_USD,
    currentBalanceUsd: accountBalanceUsd,
    leverage: LEVERAGE,
    takeProfitPct: TAKE_PROFIT_PCT,
    stopLossPct: STOP_LOSS_PCT,
    maxConcurrentTrades: getMaxActiveTrades(accountBalanceUsd)
  });
  await updateOpenTradesFromMarket(results);
  await openTradesFromSignals(results);

  persistRuntimeState();

  return buildSnapshot();
}

export async function refreshTradeSimulation(): Promise<TradeSimulationSnapshot> {
  await hydrateRuntimeStateFromStorage();
  reconcileAccountBalanceFromLedger();
  await ensureActiveTradingSession({
    startingBalanceUsd: SIM_INITIAL_CAPITAL_USD,
    currentBalanceUsd: accountBalanceUsd,
    leverage: LEVERAGE,
    takeProfitPct: TAKE_PROFIT_PCT,
    stopLossPct: STOP_LOSS_PCT,
    maxConcurrentTrades: getMaxActiveTrades(accountBalanceUsd)
  });
  await updateOpenTradesFromMarket();
  persistRuntimeState();
  return buildSnapshot();
}

export async function forceCloseOpenTradesBySymbol(
  symbol: string
): Promise<{ closedCount: number; snapshot: TradeSimulationSnapshot }> {
  await hydrateRuntimeStateFromStorage();
  await updateOpenTradesFromMarket();

  const normalized = symbol.trim().toUpperCase();
  if (!normalized) {
    const snapshot = buildSnapshot();
    return { closedCount: 0, snapshot };
  }

  const toClose = Array.from(openTrades.values()).filter(
    (trade) => trade.status === "OPEN" && trade.token.trim().toUpperCase() === normalized
  );

  const closeTime = nowIso();
  for (const trade of toClose) {
    await closeTradeAtMarket(trade, closeTime, "MANUAL_FORCE_CLOSE");
  }

  persistRuntimeState();
  const snapshot = buildSnapshot();
  return { closedCount: toClose.length, snapshot };
}

export async function forceReopenLastClosedTrade(
  symbol?: string
): Promise<{ reopened: boolean; reason?: string; reopenedTradeId?: string; snapshot: TradeSimulationSnapshot }> {
  await hydrateRuntimeStateFromStorage();
  await updateOpenTradesFromMarket();

  if (LIVE_TRADING_ENABLED) {
    return {
      reopened: false,
      reason: "Manual reopen is disabled while live trading is enabled",
      snapshot: buildSnapshot()
    };
  }

  const normalized = symbol?.trim().toUpperCase();
  const sortedClosed = [...closedTrades].sort(
    (a, b) => Date.parse(b.closeTime ?? b.openTime) - Date.parse(a.closeTime ?? a.openTime)
  );

  const sourceTrade = normalized
    ? sortedClosed.find((trade) => trade.token.trim().toUpperCase() === normalized)
    : sortedClosed[0];

  if (!sourceTrade) {
    return {
      reopened: false,
      reason: normalized ? `No closed trade found for ${normalized}` : "No closed trades found",
      snapshot: buildSnapshot()
    };
  }

  if (sourceTrade.status !== "WIN" && sourceTrade.status !== "LOSS") {
    return {
      reopened: false,
      reason: "Source trade is not closed",
      snapshot: buildSnapshot()
    };
  }

  const key = getTradeKey(sourceTrade.token, sourceTrade.direction);
  if (openTrades.has(key)) {
    return {
      reopened: false,
      reason: `Trade already open for ${sourceTrade.token} ${sourceTrade.direction}`,
      snapshot: buildSnapshot()
    };
  }

  if (openTrades.size >= getMaxActiveTrades(accountBalanceUsd)) {
    return {
      reopened: false,
      reason: "Max active trades reached",
      snapshot: buildSnapshot()
    };
  }

  const positionSizeUsd = Math.min(sourceTrade.stakeUsd, accountBalanceUsd);
  const openFeeUsd = Number((positionSizeUsd * TRADING_FEE_RATE).toFixed(2));
  if (!Number.isFinite(positionSizeUsd) || positionSizeUsd <= 0 || accountBalanceUsd - openFeeUsd <= 0) {
    return {
      reopened: false,
      reason: "Insufficient balance to reopen trade",
      snapshot: buildSnapshot()
    };
  }

  let currentPrice = Number(sourceTrade.currentPrice ?? sourceTrade.entryPrice);
  try {
    const ohlc = await fetchLatestOhlc(sourceTrade.token, "15m");
    if (ohlc && Number.isFinite(ohlc.close) && ohlc.close > 0) {
      currentPrice = Number(ohlc.close);
    }
  } catch {
    // Keep fallback price from the source trade when live fetch is unavailable.
  }

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return {
      reopened: false,
      reason: "Unable to resolve a valid entry price",
      snapshot: buildSnapshot()
    };
  }

  const now = nowIso();
  const levels = getTradeLevels(currentPrice, sourceTrade.direction, sourceTrade.token, sourceTrade.atr);

  const reopenedTrade: Trade = {
    ...sourceTrade,
    id: `${sourceTrade.token}-${sourceTrade.direction}-${Date.now()}-MANUAL_REOPEN`,
    status: "OPEN",
    openTime: now,
    closeTime: undefined,
    closeReason: undefined,
    closeContextJson: undefined,
    result: undefined,
    resultUsd: undefined,
    closeFeeUsd: undefined,
    timeToClose: undefined,
    openFeeUsd,
    stakeUsd: Number(positionSizeUsd.toFixed(2)),
    entryPrice: currentPrice,
    effectiveEntryPrice: currentPrice,
    currentPrice,
    tpPrice: levels.tpPrice,
    slPrice: levels.slPrice,
    takeProfitPct: levels.takeProfitPct,
    stopLossPct: levels.stopLossPct,
    tpDistance: Math.abs(levels.tpPrice - currentPrice),
    slDistance: Math.abs(levels.slPrice - currentPrice),
    currentPnlPct: 0,
    currentPnlUsd: 0,
    positionValueUsd: Number((positionSizeUsd * sourceTrade.leverage).toFixed(2)),
    distanceToTP: Number(
      (
        sourceTrade.direction === "LONG"
          ? ((levels.tpPrice - currentPrice) / currentPrice) * 100
          : ((currentPrice - levels.tpPrice) / currentPrice) * 100
      ).toFixed(3)
    ),
    distanceToSL: Number(
      (
        sourceTrade.direction === "LONG"
          ? ((currentPrice - levels.slPrice) / currentPrice) * 100
          : ((levels.slPrice - currentPrice) / currentPrice) * 100
      ).toFixed(3)
    ),
    maxDrawdown: 0
  };

  accountBalanceUsd = Number((accountBalanceUsd - openFeeUsd).toFixed(2));
  openTrades.set(key, reopenedTrade);
  lastOpenedByKey.set(key, Date.now());

  void appendSessionTradeOpened({
    externalTradeId: reopenedTrade.id,
    symbol: reopenedTrade.token,
    direction: reopenedTrade.direction,
    signalType: reopenedTrade.signalType,
    entryScore: reopenedTrade.entryScore,
    weightedScore: reopenedTrade.entryScore,
    takeProfitPct: reopenedTrade.takeProfitPct,
    stopLossPct: reopenedTrade.stopLossPct,
    stakeUsd: reopenedTrade.stakeUsd,
    entryPrice: reopenedTrade.entryPrice,
    tpPrice: reopenedTrade.tpPrice,
    slPrice: reopenedTrade.slPrice,
    leverage: reopenedTrade.leverage,
    openedAt: reopenedTrade.openTime
  }).catch((error) => {
    console.error("[trade-engine] Failed to persist manually reopened session trade", {
      tradeId: reopenedTrade.id,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  sendTradeLifecycleTelegram({
    stage: "OPENED",
    symbol: reopenedTrade.token,
    direction: reopenedTrade.direction,
    entryTiming: reopenedTrade.entryTiming ?? "MID",
    reversalPhase: reopenedTrade.reversalPhase ?? "UNRESOLVED",
    signalType: reopenedTrade.signalType,
    entryScore: reopenedTrade.entryScore,
    weightedScore: reopenedTrade.entryScore,
    signalStrength: 0,
    tpFeasibility: 1,
    structureConfidence: 0,
    volatilityPct: reopenedTrade.volatilityPct,
    takeProfitPct: reopenedTrade.takeProfitPct,
    stopLossPct: reopenedTrade.stopLossPct,
    marketCondition: reopenedTrade.marketCondition,
    entryPrice: reopenedTrade.entryPrice,
    tpPrice: reopenedTrade.tpPrice,
    slPrice: reopenedTrade.slPrice,
    asOf: reopenedTrade.openTime,
    dedupeKey: `MANUAL_REOPEN:${reopenedTrade.id}`
  }, Boolean(reopenedTrade.isLiveTrade));

  persistRuntimeState();
  return {
    reopened: true,
    reopenedTradeId: reopenedTrade.id,
    snapshot: buildSnapshot()
  };
}

export async function forceRemoveClosedTrade(
  input: { id?: string; symbol?: string }
): Promise<{ removed: boolean; reason?: string; removedTradeId?: string; snapshot: TradeSimulationSnapshot }> {
  await hydrateRuntimeStateFromStorage();
  reconcileAccountBalanceFromLedger();

  const normalizedId = input.id?.trim();
  const normalizedSymbol = input.symbol?.trim().toUpperCase();

  let targetIndex = -1;
  if (normalizedId) {
    targetIndex = closedTrades.findIndex((trade) => trade.id === normalizedId);
  } else if (normalizedSymbol) {
    targetIndex = closedTrades
      .map((trade, index) => ({ trade, index }))
      .filter(({ trade }) => trade.token.trim().toUpperCase() === normalizedSymbol)
      .sort((a, b) => Date.parse(b.trade.closeTime ?? b.trade.openTime) - Date.parse(a.trade.closeTime ?? a.trade.openTime))[0]?.index ?? -1;
  }

  if (targetIndex < 0) {
    return {
      removed: false,
      reason: normalizedId
        ? `Closed trade not found for id ${normalizedId}`
        : normalizedSymbol
          ? `Closed trade not found for symbol ${normalizedSymbol}`
          : "Provide id or symbol",
      snapshot: buildSnapshot()
    };
  }

  const [removedTrade] = closedTrades.splice(targetIndex, 1);
  reconcileAccountBalanceFromLedger();
  persistRuntimeState();

  return {
    removed: true,
    removedTradeId: removedTrade.id,
    snapshot: buildSnapshot()
  };
}

export async function forceResetTradingRuntime(): Promise<TradeSimulationSnapshot> {
  hydratedFromStorage = true;
  openTrades.clear();
  closedTrades.length = 0;
  lastOpenedByKey.clear();

  accountBalanceUsd = Number(SIM_INITIAL_CAPITAL_USD.toFixed(2));
  dailyStartBalanceUsd = accountBalanceUsd;
  dailyStartKeyUtc = new Date().toISOString().slice(0, 10);
  lossStreakCount = 0;
  cooldownUntilMs = 0;
  rollingCircuitUntilMs = 0;
  killSwitchActivated = false;

  equityCurve.length = 0;
  equityCurve.push({ at: nowIso(), balanceUsd: accountBalanceUsd });

  persistRuntimeState();
  return buildSnapshot();
}

export async function forceClearCooldown(): Promise<TradeSimulationSnapshot> {
  await hydrateRuntimeStateFromStorage();
  cooldownUntilMs = 0;
  persistRuntimeState();
  return buildSnapshot();
}

export async function forceOpenManualTrade(input: {
  symbol: string;
  direction: TradeDirection;
  signalType?: string;
  entryPrice?: number;
}): Promise<{ opened: boolean; reason?: string; tradeId?: string; snapshot: TradeSimulationSnapshot }> {
  await hydrateRuntimeStateFromStorage();
  reconcileAccountBalanceFromLedger();

  if (LIVE_TRADING_ENABLED && MARKET_DATA_PROVIDER !== "BITUNIX") {
    return {
      opened: false,
      reason: `Live trading requires Bitunix provider, current provider is ${MARKET_DATA_PROVIDER}`,
      snapshot: buildSnapshot()
    };
  }

  const symbol = normalizePerpSymbol(input.symbol);
  const direction = input.direction;
  if (!symbol) {
    return { opened: false, reason: "Symbol is required", snapshot: buildSnapshot() };
  }

  if (openTrades.has(getTradeKey(symbol, direction))) {
    return { opened: false, reason: `Trade already open for ${symbol} ${direction}`, snapshot: buildSnapshot() };
  }

  if (openTrades.size >= getMaxActiveTrades(accountBalanceUsd)) {
    return { opened: false, reason: "Max active trades reached", snapshot: buildSnapshot() };
  }

  let entryPrice = Number(input.entryPrice ?? Number.NaN);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    const ohlc = await fetchLatestOhlc(symbol, "15m");
    if (!ohlc || !Number.isFinite(ohlc.close) || ohlc.close <= 0) {
      return { opened: false, reason: `No valid price available for ${symbol}`, snapshot: buildSnapshot() };
    }
    entryPrice = Number(ohlc.close);
  }

  entryPrice = Number(entryPrice.toFixed(6));
  const levels = getTradeLevels(entryPrice, direction, symbol, 0);
  const leverageForTrade = getLeverageForSymbol(symbol);
  const riskPerTrade = getRiskPerTradeForSymbol(symbol);
  const stakeUsd = getPositionSizeUsd(accountBalanceUsd, openTrades.size, levels.stopLossPct, leverageForTrade, riskPerTrade);
  const openFeeUsd = Number((stakeUsd * TRADING_FEE_RATE).toFixed(2));
  if (!Number.isFinite(stakeUsd) || stakeUsd <= 0 || accountBalanceUsd - openFeeUsd <= 0) {
    return { opened: false, reason: "Insufficient balance", snapshot: buildSnapshot() };
  }

  const now = nowIso();
  const isLarge = isLargeCap(symbol);
  const dryRunDecision = await runBitunixDryRunTradePlan({
    source: "MANUAL_OPEN",
    symbol,
    direction,
    entryPrice,
    tpPrice: levels.tpPrice,
    slPrice: levels.slPrice,
    leverage: leverageForTrade,
    stakeUsd
  });
  if (dryRunDecision.blocked) {
    return {
      opened: false,
      reason: dryRunDecision.reason ?? "dry-run leverage verification failed",
      snapshot: buildSnapshot()
    };
  }

  const trade: Trade = {
    id: `${symbol}-${direction}-${Date.now()}-MANUAL_OPEN`,
    token: symbol,
    direction,
    signalType: input.signalType ?? `MANUAL ${direction}`,
    signalCategory: "SCORE_BASED",
    entryType: "SCORE_BASED",
    entryScore: SCORE_ENTRY_THRESHOLD,
    riskPctUsed: Number((riskPerTrade * 100).toFixed(2)),
    volatilityPct: 0,
    volume24h: 0,
    passedVolatility: true,
    passedLiquidity: true,
    assetType: isLarge ? "LARGE_CAP" : "ALT",
    marketCondition: "TRENDING",
    regime: "TRENDING",
    cluster: getCluster(symbol),
    stakeUsd: Number(stakeUsd.toFixed(2)),
    takeProfitPct: levels.takeProfitPct,
    stopLossPct: levels.stopLossPct,
    atr: 0,
    tpDistance: Math.abs(levels.tpPrice - entryPrice),
    slDistance: Math.abs(levels.slPrice - entryPrice),
    expectedValue: 0,
    slippageEstimate: 0,
    entryPrice,
    effectiveEntryPrice: entryPrice,
    currentPrice: entryPrice,
    tpPrice: levels.tpPrice,
    slPrice: levels.slPrice,
    leverage: leverageForTrade,
    status: "OPEN",
    openTime: now,
    openFeeUsd,
    currentPnlPct: 0,
    currentPnlUsd: 0,
    positionValueUsd: Number((stakeUsd * leverageForTrade).toFixed(2)),
    distanceToTP: Number(
      (
        direction === "LONG"
          ? ((levels.tpPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - levels.tpPrice) / entryPrice) * 100
      ).toFixed(3)
    ),
    distanceToSL: Number(
      (
        direction === "LONG"
          ? ((entryPrice - levels.slPrice) / entryPrice) * 100
          : ((levels.slPrice - entryPrice) / entryPrice) * 100
      ).toFixed(3)
    ),
    maxDrawdown: 0
  };

  if (isBitunixLiveTradingMode()) {
    try {
      const liveOrder = await executeLiveOpenOrder({
        symbol,
        direction,
        leverage: leverageForTrade,
        entryPrice,
        stakeUsd,
        localTradeId: trade.id
      });
      trade.isLiveTrade = true;
      trade.liveOrderId = liveOrder.orderId;
      trade.liveClientId = liveOrder.clientId;
      trade.livePositionId = liveOrder.positionId;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      alertLiveExecutionFailure({
        symbol,
        direction,
        phase: "OPEN",
        reason,
        signalType: trade.signalType,
        entryPrice,
        tpPrice: levels.tpPrice,
        slPrice: levels.slPrice
      });
      return {
        opened: false,
        reason: `Live open failed: ${reason}`,
        snapshot: buildSnapshot()
      };
    }
  }

  accountBalanceUsd = Number((accountBalanceUsd - openFeeUsd).toFixed(2));
  const key = getTradeKey(symbol, direction);
  openTrades.set(key, trade);
  lastOpenedByKey.set(key, Date.now());

  void appendSessionTradeOpened({
    externalTradeId: trade.id,
    symbol: trade.token,
    direction: trade.direction,
    signalType: trade.signalType,
    entryScore: trade.entryScore,
    weightedScore: trade.entryScore,
    takeProfitPct: trade.takeProfitPct,
    stopLossPct: trade.stopLossPct,
    stakeUsd: trade.stakeUsd,
    entryPrice: trade.entryPrice,
    tpPrice: trade.tpPrice,
    slPrice: trade.slPrice,
    leverage: trade.leverage,
    openedAt: trade.openTime
  }).catch((error) => {
    console.error("[trade-engine] Failed to persist manually opened session trade", {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  sendTradeLifecycleTelegram({
    stage: "OPENED",
    symbol: trade.token,
    direction: trade.direction,
    entryTiming: "MID",
    reversalPhase: "UNRESOLVED",
    signalType: trade.signalType,
    entryScore: trade.entryScore,
    weightedScore: trade.entryScore,
    signalStrength: 0,
    tpFeasibility: 1,
    structureConfidence: 0,
    volatilityPct: trade.volatilityPct,
    takeProfitPct: trade.takeProfitPct,
    stopLossPct: trade.stopLossPct,
    marketCondition: trade.marketCondition,
    entryPrice: trade.entryPrice,
    tpPrice: trade.tpPrice,
    slPrice: trade.slPrice,
    asOf: trade.openTime,
    dedupeKey: `MANUAL_OPEN:${trade.id}`
  }, Boolean(trade.isLiveTrade));

  persistRuntimeState();
  return {
    opened: true,
    tradeId: trade.id,
    snapshot: buildSnapshot()
  };
}

export async function forceSimulatePrePumpWatchTrades(
  results: TokenRsiResult[],
  options?: { maxTokens?: number }
): Promise<{
  attempted: number;
  openedCount: number;
  openedSymbols: string[];
  skipped: Array<{ symbol: string; reason: string }>;
  snapshot: TradeSimulationSnapshot;
}> {
  await hydrateRuntimeStateFromStorage();
  reconcileAccountBalanceFromLedger();

  const maxTokens = Math.max(1, Math.min(25, Math.trunc(options?.maxTokens ?? 5)));
  const candidates = results
    .map((row) => {
      const volume24h = Number(row.tradeContext?.volume24h ?? row.volume24h ?? 0);
      const minVolumeUsd = getMinVolumeUsdForSymbol(row.symbol);
      const evaluation = evaluatePrePumpWatch(row, volume24h, minVolumeUsd);
      return {
        row,
        eligible: evaluation.eligible
      };
    })
    .filter((item) => item.eligible)
    .sort((left, right) => right.row.confluence.score - left.row.confluence.score)
    .slice(0, maxTokens);

  const openedSymbols: string[] = [];
  const skipped: Array<{ symbol: string; reason: string }> = [];

  for (const candidate of candidates) {
    const symbol = normalizePerpSymbol(candidate.row.symbol);
    if (openTrades.has(getTradeKey(symbol, "LONG"))) {
      skipped.push({ symbol, reason: "Trade already open for LONG" });
      continue;
    }

    if (openTrades.size >= getMaxActiveTrades(accountBalanceUsd)) {
      skipped.push({ symbol, reason: "Max active trades reached" });
      continue;
    }

    const result = await forceOpenManualTrade({
      symbol,
      direction: "LONG",
      signalType: "PRE_PUMP_WATCH_LONG",
      entryPrice: candidate.row.close
    });

    if (result.opened) {
      openedSymbols.push(symbol);
    } else {
      skipped.push({ symbol, reason: result.reason ?? "Manual open failed" });
    }
  }

  return {
    attempted: candidates.length,
    openedCount: openedSymbols.length,
    openedSymbols,
    skipped,
    snapshot: buildSnapshot()
  };
}

export async function detectPrePumpWatchCandidates(
  results: TokenRsiResult[],
  options?: { maxTokens?: number }
): Promise<{
  scanned: number;
  eligibleCount: number;
  candidates: Array<{
    symbol: string;
    score: number;
    close: number;
    volume24h: number;
    status: TokenRsiResult["status"];
    signalType: TokenRsiResult["signal"]["type"];
    entryTiming: TokenRsiResult["entryTiming"];
    volatilityPercentile: number;
    liquidityPercentile: number;
    intermediaryRsi: number;
    emaSlope: number;
    stochDelta: number;
    details?: Record<string, unknown>;
  }>;
  rejectionSummary: Array<{ reason: string; count: number }>;
  nearMisses: Array<{
    symbol: string;
    score: number;
    reason: string;
    details?: Record<string, unknown>;
    volume24h: number;
    signalType: TokenRsiResult["signal"]["type"];
    volatilityPercentile: number;
    intermediaryRsi: number;
  }>;
}> {
  const maxTokens = Math.max(1, Math.min(50, Math.trunc(options?.maxTokens ?? 15)));

  const evaluated = results.map((row) => {
    const volume24h = Number(row.tradeContext?.volume24h ?? row.volume24h ?? 0);
    const minVolumeUsd = getMinVolumeUsdForSymbol(row.symbol);
    const evaluation = evaluatePrePumpWatch(row, volume24h, minVolumeUsd);
    return {
      row,
      volume24h,
      evaluation
    };
  });

  const candidates = evaluated
    .filter((item) => item.evaluation.eligible)
    .sort((left, right) => right.row.confluence.score - left.row.confluence.score)
    .slice(0, maxTokens)
    .map((item) => ({
      symbol: normalizePerpSymbol(item.row.symbol),
      score: item.row.confluence.score,
      close: item.row.close,
      volume24h: item.volume24h,
      status: item.row.status,
      signalType: item.row.signal.type,
      entryTiming: item.row.entryTiming,
      volatilityPercentile: Number(item.row.tradeContext?.volatilityPercentile ?? 0),
      liquidityPercentile: Number(item.row.tradeContext?.liquidityPercentile ?? 0),
      intermediaryRsi: Number(item.row.timeframes.intermediary.rsi ?? 0),
      emaSlope: Number(item.row.tradeContext?.emaSlope ?? 0),
      stochDelta: Number(
        (
          Number(item.row.timeframes.intermediary.stochK ?? 0) -
          Number(item.row.timeframes.intermediary.prevStochK ?? 0)
        ).toFixed(4)
      ),
      details: item.evaluation.details
    }));

  const rejectionCounts = new Map<string, number>();
  for (const item of evaluated) {
    if (item.evaluation.eligible) {
      continue;
    }
    const reason = item.evaluation.reason ?? "rejected";
    rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
  }

  const rejectionSummary = Array.from(rejectionCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count);

  const nearMisses = evaluated
    .filter((item) => !item.evaluation.eligible)
    .sort((left, right) => right.row.confluence.score - left.row.confluence.score)
    .slice(0, Math.min(10, maxTokens))
    .map((item) => ({
      symbol: normalizePerpSymbol(item.row.symbol),
      score: item.row.confluence.score,
      reason: item.evaluation.reason ?? "rejected",
      details: item.evaluation.details,
      volume24h: item.volume24h,
      signalType: item.row.signal.type,
      volatilityPercentile: Number(item.row.tradeContext?.volatilityPercentile ?? 0),
      intermediaryRsi: Number(item.row.timeframes.intermediary.rsi ?? 0)
    }));

  return {
    scanned: results.length,
    eligibleCount: candidates.length,
    candidates,
    rejectionSummary,
    nearMisses
  };
}

export async function updateLiveMarkPrices(): Promise<void> {
  await hydrateRuntimeStateFromStorage();

  const openTradeList = Array.from(openTrades.values()).filter((t) => t.status === "OPEN");
  if (openTradeList.length === 0) {
    return;
  }

  try {
    const symbols = openTradeList.map((t) => t.token);
    const perpContexts = await fetchPerpContexts(symbols);

    for (const trade of openTradeList) {
      const ctx = perpContexts.get(trade.token);
      if (!ctx || !ctx.markPrice || ctx.markPrice <= 0) {
        continue;
      }

      trade.currentPrice = ctx.markPrice;
      const live = computeLivePnlMetrics(trade);
      trade.currentPnlPct = live.currentPnlPct;
      trade.currentPnlUsd = live.currentPnlUsd;
      trade.positionValueUsd = live.positionValueUsd;
      trade.distanceToTP = live.distanceToTP;
      trade.distanceToSL = live.distanceToSL;
      enrichTradeWithProductionRead(trade, ctx);
    }

    persistRuntimeState();
  } catch (error) {
    console.error("[trade-engine] Failed to update live mark prices:", error);
  }
}

export function getTradeSimulationSnapshot(): TradeSimulationSnapshot {
  return buildSnapshot();
}
