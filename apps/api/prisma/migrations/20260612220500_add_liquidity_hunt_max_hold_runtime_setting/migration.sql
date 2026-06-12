INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt") VALUES
('LIQUIDITY_HUNT_MAX_HOLD_MINUTES', '25', NOW())
ON CONFLICT ("key") DO UPDATE
SET "value" = EXCLUDED."value",
    "updatedAt" = NOW();
