INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt")
VALUES ('EARLY_DRAWDOWN_EXIT_PCT', '-8', NOW())
ON CONFLICT ("key") DO UPDATE
SET "value" = EXCLUDED."value",
    "updatedAt" = NOW();
