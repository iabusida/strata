import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export type RuntimeSettingEntry = {
  key: string;
  value: string;
  updatedAt: string;
};

// Source-of-truth runtime settings loaded from DB before app modules initialize.
// If any key here is missing or empty, startup must fail.
export const REQUIRED_RUNTIME_SETTING_KEYS: string[] = [
  "MARKET_DATA_PROVIDER",
  "SCAN_MARKET",
  "SCAN_LIMIT_TOKENS",
  "SCAN_ROTATION_CHUNK_SIZE",
  "SIGNAL_SCAN_INTERVAL_MS",
  "TRADE_REFRESH_INTERVAL_MS",
  "PRICE_TICK_INTERVAL_MS",
  "TELEGRAM_ALERTS_ENABLED",
  "TELEGRAM_ALERT_STAGES",
  "TELEGRAM_ALERT_DEDUPE_MINUTES",
  "TELEGRAM_TOKEN_REPEAT_MINUTES",
  "TELEGRAM_OPENED_REPEAT_MINUTES",
  "TELEGRAM_ALERT_GRAPHICS_ENABLED",
  "TELEGRAM_COMMANDS_ENABLED",
  "TELEGRAM_TOKEN_ALERT_MATCH_WINDOW_SECONDS",
  "BITUNIX_MARKET_WS_URL",
  "BITUNIX_MARKET_WS_CHANNELS",
  "BITUNIX_WS_PRICE_MAX_AGE_MS",
  "BITUNIX_PERP_CTX_REST_REFRESH_MS",
  "BITUNIX_PERP_CTX_CACHE_TTL_MS",
  "BITUNIX_WS_RECONNECT_DELAY_MS",
  "BITUNIX_WS_STATS_LOG_INTERVAL_MS",
  "SCAN_PRIORITY_SYMBOLS",
  "SCAN_BLOCK_SYMBOLS",
  "LEVERAGE",
  "RISK_PER_TRADE",
  "TP_SL_MODE",
  "TAKE_PROFIT_PCT",
  "STOP_LOSS_PCT",
  "MIN_RISK_REWARD",
  "SCORE_ENTRY_THRESHOLD",
  "BTC_SCORE_ENTRY_THRESHOLD",
  "PRIORITY_SCORE_ENTRY_THRESHOLD",
  "PRIORITY_BTC_SCORE_ENTRY_THRESHOLD",
  "ENTRY_TIMING_MAX",
  "STRONG_SIGNAL_ENTRY_TIMING_MAX",
  "REVERSAL_MAX_HOLD_MINUTES",
  "STRONG_MAX_HOLD_MINUTES",
  "DEFAULT_MAX_HOLD_MINUTES",
  "ABSOLUTE_MAX_HOLD_MINUTES",
  "REVERSAL_PHASE_MIN",
  "ENFORCE_RESOLVED_REVERSAL_PHASE",
  "UNRESOLVED_REVERSAL_ALLOW_HIGH_SCORE",
  "UNRESOLVED_REVERSAL_MIN_SCORE",
  "UNRESOLVED_REVERSAL_REQUIRE_EARLY",
  "REVERSAL_VOLATILITY_GATE_ENABLED",
  "REVERSAL_MAX_VOLATILITY_PCT",
  "SYMBOL_FAST_SL_COOLDOWN_ENABLED",
  "SYMBOL_FAST_SL_HITS_THRESHOLD",
  "SYMBOL_FAST_SL_MAX_HOLD_MINUTES",
  "SYMBOL_FAST_SL_LOOKBACK_MINUTES",
  "SYMBOL_FAST_SL_COOLDOWN_MINUTES",
  "FIB_TOUCH_MEMORY_ENABLED",
  "FIB_TOUCH_MEMORY_WINDOW_MINUTES",
  "FIB_TOUCH_MEMORY_MAX_DISTANCE_PCT",
  "MIN_VOLATILITY_PCT",
  "MIN_VOLUME_USD",
  "MIN_VOLUME_USD_MAJOR_ALT",
  "EXPECTED_VALUE_MIN_PCT",
  "SENTIMENT_SHIFT_EXIT_ENABLED",
  "SENTIMENT_SHIFT_MIN_HOLD_MINUTES",
  "SENTIMENT_SHIFT_MIN_CONFLUENCE_SCORE",
  "SENTIMENT_SHIFT_REQUIRE_BIAS_ALIGNMENT",
  "VIOLENT_MOVE_ALERT_ENABLED",
  "VIOLENT_MOVE_MIN_VOLATILITY_PCT",
  "VIOLENT_MOVE_MIN_VOLATILITY_PERCENTILE",
  "VIOLENT_MOVE_MIN_VOLUME_MULTIPLIER",
  "VIOLENT_MOVE_STOCH_MIN_K",
  "VIOLENT_MOVE_DROP_CAUTION_ENABLED",
  "VIOLENT_MOVE_DROP_WINDOW_MINUTES",
  "VIOLENT_MOVE_DROP_RATIO",
  "VIOLENT_MOVE_DROP_ABS_VOLATILITY_PCT",
  "VIOLENT_MOVE_DROP_REQUIRE_STOCH_ROLLOVER",
  "GLOBAL_LONG_STOP_SWEEP_GUARD_ENABLED",
  "GLOBAL_LONG_STOP_SWEEP_MIN_LONG_SIGNALS",
  "GLOBAL_LONG_STOP_SWEEP_MIN_BREACH_PCT",
  "GLOBAL_LONG_STOP_SWEEP_THRESHOLD_PCT",
  "GLOBAL_LONG_STOP_SWEEP_CLEAR_CYCLES",
  "GLOBAL_LONG_STOP_SWEEP_ALERT_COOLDOWN_MINUTES",
  "LIQUIDITY_HUNT_ENTRY_ENABLED",
  "LIQUIDITY_HUNT_ENTRY_LEVERAGE",
  "LIQUIDITY_HUNT_ENTRY_TP_PCT",
  "LIQUIDITY_HUNT_ENTRY_SL_PCT",
  "LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT",
  "LIQUIDITY_HUNT_ENTRY_MODE",
  "LIQUIDITY_HUNT_MIN_CONFIDENCE_PCT",
  "LIQUIDITY_HUNT_MIN_BREAK_PCT",
  "LIQUIDITY_HUNT_MAX_HOLD_MINUTES",
  "LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE",
  "LIQUIDITY_HUNT_ONLY_MODE",
  "PRE_PUMP_WATCH_ENABLED",
  "PRE_PUMP_WATCH_MAX_VOLUME_USD",
  "PRE_PUMP_WATCH_MIN_VOLUME_RATIO",
  "PRE_PUMP_WATCH_MIN_VOLATILITY_PERCENTILE",
  "PRE_PUMP_WATCH_MIN_INTERMEDIARY_RSI",
  "PRE_PUMP_WATCH_MAX_INTERMEDIARY_RSI",
  "PRE_PUMP_WATCH_REQUIRE_EMA_TREND",
  "PRE_PUMP_WATCH_MIN_EMA_SLOPE",
  "PRE_PUMP_WATCH_REQUIRE_STOCH_UP",
  "PRE_PUMP_WATCH_REQUIRE_RECOVERY_TREND",
  "PRE_PUMP_WATCH_MIN_RESISTANCE_DISTANCE_PCT",
  "PRE_PUMP_WATCH_MAX_INTERMEDIARY_STOCH_K",
  "PRE_PUMP_WATCH_COOLDOWN_MINUTES",
  "EARLY_REVERSAL_EV_TOLERANCE",
  "EARLY_REVERSAL_MIN_RR",
  "MAX_SLIPPAGE_PCT",
  "IGNORE_SLIPPAGE_GUARD",
  "TEST_OPEN_MODE",
  "CAP_EARLY_DRAWDOWN_TO_SL",
  "EARLY_DRAWDOWN_EXIT_PCT",
  "SIM_SIGNAL_ONLY_MODE",
  "LIVE_TRADING_ENABLED",
  "LIVE_ENFORCE_TELEGRAM_OPEN_CLOSE_FROM_LIVE",
  "LIVE_MAX_ACCOUNT_DRAWDOWN_PCT",
  "LIVE_FORCE_CLOSE_ON_MAX_DRAWDOWN",
  "LIVE_BOT_AUTO_CLOSE_ENABLED",
  "LIVE_MANUAL_POSITION_WATCH_SYMBOLS",
  "LIVE_BITUNIX_MARGIN_COIN",
  "LIVE_BITUNIX_MARGIN_MODE",
  "LIVE_BITUNIX_ENFORCE_MARGIN_MODE",
  "LIVE_MULTI_TRADE_MIN_BALANCE_USD",
  "LIVE_REQUIRE_POSITION_ID_ON_OPEN",
  "FIXED_STAKE_ENABLED",
  "SIGNAL_SIM_STAKE_USD",
  "SIGNAL_SIM_MAX_ACTIVE_TRADES",
  "MAX_ACTIVE_TRADES_UNDER_1000",
  "MAX_ACTIVE_TRADES_AT_OR_ABOVE_1000",
  "TRADE_FLIP_COOLDOWN_MINUTES",
  "SYMBOL_REENTRY_COOLDOWN_MINUTES",
  "MAX_CLUSTER_DIRECTION_ACTIVE_TRADES",
  "VOLATILITY_STAKE_SCALING_ENABLED",
  "STAKE_VOL_MID_PCT",
  "STAKE_VOL_HIGH_PCT",
  "STAKE_VOL_LOW_MULT",
  "STAKE_VOL_MID_MULT",
  "STAKE_VOL_HIGH_MULT",
  "ROLLING_DRAWDOWN_WINDOW_HOURS",
  "ROLLING_DRAWDOWN_LIMIT_PCT",
  "ROLLING_DRAWDOWN_COOLDOWN_MINUTES",
  "GLOBAL_TRADE_THROTTLE_WINDOW_MINUTES",
  "GLOBAL_TRADE_THROTTLE_MAX_TRADES",
  "MAX_CONCURRENT_RISK_PCT",
  "MAX_DAILY_DRAWDOWN_PCT",
  "ORDERBOOK_MAX_SPREAD_PCT_LARGE",
  "ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT",
  "ORDERBOOK_MAX_SPREAD_PCT_ALT",
  "ORDERBOOK_MIN_DEPTH_MULTIPLIER",
  "ORDERBOOK_MAX_AGAINST_IMBALANCE",
  "ORDERBOOK_MAX_AGAINST_IMBALANCE_MAJOR_ALT",
  "HTF_MOMENTUM_ALIGNMENT_ENABLED",
  "HTF_MOMENTUM_BLOCK_SCORE_MIN",
  "TRADE_OHLC_CACHE_TTL_MS",
  "TRADE_OHLC_RATE_LIMIT_COOLDOWN_MS",
  "TRADE_OHLC_RATE_LIMIT_WARN_INTERVAL_MS"
];

let runtimeSettingsLoaded = false;

function normalizeValue(raw: string): string {
  return raw.trim();
}

export async function loadRuntimeSettingsToProcessEnvOrThrow(): Promise<void> {
  const rows = await prisma.runtimeSetting.findMany();
  const byKey = new Map(rows.map((row) => [row.key, normalizeValue(row.value)]));

  // Load ALL settings into process.env
  for (const [key, value] of byKey) {
    process.env[key] = value;
  }

  // Validate required keys exist
  const missing: string[] = [];
  for (const key of REQUIRED_RUNTIME_SETTING_KEYS) {
    const value = byKey.get(key);
    if (!value) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `[runtime-settings] Missing required settings (${missing.length}): ${missing.join(", ")}`
    );
  }

  runtimeSettingsLoaded = true;
}

export function assertRuntimeSettingsLoaded(): void {
  if (!runtimeSettingsLoaded) {
    throw new Error("[runtime-settings] Runtime settings were not loaded before module usage");
  }
}

export async function listRuntimeSettings(): Promise<RuntimeSettingEntry[]> {
  const rows = await prisma.runtimeSetting.findMany({ orderBy: { key: "asc" } });
  return rows.map((row) => ({ key: row.key, value: row.value, updatedAt: row.updatedAt.toISOString() }));
}

export async function updateRuntimeSettings(
  entries: Array<{ key: string; value: string }>
): Promise<RuntimeSettingEntry[]> {
  for (const entry of entries) {
    const key = entry.key.trim();
    const value = entry.value.trim();

    if (!key || !value) {
      throw new Error("Runtime settings update contains empty key/value");
    }

    await prisma.runtimeSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value }
    });
  }

  const all = await listRuntimeSettings();
  const byKey = new Map(all.map((row) => [row.key, row.value.trim()]));
  const missing = REQUIRED_RUNTIME_SETTING_KEYS.filter((key) => !byKey.get(key));
  if (missing.length > 0) {
    throw new Error(`[runtime-settings] Missing required settings after update: ${missing.join(", ")}`);
  }

  for (const key of REQUIRED_RUNTIME_SETTING_KEYS) {
    process.env[key] = byKey.get(key) as string;
  }

  runtimeSettingsLoaded = true;
  return all;
}
