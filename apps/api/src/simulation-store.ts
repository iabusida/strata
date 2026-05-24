import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type TradeSummary = {
  id: string;
  token: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  status: "OPEN" | "WIN" | "LOSS";
  openTime: string;
  closeTime?: string;
  result?: number;
  maxDrawdown?: number;
  timeToClose?: number;
};

type PersistedRuntimeTrade = {
  id: string;
  token: string;
  direction: "LONG" | "SHORT";
  signalType: string;
  signalCategory: "STRONG" | "CONTINUATION" | "REVERSAL" | "SCORE_BASED";
  entryType: "STRONG" | "CONTINUATION" | "REVERSAL" | "SCORE_BASED";
  entryScore: number;
  riskPctUsed: number;
  volatilityPct: number;
  volume24h: number;
  passedVolatility: boolean;
  passedLiquidity: boolean;
  assetType: "LARGE_CAP" | "ALT";
  regime: "TRENDING" | "CHOPPY" | "EXPANSION" | "LOW_VOL";
  cluster: "L1" | "L2" | "DEFI" | "OTHER";
  takeProfitPct: number;
  stopLossPct: number;
  atr: number;
  tpDistance: number;
  slDistance: number;
  expectedValue: number;
  slippageEstimate: number;
  effectiveEntryPrice?: number;
  marketCondition: "TRENDING" | "RANGING";
  stakeUsd: number;
  entryPrice: number;
  currentPrice: number;
  tpPrice: number;
  slPrice: number;
  leverage: number;
  status: "OPEN" | "WIN" | "LOSS";
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
  entryContextJson?: string;
  closeContextJson?: string;
  closeReason?: string;
};

type PersistRuntimeStateInput = {
  accountBalanceUsd: number;
  dailyStartBalanceUsd: number;
  openTrades: PersistedRuntimeTrade[];
  recentClosedTrades: PersistedRuntimeTrade[];
  metrics: {
    totalTrades: number;
    winRate: number;
    totalPnlUsd: number;
    totalPnlPct: number;
    maxDrawdown: number;
  };
};

type LoadedRuntimeState = {
  accountBalanceUsd: number;
  dailyStartBalanceUsd: number;
  openTrades: PersistedRuntimeTrade[];
  recentClosedTrades: PersistedRuntimeTrade[];
  metrics: {
    totalTrades: number;
    winRate: number;
    totalPnlUsd: number;
    totalPnlPct: number;
    maxDrawdown: number;
    lastUpdated: string;
  } | null;
};

type PersistableState = {
  analyzedAt: string;
  params: {
    query?: string;
    market: "perp" | "spot";
    limitTokens: number;
  };
  meta?: {
    onlySignals: boolean;
    filteredOutNoSignal: number;
  };
  signalCounts: {
    strongShort: number;
    strongLong: number;
    noSignal: number;
  };
  results: Array<unknown>;
  skipped: Array<unknown>;
  tradeSimulation?: {
    stats: {
      totalTrades: number;
      activeTrades: number;
      wins: number;
      losses: number;
      winRate: number;
      avgMinutesToWin: number;
      avgMinutesToLoss: number;
      totalSimulatedPnl: number;
    };
    recentClosedTrades: TradeSummary[];
  };
};

const dbPath = process.env.SIM_DB_PATH
  ? path.resolve(process.env.SIM_DB_PATH)
  : path.resolve(process.cwd(), "data", "simulation.db");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analyzed_at TEXT NOT NULL,
  market TEXT NOT NULL,
  query_text TEXT,
  limit_tokens INTEGER NOT NULL,
  only_signals INTEGER NOT NULL,
  returned_results INTEGER NOT NULL,
  strong_short INTEGER NOT NULL,
  strong_long INTEGER NOT NULL,
  no_signal INTEGER NOT NULL,
  skipped INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_stats_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at TEXT NOT NULL,
  total_trades INTEGER NOT NULL,
  active_trades INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  losses INTEGER NOT NULL,
  win_rate REAL NOT NULL,
  avg_minutes_to_win REAL NOT NULL,
  avg_minutes_to_loss REAL NOT NULL,
  total_simulated_pnl REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS closed_trades (
  trade_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_price REAL NOT NULL,
  tp_price REAL NOT NULL,
  sl_price REAL NOT NULL,
  status TEXT NOT NULL,
  open_time TEXT NOT NULL,
  close_time TEXT,
  result REAL,
  max_drawdown REAL,
  time_to_close INTEGER,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_price REAL NOT NULL,
  current_price REAL NOT NULL,
  tp_price REAL NOT NULL,
  sl_price REAL NOT NULL,
  position_size_usd REAL NOT NULL,
  status TEXT NOT NULL,
  open_time TEXT NOT NULL,
  close_time TEXT,
  result_usd REAL,
  result_pct REAL,
  max_drawdown REAL,
  signal_category TEXT NOT NULL,
  entry_type TEXT NOT NULL DEFAULT 'SCORE_BASED',
  entry_score REAL NOT NULL DEFAULT 0,
  risk_pct_used REAL NOT NULL DEFAULT 2,
  volatility_pct REAL NOT NULL DEFAULT 0,
  volume_24h REAL NOT NULL DEFAULT 0,
  passed_volatility INTEGER NOT NULL DEFAULT 0,
  passed_liquidity INTEGER NOT NULL DEFAULT 0,
  take_profit_pct REAL NOT NULL DEFAULT 15,
  stop_loss_pct REAL NOT NULL DEFAULT 10,
  atr REAL NOT NULL DEFAULT 0,
  tp_distance REAL NOT NULL DEFAULT 0,
  sl_distance REAL NOT NULL DEFAULT 0,
  expected_value REAL NOT NULL DEFAULT 0,
  slippage_estimate REAL NOT NULL DEFAULT 0,
  effective_entry_price REAL,
  signal_type TEXT NOT NULL,
  close_reason TEXT,
  entry_context_json TEXT,
  close_context_json TEXT,
  regime TEXT NOT NULL DEFAULT 'CHOPPY',
  cluster TEXT NOT NULL DEFAULT 'OTHER',
  market_condition TEXT NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'ALT',
  leverage REAL NOT NULL,
  open_fee_usd REAL,
  close_fee_usd REAL,
  current_pnl_pct REAL NOT NULL,
  current_pnl_usd REAL NOT NULL,
  position_value_usd REAL NOT NULL,
  distance_to_tp REAL NOT NULL,
  distance_to_sl REAL NOT NULL,
  time_to_close INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_balance REAL NOT NULL,
  daily_start_balance REAL NOT NULL,
  last_updated TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_trades INTEGER NOT NULL,
  win_rate REAL NOT NULL,
  total_pnl_usd REAL NOT NULL,
  total_pnl_pct REAL NOT NULL,
  max_drawdown REAL NOT NULL,
  last_updated TEXT NOT NULL
);
`);

for (const statement of [
  "ALTER TABLE trades ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'SCORE_BASED'",
  "ALTER TABLE trades ADD COLUMN entry_score REAL NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN risk_pct_used REAL NOT NULL DEFAULT 2",
  "ALTER TABLE trades ADD COLUMN volatility_pct REAL NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN volume_24h REAL NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN passed_volatility INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN passed_liquidity INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN take_profit_pct REAL NOT NULL DEFAULT 15",
  "ALTER TABLE trades ADD COLUMN stop_loss_pct REAL NOT NULL DEFAULT 10",
  "ALTER TABLE trades ADD COLUMN asset_type TEXT NOT NULL DEFAULT 'ALT'",
  "ALTER TABLE trades ADD COLUMN close_reason TEXT",
  "ALTER TABLE trades ADD COLUMN entry_context_json TEXT",
  "ALTER TABLE trades ADD COLUMN close_context_json TEXT",
  "ALTER TABLE trades ADD COLUMN atr REAL NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN tp_distance REAL NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN sl_distance REAL NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN expected_value REAL NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN slippage_estimate REAL NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN effective_entry_price REAL",
  "ALTER TABLE trades ADD COLUMN regime TEXT NOT NULL DEFAULT 'CHOPPY'",
  "ALTER TABLE trades ADD COLUMN cluster TEXT NOT NULL DEFAULT 'OTHER'"
]) {
  try {
    db.exec(statement);
  } catch {
    // Ignore if the column already exists.
  }
}

const insertScanRun = db.prepare(`
INSERT INTO scan_runs (
  analyzed_at,
  market,
  query_text,
  limit_tokens,
  only_signals,
  returned_results,
  strong_short,
  strong_long,
  no_signal,
  skipped,
  payload_json,
  created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertTradeStats = db.prepare(`
INSERT INTO trade_stats_snapshots (
  captured_at,
  total_trades,
  active_trades,
  wins,
  losses,
  win_rate,
  avg_minutes_to_win,
  avg_minutes_to_loss,
  total_simulated_pnl
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const upsertClosedTrade = db.prepare(`
INSERT INTO closed_trades (
  trade_id,
  token,
  direction,
  entry_price,
  tp_price,
  sl_price,
  status,
  open_time,
  close_time,
  result,
  max_drawdown,
  time_to_close,
  captured_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(trade_id) DO UPDATE SET
  status = excluded.status,
  close_time = excluded.close_time,
  result = excluded.result,
  max_drawdown = excluded.max_drawdown,
  time_to_close = excluded.time_to_close,
  captured_at = excluded.captured_at
`);

const upsertRuntimeTrade = db.prepare(`
INSERT INTO trades (
  id,
  token,
  direction,
  entry_price,
  current_price,
  tp_price,
  sl_price,
  position_size_usd,
  status,
  open_time,
  close_time,
  result_usd,
  result_pct,
  max_drawdown,
  signal_category,
  entry_type,
  entry_score,
  risk_pct_used,
  volatility_pct,
  volume_24h,
  passed_volatility,
  passed_liquidity,
  take_profit_pct,
  stop_loss_pct,
  atr,
  tp_distance,
  sl_distance,
  expected_value,
  slippage_estimate,
  effective_entry_price,
  signal_type,
  close_reason,
  entry_context_json,
  close_context_json,
  regime,
  cluster,
  market_condition,
  asset_type,
  leverage,
  open_fee_usd,
  close_fee_usd,
  current_pnl_pct,
  current_pnl_usd,
  position_value_usd,
  distance_to_tp,
  distance_to_sl,
  time_to_close,
  updated_at
)
VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?
)
ON CONFLICT(id) DO UPDATE SET
  token = excluded.token,
  direction = excluded.direction,
  entry_price = excluded.entry_price,
  current_price = excluded.current_price,
  tp_price = excluded.tp_price,
  sl_price = excluded.sl_price,
  position_size_usd = excluded.position_size_usd,
  status = excluded.status,
  open_time = excluded.open_time,
  close_time = excluded.close_time,
  result_usd = excluded.result_usd,
  result_pct = excluded.result_pct,
  max_drawdown = excluded.max_drawdown,
  signal_category = excluded.signal_category,
  entry_type = excluded.entry_type,
  entry_score = excluded.entry_score,
  risk_pct_used = excluded.risk_pct_used,
  volatility_pct = excluded.volatility_pct,
  volume_24h = excluded.volume_24h,
  passed_volatility = excluded.passed_volatility,
  passed_liquidity = excluded.passed_liquidity,
  take_profit_pct = excluded.take_profit_pct,
  stop_loss_pct = excluded.stop_loss_pct,
  atr = excluded.atr,
  tp_distance = excluded.tp_distance,
  sl_distance = excluded.sl_distance,
  expected_value = excluded.expected_value,
  slippage_estimate = excluded.slippage_estimate,
  effective_entry_price = excluded.effective_entry_price,
  signal_type = excluded.signal_type,
  close_reason = excluded.close_reason,
  entry_context_json = excluded.entry_context_json,
  close_context_json = excluded.close_context_json,
  regime = excluded.regime,
  cluster = excluded.cluster,
  market_condition = excluded.market_condition,
  asset_type = excluded.asset_type,
  leverage = excluded.leverage,
  open_fee_usd = excluded.open_fee_usd,
  close_fee_usd = excluded.close_fee_usd,
  current_pnl_pct = excluded.current_pnl_pct,
  current_pnl_usd = excluded.current_pnl_usd,
  position_value_usd = excluded.position_value_usd,
  distance_to_tp = excluded.distance_to_tp,
  distance_to_sl = excluded.distance_to_sl,
  time_to_close = excluded.time_to_close,
  updated_at = excluded.updated_at
`);

const deleteOpenRuntimeTrades = db.prepare(`DELETE FROM trades WHERE status = 'OPEN'`);

const upsertAccountState = db.prepare(`
INSERT INTO account_state (id, account_balance, daily_start_balance, last_updated)
VALUES (1, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  account_balance = excluded.account_balance,
  daily_start_balance = excluded.daily_start_balance,
  last_updated = excluded.last_updated
`);

const upsertMetricsSnapshot = db.prepare(`
INSERT INTO metrics_snapshot (id, total_trades, win_rate, total_pnl_usd, total_pnl_pct, max_drawdown, last_updated)
VALUES (1, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  total_trades = excluded.total_trades,
  win_rate = excluded.win_rate,
  total_pnl_usd = excluded.total_pnl_usd,
  total_pnl_pct = excluded.total_pnl_pct,
  max_drawdown = excluded.max_drawdown,
  last_updated = excluded.last_updated
`);

const selectAccountState = db.prepare(`
SELECT account_balance, daily_start_balance
FROM account_state
WHERE id = 1
`);

const selectOpenRuntimeTrades = db.prepare(`
SELECT
  id,
  token,
  direction,
  signal_type,
  close_reason,
  entry_context_json,
  close_context_json,
  signal_category,
  entry_type,
  entry_score,
  risk_pct_used,
  volatility_pct,
  volume_24h,
  passed_volatility,
  passed_liquidity,
  take_profit_pct,
  stop_loss_pct,
  atr,
  tp_distance,
  sl_distance,
  expected_value,
  slippage_estimate,
  effective_entry_price,
  market_condition,
  regime,
  cluster,
  asset_type,
  position_size_usd,
  entry_price,
  current_price,
  tp_price,
  sl_price,
  leverage,
  status,
  open_time,
  close_time,
  result_pct,
  result_usd,
  open_fee_usd,
  close_fee_usd,
  current_pnl_pct,
  current_pnl_usd,
  position_value_usd,
  distance_to_tp,
  distance_to_sl,
  max_drawdown,
  time_to_close
FROM trades
WHERE status = 'OPEN'
ORDER BY open_time DESC
`);

const selectRecentClosedRuntimeTrades = db.prepare(`
SELECT
  id,
  token,
  direction,
  signal_type,
  close_reason,
  entry_context_json,
  close_context_json,
  signal_category,
  entry_type,
  entry_score,
  risk_pct_used,
  volatility_pct,
  volume_24h,
  passed_volatility,
  passed_liquidity,
  take_profit_pct,
  stop_loss_pct,
  atr,
  tp_distance,
  sl_distance,
  expected_value,
  slippage_estimate,
  effective_entry_price,
  market_condition,
  regime,
  cluster,
  asset_type,
  position_size_usd,
  entry_price,
  current_price,
  tp_price,
  sl_price,
  leverage,
  status,
  open_time,
  close_time,
  result_pct,
  result_usd,
  open_fee_usd,
  close_fee_usd,
  current_pnl_pct,
  current_pnl_usd,
  position_value_usd,
  distance_to_tp,
  distance_to_sl,
  max_drawdown,
  time_to_close
FROM trades
WHERE status IN ('WIN', 'LOSS')
ORDER BY COALESCE(close_time, open_time) DESC
LIMIT 500
`);

const selectMetricsSnapshot = db.prepare(`
SELECT total_trades, win_rate, total_pnl_usd, total_pnl_pct, max_drawdown, last_updated
FROM metrics_snapshot
WHERE id = 1
`);

const selectLatestScanPayload = db.prepare(`
SELECT payload_json
FROM scan_runs
ORDER BY id DESC
LIMIT 1
`);

export function getSimulationDbPath(): string {
  return dbPath;
}

export function persistSimulationState(state: PersistableState): void {
  const now = new Date().toISOString();
  const onlySignals = state.meta?.onlySignals ? 1 : 0;

  insertScanRun.run(
    state.analyzedAt,
    state.params.market,
    state.params.query ?? "",
    state.params.limitTokens,
    onlySignals,
    state.results.length,
    state.signalCounts.strongShort,
    state.signalCounts.strongLong,
    state.signalCounts.noSignal,
    state.skipped.length,
    JSON.stringify(state),
    now
  );

  if (!state.tradeSimulation) {
    return;
  }

  const stats = state.tradeSimulation.stats;
  insertTradeStats.run(
    now,
    stats.totalTrades,
    stats.activeTrades,
    stats.wins,
    stats.losses,
    stats.winRate,
    stats.avgMinutesToWin,
    stats.avgMinutesToLoss,
    stats.totalSimulatedPnl
  );

  for (const trade of state.tradeSimulation.recentClosedTrades) {
    upsertClosedTrade.run(
      trade.id,
      trade.token,
      trade.direction,
      trade.entryPrice,
      trade.tpPrice,
      trade.slPrice,
      trade.status,
      trade.openTime,
      trade.closeTime ?? null,
      trade.result ?? null,
      trade.maxDrawdown ?? null,
      trade.timeToClose ?? null,
      now
    );
  }
}

function toPersistedRuntimeTrade(row: Record<string, unknown>): PersistedRuntimeTrade {
  return {
    id: String(row.id),
    token: String(row.token),
    direction: (String(row.direction) as PersistedRuntimeTrade["direction"]) ?? "LONG",
    signalType: String(row.signal_type ?? "SCORE_BASED_LONG"),
    closeReason: row.close_reason == null ? undefined : String(row.close_reason),
    entryContextJson: row.entry_context_json == null ? undefined : String(row.entry_context_json),
    closeContextJson: row.close_context_json == null ? undefined : String(row.close_context_json),
    signalCategory: (String(row.signal_category) as PersistedRuntimeTrade["signalCategory"]) ?? "SCORE_BASED",
    entryType: (String(row.entry_type ?? row.signal_category ?? "SCORE_BASED") as PersistedRuntimeTrade["entryType"]) ?? "SCORE_BASED",
    entryScore: Number(row.entry_score ?? 0),
    riskPctUsed: Number(row.risk_pct_used ?? 2),
    volatilityPct: Number(row.volatility_pct ?? 0),
    volume24h: Number(row.volume_24h ?? 0),
    passedVolatility: Number(row.passed_volatility ?? 0) === 1,
    passedLiquidity: Number(row.passed_liquidity ?? 0) === 1,
    assetType: (String(row.asset_type ?? "ALT") as PersistedRuntimeTrade["assetType"]) ?? "ALT",
    regime: (String(row.regime ?? "CHOPPY") as PersistedRuntimeTrade["regime"]) ?? "CHOPPY",
    cluster: (String(row.cluster ?? "OTHER") as PersistedRuntimeTrade["cluster"]) ?? "OTHER",
    takeProfitPct: Number(row.take_profit_pct ?? 15),
    stopLossPct: Number(row.stop_loss_pct ?? 10),
    atr: Number(row.atr ?? 0),
    tpDistance: Number(row.tp_distance ?? 0),
    slDistance: Number(row.sl_distance ?? 0),
    expectedValue: Number(row.expected_value ?? 0),
    slippageEstimate: Number(row.slippage_estimate ?? 0),
    effectiveEntryPrice: row.effective_entry_price == null ? undefined : Number(row.effective_entry_price),
    marketCondition: (String(row.market_condition) as PersistedRuntimeTrade["marketCondition"]) ?? "RANGING",
    stakeUsd: Number(row.position_size_usd ?? 0),
    entryPrice: Number(row.entry_price ?? 0),
    currentPrice: Number(row.current_price ?? 0),
    tpPrice: Number(row.tp_price ?? 0),
    slPrice: Number(row.sl_price ?? 0),
    leverage: Number(row.leverage ?? 0),
    status: (String(row.status) as PersistedRuntimeTrade["status"]) ?? "OPEN",
    openTime: String(row.open_time),
    closeTime: row.close_time ? String(row.close_time) : undefined,
    result: row.result_pct == null ? undefined : Number(row.result_pct),
    resultUsd: row.result_usd == null ? undefined : Number(row.result_usd),
    openFeeUsd: row.open_fee_usd == null ? undefined : Number(row.open_fee_usd),
    closeFeeUsd: row.close_fee_usd == null ? undefined : Number(row.close_fee_usd),
    currentPnlPct: Number(row.current_pnl_pct ?? 0),
    currentPnlUsd: Number(row.current_pnl_usd ?? 0),
    positionValueUsd: Number(row.position_value_usd ?? 0),
    distanceToTP: Number(row.distance_to_tp ?? 0),
    distanceToSL: Number(row.distance_to_sl ?? 0),
    maxDrawdown: row.max_drawdown == null ? undefined : Number(row.max_drawdown),
    timeToClose: row.time_to_close == null ? undefined : Number(row.time_to_close)
  };
}

export function persistTradeRuntimeState(state: PersistRuntimeStateInput): void {
  const now = new Date().toISOString();

  try {
    db.exec("BEGIN IMMEDIATE");
    upsertAccountState.run(state.accountBalanceUsd, state.dailyStartBalanceUsd, now);
    upsertMetricsSnapshot.run(
      state.metrics.totalTrades,
      state.metrics.winRate,
      state.metrics.totalPnlUsd,
      state.metrics.totalPnlPct,
      state.metrics.maxDrawdown,
      now
    );

    deleteOpenRuntimeTrades.run();

    for (const trade of state.openTrades) {
      upsertRuntimeTrade.run(
        trade.id,
        trade.token,
        trade.direction,
        trade.entryPrice,
        trade.currentPrice,
        trade.tpPrice,
        trade.slPrice,
        trade.stakeUsd,
        trade.status,
        trade.openTime,
        trade.closeTime ?? null,
        trade.resultUsd ?? null,
        trade.result ?? null,
        trade.maxDrawdown ?? null,
        trade.signalCategory,
        trade.entryType,
        trade.entryScore,
        trade.riskPctUsed,
        trade.volatilityPct,
        trade.volume24h,
        trade.passedVolatility ? 1 : 0,
        trade.passedLiquidity ? 1 : 0,
        trade.takeProfitPct,
        trade.stopLossPct,
        trade.atr,
        trade.tpDistance,
        trade.slDistance,
        trade.expectedValue,
        trade.slippageEstimate,
        trade.effectiveEntryPrice ?? null,
        trade.signalType,
        trade.closeReason ?? null,
        trade.entryContextJson ?? null,
        trade.closeContextJson ?? null,
        trade.regime,
        trade.cluster,
        trade.marketCondition,
        trade.assetType,
        trade.leverage,
        trade.openFeeUsd ?? null,
        trade.closeFeeUsd ?? null,
        trade.currentPnlPct,
        trade.currentPnlUsd,
        trade.positionValueUsd,
        trade.distanceToTP,
        trade.distanceToSL,
        trade.timeToClose ?? null,
        now
      );
    }

    for (const trade of state.recentClosedTrades) {
      upsertRuntimeTrade.run(
        trade.id,
        trade.token,
        trade.direction,
        trade.entryPrice,
        trade.currentPrice,
        trade.tpPrice,
        trade.slPrice,
        trade.stakeUsd,
        trade.status,
        trade.openTime,
        trade.closeTime ?? null,
        trade.resultUsd ?? null,
        trade.result ?? null,
        trade.maxDrawdown ?? null,
        trade.signalCategory,
        trade.entryType,
        trade.entryScore,
        trade.riskPctUsed,
        trade.volatilityPct,
        trade.volume24h,
        trade.passedVolatility ? 1 : 0,
        trade.passedLiquidity ? 1 : 0,
        trade.takeProfitPct,
        trade.stopLossPct,
        trade.atr,
        trade.tpDistance,
        trade.slDistance,
        trade.expectedValue,
        trade.slippageEstimate,
        trade.effectiveEntryPrice ?? null,
        trade.signalType,
        trade.closeReason ?? null,
        trade.entryContextJson ?? null,
        trade.closeContextJson ?? null,
        trade.regime,
        trade.cluster,
        trade.marketCondition,
        trade.assetType,
        trade.leverage,
        trade.openFeeUsd ?? null,
        trade.closeFeeUsd ?? null,
        trade.currentPnlPct,
        trade.currentPnlUsd,
        trade.positionValueUsd,
        trade.distanceToTP,
        trade.distanceToSL,
        trade.timeToClose ?? null,
        now
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function loadTradeRuntimeState(): LoadedRuntimeState | null {
  const accountRow = selectAccountState.get() as Record<string, unknown> | undefined;
  const openRows = selectOpenRuntimeTrades.all() as Record<string, unknown>[];
  const closedRows = selectRecentClosedRuntimeTrades.all() as Record<string, unknown>[];
  const metricsRow = selectMetricsSnapshot.get() as Record<string, unknown> | undefined;

  if (!accountRow && openRows.length === 0 && closedRows.length === 0 && !metricsRow) {
    return null;
  }

  return {
    accountBalanceUsd: Number(accountRow?.account_balance ?? 378),
    dailyStartBalanceUsd: Number(accountRow?.daily_start_balance ?? 378),
    openTrades: openRows.map(toPersistedRuntimeTrade),
    recentClosedTrades: closedRows.map(toPersistedRuntimeTrade),
    metrics: metricsRow
      ? {
          totalTrades: Number(metricsRow.total_trades ?? 0),
          winRate: Number(metricsRow.win_rate ?? 0),
          totalPnlUsd: Number(metricsRow.total_pnl_usd ?? 0),
          totalPnlPct: Number(metricsRow.total_pnl_pct ?? 0),
          maxDrawdown: Number(metricsRow.max_drawdown ?? 0),
          lastUpdated: String(metricsRow.last_updated ?? new Date().toISOString())
        }
      : null
  };
}

export function loadLatestScanPayload<T = unknown>(): T | null {
  const row = selectLatestScanPayload.get() as Record<string, unknown> | undefined;
  if (!row?.payload_json) {
    return null;
  }

  try {
    return JSON.parse(String(row.payload_json)) as T;
  } catch {
    return null;
  }
}
