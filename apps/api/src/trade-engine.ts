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
import {
  generateMomentumSignal,
  isValidSignal,
  type SimpleMomentumSignal
} from "./simple-momentum-engine.js";
import { loadAllTradeRuntimeStates, persistTradeRuntimeState } from "./simulation-store.js";
import { notifyTelegramEntry } from "./telegram-service.js";
import { isLiveTradingEnabled } from "./live-trading-switch.js";
import { isManualPositionWatched } from "./live-manual-position-watch.js";
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
import { assessCoilingForSymbol, type CoilingAssessment } from "./pre-pump-scan.js";
import {
  appendSessionOpportunity,
  appendSessionTradeOpened,
  ensureActiveTradingSession,
  hasRecentSessionOpportunity,
  markSessionTradeClosed,
  updateActiveSessionBalance
} from "./trading-session-prisma.js";
import {
  bindLiveOrderToLocalTrade,
  listUnlinkedOpenLiveOrders,
  recordLiveOrderAck,
  recordLiveOrderClosed,
  recordLiveOrderOpened
} from "./live-order-ledger-prisma.js";
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
  attachBitunixPositionTpSlDebug,
  cancelBitunixOpenOrder,
  changeBitunixLeverage,
  fetchBitunixClosedTradeHistory,
  fetchBitunixAccountSnapshot,
  getBitunixMarketWsPrice,
  fetchBitunixLeverageCheck,
  fetchBitunixPendingOpenOrders,
  fetchBitunixPendingPositions,
  fetchBitunixPendingTpslOrders,
  flashCloseBitunixPosition,
  placeBitunixLimitOrder,
  placeBitunixMarketOrder,
  type BitunixPendingPosition
} from "./bitunix-service.js";
import { recordDryRunExecutionPlan } from "./dry-run-execution.js";
import { evaluateAiDecision, getAiDecisionConfig } from "./ai-decision.js";

export type TradeDirection = "LONG" | "SHORT";
export type TradeStatus = "OPEN" | "WIN" | "LOSS";
export type TradeEntryType = "STRONG" | "CONTINUATION" | "REVERSAL" | "SCORE_BASED";
export type AssetType = "LARGE_CAP" | "ALT";
export type TradeStakeSource =
  | "RISK_BUDGET"
  | "SIM_FIXED_STAKE"
  | "SIM_BALANCE_DRIVEN"
  | "SIM_REOPEN_CAPPED"
  | "LIVE_EXCHANGE_POSITION";

export type Trade = {
  id: string;
  tenantId?: string;
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
  stakeSource?: TradeStakeSource;
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
  liveTradingEnabled: boolean;
  liveBotAutoCloseEnabled: boolean;
  testOpenMode: boolean;
  fixedStakeEnabled: boolean;
  simSignalOnlyMode: boolean;
  simBalanceDrivenSizingEnabled: boolean;
  risk: {
    minRiskReward: number;
    earlyReversalMinRiskReward: number;
    earlyDrawdownExitPct: number;
    minExpectedValuePct: number;
    maxSlippagePct: number;
    maxSlippagePctSmallCap: number;
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
    minStopLiquidityPoolUsd: number;
    minStopLiquidityPoolUsdByBucket: {
      large: number;
      major: number;
      small: number;
    };
    minBreakPct: number;
    leverage: number;
    takeProfitPct: number;
    stopLossPct: number;
  };
};

function logRejection(entry: Omit<TradeRejectionEntry, "rejectedAt">): void {
  const rejectedAt = new Date().toISOString();
  const reason = String(entry.reason ?? "rejected").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "rejected";
  const details = entry.details ?? {};
  const value = extractRejectionMetric(details, [
    "score",
    "confluenceScore",
    "volatilityPct",
    "volume24h",
    "huntScore",
    "distanceToLevelPct",
    "slippagePct",
    "spreadPct",
    "totalStopLiquidityPoolUsd"
  ]);
  const threshold = extractRejectionMetric(details, [
    "threshold",
    "requiredScore",
    "minScoreThreshold",
    "minVolatilityPct",
    "minVolumeUsd",
    "minConfidencePct",
    "entryDistancePct",
    "maxSlippagePct",
    "maxSpreadPct",
    "minStopLiquidityPoolUsd"
  ]);
  const nearMiss = isNearMiss(value, threshold);
  const structuredDetails: Record<string, unknown> = {
    ...details,
    timestamp: rejectedAt,
    rejectionReason: reason,
    value,
    threshold,
    nearMiss
  };

  appendTradeRejection({
    ...entry,
    reason,
    details: structuredDetails
  });

  if (shouldLogRejectionToConsole(entry.symbol, reason)) {
    console.info("[trade-engine] trade rejection", {
      symbol: entry.symbol,
      timestamp: rejectedAt,
      rejectionReason: reason,
      value,
      threshold
    });
  }

  if (nearMiss) {
    if (shouldLogRejectionToConsole(entry.symbol, `near_miss_${reason}`)) {
      console.info("[trade-engine] near_miss", {
        type: "near_miss",
        symbol: entry.symbol,
        timestamp: rejectedAt,
        reason,
        value,
        threshold
      });
    }
  }
}

function shouldLogRejectionToConsole(symbol: string, reason: string): boolean {
  const nowMs = Date.now();
  const isRateLimitReason = reason.includes("request_too_frequently") || reason.includes("too_many_requests") || reason.includes("429");
  const key = `global:${reason}`;
  const dedupeMs = isRateLimitReason ? REJECTION_CONSOLE_LOG_DEDUPE_RATE_LIMIT_MS : REJECTION_CONSOLE_LOG_DEDUPE_MS;
  const lastLoggedAtMs = rejectionConsoleLoggedAtByKey.get(key) ?? 0;
  if (nowMs - lastLoggedAtMs < dedupeMs) {
    return false;
  }

  rejectionConsoleLoggedAtByKey.set(key, nowMs);
  return true;
}

function extractRejectionMetric(details: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = details[key];
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function isNearMiss(value: number | null, threshold: number | null): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) {
    return false;
  }

  const absThreshold = Math.abs(Number(threshold));
  if (absThreshold <= 0) {
    return false;
  }

  return Math.abs(Number(value) - Number(threshold)) <= absThreshold * 0.1;
}

function logLiquidityHuntMiss(
  row: TokenRsiResult,
  reason: string,
  details: Record<string, unknown>,
  direction?: TradeDirection | null
): void {
  logRejection({
    symbol: normalizePerpSymbol(row.symbol),
    signal: row.signal.type,
    score: row.confluence.score,
    direction: direction ?? undefined,
    reason,
    details
  });
}

async function computeLiveVolatilityFromBitunix(symbol: string): Promise<number> {
  try {
    // Fetch latest 1h candle to get real-time volatility indicator
    const ohlc = await fetchLatestOhlc(symbol, "1h");
    if (!ohlc || !Number.isFinite(ohlc.high) || !Number.isFinite(ohlc.low) || ohlc.low <= 0) {
      return 0;
    }

    // Use 1h range as the live volatility metric
    // This reflects actual market movement in the recent hour
    const hourlyRangePct = Number((((ohlc.high - ohlc.low) / ohlc.low) * 100).toFixed(3));
    return hourlyRangePct;
  } catch {
    return 0;
  }
}

function evaluateLiquidityHuntExpectedMove(
  row: TokenRsiResult,
  direction: TradeDirection,
  entryPrice: number,
  targetLevel: number,
  liveVolatilityPct?: number
): {
  allow: boolean;
  details: Record<string, unknown>;
} {
  const atr1h = Number(row.tradeContext?.atr1h ?? row.tradeContext?.atr ?? 0);
  const atr4h = Number(row.tradeContext?.atr4h ?? 0);
  const historicalVolatilityPct = Number(row.tradeContext?.volatilityPct ?? row.volatilityPct ?? 0);
  const lookbackHours = LIQUIDITY_HUNT_EXPECTED_MOVE_LOOKBACK_HOURS;

  // Use live volatility if available and valid, else fall back to historical model
  const hasLiveVol = liveVolatilityPct !== undefined && Number.isFinite(liveVolatilityPct) && liveVolatilityPct > 0;
  const effectiveVolatilityPct = hasLiveVol ? liveVolatilityPct : historicalVolatilityPct;

  const realizedMovePct = Number.isFinite(effectiveVolatilityPct) && effectiveVolatilityPct > 0
    ? effectiveVolatilityPct * Math.sqrt(Math.max(lookbackHours, 1))
    : 0;
  const atr1hMovePct = Number.isFinite(atr1h) && atr1h > 0 && entryPrice > 0
    ? (atr1h / entryPrice) * 100
    : 0;
  const atr1hCoveragePct = atr1hMovePct * Math.max(1, Math.min(lookbackHours, 6));
  const atr4hCoveragePct = Number.isFinite(atr4h) && atr4h > 0 && entryPrice > 0
    ? ((atr4h / entryPrice) * 100) * Math.max(1, lookbackHours / 4)
    : 0;
  const expectedMoveCapacityPct = Math.max(realizedMovePct, atr1hCoveragePct, atr4hCoveragePct);
  const requiredMovePct = entryPrice > 0 && Number.isFinite(targetLevel)
    ? Math.abs(((targetLevel - entryPrice) / entryPrice) * 100)
    : 0;
  const coverageRatio = requiredMovePct > 0 ? expectedMoveCapacityPct / requiredMovePct : 0;

  return {
    allow: coverageRatio >= LIQUIDITY_HUNT_EXPECTED_MOVE_MIN_COVERAGE_RATIO,
    details: {
      lookbackHours,
      historicalVolatilityPct: Number(historicalVolatilityPct.toFixed(3)),
      liveVolatilityPct: hasLiveVol ? Number((liveVolatilityPct as number).toFixed(3)) : null,
      effectiveVolatilityPct: Number(effectiveVolatilityPct.toFixed(3)),
      atr1h: Number(atr1h.toFixed(6)),
      atr4h: Number(atr4h.toFixed(6)),
      realizedMovePct: Number(realizedMovePct.toFixed(3)),
      atr1hCoveragePct: Number(atr1hCoveragePct.toFixed(3)),
      atr4hCoveragePct: Number(atr4hCoveragePct.toFixed(3)),
      expectedMoveCapacityPct: Number(expectedMoveCapacityPct.toFixed(3)),
      requiredMovePct: Number(requiredMovePct.toFixed(3)),
      minCoverageRatio: LIQUIDITY_HUNT_EXPECTED_MOVE_MIN_COVERAGE_RATIO,
      coverageRatio: Number(coverageRatio.toFixed(3)),
      direction,
      targetLevel: Number(targetLevel.toFixed(6))
    }
  };
}

export function getTradeRejectionLog(): TradeRejectionEntry[] {
  return readTradeRejectionLog();
}

export function clearTradeRejections(): void {
  resetTradeRejectionLog();
}

export function getTradeEngineProfile(): TradeEngineProfile {
  return {
    liveTradingEnabled: isLiveTradingEnabled(),
    liveBotAutoCloseEnabled: LIVE_BOT_AUTO_CLOSE_ENABLED,
    testOpenMode: TEST_OPEN_MODE,
    fixedStakeEnabled: FIXED_STAKE_ENABLED,
    simSignalOnlyMode: SIM_SIGNAL_ONLY_MODE,
    simBalanceDrivenSizingEnabled: SIM_BALANCE_DRIVEN_SIZING_ENABLED,
    risk: {
      minRiskReward: MIN_RISK_REWARD,
      earlyReversalMinRiskReward: EARLY_REVERSAL_MIN_RR,
      earlyDrawdownExitPct: EARLY_DRAWDOWN_EXIT_PCT,
      minExpectedValuePct: EXPECTED_VALUE_MIN,
      maxSlippagePct: MAX_SLIPPAGE_PCT,
      maxSlippagePctSmallCap: MAX_SLIPPAGE_PCT_SMALL_CAP,
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
      minStopLiquidityPoolUsd: LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD_LARGE,
      minStopLiquidityPoolUsdByBucket: {
        large: LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD_LARGE,
        major: LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD_MAJOR_ALT,
        small: LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD_SMALL
      },
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
const SIM_INITIAL_CAPITAL_USD = resolveNumberEnv("SIM_INITIAL_CAPITAL_USD", 350);
const RISK_PER_TRADE = Math.max(0.001, Math.min(0.05, resolveNumberEnv("RISK_PER_TRADE", 0.01)));
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
const SCORE_ENTRY_THRESHOLD = resolveNumberEnv("SCORE_ENTRY_THRESHOLD", 4);
const BTC_SCORE_ENTRY_THRESHOLD = resolveNumberEnv("BTC_SCORE_ENTRY_THRESHOLD", 4);
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
const MIN_VOLATILITY_PCT = resolveNumberEnv("MIN_VOLATILITY_PCT", 1.2);
const MIN_VOLUME_USD = resolveNumberEnv("MIN_VOLUME_USD", 7_000_000);
const MIN_VOLUME_USD_MAJOR_ALT = resolveNumberEnv("MIN_VOLUME_USD_MAJOR_ALT", 4_000_000);
const MIN_VOLUME_USD_SMALL_CAP = resolveNumberEnv("MIN_VOLUME_USD_SMALL_CAP", 1_500_000);
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
const SYMBOL_REENTRY_COOLDOWN_MS = Math.max(0, Math.trunc(resolveNumberEnv("SYMBOL_REENTRY_COOLDOWN_MINUTES", 60))) * 60 * 1000;
const MAX_CLOSED_TRADES = 500;
const MAX_EQUITY_POINTS = 1000;
const GLOBAL_TRADE_THROTTLE_WINDOW_MINUTES = Math.max(
  1,
  Math.trunc(resolveNumberEnv("GLOBAL_TRADE_THROTTLE_WINDOW_MINUTES", 30))
);
const GLOBAL_TRADE_THROTTLE_WINDOW_MS = GLOBAL_TRADE_THROTTLE_WINDOW_MINUTES * 60 * 1000;
const MAX_TRADES_LAST_WINDOW = Math.max(0, Math.trunc(resolveNumberEnv("GLOBAL_TRADE_THROTTLE_MAX_TRADES", 5)));
const LOW_VOLATILITY_PCT_THRESHOLD = 1;
const LOW_VOLATILITY_TP_FEASIBILITY_MIN = 0.8;
const NORMAL_TP_FEASIBILITY_MIN = 0.6;
const EARLY_DRAWDOWN_EXIT_PCT = Math.min(-0.1, resolveNumberEnv("EARLY_DRAWDOWN_EXIT_PCT", -6));
const SESSION_BLOCK_START_UTC = Math.max(0, Math.min(23, Math.trunc(resolveNumberEnv("SESSION_BLOCK_START_UTC", 2))));
const SESSION_BLOCK_END_UTC = Math.max(0, Math.min(23, Math.trunc(resolveNumberEnv("SESSION_BLOCK_END_UTC", 5))));
const GLOBAL_KILL_SWITCH_DRAWDOWN_PCT = 0.15;
const MAX_ROLLING_PERFORMANCE_TRADES = 20;
const ORDERBOOK_MAX_SPREAD_PCT_LARGE = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_LARGE", 0.04));
const ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT", 0.1));
const ORDERBOOK_MAX_SPREAD_PCT_ALT = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_ALT", 0.1));
const ORDERBOOK_MIN_DEPTH_MULTIPLIER = Math.max(1, resolveNumberEnv("ORDERBOOK_MIN_DEPTH_MULTIPLIER", 1.5));
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
const MAX_SLIPPAGE_PCT = Math.max(0, resolveNumberEnv("MAX_SLIPPAGE_PCT", 0.35));
const MAX_SLIPPAGE_PCT_SMALL_CAP = Math.max(0, resolveNumberEnv("MAX_SLIPPAGE_PCT_SMALL_CAP", 0.5));
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
const PRE_PUMP_WATCH_REQUIRE_RECOVERY_TREND = String(process.env.PRE_PUMP_WATCH_REQUIRE_RECOVERY_TREND ?? "true").toLowerCase() !== "false";
const PRE_PUMP_WATCH_MIN_RESISTANCE_DISTANCE_PCT = Math.max(
  0,
  resolveNumberEnv("PRE_PUMP_WATCH_MIN_RESISTANCE_DISTANCE_PCT", 6)
);
const PRE_PUMP_WATCH_MAX_INTERMEDIARY_STOCH_K = Math.max(
  0,
  Math.min(100, resolveNumberEnv("PRE_PUMP_WATCH_MAX_INTERMEDIARY_STOCH_K", 75))
);
const LIQUIDITY_HUNT_ENTRY_ENABLED = String(process.env.LIQUIDITY_HUNT_ENTRY_ENABLED ?? "true").toLowerCase() !== "false";
const LIQUIDITY_HUNT_ENTRY_MODE = resolveEnumEnv<"FADE" | "BREAKOUT_FLIP">(
  "LIQUIDITY_HUNT_ENTRY_MODE",
  ["FADE", "BREAKOUT_FLIP"] as const,
  "FADE"
);
const LIQUIDITY_HUNT_ENTRY_LEVERAGE = Math.max(1, resolveNumberEnv("LIQUIDITY_HUNT_ENTRY_LEVERAGE", 5));
const LIQUIDITY_HUNT_ENTRY_TP_PCT = Math.max(0.1, resolveNumberEnv("LIQUIDITY_HUNT_ENTRY_TP_PCT", 20));
const LIQUIDITY_HUNT_ENTRY_SL_PCT = Math.max(0.1, resolveNumberEnv("LIQUIDITY_HUNT_ENTRY_SL_PCT", 7.5));
const LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT = Math.max(0.05, resolveNumberEnv("LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT", 2));
// Pre-pump coiling quality gate for entries (swing pre-pump). When enabled, a token
// can only open a trade if its daily candles qualify as a top-quality accumulation
// coil (passes dollar-liquidity + already-moved + extension disqualifiers and meets
// the minimum coiling score/tier). Excludes illiquid/penny tokens (e.g. FORT) and
// late/extended names.
const PRE_PUMP_COIL_ENTRY_ENABLED = String(process.env.PRE_PUMP_COIL_ENTRY_ENABLED ?? "true").toLowerCase() !== "false";
const PRE_PUMP_COIL_ENTRY_MIN_SCORE = Math.max(0, resolveNumberEnv("PRE_PUMP_COIL_ENTRY_MIN_SCORE", 45));
const PRE_PUMP_COIL_ENTRY_ALLOW_TIER3 = String(process.env.PRE_PUMP_COIL_ENTRY_ALLOW_TIER3 ?? "false").toLowerCase() === "true";
const PRE_PUMP_COIL_ENTRY_MIN_LIQUIDITY_USD = Math.max(0, resolveNumberEnv("PRE_PUMP_COIL_ENTRY_MIN_LIQUIDITY_USD", 1_000_000));
// Breakout-coil entry: open a qualified coil when it breaks out of its base (close
// clears the coil ceiling on a volume surge, not yet extended). This catches the
// pre-pump swing the moment it starts moving, instead of only buying oversold dips.
const PRE_PUMP_COIL_BREAKOUT_ENTRY_ENABLED = String(process.env.PRE_PUMP_COIL_BREAKOUT_ENTRY_ENABLED ?? "true").toLowerCase() !== "false";
const PRE_PUMP_COIL_BREAKOUT_BUFFER_PCT = Math.max(0, resolveNumberEnv("PRE_PUMP_COIL_BREAKOUT_BUFFER_PCT", 0.5));
const PRE_PUMP_COIL_BREAKOUT_MAX_CHASE_PCT = Math.max(0.5, resolveNumberEnv("PRE_PUMP_COIL_BREAKOUT_MAX_CHASE_PCT", 12));
const PRE_PUMP_COIL_BREAKOUT_MIN_VOL_SURGE = Math.max(1, resolveNumberEnv("PRE_PUMP_COIL_BREAKOUT_MIN_VOL_SURGE", 1.5));
const LIQUIDITY_HUNT_MIN_CONFIDENCE_PCT = Math.max(0, Math.min(100, resolveNumberEnv("LIQUIDITY_HUNT_MIN_CONFIDENCE_PCT", 28)));
const LIQUIDITY_HUNT_MIN_HUNT_SCORE = Math.max(
  0,
  Math.min(100, resolveNumberEnv("LIQUIDITY_HUNT_MIN_HUNT_SCORE", 25))
);
const LIQUIDITY_HUNT_ALLOW_CHOPPY_WITH_HIGH_CONFIDENCE =
  String(process.env.LIQUIDITY_HUNT_ALLOW_CHOPPY_WITH_HIGH_CONFIDENCE ?? "true").toLowerCase() !== "false";
const LIQUIDITY_HUNT_CHOPPY_MIN_HUNT_SCORE = Math.max(
  LIQUIDITY_HUNT_MIN_HUNT_SCORE,
  Math.min(100, resolveNumberEnv("LIQUIDITY_HUNT_CHOPPY_MIN_HUNT_SCORE", 30))
);
const LIQUIDITY_HUNT_MIN_TOKEN_MAX_LEVERAGE = Math.max(1, Math.trunc(resolveNumberEnv("LIQUIDITY_HUNT_MIN_TOKEN_MAX_LEVERAGE", 10)));
const LIQUIDITY_HUNT_PRE_SWEEP_ONLY = String(process.env.LIQUIDITY_HUNT_PRE_SWEEP_ONLY ?? "false").toLowerCase() !== "false";
const LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD_LARGE = Math.max(
  0,
  resolveNumberEnv("LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD_LARGE", 5_000)
);
const LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD_MAJOR_ALT = Math.max(
  0,
  resolveNumberEnv("LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD_MAJOR_ALT", 2_500)
);
const LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD_SMALL = Math.max(
  0,
  resolveNumberEnv("LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD_SMALL", 1_000)
);
const LIQUIDITY_HUNT_MIN_DIRECTIONAL_STOP_LIQUIDITY_MULTIPLIER = 1.5;
const LIQUIDITY_HUNT_MIN_BREAK_PCT = Math.max(0, resolveNumberEnv("LIQUIDITY_HUNT_MIN_BREAK_PCT", 0.5));
const LIQUIDITY_HUNT_EXPECTED_MOVE_GATE_ENABLED =
  String(process.env.LIQUIDITY_HUNT_EXPECTED_MOVE_GATE_ENABLED ?? "true").toLowerCase() !== "false";
const LIQUIDITY_HUNT_EXPECTED_MOVE_LOOKBACK_HOURS = Math.max(
  1,
  Math.trunc(resolveNumberEnv("LIQUIDITY_HUNT_EXPECTED_MOVE_LOOKBACK_HOURS", 4))
);
const LIQUIDITY_HUNT_EXPECTED_MOVE_MIN_COVERAGE_RATIO = Math.max(
  0.25,
  resolveNumberEnv("LIQUIDITY_HUNT_EXPECTED_MOVE_MIN_COVERAGE_RATIO", 1.5)
);
const LIQUIDITY_HUNT_MIN_LIVE_VOLATILITY_PCT = Math.max(
  0,
  resolveNumberEnv("LIQUIDITY_HUNT_MIN_LIVE_VOLATILITY_PCT", 1.0)
);
const LIQUIDITY_HUNT_MIN_24H_CHANGE_PCT = Math.max(
  0,
  resolveNumberEnv("LIQUIDITY_HUNT_MIN_24H_CHANGE_PCT", 5)
);
const LIQUIDITY_HUNT_MAX_24H_CHANGE_PCT = Math.max(
  LIQUIDITY_HUNT_MIN_24H_CHANGE_PCT,
  resolveNumberEnv("LIQUIDITY_HUNT_MAX_24H_CHANGE_PCT", 45)
);
const LIQUIDITY_HUNT_DYNAMIC_TP_BUFFER_PCT = Math.max(
  0,
  Math.min(3, resolveNumberEnv("LIQUIDITY_HUNT_DYNAMIC_TP_BUFFER_PCT", 0.2))
);
const LIQUIDITY_HUNT_TRAILING_STOP_ENABLED =
  String(process.env.LIQUIDITY_HUNT_TRAILING_STOP_ENABLED ?? "true").toLowerCase() !== "false";
const LIQUIDITY_HUNT_TRAILING_ACTIVATION_PNL_PCT = Math.max(
  0,
  resolveNumberEnv("LIQUIDITY_HUNT_TRAILING_ACTIVATION_PNL_PCT", 5)
);
const LIQUIDITY_HUNT_TRAILING_GAP_PNL_PCT = Math.max(
  0.2,
  resolveNumberEnv("LIQUIDITY_HUNT_TRAILING_GAP_PNL_PCT", 2)
);
const LIQUIDITY_HUNT_BREAK_EVEN_TRIGGER_PNL_PCT = Math.max(
  0,
  resolveNumberEnv("LIQUIDITY_HUNT_BREAK_EVEN_TRIGGER_PNL_PCT", 5)
);
const LIQUIDITY_HUNT_COST_BUFFER_PCT = Math.max(0, resolveNumberEnv("LIQUIDITY_HUNT_COST_BUFFER_PCT", 1.5));
const LIQUIDITY_HUNT_MIN_NET_TP_PCT = Math.max(0.1, resolveNumberEnv("LIQUIDITY_HUNT_MIN_NET_TP_PCT", 8));
const LIQUIDITY_HUNT_MIN_TP_SL_DISTANCE_RATIO = Math.max(
  1,
  resolveNumberEnv("LIQUIDITY_HUNT_MIN_TP_SL_DISTANCE_RATIO", 3)
);
const LIQUIDITY_HUNT_ONLY_MODE = String(process.env.LIQUIDITY_HUNT_ONLY_MODE ?? "true").toLowerCase() !== "false";
const LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE = resolveEnumEnv<"LIMIT" | "MARKET">(
  "LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE",
  ["LIMIT", "MARKET"] as const,
  "LIMIT"
);
const LIQUIDITY_HUNT_MM_FLOW_MIN_SCORE = Math.max(
  0,
  Math.min(100, resolveNumberEnv("LIQUIDITY_HUNT_MM_FLOW_MIN_SCORE", 70))
);
const LIQUIDITY_HUNT_HARD_MIN_VOLUME_USD = 1_500_000;
const LIQUIDITY_HUNT_MM_FLOW_ENTRY_DISTANCE_BOOST_MAX = Math.max(
  0,
  resolveNumberEnv("LIQUIDITY_HUNT_MM_FLOW_ENTRY_DISTANCE_BOOST_MAX", 1.5)
);
// How far before the sweep level to set the limit entry price (% of level).
// e.g. 1.0 → SHORT entry at level*1.01 (1% above support), LONG entry at level*0.99.
const LIQUIDITY_HUNT_PRE_SWEEP_OFFSET_PCT = Math.max(0, Math.min(5, resolveNumberEnv("LIQUIDITY_HUNT_PRE_SWEEP_OFFSET_PCT", 1.5)));
const LIQUIDITY_HUNT_PENDING_LIMIT_MAX_AGE_MINUTES = Math.max(
  1,
  Math.trunc(resolveNumberEnv("LIQUIDITY_HUNT_PENDING_LIMIT_MAX_AGE_MINUTES", 8))
);
const LIQUIDITY_HUNT_PRE_SWEEP_MARKET_FALLBACK_ENABLED =
  String(process.env.LIQUIDITY_HUNT_PRE_SWEEP_MARKET_FALLBACK_ENABLED ?? "true").toLowerCase() !== "false";
// Minimum hold time (minutes) before bot-local close guards apply to live hunt trades.
// During this window the exchange TP/SL handles the close entirely.
// Grace period after live-hunt entry during which bot-local close guards are muted.
// Prevents market-order fill spread from triggering an immediate -6% ROE early-drawdown close.
// After this window all bot protections (drawdown, sentiment shift, lifecycle) apply normally.
const LIQUIDITY_HUNT_LIVE_ENTRY_GRACE_MINUTES = Math.max(1, Math.trunc(resolveNumberEnv("LIQUIDITY_HUNT_LIVE_ENTRY_GRACE_MINUTES", 5)));
const PRE_PUMP_WATCH_MIN_EMA_SLOPE = resolveNumberEnv("PRE_PUMP_WATCH_MIN_EMA_SLOPE", 0);
const PRE_PUMP_WATCH_REQUIRE_STOCH_UP = String(process.env.PRE_PUMP_WATCH_REQUIRE_STOCH_UP ?? "true").toLowerCase() !== "false";
const PRE_PUMP_WATCH_COOLDOWN_MINUTES = Math.max(1, Math.trunc(resolveNumberEnv("PRE_PUMP_WATCH_COOLDOWN_MINUTES", 180)));
const HTF_MOMENTUM_ALIGNMENT_ENABLED = String(process.env.HTF_MOMENTUM_ALIGNMENT_ENABLED ?? "true").toLowerCase() !== "false";
const HTF_MOMENTUM_BLOCK_SCORE_MIN = Math.max(2, Math.trunc(resolveNumberEnv("HTF_MOMENTUM_BLOCK_SCORE_MIN", 3)));
const EARLY_REVERSAL_MIN_RR = Math.max(0.5, resolveNumberEnv("EARLY_REVERSAL_MIN_RR", 1.3));
const EARLY_REVERSAL_EV_TOLERANCE = Math.max(0, resolveNumberEnv("EARLY_REVERSAL_EV_TOLERANCE", 0));
const IGNORE_SLIPPAGE_GUARD = String(process.env.IGNORE_SLIPPAGE_GUARD ?? "false").toLowerCase() === "true";
const TEST_OPEN_MODE = String(process.env.TEST_OPEN_MODE ?? "false").toLowerCase() === "true";
const CAP_EARLY_DRAWDOWN_TO_SL = String(process.env.CAP_EARLY_DRAWDOWN_TO_SL ?? "true").toLowerCase() !== "false";
const SIM_SIGNAL_ONLY_MODE = String(process.env.SIM_SIGNAL_ONLY_MODE ?? "false").toLowerCase() !== "false";
const SIM_BALANCE_DRIVEN_SIZING_ENABLED = String(
  process.env.SIM_BALANCE_DRIVEN_SIZING_ENABLED ?? (SIM_SIGNAL_ONLY_MODE ? "true" : "false")
).toLowerCase() !== "false";
const SIM_LIVE_PARITY_MODE = String(process.env.SIM_LIVE_PARITY_MODE ?? "false").toLowerCase() !== "false";
const SIM_LIVE_PARITY_LIMIT_TIMEOUT_MINUTES = Math.max(
  1,
  Math.trunc(resolveNumberEnv("SIM_LIVE_PARITY_LIMIT_TIMEOUT_MINUTES", LIQUIDITY_HUNT_PENDING_LIMIT_MAX_AGE_MINUTES))
);
const SIM_LIVE_PARITY_ENTRY_SLIPPAGE_PCT = Math.max(
  0,
  resolveNumberEnv("SIM_LIVE_PARITY_ENTRY_SLIPPAGE_PCT", 0.04)
);
const SIGNAL_DIRECTION_MODE = resolveEnumEnv<"BOTH" | "LONG" | "SHORT">(
  "SIGNAL_DIRECTION_MODE",
  ["BOTH", "LONG", "SHORT"] as const,
  "BOTH"
);
const ENTRY_CANDLE_CONFIRMATION_ENABLED = String(process.env.ENTRY_CANDLE_CONFIRMATION_ENABLED ?? "true").toLowerCase() !== "false";
const ENTRY_CANDLE_CONFIRMATION_REQUIRE_DOMINANCE =
  String(process.env.ENTRY_CANDLE_CONFIRMATION_REQUIRE_DOMINANCE ?? "true").toLowerCase() !== "false";
const ENTRY_CANDLE_CONFIRMATION_SHORT_MIN_BEARISH_SCORE = Math.max(
  0,
  resolveNumberEnv("ENTRY_CANDLE_CONFIRMATION_SHORT_MIN_BEARISH_SCORE", 0.5)
);
const ENTRY_CANDLE_CONFIRMATION_LONG_MIN_BULLISH_SCORE = Math.max(
  0,
  resolveNumberEnv("ENTRY_CANDLE_CONFIRMATION_LONG_MIN_BULLISH_SCORE", 0.5)
);
const FIXED_STAKE_ENABLED = String(process.env.FIXED_STAKE_ENABLED ?? "true").toLowerCase() !== "false";
const AI_DECISION_CONFIG = getAiDecisionConfig();
const SIGNAL_SIM_STAKE_MAX_USD = Math.max(1, resolveNumberEnv("SIGNAL_SIM_STAKE_MAX_USD", 100));
const SIGNAL_SIM_BALANCE_BUFFER_USD = Math.max(0, resolveNumberEnv("SIGNAL_SIM_BALANCE_BUFFER_USD", 50));
const SIGNAL_SIM_STAKE_USD = Math.min(
  SIGNAL_SIM_STAKE_MAX_USD,
  Math.max(1, resolveNumberEnv("SIGNAL_SIM_STAKE_USD", SIGNAL_SIM_STAKE_MAX_USD))
);
const SIGNAL_SIM_MAX_ACTIVE_TRADES = Math.max(1, Math.trunc(resolveNumberEnv("SIGNAL_SIM_MAX_ACTIVE_TRADES", 3)));
const MAX_ACTIVE_TRADES_UNDER_1000 = Math.max(1, Math.trunc(resolveNumberEnv("MAX_ACTIVE_TRADES_UNDER_1000", 1)));
const MAX_ACTIVE_TRADES_AT_OR_ABOVE_1000 = Math.max(
  MAX_ACTIVE_TRADES_UNDER_1000,
  Math.trunc(resolveNumberEnv("MAX_ACTIVE_TRADES_AT_OR_ABOVE_1000", 3))
);
const LIVE_MULTI_TRADE_MIN_BALANCE_USD = Math.max(100, resolveNumberEnv("LIVE_MULTI_TRADE_MIN_BALANCE_USD", 500));
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
const FORCE_SINGLE_ACTIVE_TRADE = String(process.env.FORCE_SINGLE_ACTIVE_TRADE ?? "false").toLowerCase() !== "false";
const LIVE_ENFORCE_TELEGRAM_OPEN_CLOSE_FROM_LIVE =
  String(process.env.LIVE_ENFORCE_TELEGRAM_OPEN_CLOSE_FROM_LIVE ?? "true").toLowerCase() !== "false";
const LIVE_MAX_ACCOUNT_DRAWDOWN_PCT = Math.max(
  1,
  Math.min(50, resolveNumberEnv("LIVE_MAX_ACCOUNT_DRAWDOWN_PCT", 10))
);
const LIVE_FORCE_CLOSE_ON_MAX_DRAWDOWN =
  String(process.env.LIVE_FORCE_CLOSE_ON_MAX_DRAWDOWN ?? "true").toLowerCase() !== "false";
const LIVE_BOT_AUTO_CLOSE_ENABLED =
  String(process.env.LIVE_BOT_AUTO_CLOSE_ENABLED ?? "true").toLowerCase() !== "false";
const LIVE_ORPHAN_EARLY_DRAWDOWN_PROTECTION =
  String(process.env.LIVE_ORPHAN_EARLY_DRAWDOWN_PROTECTION ?? "true").toLowerCase() !== "false";
const LIVE_ORPHAN_EARLY_DRAWDOWN_COOLDOWN_MS = Math.max(
  10_000,
  Math.trunc(resolveNumberEnv("LIVE_ORPHAN_EARLY_DRAWDOWN_COOLDOWN_MS", 60_000))
);
const LIVE_ORPHAN_EARLY_DRAWDOWN_SCAN_MIN_INTERVAL_MS = Math.max(
  1_000,
  Math.trunc(resolveNumberEnv("LIVE_ORPHAN_EARLY_DRAWDOWN_SCAN_MIN_INTERVAL_MS", 10_000))
);
const LIVE_ORPHAN_EARLY_DRAWDOWN_RATE_LIMIT_BACKOFF_MS = Math.max(
  LIVE_ORPHAN_EARLY_DRAWDOWN_SCAN_MIN_INTERVAL_MS,
  Math.trunc(resolveNumberEnv("LIVE_ORPHAN_EARLY_DRAWDOWN_RATE_LIMIT_BACKOFF_MS", 60_000))
);
const LIVE_LEDGER_RECONCILE_ENABLED =
  String(process.env.LIVE_LEDGER_RECONCILE_ENABLED ?? "true").toLowerCase() !== "false";
const LIVE_LEDGER_RECONCILE_INTERVAL_MS = Math.max(
  1_000,
  Math.trunc(resolveNumberEnv("LIVE_LEDGER_RECONCILE_INTERVAL_MS", 30_000))
);
const LIVE_LEDGER_RECONCILE_LIMIT = Math.max(
  1,
  Math.min(500, Math.trunc(resolveNumberEnv("LIVE_LEDGER_RECONCILE_LIMIT", 100)))
);
const LIVE_BITUNIX_MARGIN_COIN = (process.env.LIVE_BITUNIX_MARGIN_COIN ?? "USDT").trim().toUpperCase() || "USDT";
const LIVE_BITUNIX_MARGIN_MODE = (process.env.LIVE_BITUNIX_MARGIN_MODE ?? "ISOLATED").trim().toUpperCase();
const LIVE_BITUNIX_ENFORCE_MARGIN_MODE =
  String(process.env.LIVE_BITUNIX_ENFORCE_MARGIN_MODE ?? "true").toLowerCase() !== "false";
const LIVE_MAX_MARGIN_USAGE_PCT = Math.max(1, Math.min(99, resolveNumberEnv("LIVE_MAX_MARGIN_USAGE_PCT", 92)));
const LIVE_MARGIN_FEE_BUFFER_PCT = Math.max(0, Math.min(20, resolveNumberEnv("LIVE_MARGIN_FEE_BUFFER_PCT", 1)));
const LIVE_OPEN_BALANCE_RETRY_ATTEMPTS = Math.max(1, Math.trunc(resolveNumberEnv("LIVE_OPEN_BALANCE_RETRY_ATTEMPTS", 3)));
const LIVE_OPEN_BALANCE_RETRY_SCALE = Math.max(0.5, Math.min(0.99, resolveNumberEnv("LIVE_OPEN_BALANCE_RETRY_SCALE", 0.9)));
const LIVE_OPEN_READINESS_CACHE_TTL_MS = Math.max(250, Math.trunc(resolveNumberEnv("LIVE_OPEN_READINESS_CACHE_TTL_MS", 2_500)));
const LIVE_OPEN_RATE_LIMIT_BACKOFF_MS = Math.max(1_000, Math.trunc(resolveNumberEnv("LIVE_OPEN_RATE_LIMIT_BACKOFF_MS", 10_000)));
const LIVE_POSITION_MATCH_RETRIES = Math.max(1, Math.trunc(resolveNumberEnv("LIVE_POSITION_MATCH_RETRIES", 5)));
const LIVE_POSITION_MATCH_RETRY_DELAY_MS = Math.max(100, Math.trunc(resolveNumberEnv("LIVE_POSITION_MATCH_RETRY_DELAY_MS", 350)));
const LIVE_POSITION_MATCH_GRACE_RETRIES = Math.max(0, Math.trunc(resolveNumberEnv("LIVE_POSITION_MATCH_GRACE_RETRIES", 6)));
const LIVE_POSITION_MATCH_GRACE_DELAY_MS = Math.max(100, Math.trunc(resolveNumberEnv("LIVE_POSITION_MATCH_GRACE_DELAY_MS", 700)));
const LIVE_REQUIRE_POSITION_ID_ON_OPEN =
  String(process.env.LIVE_REQUIRE_POSITION_ID_ON_OPEN ?? "true").toLowerCase() !== "false";
const LIVE_SOFT_ACCEPT_ORDER_WITHOUT_POSITION_ID =
  String(process.env.LIVE_SOFT_ACCEPT_ORDER_WITHOUT_POSITION_ID ?? "true").toLowerCase() !== "false";
const LIVE_TELEGRAM_ALERT_ON_EXECUTION_FAILURE =
  String(process.env.LIVE_TELEGRAM_ALERT_ON_EXECUTION_FAILURE ?? "true").toLowerCase() !== "false";
const REJECTION_CONSOLE_LOG_DEDUPE_MS = Math.max(250, Math.trunc(resolveNumberEnv("REJECTION_CONSOLE_LOG_DEDUPE_MS", 8_000)));
const REJECTION_CONSOLE_LOG_DEDUPE_RATE_LIMIT_MS = Math.max(
  REJECTION_CONSOLE_LOG_DEDUPE_MS,
  Math.trunc(resolveNumberEnv("REJECTION_CONSOLE_LOG_DEDUPE_RATE_LIMIT_MS", 60_000))
);

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
  return isLiveTradingEnabled() && MARKET_DATA_PROVIDER === "BITUNIX";
}

function isDirectionAllowedByMode(direction: TradeDirection): boolean {
  if (SIGNAL_DIRECTION_MODE === "BOTH") {
    return true;
  }

  return SIGNAL_DIRECTION_MODE === direction;
}

function evaluateCandlestickConfirmation(
  row: TokenRsiResult,
  direction: TradeDirection
): { allow: boolean; details: Record<string, unknown> } {
  const candlestickSignal = row.tradeContext?.candlestick;
  const bullishScore = Number(candlestickSignal?.bullishScore ?? 0);
  const bearishScore = Number(candlestickSignal?.bearishScore ?? 0);

  if (!ENTRY_CANDLE_CONFIRMATION_ENABLED) {
    return {
      allow: true,
      details: {
        enabled: false,
        bullishScore,
        bearishScore
      }
    };
  }

  if (direction === "SHORT") {
    const minScorePass = bearishScore >= ENTRY_CANDLE_CONFIRMATION_SHORT_MIN_BEARISH_SCORE;
    const dominancePass = !ENTRY_CANDLE_CONFIRMATION_REQUIRE_DOMINANCE || bearishScore > bullishScore;
    return {
      allow: minScorePass && dominancePass,
      details: {
        enabled: true,
        direction,
        bullishScore,
        bearishScore,
        minBearishScore: ENTRY_CANDLE_CONFIRMATION_SHORT_MIN_BEARISH_SCORE,
        requireDominance: ENTRY_CANDLE_CONFIRMATION_REQUIRE_DOMINANCE,
        minScorePass,
        dominancePass,
        bullishPatterns: candlestickSignal?.bullishPatterns ?? [],
        bearishPatterns: candlestickSignal?.bearishPatterns ?? []
      }
    };
  }

  const minScorePass = bullishScore >= ENTRY_CANDLE_CONFIRMATION_LONG_MIN_BULLISH_SCORE;
  const dominancePass = !ENTRY_CANDLE_CONFIRMATION_REQUIRE_DOMINANCE || bullishScore > bearishScore;
  return {
    allow: minScorePass && dominancePass,
    details: {
      enabled: true,
      direction,
      bullishScore,
      bearishScore,
      minBullishScore: ENTRY_CANDLE_CONFIRMATION_LONG_MIN_BULLISH_SCORE,
      requireDominance: ENTRY_CANDLE_CONFIRMATION_REQUIRE_DOMINANCE,
      minScorePass,
      dominancePass,
      bullishPatterns: candlestickSignal?.bullishPatterns ?? [],
      bearishPatterns: candlestickSignal?.bearishPatterns ?? []
    }
  };
}

function shouldSendTradeLifecycleTelegram(stage: "OPENED" | "CLOSED", isLiveTrade: boolean): boolean {
  if (!isLiveTradingEnabled() || !LIVE_ENFORCE_TELEGRAM_OPEN_CLOSE_FROM_LIVE) {
    return true;
  }

  if (stage === "OPENED" || stage === "CLOSED") {
    return isLiveTrade;
  }

  return true;
}

async function sendTradeLifecycleTelegram(
  payload: Parameters<typeof notifyTelegramEntry>[0],
  isLiveTrade: boolean,
  trade?: Trade
): Promise<void> {
  if (
    (payload.stage === "OPENED" || payload.stage === "CLOSED") &&
    !shouldSendTradeLifecycleTelegram(payload.stage, isLiveTrade)
  ) {
    return;
  }

  if (isLiveTrade && isBitunixLiveTradingMode() && (payload.stage === "OPENED" || payload.stage === "CLOSED")) {
    try {
      if (payload.stage === "OPENED") {
        const positions = await fetchBitunixPendingPositions(payload.symbol);
        const normalizedSymbol = normalizePerpSymbol(payload.symbol).replace("-PERP", "USDT");
        const expectedSide = getBitunixPositionSide(payload.direction);
        const matched = positions.find((position) => {
          if (position.symbol !== normalizedSymbol || position.side !== expectedSide || position.qty <= 0) {
            return false;
          }
          if (trade?.livePositionId) {
            return position.positionId === trade.livePositionId;
          }
          return true;
        }) ?? null;

        if (!matched || !Number.isFinite(matched.avgOpenPrice) || matched.avgOpenPrice <= 0) {
          console.warn("[trade-engine] Skipping OPENED Telegram alert: Bitunix position not confirmed", {
            symbol: payload.symbol,
            direction: payload.direction,
            tradeId: trade?.id ?? null
          });
          return;
        }

        let exchangeTpPrice = payload.tpPrice;
        let exchangeSlPrice = payload.slPrice;
        if (matched.positionId) {
          const tpsl = await fetchBitunixPendingTpslOrders({
            symbol: payload.symbol,
            positionId: matched.positionId
          }).catch(() => []);
          const active = tpsl.find((order) => order.status !== "CANCELED") ?? tpsl[0];
          if (active) {
            if (Number.isFinite(active.tpPrice) && active.tpPrice > 0) {
              exchangeTpPrice = active.tpPrice;
            }
            if (Number.isFinite(active.slPrice) && active.slPrice > 0) {
              exchangeSlPrice = active.slPrice;
            }
          }
        }

        const entryPrice = matched.avgOpenPrice;
        const exchangeTakeProfitPct =
          Number.isFinite(exchangeTpPrice) && exchangeTpPrice! > 0
            ? Math.abs(((exchangeTpPrice! - entryPrice) / entryPrice) * matched.leverage * 100)
            : undefined;
        const exchangeStopLossPct =
          Number.isFinite(exchangeSlPrice) && exchangeSlPrice! > 0
            ? Math.abs(((exchangeSlPrice! - entryPrice) / entryPrice) * matched.leverage * 100)
            : undefined;

        await dispatchRealtimeTelegramAlert({
          ...payload,
          entryPrice,
          tpPrice: exchangeTpPrice,
          slPrice: exchangeSlPrice,
          takeProfitPct: Number.isFinite(exchangeTakeProfitPct) ? Number(exchangeTakeProfitPct!.toFixed(3)) : payload.takeProfitPct,
          stopLossPct: Number.isFinite(exchangeStopLossPct) ? Number(exchangeStopLossPct!.toFixed(3)) : payload.stopLossPct,
          setupConflictNote: `Bitunix OPEN confirmed: entry ${entryPrice.toFixed(6)} | tp ${Number(exchangeTpPrice ?? 0).toFixed(6)} | sl ${Number(exchangeSlPrice ?? 0).toFixed(6)} | positionId ${matched.positionId}`
        });
        return;
      }

      if (payload.stage === "CLOSED") {
        const history = await fetchBitunixClosedTradeHistory({
          symbol: payload.symbol,
          pageSize: 50
        });
        const expectedSymbol = normalizePerpSymbol(payload.symbol);
        const expectedDirection = payload.direction;
        const candidates = history.rows.filter((row) => {
          return toPerpTokenFromBitunixSymbol(row.symbol) === expectedSymbol && row.direction === expectedDirection;
        });

        const matched = candidates
          .slice()
          .sort((left, right) => {
            const leftOpenPenalty = trade?.openTime && left.openedAt
              ? Math.abs(Date.parse(left.openedAt) - Date.parse(trade.openTime))
              : Number.MAX_SAFE_INTEGER;
            const rightOpenPenalty = trade?.openTime && right.openedAt
              ? Math.abs(Date.parse(right.openedAt) - Date.parse(trade.openTime))
              : Number.MAX_SAFE_INTEGER;
            return leftOpenPenalty - rightOpenPenalty;
          })[0] ?? null;

        if (!matched) {
          console.warn("[trade-engine] Skipping CLOSED Telegram alert: Bitunix close history not found", {
            symbol: payload.symbol,
            direction: payload.direction,
            tradeId: trade?.id ?? null,
            endpointUsed: history.endpointUsed,
            attempts: history.attempts
          });
          return;
        }

        await dispatchRealtimeTelegramAlert({
          ...payload,
          entryPrice: Number.isFinite(matched.entryPrice) && matched.entryPrice != null ? matched.entryPrice : payload.entryPrice,
          closeReason: `BITUNIX_${matched.status}`,
          resultPct: Number.isFinite(matched.roiPct) && matched.roiPct != null ? Number(matched.roiPct.toFixed(3)) : payload.resultPct,
          resultUsd: Number.isFinite(matched.realizedPnlUsd) && matched.realizedPnlUsd != null ? Number(matched.realizedPnlUsd.toFixed(2)) : payload.resultUsd,
          setupConflictNote: `Bitunix CLOSED confirmed: entry ${Number(matched.entryPrice ?? 0).toFixed(6)} | close ${Number(matched.closePrice ?? 0).toFixed(6)} | roi ${Number(matched.roiPct ?? 0).toFixed(3)}% | pnl ${Number(matched.realizedPnlUsd ?? 0).toFixed(2)} USD`
        });
        return;
      }
    } catch (error) {
      console.error("[trade-engine] Failed to build Bitunix-backed lifecycle alert", {
        stage: payload.stage,
        symbol: payload.symbol,
        direction: payload.direction,
        tradeId: trade?.id ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
  }

  await dispatchRealtimeTelegramAlert(payload);
}

async function dispatchRealtimeTelegramAlert(
  payload: Parameters<typeof notifyTelegramEntry>[0]
): Promise<void> {
  const normalizedSymbol = normalizePerpSymbol(payload.symbol);
  const enriched: Parameters<typeof notifyTelegramEntry>[0] = {
    ...payload,
    symbol: normalizedSymbol,
    asOf: payload.asOf ?? new Date().toISOString()
  };

  if (isBitunixLiveTradingMode()) {
    try {
      const ctx = (await fetchPerpContexts([normalizedSymbol])).get(normalizedSymbol);
      if (ctx && Number.isFinite(ctx.markPrice) && ctx.markPrice > 0) {
        // READY/CAUTION alerts should reflect the current websocket mark price.
        if (enriched.stage === "READY" || enriched.stage === "CAUTION") {
          enriched.entryPrice = ctx.markPrice;
        }
      }
    } catch (error) {
      console.warn("[trade-engine] Failed to enrich Telegram payload from websocket context", {
        symbol: normalizedSymbol,
        stage: payload.stage,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  notifyTelegramEntry(enriched);
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
  if (!isLiveTradingEnabled() || !LIVE_TELEGRAM_ALERT_ON_EXECUTION_FAILURE) {
    return;
  }

  const normalizedSymbol = normalizePerpSymbol(input.symbol);
  void dispatchRealtimeTelegramAlert({
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

function parseOptionalPositiveNumber(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return parsed;
}

function isLiveInsufficientBalanceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /insufficient balance|insufficient margin|not enough balance/i.test(message);
}

function isLivePositionAlreadyAbsentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no exchange position id found|position not exist|position does not exist|position not found|no such position/i.test(message);
}

async function isLivePositionStillOpenForTrade(trade: Trade): Promise<boolean> {
  if (!isBitunixLiveTradingMode() || !trade.isLiveTrade) {
    return false;
  }

  const positions = await fetchBitunixPendingPositions(trade.token);
  const normalizedSymbol = normalizePerpSymbol(trade.token).replace("-PERP", "USDT");
  const expectedSide = getBitunixPositionSide(trade.direction);

  return positions.some(
    (position) => position.symbol === normalizedSymbol && position.side === expectedSide && position.qty > 0
  );
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function resolveCappedLiveStakeUsd(requestedStakeUsd: number): Promise<number> {
  const snapshot = await fetchBitunixAccountSnapshot(LIVE_BITUNIX_MARGIN_COIN);
  const availableUsd = parseOptionalPositiveNumber(snapshot.account?.available);
  const marginUsd = parseOptionalPositiveNumber(snapshot.account?.margin);
  const balanceUsd = Math.max(availableUsd, marginUsd);

  if (balanceUsd <= 0) {
    throw new Error(`No available ${LIVE_BITUNIX_MARGIN_COIN} futures margin for live open`);
  }

  const usageCapUsd = balanceUsd * (LIVE_MAX_MARGIN_USAGE_PCT / 100);
  const feeReserveUsd = usageCapUsd * (LIVE_MARGIN_FEE_BUFFER_PCT / 100);
  const maxStakeUsd = Number(Math.max(0, usageCapUsd - feeReserveUsd).toFixed(2));
  const cappedStakeUsd = Number(Math.min(requestedStakeUsd, maxStakeUsd).toFixed(2));

  if (cappedStakeUsd <= 0) {
    throw new Error(
      `Live open blocked by margin guard: available=${balanceUsd.toFixed(2)} ${LIVE_BITUNIX_MARGIN_COIN}, maxStake=${maxStakeUsd.toFixed(2)} ${LIVE_BITUNIX_MARGIN_COIN}`
    );
  }

  return cappedStakeUsd;
}

function getBitunixOrderSide(direction: TradeDirection): "BUY" | "SELL" {
  return direction === "LONG" ? "BUY" : "SELL";
}

function getBitunixPositionSide(direction: TradeDirection): "LONG" | "SHORT" {
  return direction === "LONG" ? "LONG" : "SHORT";
}

function resolveBitunixMarginMode(modeRaw: string): "ISOLATED" | "CROSSED" | "UNKNOWN" {
  const mode = String(modeRaw ?? "").trim().toUpperCase();
  if (mode === "ISOLATED" || mode === "ISOLATE") {
    return "ISOLATED";
  }
  if (mode === "CROSS" || mode === "CROSSED") {
    return "CROSSED";
  }
  return "UNKNOWN";
}

function getConfiguredLiveBitunixMarginMode(): "ISOLATED" | "CROSSED" {
  const mode = resolveBitunixMarginMode(LIVE_BITUNIX_MARGIN_MODE);
  return mode === "CROSSED" ? "CROSSED" : "ISOLATED";
}

async function assertBitunixLiveMarginMode(symbol: string): Promise<void> {
  if (!LIVE_BITUNIX_ENFORCE_MARGIN_MODE) {
    return;
  }

  const expectedMode = getConfiguredLiveBitunixMarginMode();
  const leverageCheck = await fetchBitunixLeverageCheck(symbol, 1, LIVE_BITUNIX_MARGIN_COIN);
  const currentMode = resolveBitunixMarginMode(leverageCheck.marginMode);
  if (currentMode !== expectedMode) {
    throw new Error(
      `Live open blocked for ${leverageCheck.symbol}: margin mode is ${leverageCheck.marginMode}, expected ${expectedMode}`
    );
  }
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
  tpPrice?: number;
  slPrice?: number;
}): Promise<{
  orderId: string;
  clientId: string;
  positionId?: string;
  qty: number;
  requestedStakeUsd: number;
  stakeUsdUsed: number;
}> {
  if (!isBitunixLiveTradingMode()) {
    return {
      orderId: "",
      clientId: "",
      qty: 0,
      requestedStakeUsd: input.stakeUsd,
      stakeUsdUsed: input.stakeUsd
    };
  }

  const requestedStakeUsd = Number(input.stakeUsd.toFixed(2));
  const initialStakeUsd = await resolveCappedLiveStakeUsd(requestedStakeUsd);
  await changeBitunixLeverage(input.symbol, input.leverage, LIVE_BITUNIX_MARGIN_COIN);
  await assertBitunixLiveMarginMode(input.symbol);

  let stakeUsdUsed = initialStakeUsd;
  let qty = resolveLiveQtyBaseUnits(input.entryPrice, stakeUsdUsed, input.leverage);
  let order: Awaited<ReturnType<typeof placeBitunixMarketOrder>> | null = null;
  let lastOpenError: unknown = null;

  for (let attempt = 1; attempt <= LIVE_OPEN_BALANCE_RETRY_ATTEMPTS; attempt += 1) {
    qty = resolveLiveQtyBaseUnits(input.entryPrice, stakeUsdUsed, input.leverage);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`Live open aborted for ${input.symbol}: invalid qty ${qty}`);
    }

    try {
      order = await placeBitunixMarketOrder({
        symbol: input.symbol,
        side: getBitunixOrderSide(input.direction),
        qty,
        marginMode: getConfiguredLiveBitunixMarginMode(),
        clientId: `hype-${input.localTradeId.slice(-24)}`,
        tpPrice: input.tpPrice,
        tpStopType: "MARK",
        tpOrderType: "MARKET",
        slPrice: input.slPrice,
        slStopType: "MARK",
        slOrderType: "MARKET"
      });
      break;
    } catch (error) {
      lastOpenError = error;
      if (!isLiveInsufficientBalanceError(error) || attempt >= LIVE_OPEN_BALANCE_RETRY_ATTEMPTS) {
        throw error;
      }

      const nextStake = Number((stakeUsdUsed * LIVE_OPEN_BALANCE_RETRY_SCALE).toFixed(2));
      if (!Number.isFinite(nextStake) || nextStake <= 1) {
        throw error;
      }

      stakeUsdUsed = nextStake;
    }
  }

  if (!order) {
    throw new Error(`Live open aborted for ${input.symbol}: ${lastOpenError instanceof Error ? lastOpenError.message : String(lastOpenError)}`);
  }

  let matched: BitunixPendingPosition | null = null;
  for (let attempt = 1; attempt <= LIVE_POSITION_MATCH_RETRIES; attempt += 1) {
    const positions = await fetchBitunixPendingPositions(input.symbol);
    matched = pickBestLivePositionMatch(positions, input.symbol, input.direction, qty);
    if (matched?.positionId) {
      break;
    }

    if (attempt < LIVE_POSITION_MATCH_RETRIES) {
      await waitMs(LIVE_POSITION_MATCH_RETRY_DELAY_MS);
    }
  }

  // Exchanges can acknowledge market orders before position snapshots are fully propagated.
  // Give one extra grace window before treating this as a hard open failure.
  if (!matched?.positionId && LIVE_POSITION_MATCH_GRACE_RETRIES > 0) {
    for (let attempt = 1; attempt <= LIVE_POSITION_MATCH_GRACE_RETRIES; attempt += 1) {
      await waitMs(LIVE_POSITION_MATCH_GRACE_DELAY_MS);
      const positions = await fetchBitunixPendingPositions(input.symbol);
      matched = pickBestLivePositionMatch(positions, input.symbol, input.direction, qty);
      if (matched?.positionId) {
        break;
      }
    }
  }

  if (LIVE_REQUIRE_POSITION_ID_ON_OPEN && !matched?.positionId) {
    if (!LIVE_SOFT_ACCEPT_ORDER_WITHOUT_POSITION_ID) {
      throw new Error(
        `Live order submitted (${order.orderId}) but no matching open position found for ${normalizePerpSymbol(input.symbol)} ${input.direction}`
      );
    }

    console.warn("[trade-engine] Live open accepted without immediate position match", {
      symbol: normalizePerpSymbol(input.symbol),
      direction: input.direction,
      orderId: order.orderId,
      retries: LIVE_POSITION_MATCH_RETRIES
    });
  }

  void recordLiveOrderAck({
    provider: "BITUNIX",
    symbol: normalizePerpSymbol(input.symbol).replace("-PERP", "USDT"),
    perpToken: normalizePerpSymbol(input.symbol),
    direction: input.direction,
    orderType: "MARKET",
    source: "LIQUIDITY_HUNT_MARKET_OPEN",
    status: matched?.positionId ? "FILLED_OPENED" : "ACKED",
    localTradeId: input.localTradeId,
    clientId: order.clientId,
    orderId: order.orderId,
    positionId: matched?.positionId,
    stakeUsd: stakeUsdUsed,
    leverage: input.leverage,
    entryPrice: input.entryPrice,
    tpPrice: input.tpPrice,
    slPrice: input.slPrice,
    openedAt: new Date().toISOString(),
    meta: {
      source: "executeLiveOpenOrder",
      requestedStakeUsd,
      qty
    }
  }).catch((error) => {
    console.error("[trade-engine] Failed to persist market order lifecycle in live order ledger", {
      symbol: normalizePerpSymbol(input.symbol),
      direction: input.direction,
      orderId: order.orderId,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  if (matched?.positionId) {
    void recordLiveOrderOpened({
      provider: "BITUNIX",
      clientId: order.clientId,
      orderId: order.orderId,
      positionId: matched.positionId,
      openedAt: new Date().toISOString(),
      meta: {
        source: "executeLiveOpenOrder",
        symbol: normalizePerpSymbol(input.symbol),
        direction: input.direction
      }
    }).catch((error) => {
      console.error("[trade-engine] Failed to mark market order as opened in live order ledger", {
        symbol: normalizePerpSymbol(input.symbol),
        direction: input.direction,
        orderId: order.orderId,
        positionId: matched.positionId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  return {
    orderId: order.orderId,
    clientId: order.clientId,
    positionId: matched?.positionId,
    qty,
    requestedStakeUsd,
    stakeUsdUsed
  };
}

async function executeLiveOpenLimitOrder(input: {
  symbol: string;
  direction: TradeDirection;
  leverage: number;
  entryPrice: number;
  stakeUsd: number;
  localTradeId: string;
  tpPrice?: number;
  slPrice?: number;
}): Promise<{
  orderId: string;
  clientId: string;
  qty: number;
  requestedStakeUsd: number;
  stakeUsdUsed: number;
  limitPrice: number;
}> {
  if (!isBitunixLiveTradingMode()) {
    return {
      orderId: "",
      clientId: "",
      qty: 0,
      requestedStakeUsd: input.stakeUsd,
      stakeUsdUsed: input.stakeUsd,
      limitPrice: input.entryPrice
    };
  }

  const requestedStakeUsd = Number(input.stakeUsd.toFixed(2));
  const initialStakeUsd = await resolveCappedLiveStakeUsd(requestedStakeUsd);
  await changeBitunixLeverage(input.symbol, input.leverage, LIVE_BITUNIX_MARGIN_COIN);
  await assertBitunixLiveMarginMode(input.symbol);

  let stakeUsdUsed = initialStakeUsd;
  let qty = resolveLiveQtyBaseUnits(input.entryPrice, stakeUsdUsed, input.leverage);
  let order: Awaited<ReturnType<typeof placeBitunixLimitOrder>> | null = null;
  let lastOpenError: unknown = null;

  for (let attempt = 1; attempt <= LIVE_OPEN_BALANCE_RETRY_ATTEMPTS; attempt += 1) {
    qty = resolveLiveQtyBaseUnits(input.entryPrice, stakeUsdUsed, input.leverage);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`Live limit open aborted for ${input.symbol}: invalid qty ${qty}`);
    }

    try {
      order = await placeBitunixLimitOrder({
        symbol: input.symbol,
        side: getBitunixOrderSide(input.direction),
        qty,
        price: input.entryPrice,
        marginMode: getConfiguredLiveBitunixMarginMode(),
        clientId: `hype-lmt-${input.localTradeId.slice(-20)}`,
        tpPrice: input.tpPrice,
        tpStopType: "MARK",
        slPrice: input.slPrice,
        slStopType: "MARK"
      });
      break;
    } catch (error) {
      lastOpenError = error;
      if (!isLiveInsufficientBalanceError(error) || attempt >= LIVE_OPEN_BALANCE_RETRY_ATTEMPTS) {
        throw error;
      }

      const nextStake = Number((stakeUsdUsed * LIVE_OPEN_BALANCE_RETRY_SCALE).toFixed(2));
      if (!Number.isFinite(nextStake) || nextStake <= 1) {
        throw error;
      }

      stakeUsdUsed = nextStake;
    }
  }

  if (!order) {
    throw new Error(`Live limit open aborted for ${input.symbol}: ${lastOpenError instanceof Error ? lastOpenError.message : String(lastOpenError)}`);
  }

  void recordLiveOrderAck({
    provider: "BITUNIX",
    symbol: normalizePerpSymbol(input.symbol).replace("-PERP", "USDT"),
    perpToken: normalizePerpSymbol(input.symbol),
    direction: input.direction,
    orderType: "LIMIT",
    source: "LIQUIDITY_HUNT_PRE_SWEEP_LIMIT",
    status: "ACKED",
    localTradeId: input.localTradeId,
    clientId: order.clientId,
    orderId: order.orderId,
    stakeUsd: stakeUsdUsed,
    leverage: input.leverage,
    entryPrice: input.entryPrice,
    tpPrice: input.tpPrice,
    slPrice: input.slPrice,
    openedAt: new Date().toISOString(),
    meta: {
      source: "executeLiveOpenLimitOrder",
      requestedStakeUsd,
      qty
    }
  }).catch((error) => {
    console.error("[trade-engine] Failed to persist limit order lifecycle in live order ledger", {
      symbol: normalizePerpSymbol(input.symbol),
      direction: input.direction,
      orderId: order.orderId,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  return {
    orderId: order.orderId,
    clientId: order.clientId,
    qty,
    requestedStakeUsd,
    stakeUsdUsed,
    limitPrice: input.entryPrice
  };
}

async function evaluateLiveOpenReadiness(input: {
  symbol: string;
  direction: TradeDirection;
  stakeUsd: number;
}): Promise<{ allow: boolean; reason?: string; details?: Record<string, unknown> }> {
  if (!isBitunixLiveTradingMode()) {
    return { allow: true };
  }

  try {
    const nowMs = Date.now();
    if (nowMs < liveOpenRateLimitUntilMs) {
      return {
        allow: false,
        reason: "bitunix private payload error: request too frequently",
        details: {
          symbol: normalizePerpSymbol(input.symbol),
          direction: input.direction,
          backoffUntil: new Date(liveOpenRateLimitUntilMs).toISOString(),
          usedCachedReadiness: false
        }
      };
    }

    let context = cachedLiveOpenReadinessContext;
    const cacheFresh =
      context != null &&
      nowMs - context.fetchedAtMs <= LIVE_OPEN_READINESS_CACHE_TTL_MS;

    if (!cacheFresh) {
      const snapshot = await fetchBitunixAccountSnapshot(LIVE_BITUNIX_MARGIN_COIN);
      const availableUsd = Number(snapshot.account?.available ?? NaN);
      const livePositions = await fetchBitunixPendingPositions();
      const effectiveBalanceUsd = Number.isFinite(availableUsd) ? availableUsd : accountBalanceUsd;
      const maxActiveTrades = getMaxActiveTrades(effectiveBalanceUsd);

      context = {
        fetchedAtMs: nowMs,
        availableUsd,
        effectiveBalanceUsd,
        livePositions,
        maxActiveTrades
      };
      cachedLiveOpenReadinessContext = context;
    }

    const availableUsd = context?.availableUsd ?? Number.NaN;
    const livePositions = context?.livePositions ?? [];
    const effectiveBalanceUsd = context?.effectiveBalanceUsd ?? accountBalanceUsd;
    const maxActiveTrades = context?.maxActiveTrades ?? getMaxActiveTrades(effectiveBalanceUsd);
    const normalizedSymbol = normalizePerpSymbol(input.symbol);

    // Enforce strict single-position mode under the configured multi-trade threshold,
    // regardless of MAX_ACTIVE_TRADES_UNDER_1000 runtime overrides.
    if (effectiveBalanceUsd < LIVE_MULTI_TRADE_MIN_BALANCE_USD && livePositions.length > 0) {
      return {
        allow: false,
        reason: "single-position mode active under balance threshold",
        details: {
          openPositions: livePositions.length,
          effectiveBalanceUsd: Number(effectiveBalanceUsd.toFixed(2)),
          minBalanceForMultiTradeUsd: LIVE_MULTI_TRADE_MIN_BALANCE_USD
        }
      };
    }

    if (livePositions.some((position) => toPerpTokenFromBitunixSymbol(position.symbol) === normalizedSymbol && position.side === input.direction)) {
      return {
        allow: false,
        reason: "matching live position already open",
        details: {
          symbol: normalizedSymbol,
          direction: input.direction
        }
      };
    }

    if (livePositions.length >= maxActiveTrades) {
      return {
        allow: false,
        reason: "live position capacity reached",
        details: {
          openPositions: livePositions.length,
          maxActiveTrades,
          availableUsd: Number.isFinite(availableUsd) ? Number(availableUsd.toFixed(2)) : null,
          effectiveBalanceUsd: Number.isFinite(effectiveBalanceUsd)
            ? Number(effectiveBalanceUsd.toFixed(2))
            : null,
          minBalanceForMultiTradeUsd: LIVE_MULTI_TRADE_MIN_BALANCE_USD
        }
      };
    }

    const requestedStakeUsd = Number.isFinite(input.stakeUsd) ? input.stakeUsd : 0;
    const usesLiveMaxStakeSentinel = requestedStakeUsd >= Number.MAX_SAFE_INTEGER / 100;

    if (!usesLiveMaxStakeSentinel && Number.isFinite(availableUsd) && availableUsd < requestedStakeUsd) {
      return {
        allow: false,
        reason: "insufficient exchange margin for next trade",
        details: {
          availableUsd: Number(availableUsd.toFixed(2)),
          requiredStakeUsd: Number(requestedStakeUsd.toFixed(2))
        }
      };
    }

    return {
      allow: true,
      details: {
        openPositions: livePositions.length,
        maxActiveTrades,
        availableUsd: Number.isFinite(availableUsd) ? Number(availableUsd.toFixed(2)) : null,
        effectiveBalanceUsd: Number.isFinite(effectiveBalanceUsd)
          ? Number(effectiveBalanceUsd.toFixed(2))
          : null
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isRateLimitFetchErrorMessage(message)) {
      liveOpenRateLimitUntilMs = Date.now() + LIVE_OPEN_RATE_LIMIT_BACKOFF_MS;
      return {
        allow: false,
        reason: "bitunix private payload error: request too frequently",
        details: {
          symbol: normalizePerpSymbol(input.symbol),
          direction: input.direction,
          backoffMs: LIVE_OPEN_RATE_LIMIT_BACKOFF_MS,
          backoffUntil: new Date(liveOpenRateLimitUntilMs).toISOString()
        }
      };
    }

    return {
      allow: false,
      reason: message,
      details: {
        symbol: normalizePerpSymbol(input.symbol),
        direction: input.direction
      }
    };
  }
}

async function enforceLiquidityHuntPendingLimitPolicy(input: {
  symbol: string;
  nowMs: number;
}): Promise<{ allow: boolean; reason?: string; details?: Record<string, unknown> }> {
  if (!isBitunixLiveTradingMode()) {
    return { allow: true };
  }

  const normalizedPerpSymbol = normalizePerpSymbol(input.symbol);
  const normalizedExchangeSymbol = normalizedPerpSymbol.replace("-PERP", "USDT");
  const maxAgeMs = LIQUIDITY_HUNT_PENDING_LIMIT_MAX_AGE_MINUTES * 60 * 1000;

  try {
    const pending = await fetchBitunixPendingOpenOrders({ symbol: normalizedPerpSymbol });
    const botLimitOrders = pending.filter((order) => {
      if (order.symbol !== normalizedExchangeSymbol) {
        return false;
      }
      if (order.orderType !== "LIMIT") {
        return false;
      }
      return order.clientId.startsWith("hype-lmt-");
    });

    if (botLimitOrders.length === 0) {
      return { allow: true };
    }

    let canceledCount = 0;
    let youngestRemainingAgeMs = Number.MAX_SAFE_INTEGER;
    for (const order of botLimitOrders) {
      const anchorTs = order.createdAtMs > 0 ? order.createdAtMs : (order.updatedAtMs > 0 ? order.updatedAtMs : input.nowMs);
      const ageMs = Math.max(0, input.nowMs - anchorTs);
      if (ageMs > maxAgeMs) {
        await cancelBitunixOpenOrder({ orderId: order.orderId, symbol: normalizedPerpSymbol });
        canceledCount += 1;
      } else {
        youngestRemainingAgeMs = Math.min(youngestRemainingAgeMs, ageMs);
      }
    }

    const remaining = botLimitOrders.length - canceledCount;
    if (remaining > 0) {
      return {
        allow: false,
        reason: "pending bot limit order already exists for symbol",
        details: {
          symbol: normalizedPerpSymbol,
          remainingPendingBotLimitOrders: remaining,
          maxPendingAgeMinutes: LIQUIDITY_HUNT_PENDING_LIMIT_MAX_AGE_MINUTES,
          youngestRemainingAgeMs: youngestRemainingAgeMs === Number.MAX_SAFE_INTEGER ? 0 : youngestRemainingAgeMs,
          canceledStaleOrders: canceledCount
        }
      };
    }

    return {
      allow: true,
      details: {
        symbol: normalizedPerpSymbol,
        canceledStaleOrders: canceledCount,
        maxPendingAgeMinutes: LIQUIDITY_HUNT_PENDING_LIMIT_MAX_AGE_MINUTES
      }
    };
  } catch (error) {
    return {
      allow: false,
      reason: error instanceof Error ? error.message : String(error),
      details: {
        symbol: normalizedPerpSymbol,
        maxPendingAgeMinutes: LIQUIDITY_HUNT_PENDING_LIMIT_MAX_AGE_MINUTES
      }
    };
  }
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
    void recordLiveOrderOpened({
      provider: "BITUNIX",
      clientId: trade.liveClientId,
      orderId: trade.liveOrderId,
      positionId: matched.positionId,
      openedAt: trade.openTime,
      meta: {
        source: "resolveLivePositionIdForTrade",
        symbol: normalizePerpSymbol(trade.token),
        direction: trade.direction
      }
    }).catch((error) => {
      console.error("[trade-engine] Failed to mark live order as opened in ledger", {
        tradeId: trade.id,
        positionId: matched.positionId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
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
  void recordLiveOrderClosed({
    provider: "BITUNIX",
    clientId: trade.liveClientId,
    orderId: trade.liveOrderId,
    positionId,
    closeReason: "LIVE_CLOSE_EXECUTED",
    closedAt: new Date().toISOString(),
    meta: {
      source: "executeLiveCloseForTrade",
      symbol: normalizePerpSymbol(trade.token),
      direction: trade.direction
    }
  }).catch((error) => {
    console.error("[trade-engine] Failed to mark live order as closed in ledger", {
      tradeId: trade.id,
      positionId,
      error: error instanceof Error ? error.message : String(error)
    });
  });
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

  if (signalType.startsWith("CONTINUATION")) {
    return ENTRY_TIMING_MAX;
  }

  if (signalType.startsWith("REVERSAL")) {
    return ENTRY_TIMING_MAX;
  }

  return "MID";
}

function resolveMinRiskRewardForCandidate(candidate: RankedTradeCandidate, signalType: string): number {
  const isEarlyReversalException =
    signalType.startsWith("REVERSAL") &&
    candidate.entryTiming === "EARLY" &&
    candidate.signalStrength >= 0.9;
  if (isEarlyReversalException) {
    return Math.min(MIN_RISK_REWARD, EARLY_REVERSAL_MIN_RR);
  }

  return MIN_RISK_REWARD;
}

const openTrades = new Map<string, Trade>();
const closedTrades: Trade[] = [];
// Separate tracking for live real trades (Bitunix) vs simulation trades
const liveOpenTrades = new Map<string, Trade>();
const liveClosedTrades: Trade[] = [];
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
// Tracks the last time a bot-placed limit (hunt) position was closed by the exchange SL / drawdown
// so we can block immediate re-entry on that symbol even across restarts (in-memory).
const lastHuntOrphanSLBySymbol = new Map<string, number>();
const latestOhlcByToken = new Map<string, { ohlc: LatestOhlc; at: number }>();
const ohlcCooldownUntilByToken = new Map<string, number>();
const ohlcRateLimitWarnedAtByToken = new Map<string, number>();
const liveOrphanEarlyDrawdownAttemptByPosition = new Map<string, number>();
const rejectionConsoleLoggedAtByKey = new Map<string, number>();
const simPendingLimitOrdersByKey = new Map<string, SimPendingLimitOrder>();
let cachedLiveOpenReadinessContext: CachedLiveOpenReadinessContext | null = null;
let liveOpenRateLimitUntilMs = 0;
let liveOrphanEarlyDrawdownLastScanAtMs = 0;
let liveOrphanEarlyDrawdownPauseUntilMs = 0;
let liveLedgerReconcileLastRunAtMs = 0;
let liveLedgerReconcileRunning = false;
let backfillPrisma: PrismaClient | null = null;
const BACKFILL_STATUS_CACHE_TTL_MS = 10 * 60 * 1000;
const BACKFILL_STATUS_ERROR_CACHE_TTL_MS = 60 * 1000;
const backfillStatusCache = new Map<
  string,
  {
    tracking: Awaited<ReturnType<typeof getBackfillStatus>>;
    expiresAtMs: number;
  }
>();
let accountBalanceUsd = SIM_INITIAL_CAPITAL_USD;
let dailyStartBalanceUsd = SIM_INITIAL_CAPITAL_USD;
let dailyStartKeyUtc = new Date().toISOString().slice(0, 10);
let lossStreakCount = 0;
let cooldownUntilMs = 0;
let rollingCircuitUntilMs = 0;
let killSwitchActivated = false;
let hydratedFromStorage = false;
const DEFAULT_TRADE_TENANT_ID = (process.env.TRADING_TENANT_ID ?? "default").trim() || "default";
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

async function getBackfillStatusBestEffort(symbol: string): Promise<Awaited<ReturnType<typeof getBackfillStatus>>> {
  const cached = backfillStatusCache.get(symbol);
  const nowMs = Date.now();
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.tracking;
  }

  try {
    const tracking = await getBackfillStatus(getBackfillPrisma(), symbol);
    backfillStatusCache.set(symbol, {
      tracking,
      expiresAtMs: nowMs + BACKFILL_STATUS_CACHE_TTL_MS
    });
    return tracking;
  } catch (error) {
    backfillStatusCache.set(symbol, {
      tracking: null,
      expiresAtMs: nowMs + BACKFILL_STATUS_ERROR_CACHE_TTL_MS
    });
    console.debug(`[trade-engine] Backfill status lookup failed for ${symbol}; continuing with live data`, {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
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

  // Websocket-first lifecycle pricing: do not poll REST in the execution hot path.
  // We synthesize a micro-candle from the latest WS mark and previous close.
  if (MARKET_DATA_PROVIDER === "BITUNIX") {
    const ws = getBitunixMarketWsPrice(token);
    if (ws.fresh && Number.isFinite(ws.price) && ws.price > 0) {
      const prevClose = cached?.close ?? ws.price;
      const ohlc: LatestOhlc = {
        open: prevClose,
        high: Math.max(prevClose, ws.price),
        low: Math.min(prevClose, ws.price),
        close: ws.price,
        time: now
      };
      writeCachedLifecycleOhlc(token, ohlc);
      return ohlc;
    }

    return cached;
  }

  // Non-Bitunix providers stay cache-only here to avoid HTTP polling in the trade loop.
  return cached;
}

type TradeRuntimeMode = "LIVE" | "SIM";

function resolveTradeStakeSource(runtimeMode: TradeRuntimeMode): TradeStakeSource {
  if (runtimeMode === "SIM") {
    if (SIM_BALANCE_DRIVEN_SIZING_ENABLED) {
      return "SIM_BALANCE_DRIVEN";
    }
  }

  return "RISK_BUDGET";
}

function normalizeTenantId(value?: string | null): string {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : DEFAULT_TRADE_TENANT_ID;
}

function getTradeTenantId(trade: Pick<Trade, "tenantId">): string {
  return normalizeTenantId(trade.tenantId);
}

function isTradeInTenant(trade: Pick<Trade, "tenantId">, tenantId: string): boolean {
  return getTradeTenantId(trade) === tenantId;
}

function toTradeRuntimeMode(isLiveTrade: boolean): TradeRuntimeMode {
  return isLiveTrade ? "LIVE" : "SIM";
}

function getCurrentTradeRuntimeMode(): TradeRuntimeMode {
  return isBitunixLiveTradingMode() ? "LIVE" : "SIM";
}

function getTradeKey(
  token: string,
  direction: TradeDirection,
  runtimeMode: TradeRuntimeMode,
  tenantId?: string
): string {
  const resolvedTenantId = normalizeTenantId(tenantId);
  return `${resolvedTenantId}:${runtimeMode}:${token}:${direction}`;
}

function getTradeKeyForTrade(trade: Pick<Trade, "token" | "direction" | "isLiveTrade" | "tenantId">): string {
  return getTradeKey(
    trade.token,
    trade.direction,
    toTradeRuntimeMode(Boolean(trade.isLiveTrade)),
    getTradeTenantId(trade)
  );
}

function countOpenTradesForMode(runtimeMode: TradeRuntimeMode, tenantId?: string): number {
  const resolvedTenantId = normalizeTenantId(tenantId);
  if (runtimeMode === "LIVE") {
    return Array.from(openTrades.values()).filter(
      (trade) => Boolean(trade.isLiveTrade) && isTradeInTenant(trade, resolvedTenantId)
    ).length;
  }
  return Array.from(openTrades.values()).filter(
    (trade) => !trade.isLiveTrade && isTradeInTenant(trade, resolvedTenantId)
  ).length;
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

type SymbolTier = "LARGE" | "MAJOR_ALT" | "SMALL_CAP";

function getSymbolTier(symbol: string): SymbolTier {
  const base = getBaseSymbol(symbol);
  if (base === "BTC" || base === "ETH") {
    return "LARGE";
  }

  if (isMajorAlt(symbol)) {
    return "MAJOR_ALT";
  }

  return "SMALL_CAP";
}

function isLargeCap(symbol: string): boolean {
  return getSymbolTier(symbol) === "LARGE";
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

export type TokenLeverageProfile = {
  symbol: string;
  assetBucket: AssetRiskBucket;
  baseLeverage: number;
  caps: {
    trend: number;
    reversal: number;
    breakout: number;
  };
  maxLeverage: number;
};

export function getTokenLeverageProfile(symbol: string): TokenLeverageProfile {
  const assetBucket = getAssetRiskBucket(symbol);
  const baseLeverage = getLeverageForSymbol(symbol);
  const trend = getSetupLeverageCap(assetBucket, "TREND");
  const reversal = getSetupLeverageCap(assetBucket, "REVERSAL");
  const breakout = getSetupLeverageCap(assetBucket, "BREAKOUT");
  const maxLeverage = Math.max(
    Math.min(baseLeverage, trend),
    Math.min(baseLeverage, reversal),
    Math.min(baseLeverage, breakout)
  );

  return {
    symbol: getBaseSymbol(symbol),
    assetBucket,
    baseLeverage: Number(baseLeverage.toFixed(3)),
    caps: {
      trend: Number(trend.toFixed(3)),
      reversal: Number(reversal.toFixed(3)),
      breakout: Number(breakout.toFixed(3))
    },
    maxLeverage: Number(maxLeverage.toFixed(3))
  };
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
  const tier = getSymbolTier(symbol);
  if (tier === "LARGE") {
    return MIN_VOLUME_USD;
  }

  if (tier === "MAJOR_ALT") {
    return MIN_VOLUME_USD_MAJOR_ALT;
  }

  return MIN_VOLUME_USD_SMALL_CAP;
}

function getLiquidityHuntMinStopPoolUsdForSymbol(symbol: string): number {
  const tier = getSymbolTier(symbol);
  if (tier === "LARGE") {
    return LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD_LARGE;
  }

  if (tier === "MAJOR_ALT") {
    return LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD_MAJOR_ALT;
  }

  return LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD_SMALL;
}

function getOrderBookSpreadLimitPct(symbol: string): number {
  const tier = getSymbolTier(symbol);
  if (tier === "LARGE") {
    return ORDERBOOK_MAX_SPREAD_PCT_LARGE;
  }

  if (tier === "MAJOR_ALT") {
    return ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT;
  }

  return ORDERBOOK_MAX_SPREAD_PCT_ALT;
}

function getMaxSlippagePctForSymbol(symbol: string): number {
  const tier = getSymbolTier(symbol);
  if (tier === "LARGE" || tier === "MAJOR_ALT") {
    return MAX_SLIPPAGE_PCT;
  }

  return Math.max(MAX_SLIPPAGE_PCT, MAX_SLIPPAGE_PCT_SMALL_CAP);
}

function isWeakDirectionalSignal(signalType: string): boolean {
  return !signalType.startsWith("STRONG") && !signalType.startsWith("CONTINUATION") && !signalType.startsWith("REVERSAL");
}

function shouldRequireCandlestickConfirmation(signalType: string): boolean {
  return signalType.startsWith("REVERSAL") || isWeakDirectionalSignal(signalType);
}

function getOrderBookMaxAgainstImbalance(symbol: string): number {
  if (getSymbolTier(symbol) === "MAJOR_ALT") {
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

/**
 * Detect counter-trend condition when short-term trigger conflicts with macro trend.
 * Classifies trade context as:
 * - "TREND_ALIGNED": Macro trend == Trigger direction
 * - "COUNTER_TREND": Macro trend != Trigger direction
 * - "CHOP_NO_TREND": Both macro and intermediary are MIXED
 */
function resolveCounterTrendContext(
  row: TokenRsiResult,
  direction: TradeDirection
): {
  status: "TREND_ALIGNED" | "COUNTER_TREND" | "CHOP_NO_TREND";
  macroTrend: "UP" | "DOWN" | "MIXED";
  intermediaryTrend: "UP" | "DOWN" | "MIXED";
  triggerDirection: "UP" | "DOWN" | "MIXED";
  isCounterTrend: boolean;
  confidenceMultiplier: number;
} {
  const macroTrend = row.timeframes.macro.trend.direction;
  const intermediaryTrend = row.timeframes.intermediary.trend.direction;
  const microTrend = row.timeframes.microTrigger.trend.direction;
  const triggerDirection = direction === "LONG" ? "UP" : "DOWN";

  // Detect "Chop / No Trend" when both macro and intermediary are MIXED
  if (macroTrend === "MIXED" && intermediaryTrend === "MIXED") {
    return {
      status: "CHOP_NO_TREND",
      macroTrend,
      intermediaryTrend,
      triggerDirection: "MIXED",
      isCounterTrend: false,
      confidenceMultiplier: 1.0
    };
  }

  // Detect counter-trend: if macro trend opposes trigger direction
  const macroOpposesEntry =
    (triggerDirection === "UP" && macroTrend === "DOWN") ||
    (triggerDirection === "DOWN" && macroTrend === "UP");

  if (macroOpposesEntry) {
    // Counter-trend detected: reduce confidence to 60% of original
    return {
      status: "COUNTER_TREND",
      macroTrend,
      intermediaryTrend,
      triggerDirection,
      isCounterTrend: true,
      confidenceMultiplier: 0.6
    };
  }

  // Trend-aligned: macro and micro agree on direction
  return {
    status: "TREND_ALIGNED",
    macroTrend,
    intermediaryTrend,
    triggerDirection,
    isCounterTrend: false,
    confidenceMultiplier: 1.0
  };
}

// ============================================================================
// DUMP-REVERSAL DETECTION: Post-Dump Entry Safety Gates
// ============================================================================
// Purpose: Prevent premature LONG entries during dumping phases.
// Implementation: Detect dump zones → reaction → structure shift → entry
// ============================================================================

/**
 * Detects whether the asset is in a dump zone (rapid price drop > 5-10%).
 * Returns dump state with drop percentage and confidence level.
 */
function resolveDumpZone(row: TokenRsiResult): {
  inDumpZone: boolean;
  dumpDrop: number;
  dumpConfidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
} {
  // Detect dump via consecutive lower lows + strong bearish candles
  const microRsi = row.rsi;
  const microStochK = row.timeframes.microTrigger.stochK;
  const microTrend = row.timeframes.microTrigger.trend.direction;
  const intermediaryTrend = row.timeframes.intermediary.trend.direction;
  
  // Heuristic: RSI < 30 indicates oversold, suggesting recent dump
  const isOversold = microRsi < 30;
  // Strong bearish candle: stochastic below 30 and trend is DOWN
  const isBearishCandle = microStochK < 30 && microTrend === "DOWN";
  // Intermediary also downtrending = extended move down
  const extendedBearish = intermediaryTrend === "DOWN";

  // Volatility expansion indicates recent move
  const volatilityExpanded = (row.tradeContext?.atrExpansion ?? 0) > 1.2;

  // 24h change > 5-10% down
  const change24h = row.change24hPct ?? 0;
  const significantDrop = change24h < -5;

  // Confidence scoring
  const dumpSignals = [
    isOversold ? 1 : 0,
    isBearishCandle ? 1 : 0,
    extendedBearish ? 1 : 0,
    volatilityExpanded ? 1 : 0,
    significantDrop ? 1 : 0
  ].reduce((a, b) => a + b, 0);

  let dumpConfidence: "HIGH" | "MEDIUM" | "LOW" | "NONE" = "NONE";
  if (dumpSignals >= 4) dumpConfidence = "HIGH";
  else if (dumpSignals >= 3) dumpConfidence = "MEDIUM";
  else if (dumpSignals >= 2) dumpConfidence = "LOW";

  const inDumpZone = dumpConfidence !== "NONE";
  const estimatedDumpDrop = Math.abs(change24h);

  return {
    inDumpZone,
    dumpDrop: estimatedDumpDrop,
    dumpConfidence
  };
}

/**
 * Detects reaction bounce at support (liquidity sweep + bullish confirmation).
 * Returns whether reaction is forming with strength metric.
 */
function resolveReactionDetection(row: TokenRsiResult): {
  reactionDetected: boolean;
  reactionStrength: number;
} {
  const microRsi = row.rsi;
  const microStochK = row.timeframes.microTrigger.stochK;
  const microTrend = row.timeframes.microTrigger.trend.direction;
  const volume = row.volume24h;

  // Reaction criteria:
  // 1. Long lower wick (liquidity sweep) → RSI < 30 but turning up
  const rsiCrossUp = microRsi < 30 && row.timeframes.microTrigger.stochK > row.timeframes.microTrigger.prevStochK;
  
  // 2. Strong bullish candle after drop
  const bullishCandle = microTrend === "UP" || (microStochK > row.timeframes.microTrigger.prevStochK && microStochK > 40);
  
  // 3. Volume spike on bounce
  const volumeSpike = volume > 0; // Simplified; in production, compare to 20-period MA

  const reactionSignals = [
    rsiCrossUp ? 1 : 0,
    bullishCandle ? 1 : 0,
    volumeSpike ? 1 : 0
  ].reduce((a, b) => a + b, 0);

  const reactionDetected = reactionSignals >= 2;
  const reactionStrength = reactionSignals / 3; // Normalized 0-1

  return {
    reactionDetected,
    reactionStrength
  };
}

/**
 * Detects structure shift: Higher Low (HL) followed by breakout above bounce high.
 * Returns confirmation status and key price levels.
 */
function resolveStructureShift(row: TokenRsiResult): {
  structureShiftConfirmed: boolean;
  highestLowAfterDump: number | null;
  lowestDumpPrice: number | null;
  bounceHigh: number | null;
} {
  // Simplified detection based on available data:
  // If microTrend is UP and price is above support, treat as structure shift forming
  const microTrend = row.timeframes.microTrigger.trend.direction;
  const intermediaryTrend = row.timeframes.intermediary.trend.direction;
  const supportDistance = row.levels.supportDistancePct ?? 0;
  
  // Structure shift confirmed when:
  // - Micro trend is UP (higher low forming)
  // - Intermediate trend is also UP or transitioning (breakout)
  // - Price not too close to support (confirms move up)
  const structureShiftConfirmed =
    microTrend === "UP" &&
    (intermediaryTrend === "UP" || supportDistance > 0.5) &&
    supportDistance < 5; // Not too far from support (confirms we bounced from it)

  return {
    structureShiftConfirmed,
    highestLowAfterDump: structureShiftConfirmed ? row.close : null,
    lowestDumpPrice: row.levels.localSupport,
    bounceHigh: row.levels.localResistance
  };
}

/**
 * Resolves complete dump-reversal state machine.
 * Transitions through: DUMP → REACTION → STRUCTURE → NORMAL
 */
function resolveDumpReversalContext(row: TokenRsiResult, direction: TradeDirection): {
  inDumpZone: boolean;
  dumpDrop: number;
  dumpConfidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  reactionDetected: boolean;
  reactionStrength: number;
  structureShiftConfirmed: boolean;
  highestLowAfterDump: number | null;
  lowestDumpPrice: number | null;
  bounceHigh: number | null;
  phase: "DUMP_IN_PROGRESS" | "REACTION_FORMING" | "STRUCTURE_CONFIRMED" | "NORMAL";
  stateMessage: string;
  confidenceMultiplier: number;
} {
  const dump = resolveDumpZone(row);
  const reaction = resolveReactionDetection(row);
  const structure = resolveStructureShift(row);

  // State machine logic
  let phase: "DUMP_IN_PROGRESS" | "REACTION_FORMING" | "STRUCTURE_CONFIRMED" | "NORMAL";
  let stateMessage: string;
  let confidenceMultiplier: number;

  if (dump.inDumpZone && !reaction.reactionDetected) {
    // Dump in progress, no bounce yet
    phase = "DUMP_IN_PROGRESS";
    stateMessage = "⚠️ Dump in progress — avoid catching bottom";
    confidenceMultiplier = 0.1; // Block longs
  } else if (dump.inDumpZone && reaction.reactionDetected && !structure.structureShiftConfirmed) {
    // Reaction detected, waiting for structure confirmation
    phase = "REACTION_FORMING";
    stateMessage = "🟡 Bounce detected — waiting for structure shift";
    confidenceMultiplier = 0.4; // Allow cautious positions
  } else if (dump.inDumpZone && reaction.reactionDetected && structure.structureShiftConfirmed) {
    // Full confirmation: structure shift after reaction
    phase = "STRUCTURE_CONFIRMED";
    stateMessage = "✅ Reversal confirmed — higher low + breakout forming";
    confidenceMultiplier = 0.9; // Allow normal entries
  } else {
    // No dump zone detected, normal market
    phase = "NORMAL";
    stateMessage = "";
    confidenceMultiplier = 1.0;
  }

  // For LONG entries, enforce these rules
  if (direction === "LONG" && phase === "DUMP_IN_PROGRESS") {
    // Block LONG during dump
    confidenceMultiplier = 0.1;
  }

  return {
    inDumpZone: dump.inDumpZone,
    dumpDrop: dump.dumpDrop,
    dumpConfidence: dump.dumpConfidence,
    reactionDetected: reaction.reactionDetected,
    reactionStrength: reaction.reactionStrength,
    structureShiftConfirmed: structure.structureShiftConfirmed,
    highestLowAfterDump: structure.highestLowAfterDump,
    lowestDumpPrice: structure.lowestDumpPrice,
    bounceHigh: structure.bounceHigh,
    phase,
    stateMessage,
    confidenceMultiplier
  };
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
  orderNotionalUsd: number,
  thresholdScale = 1
): boolean {
  const safeScale = Math.max(1, thresholdScale);
  const maxSpreadPct = getOrderBookSpreadLimitPct(symbol) * safeScale;
  const maxAgainstImbalance = getOrderBookMaxAgainstImbalance(symbol) * safeScale;
  const minDepthUsd = (Math.max(orderNotionalUsd, 0) * ORDERBOOK_MIN_DEPTH_MULTIPLIER) / safeScale;
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
  
  // Detect counter-trend conditions and apply confidence multiplier
  const counterTrendCtx = resolveCounterTrendContext(row, direction);
  const counterTrendConfidenceAdj = counterTrendCtx.confidenceMultiplier;
  
  // Populate the counterTrendContext field on the result for UI display
  if (!row.tradeContext.counterTrendContext) {
    row.tradeContext.counterTrendContext = counterTrendCtx;
  }

  // Detect dump-reversal phase and apply safety gate
  const dumpReversalCtx = resolveDumpReversalContext(row, direction);
  const dumpReversalConfidenceAdj = dumpReversalCtx.confidenceMultiplier;
  
  // Populate the dumpReversalContext field on the result for UI display
  if (!row.tradeContext.dumpReversalContext) {
    row.tradeContext.dumpReversalContext = dumpReversalCtx;
  }
  
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

  // Apply counter-trend confidence reduction when detected
  if (counterTrendCtx.isCounterTrend) {
    scoreRaw *= counterTrendConfidenceAdj;
  }

  // Apply dump-reversal confidence gate (prevents early longs during dumps)
  scoreRaw *= dumpReversalConfidenceAdj;

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

  const resistanceDistancePct = Number(row.levels.resistanceDistancePct ?? 0);
  if (!Number.isFinite(resistanceDistancePct) || resistanceDistancePct < PRE_PUMP_WATCH_MIN_RESISTANCE_DISTANCE_PCT) {
    return {
      eligible: false,
      reason: "too close to resistance (late)",
      details: {
        resistanceDistancePct,
        minRequired: PRE_PUMP_WATCH_MIN_RESISTANCE_DISTANCE_PCT
      }
    };
  }

  const twelvehTrend = row.timeframes.twelveh?.trend.direction ?? "MIXED";
  if (PRE_PUMP_WATCH_REQUIRE_RECOVERY_TREND && twelvehTrend === "DOWN") {
    return {
      eligible: false,
      reason: "recovery trend not established",
      details: {
        twelvehTrend
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

  const stochK = Number(row.timeframes.intermediary.stochK ?? 0);
  if (stochK > PRE_PUMP_WATCH_MAX_INTERMEDIARY_STOCH_K) {
    return {
      eligible: false,
      reason: "intermediary stoch too extended",
      details: {
        stochK,
        maxAllowed: PRE_PUMP_WATCH_MAX_INTERMEDIARY_STOCH_K
      }
    };
  }

  return {
    eligible: true,
    details: {
      volumeRatio: Number(volumeRatio.toFixed(3)),
      volume24h,
      minVolumeUsd,
      volatilityPercentile,
      intermediaryRsi,
      resistanceDistancePct,
      twelvehTrend,
      stochK,
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

  void dispatchRealtimeTelegramAlert({
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

function getMaxActiveTrades(balance: number, runtimeMode?: TradeRuntimeMode): number {
  const resolvedRuntimeMode = runtimeMode ?? getCurrentTradeRuntimeMode();
  const isSimulationRuntime = resolvedRuntimeMode === "SIM";

  if (FORCE_SINGLE_ACTIVE_TRADE) {
    return 1;
  }

  const planLimit = getAppAccessState().limits.maxActiveTrades;
  if (planLimit === 0) {
    return 0;
  }

  const useBalanceDrivenSimulationSizing = isSimulationRuntime && SIM_BALANCE_DRIVEN_SIZING_ENABLED;
  if (useBalanceDrivenSimulationSizing) {
    if (planLimit === 0) {
      return 0;
    }

    const balanceDrivenLimit = getBalanceDrivenSimMaxActiveTrades(balance);
    return balanceDrivenLimit;
  }

  if (isSimulationRuntime) {
    return planLimit > 0 ? Math.min(SIGNAL_SIM_MAX_ACTIVE_TRADES, planLimit) : SIGNAL_SIM_MAX_ACTIVE_TRADES;
  }

  const baseLimit = balance < LIVE_MULTI_TRADE_MIN_BALANCE_USD ? MAX_ACTIVE_TRADES_UNDER_1000 : MAX_ACTIVE_TRADES_AT_OR_ABOVE_1000;
  return planLimit > 0 ? Math.min(baseLimit, planLimit) : baseLimit;
}

function getBalanceDrivenSimMaxActiveTrades(balance: number): number {
  if (!Number.isFinite(balance) || balance <= 0) {
    return 0;
  }

  const slotSizeUsd = Math.max(1, SIGNAL_SIM_STAKE_USD);
  const slots = Math.floor(balance / slotSizeUsd);
  return Math.max(0, slots);
}

function getBalanceDrivenSimStakeUsd(balance: number, currentOpenCount: number): number {
  const maxActiveTrades = getBalanceDrivenSimMaxActiveTrades(balance);
  if (maxActiveTrades <= currentOpenCount) {
    return 0;
  }

  return Number(Math.max(0, Math.min(SIGNAL_SIM_STAKE_USD, balance)).toFixed(2));
}

function getPositionSizeUsd(
  balance: number,
  currentOpenCount: number,
  stopLossPct: number,
  leverage: number,
  riskPerTrade: number,
  runtimeMode?: TradeRuntimeMode
): number {
  const resolvedRuntimeMode = runtimeMode ?? getCurrentTradeRuntimeMode();
  const isSimulationRuntime = resolvedRuntimeMode === "SIM";
  const useBalanceDrivenSimulationSizing = isSimulationRuntime && SIM_BALANCE_DRIVEN_SIZING_ENABLED;
  if (useBalanceDrivenSimulationSizing) {
    return getBalanceDrivenSimStakeUsd(balance, currentOpenCount);
  }

  if (isSimulationRuntime) {
    return SIGNAL_SIM_STAKE_USD;
  }

  const maxActiveTrades = getMaxActiveTrades(balance, resolvedRuntimeMode);
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
      void dispatchRealtimeTelegramAlert({
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

  void dispatchRealtimeTelegramAlert({
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

type SimPendingLimitOrder = {
  key: string;
  token: string;
  direction: TradeDirection;
  limitPrice: number;
  createdAtMs: number;
  expiresAtMs: number;
  tradeTemplate: Trade;
  sourceSignalType: string;
};

type CachedLiveOpenReadinessContext = {
  fetchedAtMs: number;
  availableUsd: number;
  effectiveBalanceUsd: number;
  livePositions: BitunixPendingPosition[];
  maxActiveTrades: number;
};

function evaluateOpenTradeEligibility(
  token: string,
  direction: TradeDirection,
  nowMs: number,
  runtimeMode: TradeRuntimeMode,
  tenantId: string
): OpenTradeDecision {
  const key = getTradeKey(token, direction, runtimeMode, tenantId);
  const currentOpen = openTrades.get(key);
  if (currentOpen) {
    return {
      allow: false,
      reason: "duplicate active trade",
      details: { token, direction, runtimeMode, tenantId }
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
        runtimeMode,
        tenantId,
        duplicateWindowMinutes: Math.round(DUPLICATE_WINDOW_MS / 60000),
        cooldownRemainingMs: DUPLICATE_WINDOW_MS - (nowMs - lastOpened)
      }
    };
  }

  if (TEST_OPEN_MODE) {
    return { allow: true };
  }

  if (SYMBOL_REENTRY_COOLDOWN_MS > 0) {
    const normalizedToken = normalizePerpSymbol(token);
    const latestClosed = [...closedTrades]
      .reverse()
      .find((trade) => normalizePerpSymbol(trade.token) === normalizedToken);

    if (latestClosed) {
      const latestClosedMs = Date.parse(latestClosed.closeTime ?? latestClosed.openTime);
      if (Number.isFinite(latestClosedMs) && nowMs - latestClosedMs < SYMBOL_REENTRY_COOLDOWN_MS) {
        return {
          allow: false,
          reason: "symbol re-entry cooldown active",
          details: {
            token,
            direction,
            previousDirection: latestClosed.direction,
            previousStatus: latestClosed.status,
            previousCloseReason: latestClosed.closeReason,
            cooldownMinutes: Math.round(SYMBOL_REENTRY_COOLDOWN_MS / 60000),
            cooldownRemainingMs: SYMBOL_REENTRY_COOLDOWN_MS - (nowMs - latestClosedMs)
          }
        };
      }
    }
  }

  // Symbol-level hunt SL cooldown: fires when an orphan limit-fill position was closed by
  // drawdown protection (exchange SL hit). Prevents immediate re-entry for the same period
  // as SYMBOL_FAST_SL_COOLDOWN_MINUTES even if closedTrades has no record of the loss.
  const huntOrphanSLAt = lastHuntOrphanSLBySymbol.get(token);
  if (typeof huntOrphanSLAt === "number") {
    const orphanSLCooldownMs = SYMBOL_FAST_SL_COOLDOWN_MINUTES * 60 * 1000;
    if (nowMs - huntOrphanSLAt < orphanSLCooldownMs) {
      return {
        allow: false,
        reason: "symbol hunt SL cooldown active",
        details: {
          token,
          direction,
          cooldownMinutes: SYMBOL_FAST_SL_COOLDOWN_MINUTES,
          cooldownRemainingMs: orphanSLCooldownMs - (nowMs - huntOrphanSLAt)
        }
      };
    }
  }

  if (TRADE_FLIP_COOLDOWN_MS > 0) {
    const oppositeDirection: TradeDirection = direction === "LONG" ? "SHORT" : "LONG";
    const oppositeKey = getTradeKey(token, oppositeDirection, runtimeMode, tenantId);
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
  if (SESSION_BLOCK_START_UTC === SESSION_BLOCK_END_UTC) {
    return false;
  }

  const utcHour = new Date(nowMs).getUTCHours();
  if (SESSION_BLOCK_START_UTC < SESSION_BLOCK_END_UTC) {
    return utcHour >= SESSION_BLOCK_START_UTC && utcHour < SESSION_BLOCK_END_UTC;
  }

  // Supports wrapped windows (for example 22 -> 2).
  return utcHour >= SESSION_BLOCK_START_UTC || utcHour < SESSION_BLOCK_END_UTC;
}

function getAdaptiveScoreThreshold(baseThreshold: number, volatilityPct?: number): number {
  const rolling = [...closedTrades]
    .sort((a, b) => Date.parse(b.closeTime ?? b.openTime) - Date.parse(a.closeTime ?? a.openTime))
    .slice(0, MAX_ROLLING_PERFORMANCE_TRADES)
    .filter((trade) => trade.status === "WIN" || trade.status === "LOSS");

  let adaptiveThreshold = baseThreshold;

  if (rolling.length >= MAX_ROLLING_PERFORMANCE_TRADES) {
    const wins = rolling.filter((trade) => trade.status === "WIN").length;
    const winRate = (wins / rolling.length) * 100;

    if (winRate < 40) {
      adaptiveThreshold = baseThreshold + 1;
    } else if (winRate > 60) {
      adaptiveThreshold = Math.max(baseThreshold, baseThreshold - 0.5);
    }
  }

  if (Number.isFinite(volatilityPct)) {
    if ((volatilityPct ?? 0) > 2) {
      adaptiveThreshold = Math.min(adaptiveThreshold, 4);
    } else if ((volatilityPct ?? 0) < 1.5) {
      adaptiveThreshold = Math.max(adaptiveThreshold, 5);
    }
  }

  return adaptiveThreshold;
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
  if (!isLiveTradingEnabled()) {
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

function updateLiquidityHuntTrailingStop(trade: Trade): void {
  if (!LIQUIDITY_HUNT_TRAILING_STOP_ENABLED) {
    return;
  }
  if (!String(trade.signalType ?? "").includes("LIQUIDITY_HUNT")) {
    return;
  }

  const currentPrice = Number(trade.currentPrice ?? 0);
  const entryPrice = Number(trade.entryPrice ?? 0);
  const leverage = Math.max(1, Number(trade.leverage ?? LIQUIDITY_HUNT_ENTRY_LEVERAGE));
  const currentPnlPct = Number(trade.currentPnlPct ?? 0);

  if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return;
  }
  if (currentPnlPct < LIQUIDITY_HUNT_TRAILING_ACTIVATION_PNL_PCT) {
    return;
  }

  const trailingGapUnderlying = LIQUIDITY_HUNT_TRAILING_GAP_PNL_PCT / leverage / 100;
  const breakEvenPrice = entryPrice;

  if (trade.direction === "LONG") {
    const trailingCandidate = currentPrice * (1 - trailingGapUnderlying);
    const candidate = currentPnlPct >= LIQUIDITY_HUNT_BREAK_EVEN_TRIGGER_PNL_PCT
      ? Math.max(trailingCandidate, breakEvenPrice)
      : trailingCandidate;

    if (Number.isFinite(candidate) && candidate > 0 && candidate > trade.slPrice) {
      trade.slPrice = toNumber(candidate);
      trade.stopLossPct = calcLeveragedMovePct(entryPrice, trade.slPrice, leverage);
      trade.slDistance = Math.abs(trade.slPrice - entryPrice);
    }
    return;
  }

  const trailingCandidate = currentPrice * (1 + trailingGapUnderlying);
  const candidate = currentPnlPct >= LIQUIDITY_HUNT_BREAK_EVEN_TRIGGER_PNL_PCT
    ? Math.min(trailingCandidate, breakEvenPrice)
    : trailingCandidate;

  if (Number.isFinite(candidate) && candidate > 0 && candidate < trade.slPrice) {
    trade.slPrice = toNumber(candidate);
    trade.stopLossPct = calcLeveragedMovePct(entryPrice, trade.slPrice, leverage);
    trade.slDistance = Math.abs(trade.slPrice - entryPrice);
  }
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
  trade.tenantId = normalizeTenantId(trade.tenantId);

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
  const activeAll = Array.from(openTrades.values());
  const tenantIds = new Set<string>([DEFAULT_TRADE_TENANT_ID]);
  for (const trade of activeAll) {
    tenantIds.add(getTradeTenantId(trade));
  }
  for (const trade of closedTrades) {
    tenantIds.add(getTradeTenantId(trade));
  }

  const persistTasks = Array.from(tenantIds).map(async (tenantId) => {
    const active = activeAll.filter((trade) => isTradeInTenant(trade, tenantId));
    const tenantClosed = closedTrades.filter((trade) => isTradeInTenant(trade, tenantId));
    const recentClosed = [...tenantClosed]
      .sort((a, b) => Date.parse(b.closeTime ?? b.openTime) - Date.parse(a.closeTime ?? a.openTime))
      .slice(0, MAX_CLOSED_TRADES);
    const stats = computeStats(active, tenantClosed);

    await persistTradeRuntimeState(tenantId, {
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
    });
  });

  void Promise.all(persistTasks).catch((error) => {
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

  const persistedStates = await loadAllTradeRuntimeStates();
  hydratedFromStorage = true;
  if (persistedStates.length === 0) {
    return;
  }

  const persisted = persistedStates.find((state) => state.tenantId === DEFAULT_TRADE_TENANT_ID) ?? persistedStates[0];

  accountBalanceUsd = Number((persisted.accountBalanceUsd || SIM_INITIAL_CAPITAL_USD).toFixed(2));
  dailyStartBalanceUsd = Number((persisted.dailyStartBalanceUsd || accountBalanceUsd).toFixed(2));
  dailyStartKeyUtc = new Date().toISOString().slice(0, 10);

  openTrades.clear();
  closedTrades.length = 0;
  lastOpenedByKey.clear();
  lastHuntOrphanSLBySymbol.clear();
  simPendingLimitOrdersByKey.clear();

  for (const state of persistedStates) {
    for (const trade of state.openTrades) {
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

      const key = getTradeKeyForTrade(trade);
      openTrades.set(key, trade);
      const openTs = Date.parse(trade.openTime);
      if (Number.isFinite(openTs)) {
        const current = lastOpenedByKey.get(key) ?? 0;
        if (openTs > current) {
          lastOpenedByKey.set(key, openTs);
        }
      }
    }

    for (const trade of state.recentClosedTrades) {
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
      const key = getTradeKeyForTrade(trade);
      const openTs = Date.parse(trade.openTime);
      if (Number.isFinite(openTs)) {
        const current = lastOpenedByKey.get(key) ?? 0;
        if (openTs > current) {
          lastOpenedByKey.set(key, openTs);
        }
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
      if (isLivePositionAlreadyAbsentError(error)) {
        const stillOpenOnExchange = await isLivePositionStillOpenForTrade(trade);
        if (stillOpenOnExchange) {
          alertLiveExecutionFailure({
            symbol: trade.token,
            direction: trade.direction,
            phase: "CLOSE",
            reason: `${liveCloseReason}; exchange still reports open position`,
            signalType: trade.signalType,
            entryPrice: trade.entryPrice,
            tpPrice: trade.tpPrice,
            slPrice: trade.slPrice
          });
          throw new Error(
            `Live close aborted for ${trade.token} ${trade.direction}: exchange still reports open position; local close blocked`
          );
        }

        console.warn("[trade-engine] Live close reconciliation: exchange position absent; continuing local close", {
          symbol: trade.token,
          direction: trade.direction,
          reason,
          tradeId: trade.id,
          liveCloseReason
        });
      } else {
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

  openTrades.delete(getTradeKeyForTrade(trade));
  closedTrades.push({ ...trade });
  if (!SIM_SIGNAL_ONLY_MODE) {
    const netClosePnlUsd = Number(((trade.resultUsd ?? 0) - (trade.closeFeeUsd ?? 0)).toFixed(2));
    accountBalanceUsd = Number((accountBalanceUsd + netClosePnlUsd).toFixed(2));
  }

  void sendTradeLifecycleTelegram({
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
  }, Boolean(trade.isLiveTrade), trade);

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
  flowScore: number;
  longFlowScore: number;
  shortFlowScore: number;
  volumeProfileProxyScore: number;
  longStopLiquidityUsd: number;
  shortStopLiquidityUsd: number;
} {
  const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
  const supportDistance = Number(row.levels.supportDistancePct ?? 100);
  const resistanceDistance = Number(row.levels.resistanceDistancePct ?? 100);
  const supportCloseness = clamp01(1 - supportDistance / 3.5);
  const resistanceCloseness = clamp01(1 - resistanceDistance / 3.5);

  const volatilityFactor = clamp01(Number(row.tradeContext?.volatilityPercentile ?? 0) / 100);
  const liquidityFactor = clamp01(Number(row.tradeContext?.liquidityPercentile ?? 0) / 100);
  const compressionFactor = clamp01(1 - Number(row.tradeContext?.rangeCompression ?? 0));
  const atrExpansionFactor = clamp01(Number(row.tradeContext?.atrExpansion ?? 0));
  const trendPersistence = clamp01(Number(row.tradeContext?.trendPersistence4h ?? 0));

  // Phase 3 proxy for volume profile interaction using available runtime features.
  const volumeProfileProxyScore = clamp01(
    liquidityFactor * 0.45 + compressionFactor * 0.25 + atrExpansionFactor * 0.15 + trendPersistence * 0.15
  );

  const imbalance = Math.max(-1, Math.min(1, Number(row.tradeContext?.orderBookImbalance ?? 0)));
  const bidDominance = Math.max(0, imbalance);
  const askDominance = Math.max(0, -imbalance);

  const macroMacd = Number(row.timeframes.macro?.macdHist ?? 0);
  const intermediaryMacd = Number(row.timeframes.intermediary?.macdHist ?? 0);
  const reversalPressureLong = clamp01((-macroMacd + -intermediaryMacd) * 4);
  const reversalPressureShort = clamp01((macroMacd + intermediaryMacd) * 4);

  const intermediaryRsi = Number(row.timeframes.intermediary?.rsi ?? 50);
  const oversoldFactor = clamp01((45 - intermediaryRsi) / 20);
  const overboughtFactor = clamp01((intermediaryRsi - 55) / 20);

  // Phase 1/2 MM flow core: infer sweep/absorption direction from order-book + liquidity pressure.
  const longFlowScore = clamp01(
    supportCloseness * 0.27
    + bidDominance * 0.18
    + oversoldFactor * 0.12
    + reversalPressureLong * 0.08
    + volatilityFactor * 0.10
    + volumeProfileProxyScore * 0.25
  );
  const shortFlowScore = clamp01(
    resistanceCloseness * 0.27
    + askDominance * 0.18
    + overboughtFactor * 0.12
    + reversalPressureShort * 0.08
    + volatilityFactor * 0.10
    + volumeProfileProxyScore * 0.25
  );

  const diff = shortFlowScore - longFlowScore;
  const likelySide = Math.abs(diff) < 0.08
    ? "BALANCED"
    : diff > 0
      ? "UPPER_SWEEP"
      : "LOWER_SWEEP";

  const orderBookLongTilt = clamp01((imbalance + 1) / 2);
  const estimatedLongRaw = longFlowScore * 0.78 + orderBookLongTilt * 0.22;
  const estimatedShortRaw = shortFlowScore * 0.78 + (1 - orderBookLongTilt) * 0.22;
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
    huntScore: Math.round(Math.max(longFlowScore, shortFlowScore) * 100),
    flowScore: Math.round(Math.max(longFlowScore, shortFlowScore) * 100),
    longFlowScore: Math.round(longFlowScore * 100),
    shortFlowScore: Math.round(shortFlowScore * 100),
    volumeProfileProxyScore: Math.round(volumeProfileProxyScore * 100),
    longStopLiquidityUsd,
    shortStopLiquidityUsd
  };
}

async function evaluateLiquidityHuntEntry(
  row: TokenRsiResult,
  nowMs: number,
  tenantId: string,
  runtimeMode: TradeRuntimeMode
): Promise<{
  shouldOpen: boolean;
  direction: TradeDirection | null;
  slLevel: number;
  limitEntryPrice: number;
  preSweepEntry: boolean;
  triggerZone: "SUPPORT" | "RESISTANCE" | null;
  breakPct: number;
  huntScore: number;
  flowScore: number;
  likelySweepSide: "UPPER_SWEEP" | "LOWER_SWEEP" | "BALANCED";
  longStopLiquidityUsd: number;
  shortStopLiquidityUsd: number;
}> {
  void nowMs;
  const directionalBias = resolveLiquidityHuntDirectionalBias(row);
  const totalStopLiquidityPoolUsd = directionalBias.longStopLiquidityUsd + directionalBias.shortStopLiquidityUsd;
  const tokenMaxLeverage = Number(row.maxLeverage ?? NaN);

  const noOpen = {
    shouldOpen: false as const,
    direction: null,
    slLevel: 0,
    limitEntryPrice: 0,
    preSweepEntry: false,
    triggerZone: null,
    breakPct: 0,
    huntScore: directionalBias.huntScore,
    flowScore: directionalBias.flowScore,
    likelySweepSide: directionalBias.likelySide,
    longStopLiquidityUsd: directionalBias.longStopLiquidityUsd,
    shortStopLiquidityUsd: directionalBias.shortStopLiquidityUsd
  };

  const regime = row.tradeContext?.regime ?? "CHOPPY";

  const isAllowedLiquidityHuntRegime = (currentRegime: MarketRegime): boolean => {
    if (currentRegime === "TRENDING" || currentRegime === "EXPANSION") {
      return true;
    }

    if (
      currentRegime === "CHOPPY" &&
      LIQUIDITY_HUNT_ALLOW_CHOPPY_WITH_HIGH_CONFIDENCE &&
      directionalBias.huntScore >= LIQUIDITY_HUNT_CHOPPY_MIN_HUNT_SCORE
    ) {
      return true;
    }

    return false;
  };

  const isDirectionZoneCompatible = (
    direction: TradeDirection,
    zone: "SUPPORT" | "RESISTANCE"
  ): boolean =>
    (direction === "LONG" && zone === "SUPPORT") ||
    (direction === "SHORT" && zone === "RESISTANCE");

  if (!LIQUIDITY_HUNT_ENTRY_ENABLED) {
    logLiquidityHuntMiss(row, "liquidity hunt disabled", {
      enabled: false,
      huntScore: directionalBias.huntScore,
      likelySweepSide: directionalBias.likelySide,
      maxLeverage: row.maxLeverage ?? null
    });
    return noOpen;
  }

  if (!isAllowedLiquidityHuntRegime(regime)) {
    logLiquidityHuntMiss(row, "liquidity hunt blocked by market regime", {
      regime,
      allowedRegimes: LIQUIDITY_HUNT_ALLOW_CHOPPY_WITH_HIGH_CONFIDENCE
        ? ["TRENDING", "EXPANSION", `CHOPPY(score>=${LIQUIDITY_HUNT_CHOPPY_MIN_HUNT_SCORE})`]
        : ["TRENDING", "EXPANSION"],
      blockedRegimes: ["LOW_VOL"],
      choppyOverrideEnabled: LIQUIDITY_HUNT_ALLOW_CHOPPY_WITH_HIGH_CONFIDENCE,
      choppyMinHuntScore: LIQUIDITY_HUNT_CHOPPY_MIN_HUNT_SCORE,
      huntScore: directionalBias.huntScore,
      likelySweepSide: directionalBias.likelySide
    });
    return noOpen;
  }

  // Gate: 24h change band filter — only trade tokens with meaningful momentum but not blow-off
  const change24hPct = row.change24hPct;
  if (change24hPct !== undefined) {
    const absChange = Math.abs(change24hPct);
    if (absChange < LIQUIDITY_HUNT_MIN_24H_CHANGE_PCT || absChange > LIQUIDITY_HUNT_MAX_24H_CHANGE_PCT) {
      logLiquidityHuntMiss(row, "liquidity hunt 24h change outside band", {
        change24hPct: Number(change24hPct.toFixed(2)),
        absChange: Number(absChange.toFixed(2)),
        min: LIQUIDITY_HUNT_MIN_24H_CHANGE_PCT,
        max: LIQUIDITY_HUNT_MAX_24H_CHANGE_PCT,
        huntScore: directionalBias.huntScore,
        likelySweepSide: directionalBias.likelySide
      });
      return noOpen;
    }
  }

  const minStopLiquidityPoolUsd = getLiquidityHuntMinStopPoolUsdForSymbol(row.symbol);
  const volume24h = Math.max(0, Number(row.tradeContext?.volume24h ?? row.volume24h ?? 0));

  if (volume24h < LIQUIDITY_HUNT_HARD_MIN_VOLUME_USD) {
    logLiquidityHuntMiss(row, "liquidity hunt 24h volume below hard floor", {
      volume24h: Number(volume24h.toFixed(2)),
      hardMinVolumeUsd: LIQUIDITY_HUNT_HARD_MIN_VOLUME_USD,
      huntScore: directionalBias.huntScore,
      likelySweepSide: directionalBias.likelySide,
      maxLeverage: row.maxLeverage ?? null
    });
    return noOpen;
  }

  if (totalStopLiquidityPoolUsd < minStopLiquidityPoolUsd) {
    logLiquidityHuntMiss(row, "liquidity hunt stop pool below threshold", {
      totalStopLiquidityPoolUsd: Number(totalStopLiquidityPoolUsd.toFixed(2)),
      minStopLiquidityPoolUsd,
      huntScore: directionalBias.huntScore,
      likelySweepSide: directionalBias.likelySide,
      maxLeverage: row.maxLeverage ?? null
    });
    return noOpen;
  }

  const minHuntScoreThreshold = Math.max(LIQUIDITY_HUNT_MIN_CONFIDENCE_PCT, LIQUIDITY_HUNT_MIN_HUNT_SCORE);
  const effectiveScoreThreshold = Math.max(minHuntScoreThreshold, LIQUIDITY_HUNT_MM_FLOW_MIN_SCORE);
  if (directionalBias.huntScore < effectiveScoreThreshold) {
    logLiquidityHuntMiss(row, "liquidity hunt MM flow score below threshold", {
      huntScore: directionalBias.huntScore,
      flowScore: directionalBias.flowScore,
      longFlowScore: directionalBias.longFlowScore,
      shortFlowScore: directionalBias.shortFlowScore,
      volumeProfileProxyScore: directionalBias.volumeProfileProxyScore,
      minConfidencePct: LIQUIDITY_HUNT_MIN_CONFIDENCE_PCT,
      minHuntScore: LIQUIDITY_HUNT_MIN_HUNT_SCORE,
      minMmFlowScore: LIQUIDITY_HUNT_MM_FLOW_MIN_SCORE,
      effectiveMinThreshold: effectiveScoreThreshold,
      totalStopLiquidityPoolUsd: Number(totalStopLiquidityPoolUsd.toFixed(2)),
      likelySweepSide: directionalBias.likelySide,
      maxLeverage: row.maxLeverage ?? null
    });
    return noOpen;
  }

  if (!Number.isFinite(tokenMaxLeverage) || tokenMaxLeverage < LIQUIDITY_HUNT_MIN_TOKEN_MAX_LEVERAGE) {
    logLiquidityHuntMiss(row, "liquidity hunt leverage below threshold", {
      tokenMaxLeverage: Number.isFinite(tokenMaxLeverage) ? tokenMaxLeverage : null,
      minTokenMaxLeverage: LIQUIDITY_HUNT_MIN_TOKEN_MAX_LEVERAGE,
      huntScore: directionalBias.huntScore,
      likelySweepSide: directionalBias.likelySide,
      totalStopLiquidityPoolUsd: Number(totalStopLiquidityPoolUsd.toFixed(2))
    });
    return noOpen;
  }

  const close = Number(row.close ?? 0);
  const support = Number(row.levels.localSupport ?? 0);
  const resistance = Number(row.levels.localResistance ?? 0);

  if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(support) || support <= 0 || !Number.isFinite(resistance) || resistance <= 0) {
    logLiquidityHuntMiss(row, "liquidity hunt invalid level data", {
      close,
      support,
      resistance,
      huntScore: directionalBias.huntScore,
      likelySweepSide: directionalBias.likelySide,
      maxLeverage: Number.isFinite(tokenMaxLeverage) ? tokenMaxLeverage : null
    });
    return noOpen;
  }

  const symbol = normalizePerpSymbol(row.symbol);

  // Choose the active hunt level from directional bias.
  // LOWER_SWEEP -> long-side stop zone (support).
  // UPPER_SWEEP -> short-side stop zone (resistance).
  // BALANCED -> whichever level is closer.
  let targetLevel = support;
  let triggerZone: "SUPPORT" | "RESISTANCE" = "SUPPORT";
  if (directionalBias.likelySide === "UPPER_SWEEP") {
    targetLevel = resistance;
    triggerZone = "RESISTANCE";
  } else if (directionalBias.likelySide === "BALANCED") {
    const supportDistancePct = Math.abs((close - support) / close) * 100;
    const resistanceDistancePct = Math.abs((resistance - close) / close) * 100;
    if (resistanceDistancePct < supportDistancePct) {
      targetLevel = resistance;
      triggerZone = "RESISTANCE";
    }
  }

  const upperBand = targetLevel * (1 + LIQUIDITY_HUNT_PRE_SWEEP_OFFSET_PCT / 100);
  const lowerBand = targetLevel * (1 - LIQUIDITY_HUNT_PRE_SWEEP_OFFSET_PCT / 100);
  const distanceToLevelPct = Math.abs((close - targetLevel) / close) * 100;
  const flowDistanceBoostFactor = Math.max(0, Math.min(1, (directionalBias.flowScore - 50) / 50));
  const dynamicEntryDistancePct = LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT
    + (LIQUIDITY_HUNT_MM_FLOW_ENTRY_DISTANCE_BOOST_MAX * flowDistanceBoostFactor);
  const withinBand = close >= lowerBand && close <= upperBand;

  const resolveHuntDirection = (): TradeDirection => {
    // Hard rule alignment: support setups are long, resistance setups are short.
    return triggerZone === "SUPPORT" ? "LONG" : "SHORT";
  };
  const entryDirection = resolveHuntDirection();
  const directionalStopLiquidityUsd =
    entryDirection === "LONG" ? directionalBias.longStopLiquidityUsd : directionalBias.shortStopLiquidityUsd;
  const minDirectionalStopLiquidityUsd =
    minStopLiquidityPoolUsd * LIQUIDITY_HUNT_MIN_DIRECTIONAL_STOP_LIQUIDITY_MULTIPLIER;

  if (directionalStopLiquidityUsd < minDirectionalStopLiquidityUsd) {
    logLiquidityHuntMiss(row, "liquidity hunt directional stop liquidity below floor", {
      direction: entryDirection,
      directionalStopLiquidityUsd: Number(directionalStopLiquidityUsd.toFixed(2)),
      minDirectionalStopLiquidityUsd: Number(minDirectionalStopLiquidityUsd.toFixed(2)),
      minStopLiquidityPoolUsd,
      directionalLiquidityMultiplier: LIQUIDITY_HUNT_MIN_DIRECTIONAL_STOP_LIQUIDITY_MULTIPLIER,
      totalStopLiquidityPoolUsd: Number(totalStopLiquidityPoolUsd.toFixed(2)),
      huntScore: directionalBias.huntScore,
      likelySweepSide: directionalBias.likelySide
    }, entryDirection);
    return noOpen;
  }

  // ==== FATAL WARNING VETOES (IDOL TOKEN LOGIC FIX) ====
  // Block SHORT entries that are risky based on three hard rules:
  // 1. Real distance to support is too small (price near floor)
  // 2. Intermediary Stochastic K > 90 (massive upward underlying momentum)
  // 3. Short hunt target level is dangerously high (market wants upside break)
  const performShortVetoCheck = (): { blocked: boolean; reason?: string } => {
    // Only apply to SHORT entries
    const prelimDirection = resolveHuntDirection();
    if (prelimDirection !== "SHORT") {
      return { blocked: false };
    }

    // Veto 1: Real distance to support must be > 5% (cushion against floor)
    const realDistanceToSupport = ((close - support) / close) * 100;
    if (realDistanceToSupport < 5) {
      return {
        blocked: true,
        reason: `SHORT veto: Real distance to support is only ${realDistanceToSupport.toFixed(2)}% (need >= 5%). Price ${close.toFixed(6)} is too close to floor at ${support.toFixed(6)}.`
      };
    }

    // Veto 2: Intermediary (1H) Stochastic K must be <= 90 (avoid overbought reversal)
    const intermediaryStochK = Number(row.timeframes.intermediary?.stochK ?? 0);
    if (intermediaryStochK > 90) {
      return {
        blocked: true,
        reason: `SHORT veto: Intermediary Stochastic K is ${intermediaryStochK.toFixed(1)} (> 90). Massive upward underlying momentum blocks short entries.`
      };
    }

    // Veto 3: Short hunt target level (resistance) must not be too far above current price
    // If hunt top is > 13% above price, market is signaling upside breakout bias
    const shortHuntTargetDistance = ((resistance - close) / close) * 100;
    if (shortHuntTargetDistance > 13) {
      return {
        blocked: true,
        reason: `SHORT veto: Short hunt target at ${resistance.toFixed(6)} is ${shortHuntTargetDistance.toFixed(2)}% above price (> 13%). Market likely to squeeze upward to clear stops.`
      };
    }

    return { blocked: false };
  };

  // Strategy clarified by user:
  // - price 1-2% ABOVE target level -> open SHORT toward level
  // - price 1-2% BELOW target level -> open LONG toward level
  // This is a pre-level approach setup (not post-break continuation).
  if (withinBand && distanceToLevelPct <= dynamicEntryDistancePct) {
    const direction = entryDirection;
    if (!isDirectionZoneCompatible(direction, triggerZone)) {
      logLiquidityHuntMiss(row, "liquidity hunt direction-zone mismatch", {
        direction,
        triggerZone,
        huntScore: directionalBias.huntScore,
        likelySweepSide: directionalBias.likelySide,
        entryMode: LIQUIDITY_HUNT_ENTRY_MODE
      }, direction);
      return noOpen;
    }
    if (LIQUIDITY_HUNT_EXPECTED_MOVE_GATE_ENABLED) {
      // Fetch live volatility from Bitunix for real-time gate evaluation
      const liveVolatility = await computeLiveVolatilityFromBitunix(symbol);
      
      // Check minimum volatility floor to avoid flat, low-move tokens
      if (liveVolatility < LIQUIDITY_HUNT_MIN_LIVE_VOLATILITY_PCT) {
        logLiquidityHuntMiss(row, "liquidity hunt live volatility below floor", {
          close,
          targetLevel,
          liveVolatilityPct: liveVolatility,
          minLiveVolatilityPct: LIQUIDITY_HUNT_MIN_LIVE_VOLATILITY_PCT,
          huntScore: directionalBias.huntScore,
          likelySweepSide: directionalBias.likelySide
        }, direction);
        return noOpen;
      }
      
      const expectedMove = evaluateLiquidityHuntExpectedMove(row, direction, close, targetLevel, liveVolatility);
      if (!expectedMove.allow) {
        logLiquidityHuntMiss(row, "liquidity hunt expected move below TP requirement", {
          close,
          targetLevel,
          huntScore: directionalBias.huntScore,
          likelySweepSide: directionalBias.likelySide,
          ...expectedMove.details
        }, direction);
        return noOpen;
      }
    }
    
    // Apply fatal warning vetoes before proceeding
    const vetoCheck = performShortVetoCheck();
    if (vetoCheck.blocked) {
      logLiquidityHuntMiss(row, vetoCheck.reason ?? "liquidity hunt SHORT blocked by veto", {
        direction,
        targetLevel,
        close,
        support,
        resistance,
        realDistanceToSupport: ((close - support) / close) * 100,
        intermediaryStochK: Number(row.timeframes.intermediary?.stochK ?? 0),
        shortHuntTargetDistance: ((resistance - close) / close) * 100,
        huntScore: directionalBias.huntScore,
        likelySweepSide: directionalBias.likelySide
      }, direction);
      return noOpen;
    }
    const limitEntryPrice = Number((direction === "SHORT" ? upperBand : lowerBand).toFixed(6));

    // Avoid stale short LIMIT entries after the downside move has already started.
    // For SHORT in LIMIT pre-sweep mode, only stage while price is at/above the limit entry.
    if (
      LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE === "LIMIT" &&
      direction === "SHORT" &&
      close < limitEntryPrice
    ) {
      logLiquidityHuntMiss(row, "liquidity hunt short limit stale (price already below entry)", {
        direction,
        targetLevel,
        close,
        limitEntryPrice,
        distanceToLevelPct: Number(distanceToLevelPct.toFixed(4)),
        lowerBand: Number(lowerBand.toFixed(6)),
        upperBand: Number(upperBand.toFixed(6)),
        huntScore: directionalBias.huntScore,
        likelySweepSide: directionalBias.likelySide,
        entryMode: LIQUIDITY_HUNT_ENTRY_MODE,
        preSweepExecutionMode: LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE
      }, direction);
      return noOpen;
    }

    // Avoid stale long LIMIT entries after the bounce has already started.
    // For LONG in LIMIT pre-sweep mode, only stage while price is at/below the limit entry.
    if (
      LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE === "LIMIT" &&
      direction === "LONG" &&
      close > limitEntryPrice
    ) {
      logLiquidityHuntMiss(row, "liquidity hunt long limit stale (price already above entry)", {
        direction,
        targetLevel,
        close,
        limitEntryPrice,
        distanceToLevelPct: Number(distanceToLevelPct.toFixed(4)),
        lowerBand: Number(lowerBand.toFixed(6)),
        upperBand: Number(upperBand.toFixed(6)),
        huntScore: directionalBias.huntScore,
        likelySweepSide: directionalBias.likelySide,
        entryMode: LIQUIDITY_HUNT_ENTRY_MODE,
        preSweepExecutionMode: LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE
      }, direction);
      return noOpen;
    }

    if (!openTrades.has(getTradeKey(symbol, direction, runtimeMode, tenantId))) {
      return {
        shouldOpen: true,
        direction,
        slLevel: targetLevel,
        limitEntryPrice,
        preSweepEntry: true,
        triggerZone,
        breakPct: 0,
        huntScore: directionalBias.huntScore,
        flowScore: directionalBias.flowScore,
        likelySweepSide: directionalBias.likelySide,
        longStopLiquidityUsd: directionalBias.longStopLiquidityUsd,
        shortStopLiquidityUsd: directionalBias.shortStopLiquidityUsd
      };
    }

    logLiquidityHuntMiss(row, "liquidity hunt duplicate active trade", {
      direction,
      targetLevel,
      close,
      distanceToLevelPct: Number(distanceToLevelPct.toFixed(4)),
      lowerBand: Number(lowerBand.toFixed(6)),
      upperBand: Number(upperBand.toFixed(6)),
      huntScore: directionalBias.huntScore,
      likelySweepSide: directionalBias.likelySide,
      maxLeverage: Number.isFinite(tokenMaxLeverage) ? tokenMaxLeverage : null
    }, direction);
    return noOpen;
  }

  // Optional legacy behavior: allow post-level entries when explicitly enabled.
  if (!LIQUIDITY_HUNT_PRE_SWEEP_ONLY && distanceToLevelPct <= dynamicEntryDistancePct) {
    const direction = entryDirection;
    if (!isDirectionZoneCompatible(direction, triggerZone)) {
      logLiquidityHuntMiss(row, "liquidity hunt direction-zone mismatch", {
        direction,
        triggerZone,
        huntScore: directionalBias.huntScore,
        likelySweepSide: directionalBias.likelySide,
        entryMode: LIQUIDITY_HUNT_ENTRY_MODE
      }, direction);
      return noOpen;
    }
    if (LIQUIDITY_HUNT_EXPECTED_MOVE_GATE_ENABLED) {
      const liveVolatility = await computeLiveVolatilityFromBitunix(symbol);
      
      // Check minimum volatility floor
      if (liveVolatility < LIQUIDITY_HUNT_MIN_LIVE_VOLATILITY_PCT) {
        logLiquidityHuntMiss(row, "liquidity hunt live volatility below floor", {
          close,
          targetLevel,
          liveVolatilityPct: liveVolatility,
          minLiveVolatilityPct: LIQUIDITY_HUNT_MIN_LIVE_VOLATILITY_PCT,
          huntScore: directionalBias.huntScore,
          likelySweepSide: directionalBias.likelySide
        }, direction);
        return noOpen;
      }
      
      const expectedMove = evaluateLiquidityHuntExpectedMove(row, direction, close, targetLevel, liveVolatility);
      if (!expectedMove.allow) {
        logLiquidityHuntMiss(row, "liquidity hunt expected move below TP requirement", {
          close,
          targetLevel,
          huntScore: directionalBias.huntScore,
          likelySweepSide: directionalBias.likelySide,
          ...expectedMove.details
        }, direction);
        return noOpen;
      }
    }
    
    // Apply fatal warning vetoes before proceeding (same as pre-sweep)
    const vetoCheck = performShortVetoCheck();
    if (vetoCheck.blocked) {
      logLiquidityHuntMiss(row, vetoCheck.reason ?? "liquidity hunt SHORT blocked by veto", {
        direction,
        targetLevel,
        close,
        support,
        resistance,
        realDistanceToSupport: ((close - support) / close) * 100,
        intermediaryStochK: Number(row.timeframes.intermediary?.stochK ?? 0),
        shortHuntTargetDistance: ((resistance - close) / close) * 100,
        huntScore: directionalBias.huntScore,
        likelySweepSide: directionalBias.likelySide
      }, direction);
      return noOpen;
    }
    
    if (!openTrades.has(getTradeKey(symbol, direction, runtimeMode, tenantId))) {
      return {
        shouldOpen: true,
        direction,
        slLevel: targetLevel,
        limitEntryPrice: close,
        preSweepEntry: false,
        triggerZone,
        breakPct: 0,
        huntScore: directionalBias.huntScore,
        flowScore: directionalBias.flowScore,
        likelySweepSide: directionalBias.likelySide,
        longStopLiquidityUsd: directionalBias.longStopLiquidityUsd,
        shortStopLiquidityUsd: directionalBias.shortStopLiquidityUsd
      };
    }

    logLiquidityHuntMiss(row, "liquidity hunt duplicate active trade", {
      direction,
      targetLevel,
      close,
      distanceToLevelPct: Number(distanceToLevelPct.toFixed(4)),
      lowerBand: Number(lowerBand.toFixed(6)),
      upperBand: Number(upperBand.toFixed(6)),
      huntScore: directionalBias.huntScore,
      likelySweepSide: directionalBias.likelySide,
      maxLeverage: Number.isFinite(tokenMaxLeverage) ? tokenMaxLeverage : null
    }, direction);
    return noOpen;
  }

  logLiquidityHuntMiss(row, "liquidity hunt outside entry band", {
    targetLevel,
    close,
    distanceToLevelPct: Number(distanceToLevelPct.toFixed(4)),
    entryDistancePct: Number(dynamicEntryDistancePct.toFixed(3)),
    baseEntryDistancePct: LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT,
    flowScore: directionalBias.flowScore,
    lowerBand: Number(lowerBand.toFixed(6)),
    upperBand: Number(upperBand.toFixed(6)),
    huntScore: directionalBias.huntScore,
    likelySweepSide: directionalBias.likelySide,
    maxLeverage: Number.isFinite(tokenMaxLeverage) ? tokenMaxLeverage : null
  });

  return noOpen;
}

async function openLiquidityHuntEntry(
  row: TokenRsiResult,
  tenantId: string,
  runtimeMode: TradeRuntimeMode,
  direction: TradeDirection,
  slLevel: number,
  limitEntryPrice: number,
  preSweepEntry: boolean,
  nowMs: number,
  triggerZone: "SUPPORT" | "RESISTANCE" | null,
  breakPct: number,
  huntScore: number,
  flowScore: number,
  likelySweepSide: "UPPER_SWEEP" | "LOWER_SWEEP" | "BALANCED",
  longStopLiquidityUsd: number,
  shortStopLiquidityUsd: number
): Promise<void> {
  const symbol = normalizePerpSymbol(row.symbol);
  const runAsLiveRuntime = runtimeMode === "LIVE" && isLiveTradingEnabled();
  const key = getTradeKey(symbol, direction, runtimeMode, tenantId);
  const activeTradesCount = countOpenTradesForMode(runtimeMode, tenantId);

  const maxActiveTrades = getMaxActiveTrades(accountBalanceUsd, runtimeMode);
  if (activeTradesCount >= maxActiveTrades) {
    logRejection({
      symbol,
      signal: `LIQUIDITY_HUNT_ENTRY_${direction}`,
      score: 0,
      direction,
      reason: "max active trades reached",
      details: {
        activeTrades: activeTradesCount,
        maxActiveTrades
      }
    });
    return;
  }

  const openDecision = evaluateOpenTradeEligibility(symbol, direction, nowMs, runtimeMode, tenantId);
  if (!openDecision.allow) {
    logRejection({
      symbol,
      signal: `LIQUIDITY_HUNT_ENTRY_${direction}`,
      score: 0,
      direction,
      reason: openDecision.reason ?? "liquidity hunt entry blocked",
      details: openDecision.details ?? {}
    });
    return;
  }

  if (openTrades.has(key)) {
    return;
  }

  const shouldUseMarketAtPreSweep = preSweepEntry && LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE === "MARKET";
  // For MARKET pre-sweep, use the current trigger price (close) so sim/live trigger at the same point.
  // For LIMIT pre-sweep, retain the configured pre-sweep limit price.
  const entryPrice = shouldUseMarketAtPreSweep
    ? (Number.isFinite(Number(row.close)) && Number(row.close) > 0
      ? Number(Number(row.close).toFixed(6))
      : (Number.isFinite(limitEntryPrice) && limitEntryPrice > 0
        ? limitEntryPrice
        : Number(slLevel.toFixed(6))))
    : (Number.isFinite(limitEntryPrice) && limitEntryPrice > 0
      ? limitEntryPrice
      : Number(slLevel.toFixed(6)));
  const leverage = LIQUIDITY_HUNT_ENTRY_LEVERAGE;
  const configuredTakeProfitPct = LIQUIDITY_HUNT_ENTRY_TP_PCT;
  const configuredStopLossPct = LIQUIDITY_HUNT_ENTRY_SL_PCT;
  const tpMoveAbs = entryPrice * (configuredTakeProfitPct / 100 / leverage);
  const slMoveAbs = entryPrice * (configuredStopLossPct / 100 / leverage);

  const fallbackTpPrice = direction === "LONG"
    ? toNumber(entryPrice + tpMoveAbs)
    : toNumber(entryPrice - tpMoveAbs);
  let tpPrice = fallbackTpPrice;

  const targetBuffer = LIQUIDITY_HUNT_DYNAMIC_TP_BUFFER_PCT / 100;
  const rawDynamicTpPrice = direction === "LONG"
    ? toNumber(slLevel * (1 - targetBuffer))
    : toNumber(slLevel * (1 + targetBuffer));
  const dynamicTpIsDirectional = direction === "LONG"
    ? rawDynamicTpPrice > entryPrice
    : rawDynamicTpPrice < entryPrice;
  if (Number.isFinite(rawDynamicTpPrice) && rawDynamicTpPrice > 0 && dynamicTpIsDirectional) {
    tpPrice = rawDynamicTpPrice;
  }

  // For zone-based entries, SL should be placed at or beyond the zone level for maximum bounce room.
  // This prevents tight stops from getting hit on normal price retracements before the bounce.
  // Fallback to percentage-based SL only if zone-based placement would be worse than entry.
  const zoneLevelBasedSL = direction === "LONG"
    ? toNumber(slLevel * (1 - targetBuffer)) // For LONG at support: SL below support
    : toNumber(slLevel * (1 + targetBuffer)); // For SHORT at resistance: SL above resistance
  const percentageBasedSL = direction === "LONG"
    ? toNumber(entryPrice - slMoveAbs)
    : toNumber(entryPrice + slMoveAbs);

  // Use zone-based SL if it's directionally sound (won't immediately stop out), otherwise fall back.
  const slPrice = direction === "LONG"
    ? Math.min(zoneLevelBasedSL, percentageBasedSL) // LONG: use the lower (more conservative) of the two
    : Math.max(zoneLevelBasedSL, percentageBasedSL); // SHORT: use the higher (more conservative) of the two

  const invalidGeometry =
    (direction === "LONG" && (slPrice >= entryPrice || tpPrice <= entryPrice))
    || (direction === "SHORT" && (slPrice <= entryPrice || tpPrice >= entryPrice));
  if (invalidGeometry) {
    logRejection({
      symbol,
      signal: `LIQUIDITY_HUNT_ENTRY_${direction}`,
      score: 0,
      direction,
      reason: "liquidity hunt invalid TP/SL geometry",
      details: {
        direction,
        entryPrice,
        tpPrice,
        slPrice,
        zoneLevelBasedSL,
        percentageBasedSL,
        slLevel,
        triggerZone,
        huntScore
      }
    });
    return;
  }

  const takeProfitPct = calcLeveragedMovePct(entryPrice, tpPrice, leverage);
  const stopLossPct = calcLeveragedMovePct(entryPrice, slPrice, leverage);
  const distanceToTPPct = Number(
    (
      direction === "LONG"
        ? ((tpPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - tpPrice) / entryPrice) * 100
    ).toFixed(3)
  );
  const distanceToSLPct = Number(
    (
      direction === "LONG"
        ? ((entryPrice - slPrice) / entryPrice) * 100
        : ((slPrice - entryPrice) / entryPrice) * 100
    ).toFixed(3)
  );
  const tpSlDistanceRatio =
    distanceToSLPct > 0 ? Number((distanceToTPPct / distanceToSLPct).toFixed(3)) : 0;
  if (tpSlDistanceRatio < LIQUIDITY_HUNT_MIN_TP_SL_DISTANCE_RATIO) {
    logRejection({
      symbol,
      signal: `LIQUIDITY_HUNT_ENTRY_${direction}`,
      score: 0,
      direction,
      reason: "liquidity hunt TP/SL distance ratio below threshold",
      details: {
        distanceToTPPct,
        distanceToSLPct,
        tpSlDistanceRatio,
        minTpSlDistanceRatio: LIQUIDITY_HUNT_MIN_TP_SL_DISTANCE_RATIO,
        entryPrice,
        tpPrice,
        slPrice,
        triggerZone,
        huntScore
      }
    });
    return;
  }
  const netTakeProfitPct = Number((takeProfitPct - LIQUIDITY_HUNT_COST_BUFFER_PCT).toFixed(3));
  if (netTakeProfitPct < LIQUIDITY_HUNT_MIN_NET_TP_PCT) {
    logRejection({
      symbol,
      signal: `LIQUIDITY_HUNT_ENTRY_${direction}`,
      score: 0,
      direction,
      reason: "cost-adjusted take profit below threshold",
      details: {
        takeProfitPct,
        netTakeProfitPct,
        minNetTpPct: LIQUIDITY_HUNT_MIN_NET_TP_PCT,
        costBufferPct: LIQUIDITY_HUNT_COST_BUFFER_PCT,
        entryPrice,
        tpPrice,
        slLevel,
        dynamicTpBufferPct: LIQUIDITY_HUNT_DYNAMIC_TP_BUFFER_PCT
      }
    });
    return;
  }

  const riskPerTrade = getRiskPerTradeForSymbol(symbol);
  // Keep hunt sizing policy identical across sim/live for parity and predictability.
  const stakeUsd = getPositionSizeUsd(accountBalanceUsd, activeTradesCount, stopLossPct, leverage, riskPerTrade, runtimeMode);
  let openFeeUsd = SIM_SIGNAL_ONLY_MODE ? 0 : Number(
    (runAsLiveRuntime ? 0 : stakeUsd * TRADING_FEE_RATE).toFixed(2)
  );

  // For live mode, exchange-side checks run in evaluateLiveOpenReadiness/executeLiveOpenOrder.
  // For sim mode, enforce local balance guard.
  const simStakeForGuard = stakeUsd;
  if (
    !runAsLiveRuntime &&
    (!Number.isFinite(simStakeForGuard) || simStakeForGuard <= 0 || (!SIM_SIGNAL_ONLY_MODE && accountBalanceUsd - openFeeUsd <= 0))
  ) {
    logRejection({
      symbol,
      signal: "LIQUIDITY_HUNT_ENTRY",
      score: 0,
      direction,
      reason: "liquidity hunt entry insufficient balance",
      details: {
        stakeUsd: simStakeForGuard,
        openFeeUsd,
        accountBalanceUsd,
        leverage,
        stopLossPct
      }
    });
    return;
  }

  const isLarge = isLargeCap(symbol);
  const tradeId = `${symbol}-${direction}-${Date.now()}-${runtimeMode}-LIQ_HUNT`;
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

  // Capture expected-move gate evaluation for audit trail
  let expectedMoveAudit: Record<string, unknown> = {};
  if (LIQUIDITY_HUNT_EXPECTED_MOVE_GATE_ENABLED) {
    const liveVolatility = await computeLiveVolatilityFromBitunix(symbol);
    const expectedMoveEval = evaluateLiquidityHuntExpectedMove(
      row,
      direction,
      Number(row.close ?? entryPrice),
      slLevel,
      liveVolatility
    );
    expectedMoveAudit = expectedMoveEval.details || {};
  }

  const trade: Trade = {
    id: tradeId,
    tenantId,
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
    stakeSource: resolveTradeStakeSource(runtimeMode),
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
    isLiveTrade: runAsLiveRuntime,
    openTime: new Date(nowMs).toISOString(),
    openFeeUsd,
    currentPnlPct: 0,
    currentPnlUsd: 0,
    positionValueUsd: Number((stakeUsd * leverage).toFixed(2)),
    distanceToTP: distanceToTPPct,
    distanceToSL: distanceToSLPct,
    maxDrawdown: 0,
    entryContextJson: safeJsonStringify({
      mode: "LIQUIDITY_HUNT_ENTRY",
      strategy:
        LIQUIDITY_HUNT_ENTRY_MODE === "BREAKOUT_FLIP"
          ? "Market-maker flow follow: sweep + absorption continuation"
          : "Enter at stop-loss level for quick market maker reversal",
      slLevelAtEntry: slLevel,
      triggerZone,
      breakPct,
      entryMode: LIQUIDITY_HUNT_ENTRY_MODE,
      preSweepExecutionMode: LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE,
      huntScore,
      flowScore,
      likelySweepSide,
      longStopLiquidityUsd,
      shortStopLiquidityUsd,
      distancePctThreshold: LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT,
      minBreakPct: LIQUIDITY_HUNT_MIN_BREAK_PCT,
      configuredLeverage: leverage,
      configuredTakeProfitPct: takeProfitPct,
      configuredStopLossPct: stopLossPct,
      expectedMoveGateDetails: expectedMoveAudit
    })
  };

  if (
    !isBitunixLiveTradingMode() &&
    SIM_LIVE_PARITY_MODE &&
    preSweepEntry &&
    LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE === "LIMIT"
  ) {
    const timeoutMs = SIM_LIVE_PARITY_LIMIT_TIMEOUT_MINUTES * 60 * 1000;
    simPendingLimitOrdersByKey.set(key, {
      key,
      token: symbol,
      direction,
      limitPrice: entryPrice,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + timeoutMs,
      tradeTemplate: trade,
      sourceSignalType: signalType
    });
    lastOpenedByKey.set(key, nowMs);

    console.info("[trade-engine] Sim parity LIMIT staged", {
      symbol: trade.token,
      direction: trade.direction,
      limitPrice: entryPrice,
      expiresAt: new Date(nowMs + timeoutMs).toISOString(),
      timeoutMinutes: SIM_LIVE_PARITY_LIMIT_TIMEOUT_MINUTES,
      signalType
    });
    return;
  }

  if (runAsLiveRuntime) {
    let liveOpenAllowed = true;

    if (Date.now() < liveOpenRateLimitUntilMs) {
      logRejection({
        symbol,
        signal: signalType,
        score: 0,
        direction,
        reason: "bitunix private payload error: request too frequently",
        details: {
          backoffUntil: new Date(liveOpenRateLimitUntilMs).toISOString(),
          source: "live_open_guard"
        }
      });
      liveOpenAllowed = false;
    }

    let liveReadinessDetails: Record<string, unknown> | null = null;
    if (liveOpenAllowed) {
      const liveReadiness = await evaluateLiveOpenReadiness({
        symbol,
        direction,
        stakeUsd
      });
      if (!liveReadiness.allow) {
        logRejection({
          symbol,
          signal: signalType,
          score: 0,
          direction,
          reason: liveReadiness.reason ?? "live open readiness check failed",
          details: {
            ...(liveReadiness.details ?? {}),
            preSweepEntry,
            triggerZone,
            huntScore,
            likelySweepSide
          }
        });
        liveReadinessDetails = liveReadiness.details ?? null;
        liveOpenAllowed = false;
      }
    }

    // LIMIT mode: create a pending pre-sweep order and wait for exchange fill.
    // MARKET mode: bypass this block and execute immediately below.
    // If stale limit orders were canceled in this cycle, optionally fall back to market.
    if (liveOpenAllowed && preSweepEntry && LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE === "LIMIT") {
      const pendingLimitPolicy = await enforceLiquidityHuntPendingLimitPolicy({
        symbol,
        nowMs
      });
      if (!pendingLimitPolicy.allow) {
        logRejection({
          symbol,
          signal: signalType,
          score: 0,
          direction,
          reason: pendingLimitPolicy.reason ?? "pending limit order policy blocked",
          details: {
            ...(pendingLimitPolicy.details ?? {}),
            preSweepEntry,
            triggerZone,
            huntScore,
            likelySweepSide
          }
        });
        liveOpenAllowed = false;
      }

      if (liveOpenAllowed) {
        const canceledStaleOrders = Number((pendingLimitPolicy.details as Record<string, unknown> | undefined)?.canceledStaleOrders ?? 0);
        const fallbackToMarket =
          LIQUIDITY_HUNT_PRE_SWEEP_MARKET_FALLBACK_ENABLED &&
          canceledStaleOrders > 0;

        if (fallbackToMarket) {
          console.info("[trade-engine] Liquidity hunt pre-sweep falling back to MARKET after stale LIMIT cleanup", {
            symbol,
            direction,
            canceledStaleOrders,
            maxPendingAgeMinutes: LIQUIDITY_HUNT_PENDING_LIMIT_MAX_AGE_MINUTES
          });
        }

        if (!fallbackToMarket) {

        try {
          const liveLimitOrder = await executeLiveOpenLimitOrder({
            symbol,
            direction,
            leverage,
            entryPrice,
            stakeUsd,
            localTradeId: trade.id,
            tpPrice,
            slPrice
          });

        lastOpenedByKey.set(key, nowMs);

        void dispatchRealtimeTelegramAlert({
          stage: "READY",
          symbol: trade.token,
          direction: trade.direction,
          entryTiming: "MID",
          reversalPhase: "UNRESOLVED",
          signalType: `LIQUIDITY_HUNT_LIMIT_CREATED_${direction}`,
          entryScore: 0,
          weightedScore: 0,
          signalStrength: 100,
          tpFeasibility: 1,
          structureConfidence: 0,
          volatilityPct: trade.volatilityPct,
          takeProfitPct: trade.takeProfitPct,
          stopLossPct: trade.stopLossPct,
          marketCondition: trade.marketCondition,
          entryPrice,
          tpPrice,
          slPrice,
          setupConflictNote: `LIMIT CREATED on Bitunix: ${direction} ${trade.token} @ ${entryPrice.toFixed(6)} | TP ${tpPrice.toFixed(6)} | SL ${slPrice.toFixed(6)} | OrderId ${liveLimitOrder.orderId}`,
          dedupeKey: `LIQ_HUNT_LIMIT_CREATED:${trade.token}:${direction}:${entryPrice.toFixed(6)}:${nowMs}`
        });

        console.info("[trade-engine] Liquidity hunt pre-sweep LIMIT order created", {
          symbol: trade.token,
          direction: trade.direction,
          orderId: liveLimitOrder.orderId,
          clientId: liveLimitOrder.clientId,
          entryPrice,
          tpPrice,
          slPrice,
          qty: liveLimitOrder.qty,
          stakeUsdRequested: liveLimitOrder.requestedStakeUsd,
          stakeUsdUsed: liveLimitOrder.stakeUsdUsed,
          triggerZone,
          huntScore,
          likelySweepSide,
          longStopLiquidityUsd,
          shortStopLiquidityUsd
        });
          return;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (isRateLimitFetchErrorMessage(reason)) {
            liveOpenRateLimitUntilMs = Date.now() + LIVE_OPEN_RATE_LIMIT_BACKOFF_MS;
          }
          alertLiveExecutionFailure({
            symbol,
            direction,
            phase: "OPEN",
            reason,
            signalType: `LIQUIDITY_HUNT_LIMIT_CREATED_${direction}`,
            entryPrice,
            tpPrice,
            slPrice
          });
          logRejection({
            symbol,
            signal: signalType,
            score: 0,
            direction,
            reason: `live pre-sweep limit create failed: ${reason}`,
            details: {
              liveTradingEnabled: true,
              preSweepEntry: true,
              entryPrice,
              tpPrice,
              slPrice
            }
          });
          liveOpenAllowed = false;
        }
        }
      }
    }

    if (liveOpenAllowed) {
      try {
        const liveOrder = await executeLiveOpenOrder({
          symbol,
          direction,
          leverage,
          entryPrice,
          stakeUsd,
          localTradeId: trade.id,
          tpPrice,
          slPrice
        });
        trade.isLiveTrade = true;
        trade.liveOrderId = liveOrder.orderId;
        trade.liveClientId = liveOrder.clientId;
        trade.livePositionId = liveOrder.positionId;
        if (liveOrder.stakeUsdUsed > 0 && liveOrder.stakeUsdUsed !== trade.stakeUsd) {
          trade.stakeUsd = Number(liveOrder.stakeUsdUsed.toFixed(2));
          trade.openFeeUsd = Number((trade.stakeUsd * TRADING_FEE_RATE).toFixed(2));
          trade.positionValueUsd = Number((trade.stakeUsd * leverage).toFixed(2));
          trade.marginUsedUsd = trade.stakeUsd;
          openFeeUsd = trade.openFeeUsd;
        }

      // Re-attach TP/SL explicitly with full position qty via the dedicated TPSL endpoint.
      // The inline tpPrice/slPrice on the market order may not cover the full qty on Bitunix.
      if (liveOrder.positionId && Number.isFinite(tpPrice) && Number.isFinite(slPrice)) {
        try {
          await attachBitunixPositionTpSlDebug({
            positionId: liveOrder.positionId,
            tpPrice,
            slPrice,
            symbol,
            side: direction
          });
        } catch (tpslError) {
          console.warn("[trade-engine] Full-qty TPSL reattachment failed (non-fatal); inline TPSL remains active", {
            tradeId: trade.id,
            symbol,
            positionId: liveOrder.positionId,
            tpPrice,
            slPrice,
            error: tpslError instanceof Error ? tpslError.message : String(tpslError)
          });
        }
      }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (isRateLimitFetchErrorMessage(reason)) {
          liveOpenRateLimitUntilMs = Date.now() + LIVE_OPEN_RATE_LIMIT_BACKOFF_MS;
        }
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
        liveOpenAllowed = false;
      }
    }

    if (!liveOpenAllowed) {
      console.info("[trade-engine] Live liquidity-hunt open blocked; skipping local fallback trade", {
        symbol,
        direction,
        signalType,
        preSweepEntry,
        triggerZone,
        huntScore,
        likelySweepSide,
        hasLiveReadinessDetails: Boolean(liveReadinessDetails)
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

  void sendTradeLifecycleTelegram({
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
  }, Boolean(trade.isLiveTrade), trade);

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
      if (isLivePositionAlreadyAbsentError(error)) {
        const stillOpenOnExchange = await isLivePositionStillOpenForTrade(trade);
        if (stillOpenOnExchange) {
          alertLiveExecutionFailure({
            symbol: trade.token,
            direction: trade.direction,
            phase: "CLOSE",
            reason: `${liveCloseReason}; exchange still reports open position`,
            signalType: trade.signalType,
            entryPrice: trade.entryPrice,
            tpPrice: trade.tpPrice,
            slPrice: trade.slPrice
          });
          throw new Error(
            `Live close aborted for ${trade.token} ${trade.direction}: exchange still reports open position; local close blocked`
          );
        }

        console.warn("[trade-engine] Live close reconciliation: exchange position absent; continuing local close", {
          symbol: trade.token,
          direction: trade.direction,
          reason,
          tradeId: trade.id,
          liveCloseReason
        });
      } else {
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

  openTrades.delete(getTradeKeyForTrade(trade));
  closedTrades.push({ ...trade });

  if (!SIM_SIGNAL_ONLY_MODE) {
    const netClosePnlUsd = Number(((trade.resultUsd ?? 0) - (trade.closeFeeUsd ?? 0)).toFixed(2));
    accountBalanceUsd = Number((accountBalanceUsd + netClosePnlUsd).toFixed(2));
  }

  void sendTradeLifecycleTelegram({
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
  }, Boolean(trade.isLiveTrade), trade);

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

async function processSimPendingLimitOrders(): Promise<void> {
  if (isBitunixLiveTradingMode() || !SIM_LIVE_PARITY_MODE || simPendingLimitOrdersByKey.size === 0) {
    return;
  }

  const nowMs = Date.now();
  for (const [key, pending] of simPendingLimitOrdersByKey.entries()) {
    if (nowMs >= pending.expiresAtMs) {
      simPendingLimitOrdersByKey.delete(key);
      logRejection({
        symbol: pending.token,
        signal: pending.sourceSignalType,
        score: pending.tradeTemplate.entryScore,
        direction: pending.direction,
        reason: "sim parity pending limit expired",
        details: {
          limitPrice: pending.limitPrice,
          timeoutMinutes: SIM_LIVE_PARITY_LIMIT_TIMEOUT_MINUTES,
          createdAt: new Date(pending.createdAtMs).toISOString(),
          expiredAt: new Date(nowMs).toISOString()
        }
      });
      continue;
    }

    if (openTrades.has(key)) {
      simPendingLimitOrdersByKey.delete(key);
      continue;
    }

    const ohlc = await fetchLifecycleOhlc(pending.token);
    if (!ohlc) {
      continue;
    }

    const filled = pending.direction === "LONG"
      ? Number.isFinite(ohlc.low) && ohlc.low <= pending.limitPrice
      : Number.isFinite(ohlc.high) && ohlc.high >= pending.limitPrice;

    if (!filled) {
      continue;
    }

    simPendingLimitOrdersByKey.delete(key);

    const trade: Trade = {
      ...pending.tradeTemplate,
      openTime: new Date(nowMs).toISOString(),
      status: "OPEN"
    };

    const entrySlipRatio = SIM_LIVE_PARITY_ENTRY_SLIPPAGE_PCT / 100;
    const filledEntryPrice = pending.direction === "LONG"
      ? Number((pending.limitPrice * (1 + entrySlipRatio)).toFixed(6))
      : Number((pending.limitPrice * (1 - entrySlipRatio)).toFixed(6));

    trade.entryPrice = filledEntryPrice;
    trade.effectiveEntryPrice = filledEntryPrice;
    trade.currentPrice = filledEntryPrice;
    trade.tpDistance = Math.abs(trade.tpPrice - filledEntryPrice);
    trade.slDistance = Math.abs(trade.slPrice - filledEntryPrice);
    trade.distanceToTP = Number(
      (
        trade.direction === "LONG"
          ? ((trade.tpPrice - filledEntryPrice) / filledEntryPrice) * 100
          : ((filledEntryPrice - trade.tpPrice) / filledEntryPrice) * 100
      ).toFixed(3)
    );
    trade.distanceToSL = Number(
      (
        trade.direction === "LONG"
          ? ((filledEntryPrice - trade.slPrice) / filledEntryPrice) * 100
          : ((trade.slPrice - filledEntryPrice) / filledEntryPrice) * 100
      ).toFixed(3)
    );

    const openFeeUsd = SIM_SIGNAL_ONLY_MODE ? 0 : Number((trade.stakeUsd * TRADING_FEE_RATE).toFixed(2));
    trade.openFeeUsd = openFeeUsd;

    if (!SIM_SIGNAL_ONLY_MODE) {
      accountBalanceUsd = Number((accountBalanceUsd - openFeeUsd).toFixed(2));
    }

    openTrades.set(key, trade);
    lastOpenedByKey.set(key, nowMs);

    console.info("[trade-engine] Sim parity LIMIT filled", {
      symbol: trade.token,
      direction: trade.direction,
      limitPrice: pending.limitPrice,
      filledEntryPrice,
      slippagePct: SIM_LIVE_PARITY_ENTRY_SLIPPAGE_PCT,
      signalType: trade.signalType
    });
  }
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
    await protectOrphanLivePositionsEarlyDrawdown();
    return;
  }

  if (LIVE_FORCE_CLOSE_ON_MAX_DRAWDOWN && isBitunixLiveTradingMode() && isKillSwitchTriggered(Date.now())) {
    const liveOpenTrades = openList.filter((trade) => trade.status === "OPEN" && Boolean(trade.isLiveTrade));
    if (liveOpenTrades.length === 0) {
      // Do not let the live kill-switch branch short-circuit lifecycle handling for local simulation trades.
    } else {
    const emergencyCloseTime = nowIso();
      for (const trade of liveOpenTrades) {

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

  for (const [token, trades] of byToken.entries()) {
    const ohlc = fetchedByToken.get(token);
    if (!ohlc) {
      continue;
    }

    const perpContext = null;

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
      const isLiquidityHuntTrade = String(trade.signalType ?? "").includes("LIQUIDITY_HUNT");

      if (isLiquidityHuntTrade) {
        updateLiquidityHuntTrailingStop(trade);
      }

      // Live liquidity-hunt trades: give a short grace period after entry so that market-order
      // fill spread (which can put the position at -6% ROE instantly) doesn't trigger an
      // immediate early-drawdown close. After the grace period all bot protections apply normally.
      // The exchange SL (typically set wide, e.g. 50%) acts as the absolute last backstop.
      const isLiveHuntTrade =
        Boolean(trade.isLiveTrade) &&
        isLiquidityHuntTrade;
      const pastEntryGracePeriod =
        !isLiveHuntTrade || elapsedMinutes >= LIQUIDITY_HUNT_LIVE_ENTRY_GRACE_MINUTES;

      const liveSignal = latestSignalBySymbol.get(normalizePerpSymbol(trade.token));
      if (liveSignal && pastEntryGracePeriod) {
        const sentimentShift = evaluateSentimentShiftExit(trade, liveSignal, elapsedMinutes);
        if (sentimentShift.shouldClose) {
          await closeTradeAtMarket(trade, nowIso(), "SENTIMENT_SHIFT_OPPOSITE_SIGNAL", {
            sentimentShift: sentimentShift.details
          });
          continue;
        }
      }

      // Early drawdown protection fires after the grace period.
      if (trade.currentPnlPct <= EARLY_DRAWDOWN_EXIT_PCT && pastEntryGracePeriod) {
        await closeTradeAtMarket(trade, nowIso(), "EARLY_DRAWDOWN_PROTECTION");
        continue;
      }

      // Hard time cap always applies regardless of trade type.
      if (elapsedMinutes >= ABSOLUTE_MAX_HOLD_MINUTES) {
        await closeTradeAtMarket(trade, nowIso(), "TIME_EXIT_MAX_HOLD");
        continue;
      }

      // Lifecycle simulation (local TP/SL/stale checks) only runs after the grace period.
      if (isLiveHuntTrade && !pastEntryGracePeriod) {
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
        const stopIsPastBreakeven =
          (trade.direction === "LONG" && trade.slPrice >= trade.entryPrice) ||
          (trade.direction === "SHORT" && trade.slPrice <= trade.entryPrice);
        const pnlIsPositive = Number(trade.currentPnlPct ?? 0) > 0;

        if (stopIsPastBreakeven || pnlIsPositive) {
          await closeTrade(
            trade,
            "WIN",
            nowIso(),
            trade.direction === "LONG" ? "TRAILING_STOP_PROFIT_LONG" : "TRAILING_STOP_PROFIT_SHORT"
          );
          continue;
        }

        await closeTrade(trade, "LOSS", nowIso(), trade.direction === "LONG" ? "SL_HIT_LONG" : "SL_HIT_SHORT");
      }
    }
  }

  await protectOrphanLivePositionsEarlyDrawdown();
  persistRuntimeState();
}

function toPerpTokenFromBitunixSymbol(symbolRaw: string): string {
  const symbol = String(symbolRaw ?? "").trim().toUpperCase();
  if (!symbol) {
    return "";
  }

  return symbol.endsWith("USDT") ? `${symbol.slice(0, -4)}-PERP` : normalizePerpSymbol(symbol);
}

function computeExchangePositionRoePct(input: {
  direction: TradeDirection;
  entryPrice: number;
  currentPrice: number;
  leverage: number;
}): number {
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0 || !Number.isFinite(input.currentPrice) || input.currentPrice <= 0) {
    return 0;
  }

  const longMovePct = (input.currentPrice - input.entryPrice) / input.entryPrice;
  const shortMovePct = (input.entryPrice - input.currentPrice) / input.entryPrice;
  const movePct = input.direction === "LONG" ? longMovePct : shortMovePct;
  return Number((movePct * Math.max(1, input.leverage) * 100).toFixed(3));
}

function findOpenTradeByLivePositionId(positionId: string): Trade | null {
  const normalized = positionId.trim();
  if (!normalized) {
    return null;
  }

  for (const trade of openTrades.values()) {
    if (trade.status !== "OPEN") {
      continue;
    }
    if (String(trade.livePositionId ?? "").trim() === normalized) {
      return trade;
    }
  }

  return null;
}

function pickBestPositionForLedgerRow(
  row: Awaited<ReturnType<typeof listUnlinkedOpenLiveOrders>>[number],
  positions: BitunixPendingPosition[],
  claimedPositionIds: Set<string>
): BitunixPendingPosition | null {
  const expectedPerp = normalizePerpSymbol(row.perpToken || row.symbol);
  const expectedDirection = row.direction;

  const matches = positions.filter((position) => {
    const positionId = String(position.positionId ?? "").trim();
    if (!positionId || claimedPositionIds.has(positionId)) {
      return false;
    }

    if (row.positionId && positionId === row.positionId) {
      return true;
    }

    const positionPerp = toPerpTokenFromBitunixSymbol(position.symbol);
    const direction: TradeDirection = position.side === "SHORT" ? "SHORT" : "LONG";
    return positionPerp === expectedPerp && direction === expectedDirection;
  });

  if (matches.length === 0) {
    return null;
  }

  if (matches.length === 1) {
    return matches[0];
  }

  const openedAtMs = row.openedAt ? Date.parse(row.openedAt) : NaN;
  const entryPrice = Number(row.entryPrice ?? Number.NaN);

  if (Number.isFinite(openedAtMs) && openedAtMs > 0) {
    return matches
      .slice()
      .sort((left, right) => {
        const leftAt = left.createdAtMs > 0 ? left.createdAtMs : left.updatedAtMs;
        const rightAt = right.createdAtMs > 0 ? right.createdAtMs : right.updatedAtMs;
        return Math.abs(leftAt - openedAtMs) - Math.abs(rightAt - openedAtMs);
      })[0];
  }

  if (Number.isFinite(entryPrice) && entryPrice > 0) {
    return matches
      .slice()
      .sort((left, right) => {
        const leftDiff = Math.abs(Number(left.avgOpenPrice ?? 0) - entryPrice);
        const rightDiff = Math.abs(Number(right.avgOpenPrice ?? 0) - entryPrice);
        return leftDiff - rightDiff;
      })[0];
  }

  return matches
    .slice()
    .sort((left, right) => {
      const leftAt = left.createdAtMs > 0 ? left.createdAtMs : left.updatedAtMs;
      const rightAt = right.createdAtMs > 0 ? right.createdAtMs : right.updatedAtMs;
      return rightAt - leftAt;
    })[0];
}

function resolveAdoptedStakeUsd(
  position: BitunixPendingPosition,
  row: Awaited<ReturnType<typeof listUnlinkedOpenLiveOrders>>[number]
): number {
  const marginStake = Number(position.margin ?? Number.NaN);
  if (Number.isFinite(marginStake) && marginStake > 0) {
    return Number(marginStake.toFixed(2));
  }

  const ledgerStake = Number(row.stakeUsd ?? Number.NaN);
  if (Number.isFinite(ledgerStake) && ledgerStake > 0) {
    return Number(ledgerStake.toFixed(2));
  }

  const entryPrice = Number(position.avgOpenPrice ?? row.entryPrice ?? Number.NaN);
  const qty = Number(position.qty ?? Number.NaN);
  const leverage = Math.max(1, Number(position.leverage ?? row.leverage ?? LEVERAGE));
  if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(qty) && qty > 0) {
    return Number(((entryPrice * qty) / leverage).toFixed(2));
  }

  return Number(Math.max(1, Math.min(accountBalanceUsd, SIGNAL_SIM_STAKE_USD)).toFixed(2));
}

function buildReconciledTradeFromPosition(
  row: Awaited<ReturnType<typeof listUnlinkedOpenLiveOrders>>[number],
  position: BitunixPendingPosition
): Trade | null {
  const token = toPerpTokenFromBitunixSymbol(position.symbol) || normalizePerpSymbol(row.perpToken || row.symbol);
  if (!token) {
    return null;
  }

  const direction: TradeDirection = position.side === "SHORT" ? "SHORT" : "LONG";
  const entryPrice = Number(position.avgOpenPrice ?? row.entryPrice ?? Number.NaN);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return null;
  }

  const leverage = Math.max(1, Math.trunc(Number(position.leverage ?? row.leverage ?? LEVERAGE)));
  const riskPerTrade = getRiskPerTradeForSymbol(token);
  const fallbackLevels = getTradeLevels(entryPrice, direction, token, 0);
  const tpPrice = Number.isFinite(Number(row.tpPrice)) && Number(row.tpPrice) > 0
    ? Number(row.tpPrice)
    : fallbackLevels.tpPrice;
  const slPrice = Number.isFinite(Number(row.slPrice)) && Number(row.slPrice) > 0
    ? Number(row.slPrice)
    : fallbackLevels.slPrice;
  const takeProfitPct = Number(
    (
      direction === "LONG"
        ? ((tpPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - tpPrice) / entryPrice) * 100
    ).toFixed(3)
  );
  const stopLossPct = Number(
    (
      direction === "LONG"
        ? ((entryPrice - slPrice) / entryPrice) * 100
        : ((slPrice - entryPrice) / entryPrice) * 100
    ).toFixed(3)
  );
  const stakeUsd = resolveAdoptedStakeUsd(position, row);
  const openTime = (() => {
    if (position.createdAtMs > 0) {
      return new Date(position.createdAtMs).toISOString();
    }
    if (row.openedAt) {
      return row.openedAt;
    }
    return nowIso();
  })();
  const notionalUsd = Number(position.qty ?? 0) > 0
    ? Number((Number(position.qty) * entryPrice).toFixed(2))
    : Number((stakeUsd * leverage).toFixed(2));

  return {
    id: `${token}-${direction}-${Date.now()}-LIVE_RECONCILED`,
    token,
    direction,
    signalType: "LIVE_RECONCILED_ORPHAN_POSITION",
    signalCategory: "SCORE_BASED",
    entryTiming: "MID",
    reversalPhase: "UNRESOLVED",
    entryType: "SCORE_BASED",
    entryScore: 0,
    riskPctUsed: Number((riskPerTrade * 100).toFixed(2)),
    volatilityPct: 0,
    volume24h: 0,
    passedVolatility: true,
    passedLiquidity: true,
    assetType: isLargeCap(token) ? "LARGE_CAP" : "ALT",
    marketCondition: "RANGING",
    regime: "CHOPPY",
    cluster: getCluster(token),
    stakeUsd,
    stakeSource: "LIVE_EXCHANGE_POSITION",
    takeProfitPct: Number.isFinite(takeProfitPct) && takeProfitPct > 0 ? takeProfitPct : fallbackLevels.takeProfitPct,
    stopLossPct: Number.isFinite(stopLossPct) && stopLossPct > 0 ? stopLossPct : fallbackLevels.stopLossPct,
    atr: 0,
    tpDistance: Math.abs(tpPrice - entryPrice),
    slDistance: Math.abs(entryPrice - slPrice),
    expectedValue: 0,
    slippageEstimate: 0,
    entryPrice,
    effectiveEntryPrice: entryPrice,
    currentPrice: entryPrice,
    tpPrice,
    slPrice,
    leverage,
    status: "OPEN",
    openTime,
    openFeeUsd: 0,
    currentPnlPct: 0,
    currentPnlUsd: Number(position.unrealizedPnl ?? 0),
    positionValueUsd: notionalUsd,
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
    marginUsedUsd: stakeUsd,
    maxDrawdown: 0,
    isLiveTrade: true,
    liveOrderId: row.orderId ?? undefined,
    liveClientId: row.clientId ?? undefined,
    livePositionId: String(position.positionId ?? "").trim() || (row.positionId ?? undefined)
  } satisfies Trade;
}

async function reconcileLiveLedgerWithRuntimeState(): Promise<void> {
  if (!isBitunixLiveTradingMode() || !LIVE_LEDGER_RECONCILE_ENABLED) {
    return;
  }

  const nowMs = Date.now();
  if (liveLedgerReconcileRunning || nowMs - liveLedgerReconcileLastRunAtMs < LIVE_LEDGER_RECONCILE_INTERVAL_MS) {
    return;
  }

  liveLedgerReconcileRunning = true;
  liveLedgerReconcileLastRunAtMs = nowMs;

  try {
    const [rows, positions] = await Promise.all([
      listUnlinkedOpenLiveOrders({ provider: "BITUNIX", limit: LIVE_LEDGER_RECONCILE_LIMIT }),
      fetchBitunixPendingPositions()
    ]);

    if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(positions) || positions.length === 0) {
      return;
    }

    const claimedPositionIds = new Set<string>();

    for (const trade of openTrades.values()) {
      const positionId = String(trade.livePositionId ?? "").trim();
      if (positionId) {
        claimedPositionIds.add(positionId);
      }
    }

    for (const row of rows) {
      const matchedPosition = pickBestPositionForLedgerRow(row, positions, claimedPositionIds);
      if (!matchedPosition) {
        continue;
      }

      const positionId = String(matchedPosition.positionId ?? "").trim();
      if (!positionId) {
        continue;
      }

      const alreadyTracked = findOpenTradeByLivePositionId(positionId);
      if (alreadyTracked) {
        claimedPositionIds.add(positionId);
        await bindLiveOrderToLocalTrade({
          provider: "BITUNIX",
          localTradeId: alreadyTracked.id,
          clientId: row.clientId ?? undefined,
          orderId: row.orderId ?? undefined,
          positionId
        });
        continue;
      }

      const adoptedTrade = buildReconciledTradeFromPosition(row, matchedPosition);
      if (!adoptedTrade) {
        continue;
      }

      const key = getTradeKeyForTrade(adoptedTrade);
      if (openTrades.has(key)) {
        continue;
      }

      openTrades.set(key, adoptedTrade);
      claimedPositionIds.add(positionId);

      const openedAtMs = Date.parse(adoptedTrade.openTime);
      lastOpenedByKey.set(key, Number.isFinite(openedAtMs) ? openedAtMs : Date.now());

      await bindLiveOrderToLocalTrade({
        provider: "BITUNIX",
        localTradeId: adoptedTrade.id,
        clientId: row.clientId ?? undefined,
        orderId: row.orderId ?? undefined,
        positionId
      });

      void appendSessionTradeOpened({
        externalTradeId: adoptedTrade.id,
        symbol: adoptedTrade.token,
        direction: adoptedTrade.direction,
        signalType: adoptedTrade.signalType,
        entryScore: adoptedTrade.entryScore,
        weightedScore: adoptedTrade.entryScore,
        takeProfitPct: adoptedTrade.takeProfitPct,
        stopLossPct: adoptedTrade.stopLossPct,
        stakeUsd: adoptedTrade.stakeUsd,
        entryPrice: adoptedTrade.entryPrice,
        tpPrice: adoptedTrade.tpPrice,
        slPrice: adoptedTrade.slPrice,
        leverage: adoptedTrade.leverage,
        openedAt: adoptedTrade.openTime
      }).catch((error) => {
        console.error("[trade-engine] Failed to persist reconciled live trade in session store", {
          tradeId: adoptedTrade.id,
          error: error instanceof Error ? error.message : String(error)
        });
      });

      console.warn("[trade-engine] Reconciled untracked live position into local runtime", {
        tradeId: adoptedTrade.id,
        symbol: adoptedTrade.token,
        direction: adoptedTrade.direction,
        positionId,
        clientId: row.clientId,
        orderId: row.orderId,
        source: row.source,
        status: row.status
      });
    }
  } catch (error) {
    console.error("[trade-engine] Live ledger reconciliation failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    liveLedgerReconcileRunning = false;
  }
}

async function protectOrphanLivePositionsEarlyDrawdown(): Promise<void> {
  if (!isBitunixLiveTradingMode() || !LIVE_ORPHAN_EARLY_DRAWDOWN_PROTECTION) {
    return;
  }

  const nowMs = Date.now();
  if (nowMs < liveOrphanEarlyDrawdownPauseUntilMs) {
    return;
  }

  if (nowMs - liveOrphanEarlyDrawdownLastScanAtMs < LIVE_ORPHAN_EARLY_DRAWDOWN_SCAN_MIN_INTERVAL_MS) {
    return;
  }

  liveOrphanEarlyDrawdownLastScanAtMs = nowMs;

  let positions: BitunixPendingPosition[] = [];
  try {
    positions = await fetchBitunixPendingPositions();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("request too frequently")) {
      liveOrphanEarlyDrawdownPauseUntilMs = Date.now() + LIVE_ORPHAN_EARLY_DRAWDOWN_RATE_LIMIT_BACKOFF_MS;
      console.warn("[trade-engine] Orphan drawdown protection backing off after Bitunix rate limit", {
        backoffMs: LIVE_ORPHAN_EARLY_DRAWDOWN_RATE_LIMIT_BACKOFF_MS,
        resumeAt: new Date(liveOrphanEarlyDrawdownPauseUntilMs).toISOString()
      });
      return;
    }

    console.error("[trade-engine] Failed to load live positions for orphan drawdown protection", {
      error: message
    });
    return;
  }

  if (!Array.isArray(positions) || positions.length === 0) {
    return;
  }

  for (const position of positions) {
    const positionId = String(position.positionId ?? "").trim();
    if (!positionId) {
      continue;
    }

    const loopNowMs = Date.now();
    const lastAttemptAt = liveOrphanEarlyDrawdownAttemptByPosition.get(positionId) ?? 0;
    if (loopNowMs - lastAttemptAt < LIVE_ORPHAN_EARLY_DRAWDOWN_COOLDOWN_MS) {
      continue;
    }

    const token = toPerpTokenFromBitunixSymbol(position.symbol);
    if (!token) {
      continue;
    }

    const direction: TradeDirection = position.side === "SHORT" ? "SHORT" : "LONG";

    // Cover three classes of positions for protection:
    // 1. Manually watched symbols (user-managed positions)
    // 2. Symbols the bot recently placed a limit/market entry on (bot-placed limit fills that
    //    are not tracked in openTrades because the LIMIT pre-sweep path returns early)
    // 3. Strategy-managed symbols when liquidity-hunt only mode is enabled
    const isBotPlacedEntry = lastOpenedByKey.has(getTradeKey(token, direction, "LIVE"));
    const isManualWatched = isManualPositionWatched(token);
    const isStrategyManagedPosition = LIQUIDITY_HUNT_ONLY_MODE;
    const shouldApplyMaxHoldGuard = isBotPlacedEntry || isManualWatched || isStrategyManagedPosition;
    const shouldApplyDrawdownGuard = isBotPlacedEntry || isManualWatched;
    if (!shouldApplyMaxHoldGuard && !shouldApplyDrawdownGuard) {
      continue;
    }

    if (!shouldApplyDrawdownGuard) {
      continue;
    }

    const entryPrice = Number(position.avgOpenPrice ?? NaN);
    const leverage = Math.max(1, Number(position.leverage ?? 1));
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      continue;
    }

    const ohlc = await fetchLifecycleOhlc(token);
    if (!ohlc || !Number.isFinite(ohlc.close) || ohlc.close <= 0) {
      continue;
    }

    const currentPnlPct = computeExchangePositionRoePct({
      direction,
      entryPrice,
      currentPrice: ohlc.close,
      leverage
    });

    if (currentPnlPct > EARLY_DRAWDOWN_EXIT_PCT) {
      continue;
    }

    liveOrphanEarlyDrawdownAttemptByPosition.set(positionId, loopNowMs);

    try {
      await flashCloseBitunixPosition(positionId);
      void recordLiveOrderClosed({
        provider: "BITUNIX",
        positionId,
        closeReason: "EARLY_DRAWDOWN_PROTECTION_ORPHAN_POSITION",
        closedAt: new Date().toISOString(),
        meta: {
          source: "protectOrphanLivePositionsEarlyDrawdown",
          symbol: normalizePerpSymbol(token),
          direction,
          currentPnlPct
        }
      }).catch((error) => {
        console.error("[trade-engine] Failed to persist orphan drawdown close in live order ledger", {
          token,
          direction,
          positionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      // Record the close time so the symbol is on cooldown against new entries.
      lastHuntOrphanSLBySymbol.set(token, Date.now());
      console.warn("[trade-engine] Closed orphan live position by early drawdown protection", {
        token,
        direction,
        positionId,
        currentPnlPct,
        thresholdPct: EARLY_DRAWDOWN_EXIT_PCT,
        entryPrice,
        currentPrice: ohlc.close
      });
      void dispatchRealtimeTelegramAlert({
        stage: "CLOSED",
        symbol: token,
        direction,
        entryTiming: "MID",
        reversalPhase: "UNRESOLVED",
        signalType: "EARLY_DRAWDOWN_PROTECTION_ORPHAN_POSITION",
        entryScore: 0,
        weightedScore: 0,
        signalStrength: 0,
        tpFeasibility: 1,
        structureConfidence: 0,
        volatilityPct: 0,
        takeProfitPct: 0,
        stopLossPct: 0,
        marketCondition: "RANGING",
        entryPrice,
        tpPrice: entryPrice,
        slPrice: ohlc.close,
        closeReason: `Orphan live position auto-closed by early drawdown guard at ${currentPnlPct.toFixed(2)}% (threshold ${EARLY_DRAWDOWN_EXIT_PCT}%)`,
        resultPct: currentPnlPct,
        resultUsd: Number(position.unrealizedPnl ?? 0),
        dedupeKey: `EARLY_DRAWDOWN_PROTECTION_ORPHAN_POSITION:${positionId}`
      });
    } catch (error) {
      console.error("[trade-engine] Failed to close orphan live position by early drawdown protection", {
        token,
        direction,
        positionId,
        currentPnlPct,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

/**
 * Evaluate simple momentum entry signal for a token
 * Replaces complex liquidity hunt logic with RSI-based oversold detection
 */
async function evaluateSimpleMomentumEntry(
  row: TokenRsiResult,
  nowMs: number,
  tenantId: string,
  runtimeMode: TradeRuntimeMode
): Promise<{
  shouldOpen: boolean;
  direction?: TradeDirection;
  signal?: SimpleMomentumSignal;
  reason: string;
}> {
  // Get latest candles for this token
  // Simple momentum strategy: RSI oversold + support confirmation
  const rsiValue = Number(row.rsi ?? 50);
  const supportDist = Number(row.levels?.supportDistancePct ?? 0);
  const oversoldAtSupport = rsiValue <= 30 && Math.abs(supportDist) <= 2;

  // Assess pre-pump coil quality once (used by both the breakout and the oversold
  // mean-reversion paths). The coil gate enforces the $-liquidity / already-moved /
  // extension disqualifiers and a minimum score+tier, so illiquid or late names
  // (e.g. FORT) can never open regardless of which trigger fires.
  let coil: CoilingAssessment | null = null;
  if (PRE_PUMP_COIL_ENTRY_ENABLED || PRE_PUMP_COIL_BREAKOUT_ENTRY_ENABLED) {
    try {
      coil = await assessCoilingForSymbol(row.symbol, {
        minScore: PRE_PUMP_COIL_ENTRY_MIN_SCORE,
        minLiquidityUsd: PRE_PUMP_COIL_ENTRY_MIN_LIQUIDITY_USD,
        allowTier3: PRE_PUMP_COIL_ENTRY_ALLOW_TIER3,
        breakoutBufferPct: PRE_PUMP_COIL_BREAKOUT_BUFFER_PCT,
        breakoutMaxChasePct: PRE_PUMP_COIL_BREAKOUT_MAX_CHASE_PCT,
        breakoutMinVolSurge: PRE_PUMP_COIL_BREAKOUT_MIN_VOL_SURGE
      });
    } catch (error) {
      // Strict: if we cannot verify coil quality, do not open the trade.
      logRejection({
        symbol: row.symbol,
        signal: "PRE_PUMP_COIL_ENTRY_LONG",
        score: 0,
        direction: "LONG",
        reason: "pre-pump coil assessment failed",
        details: { error: error instanceof Error ? error.message : String(error) }
      });
      return { shouldOpen: false, reason: "coil_assessment_error" };
    }
  }

  // ── Path A: breakout-coil entry ──────────────────────────────────────────────
  // A qualified coil that is breaking out of its base (close cleared the coil
  // ceiling on a volume surge, not yet extended). This is the pre-pump swing entry
  // that fires the moment the base breaks, instead of waiting for an oversold dip.
  if (PRE_PUMP_COIL_BREAKOUT_ENTRY_ENABLED && coil && coil.breakoutReady && coil.breakout) {
    const breakoutEntryPrice = Number(row.close);
    if (!Number.isFinite(breakoutEntryPrice) || breakoutEntryPrice <= 0) {
      return { shouldOpen: false, reason: "breakout_invalid_price" };
    }
    // Geometry mirrors the swing config (SL -10% / TP +30% at 1x). The downstream
    // liquidity-hunt opener recomputes the actual TP/SL from runtime settings.
    const breakoutSignal: SimpleMomentumSignal = {
      symbol: row.symbol,
      side: "LONG",
      confidence: Math.min(100, Math.max(50, Math.round(coil.score))),
      reason: `Coil breakout (${coil.tier}, +${coil.breakout.breakoutPct.toFixed(1)}% vs base, ${coil.breakout.volumeSurgeRatio.toFixed(1)}x vol)`,
      entryPrice: breakoutEntryPrice,
      stopLoss: breakoutEntryPrice * 0.9,
      takeProfit: breakoutEntryPrice * 1.3,
      riskRewardRatio: 3.0,
      riskPercentage: 0.01
    };
    if (!isValidSignal(breakoutSignal)) {
      return { shouldOpen: false, reason: "breakout_signal_failed_validation" };
    }
    return {
      shouldOpen: true,
      direction: "LONG",
      signal: breakoutSignal,
      reason: breakoutSignal.reason
    };
  }

  // ── Path B: oversold mean-reversion at support (buy the dip) ──────────────────
  // Entry only when RSI is oversold and price is pressed against support.
  if (rsiValue > 30) {
    return { shouldOpen: false, reason: "rsi_not_oversold" };
  }
  if (Math.abs(supportDist) > 2) {
    return { shouldOpen: false, reason: "not_at_support" };
  }

  // Pre-pump coiling quality gate (swing). Only allow entries on tokens that
  // qualify as a top-quality accumulation/squeeze coil: passes the dollar-volume
  // liquidity gate (rejects illiquid penny tokens like FORT), the already-moved /
  // extension / overbought / range disqualifiers, and a minimum coiling score+tier.
  if (PRE_PUMP_COIL_ENTRY_ENABLED) {
    if (!coil) {
      return { shouldOpen: false, reason: "coil_assessment_error" };
    }
    if (!coil.qualified) {
      logRejection({
        symbol: row.symbol,
        signal: "PRE_PUMP_COIL_ENTRY_LONG",
        score: coil.score,
        direction: "LONG",
        reason: coil.disqualifiedReason ? `pre-pump coil: ${coil.disqualifiedReason}` : `pre-pump coil: ${coil.reason}`,
        details: {
          coilTier: coil.tier,
          coilScore: coil.score,
          avgDollarVol14: coil.avgDollarVol14,
          minScore: PRE_PUMP_COIL_ENTRY_MIN_SCORE,
          minLiquidityUsd: PRE_PUMP_COIL_ENTRY_MIN_LIQUIDITY_USD
        }
      });
      return { shouldOpen: false, reason: `not_prepump_coil:${coil.disqualifiedReason ?? coil.reason}` };
    }
  }

  // Calculate simple entry geometry
  const support = Number(row.levels?.localSupport ?? row.close);
  const entryPrice = support * 1.002; // Entry at 0.2% above support
  const stopLoss = entryPrice * 0.985; // 1.5% SL
  const takeProfit = entryPrice * 1.03; // 3% TP (2:1 RR)
  
  const signal: SimpleMomentumSignal = {
    symbol: row.symbol,
    side: "LONG",
    confidence: Math.min(100, Math.max(40, 70 - rsiValue)),
    reason: `RSI oversold (${rsiValue.toFixed(1)}) at support`,
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: 2.0,
    riskPercentage: 0.01
  };

  if (!isValidSignal(signal)) {
    return { shouldOpen: false, reason: "signal_failed_validation" };
  }

  return {
    shouldOpen: true,
    direction: "LONG",
    signal,
    reason: signal.reason
  };
}

async function openTradesFromSignals(
  results: TokenRsiResult[],
  tenantId: string = DEFAULT_TRADE_TENANT_ID,
  runtimeModeOverride?: TradeRuntimeMode
): Promise<void> {
  // MM: Live trading can work with any provider now (Bitunix or Coinbase)
  // Removed Bitunix-only restriction for exchange flexibility

  const nowMs = Date.now();
  const resolvedTenantId = normalizeTenantId(tenantId);
  const runtimeMode = runtimeModeOverride ?? getCurrentTradeRuntimeMode();
  const runAsLiveRuntime = runtimeMode === "LIVE" && isLiveTradingEnabled();
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
  if (countOpenTradesForMode(runtimeMode, resolvedTenantId) >= getMaxActiveTrades(accountBalanceUsd, runtimeMode)) {
    console.info("[trade-engine] Entry open blocked: max active trades reached; scanning for opportunities", {
      openTrades: countOpenTradesForMode(runtimeMode, resolvedTenantId),
      maxActiveTrades: getMaxActiveTrades(accountBalanceUsd, runtimeMode)
    });
  }

  for (const row of results) {
    const baseSymbol = getBaseSymbol(row.symbol);
    const tracking = await getBackfillStatusBestEffort(baseSymbol);
    const backfillStatus = tracking?.status ?? "PENDING";
    // Log backfill status for tracking but do not block trade entry.
    // Backfill happens per-token in the background; tokens can trade with live data while backfill is pending.
    if (backfillStatus === "NO_DATA" || backfillStatus === "SKIPPED") {
      console.debug(`[trade-engine] Token ${row.symbol} backfill status: ${backfillStatus}; allowing trade entry with live data`, {
        baseSymbol,
        backfillStatus,
        candleCount: tracking?.candleCount ?? 0
      });
    }

    // === STRATEGY SWITCH: Simple Momentum instead of MM Liquidity Hunt ===
    // Using simple RSI-based momentum strategy for Coinbase compatibility
    const momentumEntry = await evaluateSimpleMomentumEntry(row, nowMs, resolvedTenantId, runtimeMode);
    
    if (momentumEntry.shouldOpen && momentumEntry.direction && momentumEntry.signal) {
      const signal = momentumEntry.signal;
      const liquidityHuntEntry = {
        shouldOpen: true,
        direction: momentumEntry.direction,
        preSweepEntry: false,
        triggerZone: "SUPPORT" as const,
        likelySweepSide: "UPPER_SWEEP" as const,
        limitEntryPrice: signal.entryPrice,
        slLevel: signal.stopLoss,
        // Stub MM-specific properties
        breakPct: 0,
        huntScore: signal.confidence,
        flowScore: signal.confidence,
        longStopLiquidityUsd: 1000000,
        shortStopLiquidityUsd: 1000000
      };
      if (!isDirectionAllowedByMode(liquidityHuntEntry.direction)) {
        logRejection({
          symbol: row.symbol,
          signal: `LIQUIDITY_HUNT_ENTRY_${liquidityHuntEntry.direction}`,
          score: 0,
          direction: liquidityHuntEntry.direction,
          reason: "direction mode filter",
          details: {
            signalDirectionMode: SIGNAL_DIRECTION_MODE
          }
        });
        continue;
      }

      if (!TEST_OPEN_MODE) {
        const candleConfirmation = evaluateCandlestickConfirmation(row, liquidityHuntEntry.direction);
        if (!candleConfirmation.allow) {
          logRejection({
            symbol: row.symbol,
            signal: `LIQUIDITY_HUNT_ENTRY_${liquidityHuntEntry.direction}`,
            score: row.confluence.score,
            direction: liquidityHuntEntry.direction,
            reason: "candlestick confirmation",
            details: candleConfirmation.details
          });
          continue;
        }
      }

      if (HTF_MOMENTUM_ALIGNMENT_ENABLED) {
        const htfConflict = evaluateHigherTimeframeMomentumConflict(row, liquidityHuntEntry.direction);
        const shouldBlock = htfConflict.hasHigherTimeframeConflict && htfConflict.conflictScore >= HTF_MOMENTUM_BLOCK_SCORE_MIN;
        if (shouldBlock) {
          logRejection({
            symbol: row.symbol,
            signal: `LIQUIDITY_HUNT_ENTRY_${liquidityHuntEntry.direction}`,
            score: row.confluence.score,
            direction: liquidityHuntEntry.direction,
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
          if (shouldLogRejectionToConsole(row.symbol, "higher_timeframe_momentum_conflict_verbose")) {
            console.info("[trade-engine] Liquidity-hunt entry rejected: higher timeframe momentum conflict", {
              symbol: row.symbol,
              direction: liquidityHuntEntry.direction,
              conflictScore: htfConflict.conflictScore,
              blockScoreMin: HTF_MOMENTUM_BLOCK_SCORE_MIN,
              triggers: htfConflict.details
            });
          }
          continue;
        }
      }

      const liquidityHuntSignalType = `LIQUIDITY_HUNT_ENTRY_${liquidityHuntEntry.direction}`;
      const liquidityHuntEntryPrice =
        liquidityHuntEntry.preSweepEntry && LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE === "MARKET"
          ? Number(Number(row.close).toFixed(6))
          : (Number.isFinite(liquidityHuntEntry.limitEntryPrice) && liquidityHuntEntry.limitEntryPrice > 0
            ? liquidityHuntEntry.limitEntryPrice
            : Number(liquidityHuntEntry.slLevel.toFixed(6)));
      const liquidityHuntTpMoveAbs = liquidityHuntEntryPrice * (LIQUIDITY_HUNT_ENTRY_TP_PCT / 100 / LIQUIDITY_HUNT_ENTRY_LEVERAGE);
      const liquidityHuntSlMoveAbs = liquidityHuntEntryPrice * (LIQUIDITY_HUNT_ENTRY_SL_PCT / 100 / LIQUIDITY_HUNT_ENTRY_LEVERAGE);
      const liquidityHuntFallbackTpPrice = liquidityHuntEntry.direction === "LONG"
        ? toNumber(liquidityHuntEntryPrice + liquidityHuntTpMoveAbs)
        : toNumber(liquidityHuntEntryPrice - liquidityHuntTpMoveAbs);
      const liquidityHuntRawDynamicTpPrice = liquidityHuntEntry.direction === "LONG"
        ? toNumber(liquidityHuntEntry.slLevel * (1 - (LIQUIDITY_HUNT_DYNAMIC_TP_BUFFER_PCT / 100)))
        : toNumber(liquidityHuntEntry.slLevel * (1 + (LIQUIDITY_HUNT_DYNAMIC_TP_BUFFER_PCT / 100)));
      const liquidityHuntDynamicTpDirectional = liquidityHuntEntry.direction === "LONG"
        ? liquidityHuntRawDynamicTpPrice > liquidityHuntEntryPrice
        : liquidityHuntRawDynamicTpPrice < liquidityHuntEntryPrice;
      const liquidityHuntTpPrice = Number.isFinite(liquidityHuntRawDynamicTpPrice) && liquidityHuntRawDynamicTpPrice > 0 && liquidityHuntDynamicTpDirectional
        ? liquidityHuntRawDynamicTpPrice
        : liquidityHuntFallbackTpPrice;
      const liquidityHuntZoneLevelBasedSlPrice = liquidityHuntEntry.direction === "LONG"
        ? toNumber(liquidityHuntEntry.slLevel * (1 - (LIQUIDITY_HUNT_DYNAMIC_TP_BUFFER_PCT / 100)))
        : toNumber(liquidityHuntEntry.slLevel * (1 + (LIQUIDITY_HUNT_DYNAMIC_TP_BUFFER_PCT / 100)));
      const liquidityHuntPctBasedSlPrice = liquidityHuntEntry.direction === "LONG"
        ? toNumber(liquidityHuntEntryPrice - liquidityHuntSlMoveAbs)
        : toNumber(liquidityHuntEntryPrice + liquidityHuntSlMoveAbs);
      const liquidityHuntSlPrice = liquidityHuntEntry.direction === "LONG"
        ? Math.min(liquidityHuntZoneLevelBasedSlPrice, liquidityHuntPctBasedSlPrice)
        : Math.max(liquidityHuntZoneLevelBasedSlPrice, liquidityHuntPctBasedSlPrice);
      const liquidityHuntTakeProfitPct = calcLeveragedMovePct(
        liquidityHuntEntryPrice,
        liquidityHuntTpPrice,
        LIQUIDITY_HUNT_ENTRY_LEVERAGE
      );
      const liquidityHuntStopLossPct = calcLeveragedMovePct(
        liquidityHuntEntryPrice,
        liquidityHuntSlPrice,
        LIQUIDITY_HUNT_ENTRY_LEVERAGE
      );
      const liquidityHuntEntryTiming = row.entryTiming ?? classifyEntryTiming({
        direction: liquidityHuntEntry.direction,
        price: row.close,
        atr: Number(row.tradeContext?.atr ?? 0),
        supportDistancePct: Number(row.levels.supportDistancePct ?? 0),
        resistanceDistancePct: Number(row.levels.resistanceDistancePct ?? 0),
        ema20: Number(row.tradeContext?.ema20 ?? 0)
      });
      const liquidityHuntReversalPhase = resolveReversalPhase(row, liquidityHuntEntry.direction);
      const liquidityHuntHigherTimeframeTrend = resolveHigherTimeframeTrend(row);
      const liquidityHuntStructureState = resolveStructureState(row, liquidityHuntEntry.direction);
      const liquidityHuntStructureConfidence = resolveStructureConfidence(
        liquidityHuntHigherTimeframeTrend,
        liquidityHuntStructureState,
        liquidityHuntEntry.direction
      );
      const liquidityHuntMarketCondition = classifyMarketCondition(row.timeframes.macro.macdHist, row.close);
      const hasRecentLiquidityHuntReady = await hasRecentSessionOpportunity({
        symbol: row.symbol,
        direction: liquidityHuntEntry.direction,
        signalType: liquidityHuntSignalType,
        withinMinutes: TELEGRAM_ALERT_DEDUPE_MINUTES,
        reason: "ENTRY_AVAILABLE"
      });

      if (!hasRecentLiquidityHuntReady) {
        void dispatchRealtimeTelegramAlert({
          stage: "READY",
          symbol: row.symbol,
          direction: liquidityHuntEntry.direction,
          entryTiming: liquidityHuntEntryTiming,
          reversalPhase: liquidityHuntReversalPhase,
          signalType: liquidityHuntSignalType,
          entryScore: row.confluence.score,
          weightedScore: row.confluence.score,
          signalStrength: resolveSignalStrength(row),
          tpFeasibility: 1,
          structureConfidence: liquidityHuntStructureConfidence,
          volatilityPct: Number(row.tradeContext?.volatilityPct ?? row.volatilityPct ?? 0),
          takeProfitPct: liquidityHuntTakeProfitPct,
          stopLossPct: liquidityHuntStopLossPct,
          marketCondition: liquidityHuntMarketCondition,
          entryPrice: liquidityHuntEntryPrice,
          tpPrice: liquidityHuntTpPrice,
          slPrice: liquidityHuntSlPrice,
          marketStatus: row.status,
          setupConflictNote: `Liquidity-hunt ${liquidityHuntEntry.preSweepEntry ? "pre-sweep" : "touch"} ${liquidityHuntEntry.triggerZone?.toLowerCase() ?? "level"} setup (${liquidityHuntEntry.likelySweepSide.toLowerCase()})`
        });
      }

      const activeTradesCount = countOpenTradesForMode(runtimeMode, resolvedTenantId);
      persistenceTasks.push(
        appendSessionOpportunity({
          symbol: row.symbol,
          direction: liquidityHuntEntry.direction,
          signalType: liquidityHuntSignalType,
          entryScore: row.confluence.score,
          weightedScore: row.confluence.score,
          takeProfitPct: liquidityHuntTakeProfitPct,
          stopLossPct: liquidityHuntStopLossPct,
          volatilityPct: Number(row.tradeContext?.volatilityPct ?? row.volatilityPct ?? 0),
          marketCondition: liquidityHuntMarketCondition,
          availableForEntry: activeTradesCount < getMaxActiveTrades(accountBalanceUsd, runtimeMode),
          reason: activeTradesCount >= getMaxActiveTrades(accountBalanceUsd, runtimeMode)
            ? "MAX_ACTIVE_TRADE_REACHED"
            : "ENTRY_AVAILABLE"
        }).catch((error) => {
          console.error("[trade-engine] Failed to persist liquidity-hunt session opportunity", {
            symbol: row.symbol,
            error: error instanceof Error ? error.message : String(error)
          });
        })
      );

      if (activeTradesCount >= getMaxActiveTrades(accountBalanceUsd, runtimeMode)) {
        logRejection({
          symbol: row.symbol,
          signal: liquidityHuntSignalType,
          score: row.confluence.score,
          direction: liquidityHuntEntry.direction,
          reason: "max active trades reached",
          details: {
            activeTrades: activeTradesCount,
            maxActiveTrades: getMaxActiveTrades(accountBalanceUsd, runtimeMode)
          }
        });
        continue;
      }

      try {
        await openLiquidityHuntEntry(
          row,
          resolvedTenantId,
          runtimeMode,
          liquidityHuntEntry.direction,
          liquidityHuntEntry.slLevel,
          liquidityHuntEntry.limitEntryPrice,
          liquidityHuntEntry.preSweepEntry,
          nowMs,
          liquidityHuntEntry.triggerZone,
          liquidityHuntEntry.breakPct,
          liquidityHuntEntry.huntScore,
          liquidityHuntEntry.flowScore,
          liquidityHuntEntry.likelySweepSide,
          liquidityHuntEntry.longStopLiquidityUsd,
          liquidityHuntEntry.shortStopLiquidityUsd
        );
      } catch (error) {
        console.error("[trade-engine] Failed to open liquidity hunt entry", {
          symbol: row.symbol,
          direction: liquidityHuntEntry.direction,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      continue;
    }

    // Skip normal entry logic if in liquidity hunt only mode
    if (LIQUIDITY_HUNT_ONLY_MODE) {
      continue;
    }

    const isLarge = isLargeCap(row.symbol);
    const baseScoreThreshold = isLarge ? BTC_SCORE_ENTRY_THRESHOLD : SCORE_ENTRY_THRESHOLD;
    const strongSignal = isStrongSignal(row.signal.type);
    const lowVolRegime = row.tradeContext?.regime === "LOW_VOL";
    let signalDirection = signalToDirection(row.signal.type);
    const fibTouchMemory = getFibTouchMemory(row.symbol, nowMs);
    const volatilityPct = Number(row.tradeContext?.volatilityPct ?? row.volatilityPct ?? 0);
    const minScoreThreshold = getAdaptiveScoreThreshold(baseScoreThreshold, volatilityPct);
    const scoreQualified = row.confluence.score >= minScoreThreshold;
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
        void dispatchRealtimeTelegramAlert({
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
      const oppositeOpenTrade = openTrades.get(
        getTradeKey(row.symbol, oppositeDirection, getCurrentTradeRuntimeMode(), resolvedTenantId)
      );

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

        void dispatchRealtimeTelegramAlert({
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
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        reason: "signal/score below threshold",
        details: {
          strongSignal,
          scoreQualified,
          minScoreThreshold,
          fibTouchMemory: fibTouchMemory != null,
          bias: row.confluence.bias
        }
      });
      continue;
    }

    if (lowVolRegime && !strongSignal && row.confluence.score < 5) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        reason: "low-vol regime requires stronger score",
        details: {
          regime: row.tradeContext?.regime ?? "UNKNOWN",
          signalType: row.signal.type,
          strongSignal,
          score: row.confluence.score,
          requiredScore: 5
        }
      });
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
      if (shouldLogRejectionToConsole(row.symbol, "no_directional_signal")) {
        console.info("[trade-engine] Trade rejected: no directional signal", {
          symbol: row.symbol,
          signal: row.signal.type,
          bias: row.confluence.bias,
          score: row.confluence.score,
          minScoreThreshold
        });
      }
      continue;
    }

    if (!isDirectionAllowedByMode(signalDirection)) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction: signalDirection,
        reason: "direction mode filter",
        details: {
          signalDirectionMode: SIGNAL_DIRECTION_MODE
        }
      });
      continue;
    }

    const candlestickRequired = shouldRequireCandlestickConfirmation(row.signal.type);
    if (!TEST_OPEN_MODE && candlestickRequired) {
      const candleConfirmation = evaluateCandlestickConfirmation(row, signalDirection);
      if (!candleConfirmation.allow) {
        logRejection({
          symbol: row.symbol,
          signal: row.signal.type,
          score: row.confluence.score,
          direction: signalDirection,
          reason: "candlestick confirmation",
          details: candleConfirmation.details
        });
        if (shouldLogRejectionToConsole(row.symbol, "candlestick_confirmation_verbose")) {
          console.info("[trade-engine] Trade rejected: candlestick confirmation", {
            symbol: row.symbol,
            signal: row.signal.type,
            direction: signalDirection,
            ...candleConfirmation.details
          });
        }
        continue;
      }
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
        if (shouldLogRejectionToConsole(row.symbol, "higher_timeframe_momentum_conflict_verbose")) {
          console.info("[trade-engine] Trade rejected: higher timeframe momentum conflict", {
            symbol: row.symbol,
            signal: row.signal.type,
            direction: signalDirection,
            conflictScore: htfConflict.conflictScore,
            blockScoreMin: HTF_MOMENTUM_BLOCK_SCORE_MIN,
            triggers: htfConflict.details
          });
        }
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
      logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction: signalDirection, reason: "low liquidity", details: { volume24h, minVolumeUsd } });
      if (shouldLogRejectionToConsole(row.symbol, "low_liquidity_verbose")) {
        console.info("[trade-engine] Trade rejected: low liquidity", {
          symbol: row.symbol,
          signal: row.signal.type,
          score: row.confluence.score,
          volume24h,
          minVolumeUsd
        });
      }
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
    if (!TEST_OPEN_MODE && isWeakDirectionalSignal(row.signal.type) && candidate.entryTiming !== "MID") {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction: signalDirection,
        reason: "weak signal requires MID timing",
        details: {
          entryTiming: candidate.entryTiming,
          requiredTiming: "MID"
        }
      });
      continue;
    }
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

    if (AI_DECISION_CONFIG.enabled) {
      const aiDecision = await evaluateAiDecision(row, signalDirection);
      const aiDirectionAligned = aiDecision.direction === signalDirection;
      const aiConfidencePass = aiDecision.confidence >= AI_DECISION_CONFIG.minConfidence;
      const aiAllowsEntry = aiDirectionAligned && aiConfidencePass && aiDecision.direction !== "ABSTAIN";

      if (AI_DECISION_CONFIG.logDecisions || !aiAllowsEntry || AI_DECISION_CONFIG.shadowMode) {
        console.info("[trade-engine] AI decision", {
          symbol: row.symbol,
          signalType: row.signal.type,
          proposedDirection: signalDirection,
          aiDirection: aiDecision.direction,
          aiConfidence: aiDecision.confidence,
          minConfidence: AI_DECISION_CONFIG.minConfidence,
          aiExpectedEdgePct: aiDecision.expectedEdgePct,
          aiProvider: aiDecision.provider,
          aiModel: aiDecision.model,
          shadowMode: AI_DECISION_CONFIG.shadowMode,
          allowsEntry: aiAllowsEntry,
          reasonCodes: aiDecision.reasonCodes
        });
      }

      if (!TEST_OPEN_MODE && !AI_DECISION_CONFIG.shadowMode && !aiAllowsEntry) {
        logRejection({
          symbol: row.symbol,
          signal: row.signal.type,
          score: row.confluence.score,
          direction: signalDirection,
          reason: "ai decision gate",
          details: {
            aiDirection: aiDecision.direction,
            aiConfidence: aiDecision.confidence,
            minConfidence: AI_DECISION_CONFIG.minConfidence,
            aiExpectedEdgePct: aiDecision.expectedEdgePct,
            aiProvider: aiDecision.provider,
            aiModel: aiDecision.model,
            reasonCodes: aiDecision.reasonCodes
          }
        });
        continue;
      }
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
      void dispatchRealtimeTelegramAlert({
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
        availableForEntry: countOpenTradesForMode(runtimeMode, resolvedTenantId) < getMaxActiveTrades(accountBalanceUsd, runtimeMode),
        reason: countOpenTradesForMode(runtimeMode, resolvedTenantId) >= getMaxActiveTrades(accountBalanceUsd, runtimeMode)
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
    const activeTradesCount = countOpenTradesForMode(runtimeMode, resolvedTenantId);
    if (activeTradesCount >= getMaxActiveTrades(accountBalanceUsd, runtimeMode)) {
      logRejection({
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        direction,
        reason: "max active trades reached",
        details: {
          activeTrades: activeTradesCount,
          maxActiveTrades: getMaxActiveTrades(accountBalanceUsd, runtimeMode)
        }
      });
      break;
    }

    const openDecision = evaluateOpenTradeEligibility(row.symbol, direction, nowMs, runtimeMode, resolvedTenantId);
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
      activeTradesCount,
      candidate.stopLossPct,
      leverageForTrade,
      riskPerTrade,
      runtimeMode
    );
    let positionSizeUsd = scaleStakeByVolatility(basePositionSizeUsd, volatilityPct);
    const useBalanceDrivenSimulationSizing = !runAsLiveRuntime && SIM_BALANCE_DRIVEN_SIZING_ENABLED;
    if (useBalanceDrivenSimulationSizing) {
      const simulationStakeCapUsd = getBalanceDrivenSimStakeUsd(accountBalanceUsd, activeTradesCount);
      positionSizeUsd = Number(Math.min(positionSizeUsd, simulationStakeCapUsd).toFixed(2));
    }

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
    let openFeeUsd = SIM_SIGNAL_ONLY_MODE ? 0 : Number((positionSizeUsd * TRADING_FEE_RATE).toFixed(2));
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
    let usedRelaxedExecutionRetry = false;

    if (!TEST_OPEN_MODE) {
      const orderBookRead = await fetchOrderBookExecutionRead(row.symbol);
      if (!orderBookRead) {
        logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction, reason: "order book unavailable", details: {} });
        console.info("[trade-engine] Trade rejected: order book unavailable", { symbol: row.symbol, signal: row.signal.type });
        continue;
      }

      const maxSlippagePctForSymbol = getMaxSlippagePctForSymbol(row.symbol);

      const runtimeOrderBookPass = passesRuntimeOrderBookGate(
        row.symbol,
        direction,
        orderBookRead.spreadPct,
        orderBookRead.combinedDepthUsd,
        orderBookRead.imbalance,
        orderNotionalUsd
      );
      if (!runtimeOrderBookPass) {
        const relaxedRuntimeOrderBookPass = passesRuntimeOrderBookGate(
          row.symbol,
          direction,
          orderBookRead.spreadPct,
          orderBookRead.combinedDepthUsd,
          orderBookRead.imbalance,
          orderNotionalUsd,
          1.25
        );

        if (relaxedRuntimeOrderBookPass) {
          usedRelaxedExecutionRetry = true;
        } else {
        logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction, reason: "order book execution guard", details: { spreadPct: orderBookRead.spreadPct, depthUsd: orderBookRead.combinedDepthUsd, imbalance: orderBookRead.imbalance, orderNotionalUsd } });
        console.info("[trade-engine] Trade rejected: runtime order book execution guard", { symbol: row.symbol, signal: row.signal.type, spreadPct: orderBookRead.spreadPct, depthUsd: orderBookRead.combinedDepthUsd, imbalance: orderBookRead.imbalance, orderNotionalUsd, maxSpreadPct: isLargeCap(row.symbol) ? ORDERBOOK_MAX_SPREAD_PCT_LARGE : ORDERBOOK_MAX_SPREAD_PCT_ALT, minDepthUsd: orderNotionalUsd * ORDERBOOK_MIN_DEPTH_MULTIPLIER, maxAgainstImbalance: ORDERBOOK_MAX_AGAINST_IMBALANCE });
        continue;
        }
      }

      const strictExecutionValidation = validateExecution({
        spreadPct: orderBookRead.spreadPct,
        depthUsd: Math.max(orderBookRead.combinedDepthUsd, 0),
        orderNotional: orderNotionalUsd,
        maxSpread: getOrderBookSpreadLimitPct(row.symbol),
        minDepthMultiplier: ORDERBOOK_MIN_DEPTH_MULTIPLIER,
        maxSlippage: maxSlippagePctForSymbol / 100,
        ignoreSlippageGuard: IGNORE_SLIPPAGE_GUARD
      });

      let executionValidation = strictExecutionValidation;
      let maxSlippagePctEffective = maxSlippagePctForSymbol;
      if (!strictExecutionValidation.ok && !IGNORE_SLIPPAGE_GUARD) {
        const relaxedExecutionValidation = validateExecution({
          spreadPct: orderBookRead.spreadPct,
          depthUsd: Math.max(orderBookRead.combinedDepthUsd, 0),
          orderNotional: orderNotionalUsd,
          maxSpread: getOrderBookSpreadLimitPct(row.symbol) * 1.25,
          minDepthMultiplier: ORDERBOOK_MIN_DEPTH_MULTIPLIER / 1.25,
          maxSlippage: (maxSlippagePctForSymbol * 1.25) / 100,
          ignoreSlippageGuard: IGNORE_SLIPPAGE_GUARD
        });

        if (relaxedExecutionValidation.ok) {
          executionValidation = relaxedExecutionValidation;
          usedRelaxedExecutionRetry = true;
          maxSlippagePctEffective = maxSlippagePctForSymbol * 1.25;
        }
      }

      simulatedSlippagePct = Number((executionValidation.slippage * 100).toFixed(4));
      const appliedSlippage = IGNORE_SLIPPAGE_GUARD ? 0 : executionValidation.slippage;
      appliedSlippagePct = Number((appliedSlippage * 100).toFixed(4));

      const slippageExceeded = simulatedSlippagePct > maxSlippagePctEffective;
      if (!executionValidation.ok || (!IGNORE_SLIPPAGE_GUARD && slippageExceeded)) {
        logRejection({ symbol: row.symbol, signal: row.signal.type, score: row.confluence.score, direction, reason: "slippage protection", details: { slippagePct: simulatedSlippagePct, maxSlippagePct: maxSlippagePctEffective, depthUsd: orderBookRead.combinedDepthUsd, orderNotionalUsd, relaxedRetryAttempted: true, relaxedRetryUsed: usedRelaxedExecutionRetry } });
        console.info("[trade-engine] Trade rejected: slippage protection", { symbol: row.symbol, depthUsdAt10bps: orderBookRead.combinedDepthUsd, orderNotionalUsd, slippagePct: simulatedSlippagePct, maxSlippagePct: maxSlippagePctEffective, ignoreSlippageGuard: IGNORE_SLIPPAGE_GUARD, relaxedRetryUsed: usedRelaxedExecutionRetry });
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
      executionFallbackRetryUsed: usedRelaxedExecutionRetry,
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
      id: `${row.symbol}-${direction}-${nowMs}-${runtimeMode}`,
      tenantId: resolvedTenantId,
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
      stakeSource: resolveTradeStakeSource(runtimeMode),
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
      isLiveTrade: runAsLiveRuntime,
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

    if (runAsLiveRuntime) {
      let liveOpenAllowed = true;

      const liveReadiness = await evaluateLiveOpenReadiness({
        symbol: row.symbol,
        direction,
        stakeUsd: positionSizeUsd
      });
      if (!liveReadiness.allow) {
        logRejection({
          symbol: row.symbol,
          signal: row.signal.type,
          score: row.confluence.score,
          direction,
          reason: liveReadiness.reason ?? "live open readiness check failed",
          details: liveReadiness.details ?? {}
        });
        liveOpenAllowed = false;
      }

      if (liveOpenAllowed) {
        try {
          const liveOrder = await executeLiveOpenOrder({
            symbol: row.symbol,
            direction,
            leverage: leverageForTrade,
            entryPrice: effectiveEntry,
            stakeUsd: positionSizeUsd,
            localTradeId: trade.id,
            tpPrice: levels.tpPrice,
            slPrice: levels.slPrice
          });
          trade.isLiveTrade = true;
          trade.liveOrderId = liveOrder.orderId;
          trade.liveClientId = liveOrder.clientId;
          trade.livePositionId = liveOrder.positionId;
          if (liveOrder.stakeUsdUsed > 0 && liveOrder.stakeUsdUsed !== trade.stakeUsd) {
            positionSizeUsd = Number(liveOrder.stakeUsdUsed.toFixed(2));
            trade.stakeUsd = positionSizeUsd;
            trade.openFeeUsd = Number((positionSizeUsd * TRADING_FEE_RATE).toFixed(2));
            trade.positionValueUsd = positionSizeUsd;
            trade.marginUsedUsd = positionSizeUsd;
            openFeeUsd = trade.openFeeUsd;
          }
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
          liveOpenAllowed = false;
        }
      }

      if (!liveOpenAllowed) {
        console.info("[trade-engine] Live auto-open blocked; skipping local fallback trade", {
          symbol: row.symbol,
          direction,
          signal: row.signal.type
        });
        continue;
      }
    }

    enrichTradeWithProductionRead(trade, null);

    if (!SIM_SIGNAL_ONLY_MODE) {
      accountBalanceUsd = Number((accountBalanceUsd - openFeeUsd).toFixed(2));
    }

    const key = getTradeKeyForTrade(trade);
    openTrades.set(key, trade);
    lastOpenedByKey.set(key, nowMs);
    openedAnyTrade = true;

    void sendTradeLifecycleTelegram({
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
    }, Boolean(trade.isLiveTrade), trade);

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

function buildSnapshot(options?: { includeLiveTrades?: boolean; tenantId?: string }): TradeSimulationSnapshot {
  const includeLiveTrades = options?.includeLiveTrades ?? true;
  const tenantId = typeof options?.tenantId === "string" ? normalizeTenantId(options.tenantId) : null;
  const activeSource = includeLiveTrades
    ? Array.from(openTrades.values()).filter((trade) => (tenantId ? isTradeInTenant(trade, tenantId) : true))
    : Array.from(openTrades.values()).filter(
      (trade) => !trade.isLiveTrade && (tenantId ? isTradeInTenant(trade, tenantId) : true)
    );
  const closedSource = includeLiveTrades
    ? closedTrades.filter((trade) => (tenantId ? isTradeInTenant(trade, tenantId) : true))
    : closedTrades.filter((trade) => !trade.isLiveTrade && (tenantId ? isTradeInTenant(trade, tenantId) : true));

  const active = activeSource.sort((a, b) => Date.parse(b.openTime) - Date.parse(a.openTime));
  const recentClosed = closedSource
    .sort((a, b) => Date.parse(b.closeTime ?? b.openTime) - Date.parse(a.closeTime ?? a.openTime))
    .slice(0, 50);

  return {
    stats: computeStats(active, closedSource),
    activeTrades: active,
    recentClosedTrades: recentClosed
  };
}

export async function processTradeSimulation(
  results: TokenRsiResult[],
  options?: { tenantId?: string; runtimeMode?: TradeRuntimeMode }
): Promise<TradeSimulationSnapshot> {
  const tenantId = normalizeTenantId(options?.tenantId);
  const runtimeMode = options?.runtimeMode ?? getCurrentTradeRuntimeMode();
  await hydrateRuntimeStateFromStorage();
  await reconcileLiveLedgerWithRuntimeState();
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
  await processSimPendingLimitOrders();
  await openTradesFromSignals(results, tenantId, runtimeMode);

  persistRuntimeState();

  return buildSnapshot({ tenantId });
}

export async function refreshTradeSimulation(options?: { tenantId?: string }): Promise<TradeSimulationSnapshot> {
  await hydrateRuntimeStateFromStorage();
  await reconcileLiveLedgerWithRuntimeState();
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
  await processSimPendingLimitOrders();
  persistRuntimeState();
  return buildSnapshot({ tenantId: options?.tenantId });
}

export async function forceCloseOpenTradesBySymbol(
  symbol: string,
  options?: { simulateOnly?: boolean; tenantId?: string }
): Promise<{ closedCount: number; snapshot: TradeSimulationSnapshot }> {
  await hydrateRuntimeStateFromStorage();
  await updateOpenTradesFromMarket();
  const includeLiveTrades = !(options?.simulateOnly ?? false);
  const tenantId = normalizeTenantId(options?.tenantId);

  const normalized = symbol.trim().toUpperCase();
  if (!normalized) {
    const snapshot = buildSnapshot({ includeLiveTrades, tenantId });
    return { closedCount: 0, snapshot };
  }

  const toClose = Array.from(openTrades.values()).filter(
    (trade) =>
      trade.status === "OPEN" &&
      trade.token.trim().toUpperCase() === normalized &&
      isTradeInTenant(trade, tenantId) &&
      (includeLiveTrades || !trade.isLiveTrade)
  );

  const closeTime = nowIso();
  for (const trade of toClose) {
    await closeTradeAtMarket(trade, closeTime, "MANUAL_FORCE_CLOSE");
  }

  persistRuntimeState();
  const snapshot = buildSnapshot({ includeLiveTrades, tenantId });
  return { closedCount: toClose.length, snapshot };
}

export async function forceReopenLastClosedTrade(
  symbol?: string,
  options?: { simulateOnly?: boolean; tenantId?: string }
): Promise<{ reopened: boolean; reason?: string; reopenedTradeId?: string; snapshot: TradeSimulationSnapshot }> {
  await hydrateRuntimeStateFromStorage();
  await updateOpenTradesFromMarket();
  const includeLiveTrades = !(options?.simulateOnly ?? false);
  const tenantId = normalizeTenantId(options?.tenantId);
  const intendedRuntimeMode: TradeRuntimeMode = includeLiveTrades
    ? getCurrentTradeRuntimeMode()
    : "SIM";
  const activeTradesCount = includeLiveTrades
    ? countOpenTradesForMode(intendedRuntimeMode, tenantId)
    : Array.from(openTrades.values()).filter((trade) => !trade.isLiveTrade && isTradeInTenant(trade, tenantId)).length;

  if (isLiveTradingEnabled() && includeLiveTrades) {
    return {
      reopened: false,
      reason: "Manual reopen is disabled while live trading is enabled",
      snapshot: buildSnapshot({ includeLiveTrades, tenantId })
    };
  }

  const normalized = symbol?.trim().toUpperCase();
  const sortedClosed = (includeLiveTrades ? [...closedTrades] : closedTrades.filter((trade) => !trade.isLiveTrade))
    .filter((trade) => isTradeInTenant(trade, tenantId))
    .sort(
    (a, b) => Date.parse(b.closeTime ?? b.openTime) - Date.parse(a.closeTime ?? a.openTime)
  );

  const sourceTrade = normalized
    ? sortedClosed.find((trade) => trade.token.trim().toUpperCase() === normalized)
    : sortedClosed[0];

  if (!sourceTrade) {
    return {
      reopened: false,
      reason: normalized ? `No closed trade found for ${normalized}` : "No closed trades found",
      snapshot: buildSnapshot({ includeLiveTrades, tenantId })
    };
  }

  if (sourceTrade.status !== "WIN" && sourceTrade.status !== "LOSS") {
    return {
      reopened: false,
      reason: "Source trade is not closed",
      snapshot: buildSnapshot({ includeLiveTrades, tenantId })
    };
  }

  const key = getTradeKey(sourceTrade.token, sourceTrade.direction, intendedRuntimeMode, tenantId);
  if (openTrades.has(key)) {
    return {
      reopened: false,
      reason: `Trade already open for ${sourceTrade.token} ${sourceTrade.direction}`,
      snapshot: buildSnapshot({ includeLiveTrades, tenantId })
    };
  }

  if (activeTradesCount >= getMaxActiveTrades(accountBalanceUsd, intendedRuntimeMode)) {
    return {
      reopened: false,
      reason: "Max active trades reached",
      snapshot: buildSnapshot({ includeLiveTrades, tenantId })
    };
  }

  const simulationStakeCapUsd = getBalanceDrivenSimStakeUsd(accountBalanceUsd, activeTradesCount);
  const positionSizeUsd = Math.min(sourceTrade.stakeUsd, simulationStakeCapUsd, accountBalanceUsd);
  const openFeeUsd = Number((positionSizeUsd * TRADING_FEE_RATE).toFixed(2));
  if (!Number.isFinite(positionSizeUsd) || positionSizeUsd <= 0 || accountBalanceUsd - openFeeUsd <= 0) {
    return {
      reopened: false,
      reason: "Insufficient balance to reopen trade",
      snapshot: buildSnapshot({ includeLiveTrades, tenantId })
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
      snapshot: buildSnapshot({ includeLiveTrades, tenantId })
    };
  }

  const now = nowIso();
  const levels = getTradeLevels(currentPrice, sourceTrade.direction, sourceTrade.token, sourceTrade.atr);

  const reopenedTrade: Trade = {
    ...sourceTrade,
    tenantId,
    id: `${sourceTrade.token}-${sourceTrade.direction}-${Date.now()}-${intendedRuntimeMode}-MANUAL_REOPEN`,
    isLiveTrade: false,
    stakeSource: "SIM_REOPEN_CAPPED",
    liveOrderId: undefined,
    liveClientId: undefined,
    livePositionId: undefined,
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

  void sendTradeLifecycleTelegram({
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
  }, Boolean(reopenedTrade.isLiveTrade), reopenedTrade);

  persistRuntimeState();
  return {
    reopened: true,
    reopenedTradeId: reopenedTrade.id,
    snapshot: buildSnapshot({ includeLiveTrades, tenantId })
  };
}

export async function forceRemoveClosedTrade(
  input: { id?: string; symbol?: string },
  options?: { simulateOnly?: boolean; tenantId?: string }
): Promise<{ removed: boolean; reason?: string; removedTradeId?: string; snapshot: TradeSimulationSnapshot }> {
  await hydrateRuntimeStateFromStorage();
  reconcileAccountBalanceFromLedger();
  const includeLiveTrades = !(options?.simulateOnly ?? false);
  const tenantId = normalizeTenantId(options?.tenantId);
  const closedUniverse = includeLiveTrades
    ? closedTrades
    : closedTrades.filter((trade) => !trade.isLiveTrade);
  const tenantClosedUniverse = closedUniverse.filter((trade) => isTradeInTenant(trade, tenantId));

  const normalizedId = input.id?.trim();
  const normalizedSymbol = input.symbol?.trim().toUpperCase();

  let targetIndex = -1;
  if (normalizedId) {
    targetIndex = closedTrades.findIndex(
      (trade) => trade.id === normalizedId && (includeLiveTrades || !trade.isLiveTrade) && isTradeInTenant(trade, tenantId)
    );
  } else if (normalizedSymbol) {
    targetIndex = tenantClosedUniverse
      .map((trade, index) => ({ trade, index }))
      .filter(({ trade }) => trade.token.trim().toUpperCase() === normalizedSymbol)
      .sort((a, b) => Date.parse(b.trade.closeTime ?? b.trade.openTime) - Date.parse(a.trade.closeTime ?? a.trade.openTime))[0]?.index ?? -1;

    if (!includeLiveTrades && targetIndex >= 0) {
      const targetTrade = tenantClosedUniverse[targetIndex];
      targetIndex = closedTrades.findIndex((trade) => trade.id === targetTrade.id);
    }
  }

  if (targetIndex < 0) {
    return {
      removed: false,
      reason: normalizedId
        ? `Closed trade not found for id ${normalizedId}`
        : normalizedSymbol
          ? `Closed trade not found for symbol ${normalizedSymbol}`
          : "Provide id or symbol",
      snapshot: buildSnapshot({ includeLiveTrades, tenantId })
    };
  }

  const [removedTrade] = closedTrades.splice(targetIndex, 1);
  reconcileAccountBalanceFromLedger();
  persistRuntimeState();

  return {
    removed: true,
    removedTradeId: removedTrade.id,
    snapshot: buildSnapshot({ includeLiveTrades, tenantId })
  };
}

export async function forceResetTradingRuntime(options?: { simulateOnly?: boolean; tenantId?: string }): Promise<TradeSimulationSnapshot> {
  const includeLiveTrades = !(options?.simulateOnly ?? false);
  const tenantId = normalizeTenantId(options?.tenantId);

  if (!includeLiveTrades) {
    for (const [key, trade] of openTrades.entries()) {
      if (!trade.isLiveTrade && isTradeInTenant(trade, tenantId)) {
        openTrades.delete(key);
        lastOpenedByKey.delete(key);
      }
    }
    for (const [key, pending] of simPendingLimitOrdersByKey.entries()) {
      if (isTradeInTenant(pending.tradeTemplate, tenantId)) {
        simPendingLimitOrdersByKey.delete(key);
      }
    }

    for (let index = closedTrades.length - 1; index >= 0; index -= 1) {
      if (!closedTrades[index]?.isLiveTrade && isTradeInTenant(closedTrades[index], tenantId)) {
        closedTrades.splice(index, 1);
      }
    }

    reconcileAccountBalanceFromLedger();
    persistRuntimeState();
    return buildSnapshot({ includeLiveTrades: false, tenantId });
  }

  hydratedFromStorage = true;
  openTrades.clear();
  closedTrades.length = 0;
  lastOpenedByKey.clear();
  lastHuntOrphanSLBySymbol.clear();
  simPendingLimitOrdersByKey.clear();

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
  return buildSnapshot({ tenantId });
}

export async function forceClearCooldown(options?: { tenantId?: string }): Promise<TradeSimulationSnapshot> {
  await hydrateRuntimeStateFromStorage();
  cooldownUntilMs = 0;
  persistRuntimeState();
  return buildSnapshot({ tenantId: normalizeTenantId(options?.tenantId) });
}

export async function forceOpenManualTrade(input: {
  symbol: string;
  direction: TradeDirection;
  signalType?: string;
  entryPrice?: number;
}, options?: { simulateOnly?: boolean; tenantId?: string }): Promise<{ opened: boolean; reason?: string; tradeId?: string; snapshot: TradeSimulationSnapshot }> {
  await hydrateRuntimeStateFromStorage();
  reconcileAccountBalanceFromLedger();
  const includeLiveTrades = !(options?.simulateOnly ?? false);
  const tenantId = normalizeTenantId(options?.tenantId);
  const runAsSimulationOnly = !includeLiveTrades;
  const intendedRuntimeMode: TradeRuntimeMode = runAsSimulationOnly
    ? "SIM"
    : (isBitunixLiveTradingMode() ? "LIVE" : "SIM");
  const runAsLiveRuntime = intendedRuntimeMode === "LIVE" && isLiveTradingEnabled();
  const activeTradesCount = includeLiveTrades
    ? countOpenTradesForMode(intendedRuntimeMode, tenantId)
    : Array.from(openTrades.values()).filter((trade) => !trade.isLiveTrade && isTradeInTenant(trade, tenantId)).length;
  const snapshotForMode = (): TradeSimulationSnapshot => buildSnapshot({ includeLiveTrades, tenantId });

  if (isLiveTradingEnabled() && MARKET_DATA_PROVIDER !== "BITUNIX" && !runAsSimulationOnly) {
    return {
      opened: false,
      reason: `Live trading requires Bitunix provider, current provider is ${MARKET_DATA_PROVIDER}`,
      snapshot: snapshotForMode()
    };
  }

  const symbol = normalizePerpSymbol(input.symbol);
  const direction = input.direction;
  if (!symbol) {
    return { opened: false, reason: "Symbol is required", snapshot: snapshotForMode() };
  }

  if (openTrades.has(getTradeKey(symbol, direction, intendedRuntimeMode, tenantId))) {
    return { opened: false, reason: `Trade already open for ${symbol} ${direction}`, snapshot: snapshotForMode() };
  }

  if (activeTradesCount >= getMaxActiveTrades(accountBalanceUsd, intendedRuntimeMode)) {
    return { opened: false, reason: "Max active trades reached", snapshot: snapshotForMode() };
  }

  let entryPrice = Number(input.entryPrice ?? Number.NaN);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    const ohlc = await fetchLatestOhlc(symbol, "15m");
    if (!ohlc || !Number.isFinite(ohlc.close) || ohlc.close <= 0) {
      return { opened: false, reason: `No valid price available for ${symbol}`, snapshot: snapshotForMode() };
    }
    entryPrice = Number(ohlc.close);
  }

  entryPrice = Number(entryPrice.toFixed(6));
  const levels = getTradeLevels(entryPrice, direction, symbol, 0);
  const leverageForTrade = getLeverageForSymbol(symbol);
  const riskPerTrade = getRiskPerTradeForSymbol(symbol);
  let stakeUsd = getPositionSizeUsd(
    accountBalanceUsd,
    activeTradesCount,
    levels.stopLossPct,
    leverageForTrade,
    riskPerTrade,
    intendedRuntimeMode
  );
  let openFeeUsd = Number((stakeUsd * TRADING_FEE_RATE).toFixed(2));
  if (!Number.isFinite(stakeUsd) || stakeUsd <= 0 || accountBalanceUsd - openFeeUsd <= 0) {
    return { opened: false, reason: "Insufficient balance", snapshot: snapshotForMode() };
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
      snapshot: snapshotForMode()
    };
  }

  const trade: Trade = {
    id: `${symbol}-${direction}-${Date.now()}-${intendedRuntimeMode}-MANUAL_OPEN`,
    tenantId,
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
    stakeSource: resolveTradeStakeSource(intendedRuntimeMode),
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
    isLiveTrade: runAsLiveRuntime,
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

  if (isBitunixLiveTradingMode() && !runAsSimulationOnly) {
    const liveReadiness = await evaluateLiveOpenReadiness({
      symbol,
      direction,
      stakeUsd
    });
    if (!liveReadiness.allow) {
      logRejection({
        symbol,
        signal: trade.signalType,
        score: 0,
        direction,
        reason: liveReadiness.reason ?? "live open readiness check failed",
        details: liveReadiness.details ?? {}
      });
      return {
        opened: false,
        reason: liveReadiness.reason ?? "live open readiness check failed",
        snapshot: snapshotForMode()
      };
    }

    try {
      const liveOrder = await executeLiveOpenOrder({
        symbol,
        direction,
        leverage: leverageForTrade,
        entryPrice,
        stakeUsd,
        localTradeId: trade.id,
        tpPrice: levels.tpPrice,
        slPrice: levels.slPrice
      });
      trade.isLiveTrade = true;
      trade.liveOrderId = liveOrder.orderId;
      trade.liveClientId = liveOrder.clientId;
      trade.livePositionId = liveOrder.positionId;
      if (liveOrder.stakeUsdUsed > 0 && liveOrder.stakeUsdUsed !== trade.stakeUsd) {
        stakeUsd = Number(liveOrder.stakeUsdUsed.toFixed(2));
        trade.stakeUsd = stakeUsd;
        trade.openFeeUsd = Number((stakeUsd * TRADING_FEE_RATE).toFixed(2));
        trade.positionValueUsd = Number((stakeUsd * leverageForTrade).toFixed(2));
        trade.marginUsedUsd = stakeUsd;
        openFeeUsd = trade.openFeeUsd;
      }
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
        snapshot: snapshotForMode()
      };
    }
  }

  accountBalanceUsd = Number((accountBalanceUsd - openFeeUsd).toFixed(2));
  const key = getTradeKeyForTrade(trade);
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

  void sendTradeLifecycleTelegram({
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
  }, Boolean(trade.isLiveTrade), trade);

  persistRuntimeState();
  return {
    opened: true,
    tradeId: trade.id,
    snapshot: snapshotForMode()
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
    if (openTrades.has(getTradeKey(symbol, "LONG", getCurrentTradeRuntimeMode()))) {
      skipped.push({ symbol, reason: "Trade already open for LONG" });
      continue;
    }

    if (countOpenTradesForMode(getCurrentTradeRuntimeMode()) >= getMaxActiveTrades(accountBalanceUsd)) {
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

export function getTradeSimulationSnapshot(options?: { tenantId?: string }): TradeSimulationSnapshot {
  return buildSnapshot({ tenantId: options?.tenantId });
}

export async function buildLiveAccountSnapshot(): Promise<any> {
  try {
    if (!isLiveTradingEnabled()) {
      return null;
    }

    const [accountSnapshot, historyResult] = await Promise.all([
      fetchBitunixAccountSnapshot(),
      fetchBitunixClosedTradeHistory({ pageSize: 50 })
    ]);

    const available = parseFloat(accountSnapshot.account?.available ?? "0") || 0;
    const frozen = parseFloat(accountSnapshot.account?.frozen ?? "0") || 0;
    const margin = parseFloat(accountSnapshot.account?.margin ?? "0") || 0;
    const bonus = parseFloat(accountSnapshot.account?.bonus ?? "0") || 0;
    const accountBalance = available + frozen + margin + bonus;

    // Convert open positions to activeTrades format
    const activeTrades = accountSnapshot.positions.map((position: any, idx: number) => {
      const token = String(position.symbol ?? `POS_${idx}`).replace(/USDT|PERP|_PERP/, "");
      const direction = String(position.side ?? "LONG").toUpperCase() as "LONG" | "SHORT";
      const qty = parseFloat(position.qty ?? "0") || 0;
      const avgOpenPrice = parseFloat(position.avgOpenPrice ?? "0") || 0;
      const markPrice = parseFloat(position.markPrice ?? avgOpenPrice) || avgOpenPrice;
      const leverage = parseFloat(position.leverage ?? "1") || 1;
      const margin = parseFloat(position.margin ?? "0") || 0;
      const unrealizedPnl = parseFloat(position.unrealizedPNL ?? "0") || 0;
      const notional = Math.abs(qty) * markPrice;

      const pnlPct = avgOpenPrice > 0 ? ((markPrice - avgOpenPrice) / avgOpenPrice) * 100 : 0;
      const finalPnlPct = direction === "SHORT" ? -pnlPct : pnlPct;

      const tpPrice = parseFloat(position.tpPrice ?? "0") || 0;
      const slPrice = parseFloat(position.slPrice ?? "0") || 0;

      const distanceToTP = tpPrice > 0 
        ? Math.abs((markPrice - tpPrice) / markPrice) * 100 
        : 0;
      const distanceToSL = slPrice > 0 
        ? Math.abs((markPrice - slPrice) / markPrice) * 100 
        : 0;

      return {
        id: `live_${token}_${direction}_${idx}`,
        token,
        direction,
        signalType: "LIVE_MANUAL",
        signalCategory: "SCORE_BASED" as const,
        entryType: "SCORE_BASED" as const,
        entryScore: 0,
        riskPctUsed: 0,
        assetType: "ALT" as const,
        takeProfitPct: 0,
        marketCondition: "RANGING" as const,
        stakeUsd: margin,
        entryPrice: avgOpenPrice,
        currentPrice: markPrice,
        tpPrice,
        slPrice,
        leverage: Math.round(leverage * 10) / 10,
        status: "OPEN" as const,
        openTime: String(position.createTime ?? new Date().toISOString()),
        currentPnlPct: finalPnlPct,
        currentPnlUsd: unrealizedPnl,
        positionValueUsd: notional,
        distanceToTP,
        distanceToSL
      };
    });

    // Convert closed trade history to recentClosedTrades format
    const recentClosedTrades = historyResult.rows.slice(0, 50).map((trade: any, idx: number) => {
      const token = String(trade.symbol ?? `TRADE_${idx}`).replace(/USDT|PERP|_PERP/, "");
      const direction = String(trade.side ?? "LONG").toUpperCase() as "LONG" | "SHORT";
      const entryPrice = parseFloat(trade.entryPrice ?? "0") || 0;
      const exitPrice = parseFloat(trade.closePrice ?? entryPrice) || entryPrice;
      const qty = Math.abs(parseFloat(trade.qty ?? "0")) || 0;
      const realizedPnl = parseFloat(trade.realizedPNL ?? "0") || 0;
      const status = realizedPnl >= 0 ? "WIN" : "LOSS";

      const pnlPct = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
      const finalPnlPct = direction === "SHORT" ? -pnlPct : pnlPct;

      return {
        id: `live_closed_${token}_${direction}_${idx}`,
        token,
        direction,
        signalType: "LIVE_MANUAL",
        signalCategory: "SCORE_BASED" as const,
        entryType: "SCORE_BASED" as const,
        entryScore: 0,
        riskPctUsed: 0,
        assetType: "ALT" as const,
        takeProfitPct: 0,
        marketCondition: "RANGING" as const,
        stakeUsd: 0,
        entryPrice,
        currentPrice: exitPrice,
        tpPrice: 0,
        slPrice: 0,
        leverage: 1,
        status,
        openTime: String(trade.createTime ?? new Date().toISOString()),
        closeTime: String(trade.closeTime ?? new Date().toISOString()),
        result: finalPnlPct,
        resultUsd: realizedPnl
      };
    });

    // Build stats
    const wins = recentClosedTrades.filter((t: any) => t.status === "WIN").length;
    const losses = recentClosedTrades.filter((t: any) => t.status === "LOSS").length;
    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

    const totalPnlUsd = recentClosedTrades.reduce((sum: number, t: any) => sum + (t.resultUsd ?? 0), 0);
    const unrealizedPnlUsd = activeTrades.reduce((sum: number, t: any) => sum + (t.currentPnlUsd ?? 0), 0);

    const result = {
      stats: {
        totalTrades,
        activeTrades: activeTrades.length,
        wins,
        losses,
        winRate,
        avgMinutesToWin: 0,
        avgMinutesToLoss: 0,
        totalSimulatedPnl: totalPnlUsd,
        totalSimulatedPnlUsd: totalPnlUsd,
        totalPnlUsd,
        totalPnlPct: accountBalance > 0 ? (totalPnlUsd / accountBalance) * 100 : 0,
        unrealizedPnlUsd,
        equityUsd: accountBalance + unrealizedPnlUsd,
        accountBalanceUsd: accountBalance,
        initialCapitalUsd: accountBalance,
        stakePerTradeUsd: accountBalance / Math.max(1, activeTrades.length + 1),
        estimatedBalanceUsd: accountBalance,
        maxActiveTrades: activeTrades.length,
        leverage: Math.max(...activeTrades.map((t: any) => t.leverage || 1), 1),
        targetReturnPct: 0,
        stopReturnPct: 0
      },
      activeTrades,
      recentClosedTrades
    } as any;

    return result;
  } catch (error) {
    console.warn("[trade-engine] Failed to build live account snapshot:", error);
    return null;
  }
}
