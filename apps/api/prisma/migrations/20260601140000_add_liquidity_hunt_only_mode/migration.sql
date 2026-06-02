-- Seed liquidity-hunt only mode setting.
-- When enabled, only liquidity hunt entries are allowed (normal signal-based entry logic is skipped).
INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt") VALUES
('LIQUIDITY_HUNT_ONLY_MODE', 'true', NOW())
ON CONFLICT ("key") DO UPDATE
SET "value" = EXCLUDED."value",
    "updatedAt" = NOW();
