-- Migrate trading logic settings from Fly environment variables to RuntimeSetting table.
-- All trading/business-logic settings are now database-configured only.
-- Infrastructure-only secrets remain in Fly (DB, Telegram token, API credentials, etc.)

-- Upsert all trading settings to ensure they exist in the database.
-- If a key already exists, keep the existing value; otherwise, insert the default.

INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt") VALUES
-- Telegram (business logic - alerting configuration)
('TELEGRAM_ALERTS_ENABLED', 'true', NOW()),
('TELEGRAM_ALERT_STAGES', 'READY,OPENED,CLOSED,CAUTION', NOW()),
('TELEGRAM_ALERT_DEDUPE_MINUTES', '15', NOW()),
('TELEGRAM_TOKEN_REPEAT_MINUTES', '180', NOW()),
('TELEGRAM_OPENED_REPEAT_MINUTES', '30', NOW()),
('TELEGRAM_COMMANDS_ENABLED', 'true', NOW()),
('TELEGRAM_TOKEN_ALERT_MATCH_WINDOW_SECONDS', '5', NOW()),

-- Backfill (market data strategy)
('BACKFILL_PROVIDER', 'AUTO', NOW()),

-- Risk and position management
('RISK_PER_TRADE', '0.01', NOW()),
('TP_SL_MODE', 'ROE', NOW()),
('MIN_RISK_REWARD', '1.5', NOW()),
('EARLY_REVERSAL_MIN_RR', '1.2', NOW()),
('MAX_SLIPPAGE_PCT', '0.2', NOW()),
('IGNORE_SLIPPAGE_GUARD', 'false', NOW()),
('TEST_OPEN_MODE', 'false', NOW()),
('CAP_EARLY_DRAWDOWN_TO_SL', 'true', NOW()),

-- Pre-pump watch configuration
('PRE_PUMP_WATCH_ENABLED', 'true', NOW()),
('PRE_PUMP_WATCH_MAX_VOLUME_USD', '60000000', NOW()),
('PRE_PUMP_WATCH_MIN_VOLUME_RATIO', '1.05', NOW()),
('PRE_PUMP_WATCH_MIN_VOLATILITY_PERCENTILE', '55', NOW()),
('PRE_PUMP_WATCH_MIN_INTERMEDIARY_RSI', '30', NOW()),
('PRE_PUMP_WATCH_MAX_INTERMEDIARY_RSI', '74', NOW()),
('PRE_PUMP_WATCH_REQUIRE_EMA_TREND', 'true', NOW()),
('PRE_PUMP_WATCH_REQUIRE_RECOVERY_TREND', 'true', NOW()),
('PRE_PUMP_WATCH_MIN_RESISTANCE_DISTANCE_PCT', '3', NOW()),
('PRE_PUMP_WATCH_MAX_INTERMEDIARY_STOCH_K', '92', NOW()),
('PRE_PUMP_WATCH_MIN_EMA_SLOPE', '0', NOW()),
('PRE_PUMP_WATCH_REQUIRE_STOCH_UP', 'true', NOW()),
('PRE_PUMP_WATCH_COOLDOWN_MINUTES', '120', NOW()),

-- UTC session blocking (low-liquidity hours)
('SESSION_BLOCK_START_UTC', '0', NOW()),
('SESSION_BLOCK_END_UTC', '0', NOW()),

-- Simulation and live trading flags
('SIM_SIGNAL_ONLY_MODE', 'false', NOW()),
('SIM_LIVE_PARITY_MODE', 'true', NOW()),
('SIM_LIVE_PARITY_LIMIT_TIMEOUT_MINUTES', '15', NOW()),
('SIM_LIVE_PARITY_ENTRY_SLIPPAGE_PCT', '0.04', NOW()),
('SIGNAL_DIRECTION_MODE', 'BOTH', NOW()),
('LIQUIDITY_HUNT_ONLY_MODE', 'false', NOW()),
('LIQUIDITY_HUNT_ENTRY_ENABLED', 'true', NOW()),
('LIQUIDITY_HUNT_ENTRY_LEVERAGE', '10', NOW()),
('LIQUIDITY_HUNT_ENTRY_TP_PCT', '10', NOW()),
('LIQUIDITY_HUNT_ENTRY_SL_PCT', '8', NOW()),
('LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT', '1.2', NOW()),
('LIQUIDITY_HUNT_MIN_BREAK_PCT', '0.6', NOW()),
('LIQUIDITY_HUNT_MIN_STOP_LIQUIDITY_POOL_USD', '5000', NOW()),
('LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE', 'LIMIT', NOW()),

-- Entry candle confirmation
('ENTRY_CANDLE_CONFIRMATION_ENABLED', 'true', NOW()),
('ENTRY_CANDLE_CONFIRMATION_REQUIRE_DOMINANCE', 'true', NOW()),
('ENTRY_CANDLE_CONFIRMATION_SHORT_MIN_BEARISH_SCORE', '0.5', NOW()),
('ENTRY_CANDLE_CONFIRMATION_LONG_MIN_BULLISH_SCORE', '0.5', NOW()),

-- AI decision making
('AI_DECISION_ENABLED', 'true', NOW()),
('AI_DECISION_SHADOW_MODE', 'true', NOW()),
('AI_DECISION_PROVIDER', 'AZURE_OPENAI', NOW()),
('AI_DECISION_MODEL', 'gpt-4o-mini', NOW()),
('AI_DECISION_MIN_CONFIDENCE', '0.6', NOW()),
('AI_DECISION_TIMEOUT_MS', '3500', NOW()),
('AI_DECISION_LOG_DECISIONS', 'true', NOW()),

-- Fixed stake configuration
('FIXED_STAKE_ENABLED', 'true', NOW()),
('SIM_INITIAL_CAPITAL_USD', '350', NOW()),
('SIGNAL_SIM_STAKE_USD', '100', NOW()),
('SIGNAL_SIM_MAX_ACTIVE_TRADES', '3', NOW()),
('MAX_ACTIVE_TRADES_UNDER_1000', '3', NOW()),
('MAX_ACTIVE_TRADES_AT_OR_ABOVE_1000', '3', NOW()),

-- Trade lifecycle management
('TRADE_FLIP_COOLDOWN_MINUTES', '60', NOW()),
('SYMBOL_REENTRY_COOLDOWN_MINUTES', '60', NOW()),
('MAX_CLUSTER_DIRECTION_ACTIVE_TRADES', '1', NOW()),

-- Volatility-based stake scaling
('VOLATILITY_STAKE_SCALING_ENABLED', 'true', NOW()),
('STAKE_VOL_MID_PCT', '3', NOW()),
('STAKE_VOL_HIGH_PCT', '6', NOW()),
('STAKE_VOL_LOW_MULT', '1', NOW()),
('STAKE_VOL_MID_MULT', '0.85', NOW()),
('STAKE_VOL_HIGH_MULT', '0.7', NOW()),

-- Rolling drawdown management
('ROLLING_DRAWDOWN_WINDOW_HOURS', '24', NOW()),
('ROLLING_DRAWDOWN_LIMIT_PCT', '8', NOW()),
('ROLLING_DRAWDOWN_COOLDOWN_MINUTES', '120', NOW()),

-- Global trade throttling
('GLOBAL_TRADE_THROTTLE_WINDOW_MINUTES', '30', NOW()),
('GLOBAL_TRADE_THROTTLE_MAX_TRADES', '3', NOW()),
('MAX_CONCURRENT_RISK_PCT', '3.5', NOW()),
('MAX_DAILY_DRAWDOWN_PCT', '3', NOW()),

-- Account management for live trading
('SIM_TARGET_TRADES', '100', NOW()),
('SIM_ALLOW_SYMBOLS', '', NOW()),
('SIM_BLOCK_SYMBOLS', 'CRV,APE', NOW()),
('SIM_SCORE_THRESHOLD', '3.5', NOW()),
('SIM_ENTRY_TIMING_MAX', 'MID', NOW()),
('SIM_REVERSAL_PHASE_MIN', 'TRANSITION_REVERSAL', NOW())

ON CONFLICT ("key") DO NOTHING;
