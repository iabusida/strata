-- Retune runtime settings for swing pre-pump trading (days-to-weeks holds).
-- These values feed the active simple-momentum -> liquidity-hunt entry path used by
-- the simulation (and live trading). Position sizing is risk-based off the stop
-- distance, so widening the stop reduces position size and keeps dollar risk constant.
--
-- Geometry at 1x leverage (price == ROE):
--   Take profit: +30% (was +15%) -- realistic pre-pump breakout swing target
--   Stop loss:   -10% (was  -2%) -- below the coil base, room for multi-day holds
--   R:R = 3:1
-- Hold window: up to 21 days (was 2 days) so swing trades are not force-closed early.

INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt") VALUES
  ('LIQUIDITY_HUNT_ENTRY_TP_PCT', '30', NOW()),
  ('LIQUIDITY_HUNT_ENTRY_SL_PCT', '10', NOW()),
  ('LIQUIDITY_HUNT_MAX_HOLD_MINUTES', '30240', NOW()),
  ('DEFAULT_MAX_HOLD_MINUTES', '30240', NOW()),
  ('ABSOLUTE_MAX_HOLD_MINUTES', '30240', NOW())
ON CONFLICT ("key") DO UPDATE
SET
  "value" = EXCLUDED."value",
  "updatedAt" = NOW();
