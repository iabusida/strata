import { fetchLatestOhlc } from "./hyperliquid-service.js";
import type { TokenRsiResult } from "./rsi.js";
import { loadTradeRuntimeState, persistTradeRuntimeState } from "./simulation-store.js";

export type TradeDirection = "LONG" | "SHORT";
export type TradeStatus = "OPEN" | "WIN" | "LOSS";
export type TradeEntryType = "STRONG" | "CONTINUATION" | "SCORE_BASED";
export type AssetType = "LARGE_CAP" | "ALT";

export type Trade = {
  id: string;
  token: string;
  direction: TradeDirection;
  signalType: string;
  signalCategory: TradeEntryType;
  entryType: TradeEntryType;
  entryScore: number;
  riskPctUsed: number;
  volatilityPct: number;
  volume24h: number;
  passedVolatility: boolean;
  passedLiquidity: boolean;
  assetType: AssetType;
  marketCondition: "TRENDING" | "RANGING";
  stakeUsd: number;
  takeProfitPct: number;
  stopLossPct: number;
  entryPrice: number;
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
  maxDrawdown?: number;
  timeToClose?: number;
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

const LEVERAGE = resolveNumberEnv("LEVERAGE", 5);
const SIM_INITIAL_CAPITAL_USD = 378;
const RISK_PER_TRADE = 0.02;
const MAX_CONCURRENT_RISK = 0.06;
const MAX_DAILY_DRAWDOWN_PCT = 0.06;
const MAX_LOSS_STREAK = 3;
const COOLDOWN_DURATION_MS = 60 * 60 * 1000;
const SL_DISTANCE_PCT = 0.02;
const TRADING_FEE_RATE = 0.0005;
const TAKE_PROFIT_PCT = resolveNumberEnv("TAKE_PROFIT_PCT", 15);
const STOP_LOSS_PCT = resolveNumberEnv("STOP_LOSS_PCT", 10);
const SCORE_ENTRY_THRESHOLD = 7;
const BTC_SCORE_ENTRY_THRESHOLD = 8;
const MIN_VOLATILITY_PCT = resolveNumberEnv("MIN_VOLATILITY_PCT", 1.5);
const MIN_VOLUME_USD = resolveNumberEnv("MIN_VOLUME_USD", 50_000_000);
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_CLOSED_TRADES = 500;
const MAX_EQUITY_POINTS = 1000;

const openTrades = new Map<string, Trade>();
const closedTrades: Trade[] = [];
const lastOpenedByKey = new Map<string, number>();
let accountBalanceUsd = SIM_INITIAL_CAPITAL_USD;
let dailyStartBalanceUsd = SIM_INITIAL_CAPITAL_USD;
let dailyStartKeyUtc = new Date().toISOString().slice(0, 10);
let lossStreakCount = 0;
let cooldownUntilMs = 0;
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

function isLargeCap(symbol: string): boolean {
  const upper = symbol.trim().toUpperCase();
  return upper.includes("BTC") || upper.includes("ETH");
}

function getTradeLevels(
  entryPrice: number,
  direction: TradeDirection,
  symbol: string
): { tpPrice: number; slPrice: number; takeProfitPct: number } {
  const isLarge = isLargeCap(symbol);
  const takeProfitPct = isLarge ? 12 : 15;
  const tpMovePct = takeProfitPct / LEVERAGE / 100;
  const slMovePct = STOP_LOSS_PCT / LEVERAGE / 100;

  if (direction === "LONG") {
    return {
      tpPrice: toNumber(entryPrice * (1 + tpMovePct)),
      slPrice: toNumber(entryPrice * (1 - slMovePct)),
      takeProfitPct
    };
  }

  return {
    tpPrice: toNumber(entryPrice * (1 - tpMovePct)),
    slPrice: toNumber(entryPrice * (1 + slMovePct)),
    takeProfitPct
  };
}

type HigherTimeframeTrend = "BULLISH" | "BEARISH" | "NEUTRAL";
type StructureState = "TRENDING" | "BREAKOUT" | "CHOP";

type RankedTradeCandidate = {
  row: TokenRsiResult;
  direction: TradeDirection;
  takeProfitPct: number;
  signalStrength: number;
  higherTimeframeTrend: HigherTimeframeTrend;
  structureState: StructureState;
  structureConfidence: number;
  tpFeasibility: number;
  score: number;
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

  if (microDirection === targetTrend || row.signal.type.startsWith("CONTINUATION")) {
    return "BREAKOUT";
  }

  return "CHOP";
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

  return normalizedScore;
}

function buildRankedTradeCandidate(
  row: TokenRsiResult,
  direction: TradeDirection
): RankedTradeCandidate {
  const takeProfitPct = isLargeCap(row.symbol) ? 12 : 15;
  const requiredMove = takeProfitPct / 100;
  const volatilityPct = Number(row.tradeContext?.volatilityPct ?? row.volatilityPct ?? 0);
  const expectedMove = clamp01(volatilityPct / 100);
  const tpFeasibility = clamp01(requiredMove > 0 ? expectedMove / requiredMove : 0);
  const signalStrength = resolveSignalStrength(row);
  const higherTimeframeTrend = resolveHigherTimeframeTrend(row);
  const structureState = resolveStructureState(row, direction);
  const structureConfidence = resolveStructureConfidence(higherTimeframeTrend, structureState, direction);

  let score = (0.5 * signalStrength) + (0.3 * tpFeasibility) + (0.2 * structureConfidence);
  if (expectedMove > 0.25) {
    score *= 0.85;
  }

  return {
    row,
    direction,
    takeProfitPct,
    signalStrength,
    higherTimeframeTrend,
    structureState,
    structureConfidence,
    tpFeasibility,
    score: Number(score.toFixed(6))
  };
}

function compareTradeCandidates(left: RankedTradeCandidate, right: RankedTradeCandidate): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  if (left.signalStrength !== right.signalStrength) {
    return right.signalStrength - left.signalStrength;
  }

  if (left.tpFeasibility !== right.tpFeasibility) {
    return right.tpFeasibility - left.tpFeasibility;
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

function getPositionSizeUsd(balance: number, currentOpenCount: number): number {
  const maxActiveTrades = getMaxActiveTrades(balance);
  const remainingSlots = Math.max(1, maxActiveTrades - currentOpenCount);
  const reservedFees = balance * TRADING_FEE_RATE * 2 * remainingSlots;
  const availableAfterFees = Math.max(0, balance - reservedFees);
  const perTradeBudget = availableAfterFees / remainingSlots;

  const riskUsd = perTradeBudget * RISK_PER_TRADE;
  const rawSize = riskUsd / SL_DISTANCE_PCT;

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

  if (migrateOpenTradeLevels) {
    const levels = getTradeLevels(trade.entryPrice, trade.direction, trade.token);
    trade.tpPrice = levels.tpPrice;
    trade.slPrice = levels.slPrice;
    if (!Number.isFinite(trade.takeProfitPct) || trade.takeProfitPct <= 0) {
      trade.takeProfitPct = levels.takeProfitPct;
    }
  }

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

  persistTradeRuntimeState({
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
}

function hydrateRuntimeStateFromStorage(): void {
  if (hydratedFromStorage) {
    return;
  }

  const persisted = loadTradeRuntimeState();
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
      (trade as Trade).passedLiquidity = (trade as Trade).volume24h >= MIN_VOLUME_USD;
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
      (trade as Trade).passedLiquidity = (trade as Trade).volume24h >= MIN_VOLUME_USD;
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

function closeTrade(trade: Trade, status: "WIN" | "LOSS", closeTime: string): void {
  trade.status = status;
  trade.closeTime = closeTime;
  trade.result = status === "WIN" ? trade.takeProfitPct : -trade.stopLossPct;
  trade.resultUsd = Number((trade.stakeUsd * ((trade.result ?? 0) / 100)).toFixed(2));
  trade.closeFeeUsd = Number((trade.stakeUsd * TRADING_FEE_RATE).toFixed(2));

  const openMs = Date.parse(trade.openTime);
  const closeMs = Date.parse(closeTime);
  if (Number.isFinite(openMs) && Number.isFinite(closeMs)) {
    trade.timeToClose = Math.max(0, Math.round((closeMs - openMs) / 60000));
  }

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

  persistRuntimeState();
}

function closeTradeAtMarket(trade: Trade, closeTime: string): void {
  const marketResultPct = Number((trade.currentPnlPct ?? 0).toFixed(2));
  const status: "WIN" | "LOSS" = marketResultPct >= 0 ? "WIN" : "LOSS";

  trade.status = status;
  trade.closeTime = closeTime;
  trade.result = marketResultPct;
  trade.resultUsd = Number((trade.stakeUsd * (marketResultPct / 100)).toFixed(2));
  trade.closeFeeUsd = Number((trade.stakeUsd * TRADING_FEE_RATE).toFixed(2));

  const openMs = Date.parse(trade.openTime);
  const closeMs = Date.parse(closeTime);
  if (Number.isFinite(openMs) && Number.isFinite(closeMs)) {
    trade.timeToClose = Math.max(0, Math.round((closeMs - openMs) / 60000));
  }

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

  for (const [token, trades] of byToken.entries()) {
    const ohlc = fetchedByToken.get(token);
    if (!ohlc) {
      continue;
    }

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

      if (trade.direction === "LONG") {
        const hitTp = ohlc.high >= trade.tpPrice;
        const hitSl = ohlc.low <= trade.slPrice;

        if (hitTp && hitSl) {
          const status = resolveAmbiguousHit("LONG", ohlc.open, trade.tpPrice, trade.slPrice);
          closeTrade(trade, status, nowIso());
        } else if (hitTp) {
          closeTrade(trade, "WIN", nowIso());
        } else if (hitSl) {
          closeTrade(trade, "LOSS", nowIso());
        }

        continue;
      }

      const hitTp = ohlc.low <= trade.tpPrice;
      const hitSl = ohlc.high >= trade.slPrice;

      if (hitTp && hitSl) {
        const status = resolveAmbiguousHit("SHORT", ohlc.open, trade.tpPrice, trade.slPrice);
        closeTrade(trade, status, nowIso());
      } else if (hitTp) {
        closeTrade(trade, "WIN", nowIso());
      } else if (hitSl) {
        closeTrade(trade, "LOSS", nowIso());
      }
    }
  }

  persistRuntimeState();
}

function openTradesFromSignals(results: TokenRsiResult[]): void {
  const nowMs = Date.now();
  let openedAnyTrade = false;
  const rankedCandidates: RankedTradeCandidate[] = [];

  // Required execution order of system-level guardrails.
  resetDailyStartIfNeeded(nowMs);
  if (isCooldownActive(nowMs)) {
    return;
  }
  if (hitDailyDrawdownLimit()) {
    return;
  }
  if (wouldExceedConcurrentRisk()) {
    return;
  }
  if (openTrades.size >= getMaxActiveTrades(accountBalanceUsd)) {
    return;
  }

  for (const row of results) {
    const strongSignal = isStrongSignal(row.signal.type);
    const isLarge = isLargeCap(row.symbol);
    const minScoreThreshold = isLarge ? 8 : 7;
    const scoreQualified = row.confluence.score >= minScoreThreshold;
    const signalDirection = signalToDirection(row.signal.type);
    const volatilityPct = Number(row.tradeContext?.volatilityPct ?? row.volatilityPct ?? 0);
    const volume24h = Number(row.tradeContext?.volume24h ?? row.volume24h ?? 0);
    const passedVolatility = volatilityPct >= MIN_VOLATILITY_PCT;
    const passedLiquidity = volume24h >= MIN_VOLUME_USD;

    if (!strongSignal && !scoreQualified) {
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

    const candidate = buildRankedTradeCandidate(row, signalDirection);
    if (candidate.tpFeasibility < 0.6) {
      console.info("[trade-engine] Trade rejected: low TP feasibility", {
        symbol: row.symbol,
        signal: row.signal.type,
        score: row.confluence.score,
        signalStrength: Number(candidate.signalStrength.toFixed(3)),
        tpFeasibility: Number(candidate.tpFeasibility.toFixed(3)),
        structureConfidence: Number(candidate.structureConfidence.toFixed(3)),
        takeProfitPct: candidate.takeProfitPct
      });
      continue;
    }

    rankedCandidates.push(candidate);
  }

  const prioritizedResults = rankedCandidates.sort(compareTradeCandidates);

  for (const candidate of prioritizedResults) {
    const row = candidate.row;
    const direction = candidate.direction;
    const strongSignal = isStrongSignal(row.signal.type);
    const isLarge = isLargeCap(row.symbol);
    const scoreQualified = row.confluence.score >= (isLarge ? 8 : 7);
    const volatilityPct = Number(row.tradeContext?.volatilityPct ?? row.volatilityPct ?? 0);
    const volume24h = Number(row.tradeContext?.volume24h ?? row.volume24h ?? 0);
    const passedVolatility = volatilityPct >= MIN_VOLATILITY_PCT;
    const passedLiquidity = volume24h >= MIN_VOLUME_USD;

    if (!Number.isFinite(row.close) || row.close <= 0) {
      continue;
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

    const positionSizeUsd = getPositionSizeUsd(accountBalanceUsd, openTrades.size);
    if (!Number.isFinite(positionSizeUsd) || positionSizeUsd <= 0) {
      continue;
    }

    const openFeeUsd = Number((positionSizeUsd * TRADING_FEE_RATE).toFixed(2));
    if (accountBalanceUsd - openFeeUsd <= 0) {
      continue;
    }

    console.info("[trade-engine] Trade selected", {
      symbol: row.symbol,
      score: Number(candidate.score.toFixed(3)),
      signalStrength: Number(candidate.signalStrength.toFixed(3)),
      tpFeasibility: Number(candidate.tpFeasibility.toFixed(3)),
      structureConfidence: Number(candidate.structureConfidence.toFixed(3))
    });

    const levels = getTradeLevels(row.close, direction, row.symbol);
    const signalCategory: TradeEntryType = row.signal.type.startsWith("STRONG")
      ? "STRONG"
      : row.signal.type.startsWith("CONTINUATION") && scoreQualified
        ? "CONTINUATION"
        : "SCORE_BASED";
    const marketCondition = classifyMarketCondition(row.timeframes.macro.macdHist, row.close);
    const assetType: AssetType = isLarge ? "LARGE_CAP" : "ALT";

    const trade: Trade = {
      id: `${row.symbol}-${direction}-${nowMs}`,
      token: row.symbol,
      direction,
      signalType: strongSignal ? row.signal.type : `SCORE_BASED_${row.confluence.bias}`,
      signalCategory,
      entryType: signalCategory,
      entryScore: row.confluence.score,
      riskPctUsed: Number((RISK_PER_TRADE * 100).toFixed(2)),
      volatilityPct,
      volume24h,
      passedVolatility,
      passedLiquidity,
      assetType,
      marketCondition,
      stakeUsd: positionSizeUsd,
      takeProfitPct: levels.takeProfitPct,
      stopLossPct: STOP_LOSS_PCT,
      openFeeUsd,
      entryPrice: row.close,
      currentPrice: row.close,
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
            ? ((levels.tpPrice - row.close) / row.close) * 100
            : ((row.close - levels.tpPrice) / row.close) * 100
        ).toFixed(3)
      ),
      distanceToSL: Number(
        (
          direction === "LONG"
            ? ((row.close - levels.slPrice) / row.close) * 100
            : ((levels.slPrice - row.close) / row.close) * 100
        ).toFixed(3)
      ),
      maxDrawdown: 0
    };

    accountBalanceUsd = Number((accountBalanceUsd - openFeeUsd).toFixed(2));

    const key = getTradeKey(row.symbol, direction);
    openTrades.set(key, trade);
    lastOpenedByKey.set(key, nowMs);
    openedAnyTrade = true;
  }

  if (openedAnyTrade) {
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
    stakePerTradeUsd: Number(getPositionSizeUsd(accountBalanceUsd, active.length).toFixed(2)),
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
  hydrateRuntimeStateFromStorage();
  await updateOpenTradesFromMarket();
  openTradesFromSignals(results);

  persistRuntimeState();

  return buildSnapshot();
}

export async function refreshTradeSimulation(): Promise<TradeSimulationSnapshot> {
  hydrateRuntimeStateFromStorage();
  await updateOpenTradesFromMarket();
  persistRuntimeState();
  return buildSnapshot();
}

export async function forceCloseOpenTradesBySymbol(
  symbol: string
): Promise<{ closedCount: number; snapshot: TradeSimulationSnapshot }> {
  hydrateRuntimeStateFromStorage();
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
    closeTradeAtMarket(trade, closeTime);
  }

  persistRuntimeState();
  const snapshot = buildSnapshot();
  return { closedCount: toClose.length, snapshot };
}

export function getTradeSimulationSnapshot(): TradeSimulationSnapshot {
  hydrateRuntimeStateFromStorage();
  return buildSnapshot();
}
