-- Seed global long stop sweep guard controls into strict runtime settings.
INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt") VALUES
('GLOBAL_LONG_STOP_SWEEP_GUARD_ENABLED', 'true', NOW()),
('GLOBAL_LONG_STOP_SWEEP_MIN_LONG_SIGNALS', '10', NOW()),
('GLOBAL_LONG_STOP_SWEEP_MIN_BREACH_PCT', '0.15', NOW()),
('GLOBAL_LONG_STOP_SWEEP_THRESHOLD_PCT', '12', NOW()),
('GLOBAL_LONG_STOP_SWEEP_CLEAR_CYCLES', '2', NOW()),
('GLOBAL_LONG_STOP_SWEEP_ALERT_COOLDOWN_MINUTES', '15', NOW())
ON CONFLICT ("key") DO UPDATE
SET "value" = EXCLUDED."value",
    "updatedAt" = NOW();
