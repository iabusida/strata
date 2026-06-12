INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt")
VALUES ('PRE_PUMP_WATCH_REQUIRE_RECOVERY_TREND', 'true', NOW())
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt")
VALUES ('PRE_PUMP_WATCH_MIN_RESISTANCE_DISTANCE_PCT', '6', NOW())
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt")
VALUES ('PRE_PUMP_WATCH_MAX_INTERMEDIARY_STOCH_K', '75', NOW())
ON CONFLICT ("key") DO NOTHING;
