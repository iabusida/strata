INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt") VALUES
  ('LIVE_TRADING_ENABLED', 'false', NOW()),
  ('LIVE_ENFORCE_TELEGRAM_OPEN_CLOSE_FROM_LIVE', 'true', NOW()),
  ('LIVE_MAX_ACCOUNT_DRAWDOWN_PCT', '10', NOW()),
  ('LIVE_FORCE_CLOSE_ON_MAX_DRAWDOWN', 'true', NOW()),
  ('LIVE_BITUNIX_MARGIN_COIN', 'USDT', NOW()),
  ('LIVE_REQUIRE_POSITION_ID_ON_OPEN', 'true', NOW())
ON CONFLICT ("key") DO UPDATE
SET
  "value" = EXCLUDED."value",
  "updatedAt" = NOW();