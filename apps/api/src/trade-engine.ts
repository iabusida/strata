import "./env.js";
import {
  fetchLatestOhlc,
  fetchOrderBookExecutionRead,
  fetchPerpContexts,
  type PerpAssetContext
} from "./hyperliquid-service.js";
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
};

export type TradeSimulationSnapshot = {
  stats: TradeStats;
  activeTrades: Trade[];
  recentClosedTrades: Trade[];
};

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

const LEVERAGE = resolveNumberEnv("LEVERAGE", 5);
const SIM_INITIAL_CAPITAL_USD = resolveNumberEnv("SIM_INITIAL_CAPITAL_USD", 500);
const RISK_PER_TRADE = 0.02;
const MAX_CONCURRENT_RISK = 0.10;
const MAX_DAILY_DRAWDOWN_PCT = 0.06;
const MAX_LOSS_STREAK = 3;
const COOLDOWN_DURATION_MS = 60 * 60 * 1000;
const DEFAULT_SL_DISTANCE_PCT = 0.02;
const TRADING_FEE_RATE = 0.0005;
const TAKE_PROFIT_PCT = resolveNumberEnv("TAKE_PROFIT_PCT", 10);
const STOP_LOSS_PCT = resolveNumberEnv("STOP_LOSS_PCT", 10);
const TP_SL_MODE = resolveEnumEnv("TP_SL_MODE", ["ROE", "ATR"] as const, "ROE");
const MIN_RISK_REWARD = resolveNumberEnv("MIN_RISK_REWARD", TP_SL_MODE === "ROE" ? 1 : 1.5);
const SCORE_ENTRY_THRESHOLD = resolveNumberEnv("SCORE_ENTRY_THRESHOLD", 5);
const BTC_SCORE_ENTRY_THRESHOLD = resolveNumberEnv("BTC_SCORE_ENTRY_THRESHOLD", 5);
const PRIORITY_SCORE_ENTRY_THRESHOLD = resolveNumberEnv("PRIORITY_SCORE_ENTRY_THRESHOLD", 7);
const PRIORITY_BTC_SCORE_ENTRY_THRESHOLD = resolveNumberEnv("PRIORITY_BTC_SCORE_ENTRY_THRESHOLD", 8);
const ENTRY_TIMING_MAX = resolveEnumEnv<EntryTimingMax>("ENTRY_TIMING_MAX", ["EARLY", "MID", "LATE"] as const, "MID");
const REVERSAL_PHASE_MIN = resolveEnumEnv<ReversalPhaseMin>(
  "REVERSAL_PHASE_MIN",
  ["COUNTER_TREND_BOUNCE", "TRANSITION_REVERSAL", "CONFIRMED_REVERSAL"] as const,
  "COUNTER_TREND_BOUNCE"
);
const MIN_VOLATILITY_PCT = resolveNumberEnv("MIN_VOLATILITY_PCT", 1.5);
const MIN_VOLUME_USD = resolveNumberEnv("MIN_VOLUME_USD", 7_000_000);
const MIN_VOLUME_USD_MAJOR_ALT = resolveNumberEnv("MIN_VOLUME_USD_MAJOR_ALT", 3_000_000);
const MAJOR_ALT_SYMBOLS = resolveSymbolSetEnv(
  "MAJOR_ALT_SYMBOLS",
  "SOL,BNB,XRP,DOGE,ADA,TON,AVAX,LINK,DOT,LTC,TRX,BCH,APT,ARB,OP,INJ,ONDO,SUI,NEAR"
);
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_CLOSED_TRADES = 500;
const MAX_EQUITY_POINTS = 1000;
const GLOBAL_TRADE_THROTTLE_WINDOW_MS = 30 * 60 * 1000;
const MAX_TRADES_LAST_30_MIN = 3;
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
const MAX_SLIPPAGE_PCT = 0.2;
const ADAPTIVE_UPDATE_WINDOW_TRADES = 50;
const EXPECTED_VALUE_MIN = resolveNumberEnv("EXPECTED_VALUE_MIN", 0);
const TELEGRAM_ALERT_DEDUPE_MINUTES = Math.max(
  1,
  Math.trunc(resolveNumberEnv("TELEGRAM_ALERT_DEDUPE_MINUTES", 15))
);

const openTrades = new Map<string, Trade>();
const closedTrades: Trade[] = [];
const lastOpenedByKey = new Map<string, number>();
let accountBalanceUsd = SIM_INITIAL_CAPITAL_USD;
let dailyStartBalanceUsd = SIM_INITIAL_CAPITAL_USD;
let dailyStartKeyUtc = new Date().toISOString().slice(0, 10);
let lossStreakCount = 0;
let cooldownUntilMs = 0;
let killSwitchActivated = false;
let hydratedFromStorage = false;
const equityCurve: Array<{ at: string; balanceUsd: number }> = [
  { at: new Date().toISOString(), balanceUsd: Number(SIM_INITIAL_CAPITAL_USD.toFixed(2)) }
];

function nowIso(): string {
  return new Date().toISOString();
}

function toNumber(value: number): number {
  return Number(value.toFixed(6));
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
  return base === "BTC" || base === "ETH";
}

function isMajorAlt(symbol: string): boolean {
  const base = getBaseSymbol(symbol);
  return MAJOR_ALT_SYMBOLS.has(base);
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

  if (regime === "CHOPPY" && signalType.startsWith("STRONG")) {
    return false;
  }

  if (regime === "TRENDING" && signalType.startsWith("REVERSAL") && structureState !== "REVERSAL") {
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
  atr: number
): { tpPrice: number; slPrice: number; takeProfitPct: number; stopLossPct: number } {
  if (TP_SL_MODE === "ROE") {
    const takeProfitPct = Number(TAKE_PROFIT_PCT.toFixed(3));
    const stopLossPct = Number(STOP_LOSS_PCT.toFixed(3));
    const tpMoveAbs = entryPrice * (takeProfitPct / 100 / LEVERAGE);
    const slMoveAbs = entryPrice * (stopLossPct / 100 / LEVERAGE);

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

  const takeProfitPct = Number((((tpMoveAbs / entryPrice) * LEVERAGE) * 100).toFixed(3));
  const stopLossPct = Number((((slMoveAbs / entryPrice) * LEVERAGE) * 100).toFixed(3));

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

function buildRankedTradeCandidate(
  row: TokenRsiResult,
  direction: TradeDirection,
  feedback: AdaptiveFeedback
): RankedTradeCandidate {
  const atr = Number(row.tradeContext?.atr ?? 0);
  const levels = getTradeLevels(row.close, direction, row.symbol, atr);
  const tpDistance = Math.abs(levels.tpPrice - row.close);
  const slDistance = Math.abs(levels.slPrice - row.close);
  const riskReward = slDistance > 0 ? tpDistance / slDistance : 0;
  const expectedMove = row.close > 0 ? tpDistance / row.close : 0;
  const signalStrength = resolveSignalStrength(row);
  const higherTimeframeTrend = resolveHigherTimeframeTrend(row);
  const structureState = resolveStructureState(row, direction);
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

  let scoreRaw =
    regimeAlignment +
    Math.min(riskReward, 3) +
    (volatilityPotential * 1.5) +
    (liquidityQuality * 1.5) +
    distancePenalty +
    signalTypeBonus;

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
  const fallbackEv = (winProb * tpDistance) - ((1 - winProb) * slDistance);
  const expectedValueRaw = fallbackEv;
  const expectedValue = Number(expectedValueRaw.toFixed(6));

  return {
    row,
    direction,
    entryTiming,
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

function getMaxActiveTrades(balance: number): number {
  return balance < 1000 ? 1 : 3;
}

function getPositionSizeUsd(balance: number, currentOpenCount: number, stopLossPct: number): number {
  const maxActiveTrades = getMaxActiveTrades(balance);
  const remainingSlots = Math.max(1, maxActiveTrades - currentOpenCount);
  const reservedFees = balance * TRADING_FEE_RATE * 2 * remainingSlots;
  const availableAfterFees = Math.max(0, balance - reservedFees);
  const perTradeBudget = availableAfterFees / remainingSlots;

  const riskUsd = perTradeBudget * RISK_PER_TRADE;
  const stopDistanceRatio = Math.max(0.001, stopLossPct / 100 / LEVERAGE);
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

function computeEstimatedLiqPrice(entryPrice: number, direction: TradeDirection): number {
  // Approximation for isolated-style liquidation with a conservative maintenance margin.
  const maintenanceMarginRate = 0.005;
  const liqMovePct = Math.max((1 / LEVERAGE) - maintenanceMarginRate, 0.01);

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
  trade.estimatedLiqPrice = computeEstimatedLiqPrice(trade.entryPrice, trade.direction);
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

function buildCloseContextJson(trade: Trade, reason: string): string {
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
    openInterestUsd: trade.openInterestUsd
  });
}

function shouldOpenTrade(token: string, direction: TradeDirection, nowMs: number): boolean {
  const key = getTradeKey(token, direction);
  const currentOpen = openTrades.get(key);
  if (currentOpen) {
    return false;
  }

  const lastOpened = lastOpenedByKey.get(key);
  if (typeof lastOpened === "number" && nowMs - lastOpened < DUPLICATE_WINDOW_MS) {
    return false;
  }

  return true;
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
  if (drawdown >= GLOBAL_KILL_SWITCH_DRAWDOWN_PCT) {
    killSwitchActivated = true;
    console.error("[trade-engine] Kill switch activated", {
      at: new Date(nowMs).toISOString(),
      drawdownPct: Number((drawdown * 100).toFixed(2)),
      thresholdPct: GLOBAL_KILL_SWITCH_DRAWDOWN_PCT * 100,
      peakEquity,
      currentEquity
    });
    return true;
  }

  return false;
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

function hitDailyDrawdownLimit(): boolean {
  if (!Number.isFinite(dailyStartBalanceUsd) || dailyStartBalanceUsd <= 0) {
    return false;
  }

  const dailyPnlPct = (accountBalanceUsd - dailyStartBalanceUsd) / dailyStartBalanceUsd;
  return dailyPnlPct <= -MAX_DAILY_DRAWDOWN_PCT;
}

function wouldExceedConcurrentRisk(): boolean {
  const currentOpenRisk = openTrades.size * RISK_PER_TRADE;
  return currentOpenRisk + RISK_PER_TRADE > MAX_CONCURRENT_RISK;
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
    trade.leverage = LEVERAGE;
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
      (trade as Trade).riskPctUsed = Number((RISK_PER_TRADE * 100).toFixed(2));
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
      (trade as Trade).riskPctUsed = Number((RISK_PER_TRADE * 100).toFixed(2));
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

function closeTrade(trade: Trade, status: "WIN" | "LOSS", closeTime: string, reason: string): void {
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
  trade.resultUsd = Number((trade.stakeUsd * ((trade.result ?? 0) / 100)).toFixed(2));
  trade.closeFeeUsd = Number((trade.stakeUsd * TRADING_FEE_RATE).toFixed(2));

  const openMs = Date.parse(trade.openTime);
  const closeMs = Date.parse(closeTime);
  if (Number.isFinite(openMs) && Number.isFinite(closeMs)) {
    trade.timeToClose = Math.max(0, Math.round((closeMs - openMs) / 60000));
  }

  trade.closeContextJson = buildCloseContextJson(trade, reason);

  openTrades.delete(getTradeKey(trade.token, trade.direction));
  closedTrades.push({ ...trade });
  const netClosePnlUsd = Number(((trade.resultUsd ?? 0) - (trade.closeFeeUsd ?? 0)).toFixed(2));
  accountBalanceUsd = Number((accountBalanceUsd + netClosePnlUsd).toFixed(2));

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

function closeTradeAtMarket(trade: Trade, closeTime: string, reason: string): void {
  const marketResultPct = Number((trade.currentPnlPct ?? 0).toFixed(2));
  const status: "WIN" | "LOSS" = marketResultPct >= 0 ? "WIN" : "LOSS";

  console.info("[trade-engine] Trade closed at market", {
    symbol: trade.token,
    direction: trade.direction,
    status,
    reason,
    marketResultPct,
    openTime: trade.openTime,
    closeTime
  });

  trade.status = status;
  trade.closeTime = closeTime;
  trade.closeReason = reason;
  trade.result = marketResultPct;
  trade.resultUsd = Number((trade.stakeUsd * (marketResultPct / 100)).toFixed(2));
  trade.closeFeeUsd = Number((trade.stakeUsd * TRADING_FEE_RATE).toFixed(2));

  const openMs = Date.parse(trade.openTime);
  const closeMs = Date.parse(closeTime);
  if (Number.isFinite(openMs) && Number.isFinite(closeMs)) {
    trade.timeToClose = Math.max(0, Math.round((closeMs - openMs) / 60000));
  }

  trade.closeContextJson = buildCloseContextJson(trade, reason);

  openTrades.delete(getTradeKey(trade.token, trade.direction));
  closedTrades.push({ ...trade });

  const netClosePnlUsd = Number(((trade.resultUsd ?? 0) - (trade.closeFeeUsd ?? 0)).toFixed(2));
  accountBalanceUsd = Number((accountBalanceUsd + netClosePnlUsd).toFixed(2));

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

async function updateOpenTradesFromMarket(): Promise<void> {
  const openList = Array.from(openTrades.values());
  if (openList.length === 0) {
    return;
  }

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
  const fetched = await Promise.all(
    tokenEntries.map(async ([token]) => {
      const ohlc = await fetchLatestOhlc(token, "1m");
      return { token, ohlc };
    })
  );

  const fetchedByToken = new Map(fetched.map((item) => [item.token, item.ohlc]));
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

      if (trade.currentPnlPct <= EARLY_DRAWDOWN_EXIT_PCT) {
        closeTradeAtMarket(trade, nowIso(), "EARLY_DRAWDOWN_PROTECTION");
        continue;
      }

      const elapsedMinutes = Math.max(0, Math.round((Date.now() - Date.parse(trade.openTime)) / 60000));
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
        if (trade.entryType === "REVERSAL" && (trade.currentPnlPct ?? 0) < 2) {
          closeTradeAtMarket(trade, nowIso(), "TIME_EXIT_REVERSAL_STALE");
          continue;
        }
        if (trade.entryType === "STRONG" && (trade.currentPnlPct ?? 0) < 3) {
          closeTradeAtMarket(trade, nowIso(), "TIME_EXIT_STRONG_STALE");
          continue;
        }
        if (elapsedMinutes > 360) {
          closeTradeAtMarket(trade, nowIso(), "TIME_EXIT_MAX_HOLD");
          continue;
        }
      }

      if (lifecycle.outcome === "WIN") {
        closeTrade(trade, "WIN", nowIso(), trade.direction === "LONG" ? "TP_HIT_LONG" : "TP_HIT_SHORT");
        continue;
      }

      if (lifecycle.outcome === "LOSS") {
        closeTrade(trade, "LOSS", nowIso(), trade.direction === "LONG" ? "SL_HIT_LONG" : "SL_HIT_SHORT");
      }
    }
  }

  persistRuntimeState();
}

async function openTradesFromSignals(results: TokenRsiResult[]): Promise<void> {
  const nowMs = Date.now();
  let openedAnyTrade = false;
  const persistenceTasks: Array<Promise<void>> = [];
  const rankedCandidates: RankedTradeCandidate[] = [];
  const feedback = getAdaptiveFeedback();

  // Required execution order of system-level guardrails.
  resetDailyStartIfNeeded(nowMs);
  if (isKillSwitchTriggered(nowMs)) {
    console.warn("[trade-engine] Entry blocked: kill switch active");
    return;
  }
  if (isSessionBlocked(nowMs)) {
    console.info("[trade-engine] Entry blocked: low-liquidity UTC session", {
      hourUtc: new Date(nowMs).getUTCHours()
    });
    return;
  }
  if (countTradesOpenedLastWindow(nowMs, GLOBAL_TRADE_THROTTLE_WINDOW_MS) >= MAX_TRADES_LAST_30_MIN) {
    console.info("[trade-engine] Entry blocked: trade throttle", {
      windowMinutes: 30,
      maxTrades: MAX_TRADES_LAST_30_MIN
    });
    return;
  }
  if (isCooldownActive(nowMs)) {
    console.info("[trade-engine] Entry blocked: cooldown active", {
      cooldownUntil: new Date(cooldownUntilMs).toISOString()
    });
    return;
  }
  if (hitDailyDrawdownLimit()) {
    console.info("[trade-engine] Entry blocked: daily drawdown limit reached");
    return;
  }
  if (wouldExceedConcurrentRisk()) {
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
    const isLarge = isLargeCap(row.symbol);
    const baseScoreThreshold = isLarge ? BTC_SCORE_ENTRY_THRESHOLD : SCORE_ENTRY_THRESHOLD;
    const minScoreThreshold = getAdaptiveScoreThreshold(baseScoreThreshold);
    const strongSignal = isStrongSignal(row.signal.type);
    const lowVolRegime = row.tradeContext?.regime === "LOW_VOL";
    const scoreQualified = row.confluence.score >= minScoreThreshold;
    const signalDirection = signalToDirection(row.signal.type);
    const volatilityPct = Number(row.tradeContext?.volatilityPct ?? row.volatilityPct ?? 0);
    const volume24h = Number(row.tradeContext?.volume24h ?? row.volume24h ?? 0);
    const passedVolatility = row.tradeContext?.passedVolatility ?? volatilityPct >= MIN_VOLATILITY_PCT;
    const minVolumeUsd = getMinVolumeUsdForSymbol(row.symbol);
    const passedLiquidity = row.tradeContext?.passedLiquidity ?? volume24h >= minVolumeUsd;
    const passedStructure = row.tradeContext?.passedStructure ?? true;
    const passedMicroTrend = row.tradeContext?.passedMicroTrend ?? true;

    const directSignalQualified = strongSignal || row.signal.type.startsWith("REVERSAL");
    const structureMomentumOk = passedStructure || passedMicroTrend;

    if (signalDirection) {
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
          marketCondition
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
      console.info("[trade-engine] Trade rejected: structure/micro alignment", {
        symbol: row.symbol,
        signal: row.signal.type,
        passedStructure,
        passedMicroTrend
      });
      continue;
    }

    if (!signalDirection) {
      console.info("[trade-engine] Trade rejected: no directional signal", {
        symbol: row.symbol,
        signal: row.signal.type,
        bias: row.confluence.bias,
        score: row.confluence.score,
        minScoreThreshold
      });
      continue;
    }

    if (!passesRegimeEntryRules(row, signalDirection)) {
      console.info("[trade-engine] Trade rejected: regime rules", {
        symbol: row.symbol,
        regime: row.tradeContext?.regime ?? "CHOPPY",
        signal: row.signal.type,
        structureState: row.tradeContext?.structureState
      });
      continue;
    }

    if (!passedVolatility) {
      console.info("[trade-engine] Trade rejected: low volatility", {
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        volatilityPct,
        minVolatilityPct: MIN_VOLATILITY_PCT
      });
      continue;
    }

    if (!passedLiquidity) {
      console.info("[trade-engine] Trade rejected: low liquidity", {
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        volume24h,
        minVolumeUsd: MIN_VOLUME_USD
      });
      continue;
    }

    const candidate = buildRankedTradeCandidate(row, signalDirection, feedback);
    if (candidate.expectedValue < EXPECTED_VALUE_MIN) {
      console.info("[trade-engine] Trade rejected: non-positive EV", {
        symbol: row.symbol,
        expectedValue: candidate.expectedValue,
        minExpectedValue: EXPECTED_VALUE_MIN,
        signal: row.signal.type
      });
      continue;
    }

    if (!isEntryTimingAllowed(candidate.entryTiming, ENTRY_TIMING_MAX)) {
      console.info("[trade-engine] Trade rejected: entry timing", {
        symbol: row.symbol,
        signal: row.signal.type,
        entryTiming: candidate.entryTiming,
        maxAllowed: ENTRY_TIMING_MAX
      });
      continue;
    }

    const continuationSignal = row.signal.type.startsWith("CONTINUATION");
    const allowUnresolvedContinuation =
      continuationSignal &&
      candidate.reversalPhase === "UNRESOLVED" &&
      row.confluence.score >= minScoreThreshold;

    if (!isReversalPhaseAllowed(candidate.reversalPhase, REVERSAL_PHASE_MIN) && !allowUnresolvedContinuation) {
      console.info("[trade-engine] Trade rejected: reversal phase", {
        symbol: row.symbol,
        signal: row.signal.type,
        reversalPhase: candidate.reversalPhase,
        minAllowed: REVERSAL_PHASE_MIN
      });
      continue;
    }

    if (candidate.reversalPhase === "COUNTER_TREND_BOUNCE" && candidate.entryTiming !== "EARLY") {
      console.info("[trade-engine] Trade rejected: counter-trend requires EARLY timing", {
        symbol: row.symbol,
        signal: row.signal.type,
        reversalPhase: candidate.reversalPhase,
        entryTiming: candidate.entryTiming
      });
      continue;
    }

    if (candidate.riskReward < MIN_RISK_REWARD) {
      console.info("[trade-engine] Trade rejected: RR below threshold", {
        symbol: row.symbol,
        signal: row.signal.type,
        riskReward: Number(candidate.riskReward.toFixed(3)),
        minRiskReward: MIN_RISK_REWARD
      });
      continue;
    }
    const tpFeasibility = candidate.riskReward >= MIN_RISK_REWARD ? 1 : candidate.riskReward / Math.max(0.001, MIN_RISK_REWARD);
    const tpFeasibilityMin = lowVolRegime || volatilityPct < LOW_VOLATILITY_PCT_THRESHOLD
      ? LOW_VOLATILITY_TP_FEASIBILITY_MIN
      : NORMAL_TP_FEASIBILITY_MIN;
    if (tpFeasibility < tpFeasibilityMin) {
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
        marketCondition
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
      marketCondition === "RANGING" &&
      (row.signal.type === "CONTINUATION LONG" || row.signal.type === "CONTINUATION SHORT")
    ) {
      console.info("[trade-engine] Trade rejected: continuation blocked in ranging regime", {
        symbol: row.symbol,
        signal: row.signal.type,
        marketCondition
      });
      continue;
    }

    if (!Number.isFinite(row.close) || row.close <= 0) {
      continue;
    }

    if (isKillSwitchTriggered(nowMs)) {
      break;
    }

    if (countTradesOpenedLastWindow(nowMs, GLOBAL_TRADE_THROTTLE_WINDOW_MS) >= MAX_TRADES_LAST_30_MIN) {
      console.info("[trade-engine] Entry blocked mid-loop: trade throttle");
      break;
    }

    // Re-check risk cap per accepted trade because exposure changes during this loop.
    if (wouldExceedConcurrentRisk()) {
      break;
    }
    if (openTrades.size >= getMaxActiveTrades(accountBalanceUsd)) {
      break;
    }

    if (!shouldOpenTrade(row.symbol, direction, nowMs)) {
      continue;
    }

    if (countClusterActiveTrades(cluster) >= MAX_CLUSTER_ACTIVE_TRADES) {
      console.info("[trade-engine] Trade rejected: cluster exposure cap", {
        symbol: row.symbol,
        cluster,
        maxPerCluster: MAX_CLUSTER_ACTIVE_TRADES
      });
      continue;
    }

    const positionSizeUsd = getPositionSizeUsd(accountBalanceUsd, openTrades.size, candidate.stopLossPct);
    if (!Number.isFinite(positionSizeUsd) || positionSizeUsd <= 0) {
      continue;
    }

    const orderNotionalUsd = positionSizeUsd * LEVERAGE;
    const orderBookRead = await fetchOrderBookExecutionRead(row.symbol);
    if (!orderBookRead) {
      console.info("[trade-engine] Trade rejected: order book unavailable", {
        symbol: row.symbol,
        signal: row.signal.type
      });
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
      console.info("[trade-engine] Trade rejected: runtime order book execution guard", {
        symbol: row.symbol,
        signal: row.signal.type,
        spreadPct: orderBookRead.spreadPct,
        depthUsd: orderBookRead.combinedDepthUsd,
        imbalance: orderBookRead.imbalance,
        orderNotionalUsd,
        maxSpreadPct: isLargeCap(row.symbol) ? ORDERBOOK_MAX_SPREAD_PCT_LARGE : ORDERBOOK_MAX_SPREAD_PCT_ALT,
        minDepthUsd: orderNotionalUsd * ORDERBOOK_MIN_DEPTH_MULTIPLIER,
        maxAgainstImbalance: ORDERBOOK_MAX_AGAINST_IMBALANCE
      });
      continue;
    }

    const openFeeUsd = Number((positionSizeUsd * TRADING_FEE_RATE).toFixed(2));
    if (accountBalanceUsd - openFeeUsd <= 0) {
      continue;
    }

    const executionValidation = validateExecution({
      spreadPct: orderBookRead.spreadPct,
      depthUsd: Math.max(orderBookRead.combinedDepthUsd, 0),
      orderNotional: orderNotionalUsd,
      maxSpread: getOrderBookSpreadLimitPct(row.symbol)
    });
    const simulatedSlippagePct = Number((executionValidation.slippage * 100).toFixed(4));

    if (!executionValidation.ok || simulatedSlippagePct > MAX_SLIPPAGE_PCT) {
      console.info("[trade-engine] Trade rejected: slippage protection", {
        symbol: row.symbol,
        depthUsdAt10bps: orderBookRead.combinedDepthUsd,
        orderNotionalUsd,
        slippagePct: simulatedSlippagePct,
        maxSlippagePct: MAX_SLIPPAGE_PCT
      });
      continue;
    }

    const effectiveEntry = effectiveEntryPrice(row.close, row.signal.type, executionValidation.slippage);

    const levelsForValidation = getTradeLevels(effectiveEntry, direction, row.symbol, Number(row.tradeContext?.atr ?? 0));
    const tpDistance = Math.abs(levelsForValidation.tpPrice - effectiveEntry);
    const slDistance = Math.abs(levelsForValidation.slPrice - effectiveEntry);
    const rr = slDistance > 0 ? tpDistance / slDistance : 0;
    const spreadCostPct = orderBookRead.spreadPct;
    const spreadAndSlippagePct = spreadCostPct + (simulatedSlippagePct * 2);
    const tpDistancePct = effectiveEntry > 0 ? Number(((tpDistance / effectiveEntry) * 100).toFixed(4)) : 0;

    if (rr < MIN_RISK_REWARD || tpDistancePct <= spreadAndSlippagePct) {
      console.info("[trade-engine] Trade rejected: execution-adjusted TP viability", {
        symbol: row.symbol,
        rr: Number(rr.toFixed(3)),
        minRiskReward: MIN_RISK_REWARD,
        tpDistancePct,
        spreadAndSlippagePct,
        spreadPct: spreadCostPct,
        slippagePct: simulatedSlippagePct
      });
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
      slippagePct: simulatedSlippagePct,
      entryReason: "RANKED_CANDIDATE_SELECTED"
    });

    notifyTelegramEntry({
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
      marketCondition
    });

    const levels = getTradeLevels(effectiveEntry, direction, row.symbol, Number(row.tradeContext?.atr ?? 0));
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
      riskPctUsed: Number((RISK_PER_TRADE * 100).toFixed(2)),
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
      slippageEstimate: simulatedSlippagePct,
      openFeeUsd,
      entryPrice: effectiveEntry,
      effectiveEntryPrice: effectiveEntry,
      currentPrice: effectiveEntry,
      tpPrice: levels.tpPrice,
      slPrice: levels.slPrice,
      leverage: LEVERAGE,
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

    enrichTradeWithProductionRead(trade, null);

    accountBalanceUsd = Number((accountBalanceUsd - openFeeUsd).toFixed(2));

    const key = getTradeKey(row.symbol, direction);
    openTrades.set(key, trade);
    lastOpenedByKey.set(key, nowMs);
    openedAnyTrade = true;

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
    stakePerTradeUsd: Number(getPositionSizeUsd(accountBalanceUsd, active.length, STOP_LOSS_PCT).toFixed(2)),
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
    byToken
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
  await ensureActiveTradingSession({
    startingBalanceUsd: SIM_INITIAL_CAPITAL_USD,
    currentBalanceUsd: accountBalanceUsd,
    leverage: LEVERAGE,
    takeProfitPct: TAKE_PROFIT_PCT,
    stopLossPct: STOP_LOSS_PCT,
    maxConcurrentTrades: getMaxActiveTrades(accountBalanceUsd)
  });
  await updateOpenTradesFromMarket();
  await openTradesFromSignals(results);

  persistRuntimeState();

  return buildSnapshot();
}

export async function refreshTradeSimulation(): Promise<TradeSimulationSnapshot> {
  await hydrateRuntimeStateFromStorage();
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
    closeTradeAtMarket(trade, closeTime, "MANUAL_FORCE_CLOSE");
  }

  persistRuntimeState();
  const snapshot = buildSnapshot();
  return { closedCount: toClose.length, snapshot };
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
