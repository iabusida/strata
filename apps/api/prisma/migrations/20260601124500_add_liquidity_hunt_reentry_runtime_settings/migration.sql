-- Seed liquidity-hunt proactive entry controls into strict runtime settings.
-- Strategy: Enter at predicted stop-loss (support/resistance) levels with high leverage, expecting quick market maker reversal.
INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt") VALUES
('LIQUIDITY_HUNT_ENTRY_ENABLED', 'true', NOW()),
('LIQUIDITY_HUNT_ENTRY_LEVERAGE', '10', NOW()),
('LIQUIDITY_HUNT_ENTRY_TP_PCT', '15', NOW()),
('LIQUIDITY_HUNT_ENTRY_SL_PCT', '2', NOW()),
('LIQUIDITY_HUNT_ENTRY_DISTANCE_PCT', '1.5', NOW())
ON CONFLICT ("key") DO UPDATE
SET "value" = EXCLUDED."value",
    "updatedAt" = NOW();
