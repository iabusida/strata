-- Seed liquidity-hunt flip controls.
-- LIQUIDITY_HUNT_ENTRY_MODE:
--   FADE: fade support/resistance stop-sweep levels (legacy behavior)
--   BREAKOUT_FLIP: take continuation direction after a decisive level breach
-- LIQUIDITY_HUNT_MIN_BREAK_PCT applies only when mode is BREAKOUT_FLIP.
INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt") VALUES
('LIQUIDITY_HUNT_ENTRY_MODE', 'BREAKOUT_FLIP', NOW()),
('LIQUIDITY_HUNT_MIN_BREAK_PCT', '0.5', NOW())
ON CONFLICT ("key") DO UPDATE
SET "value" = EXCLUDED."value",
    "updatedAt" = NOW();
