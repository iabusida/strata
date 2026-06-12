INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt")
VALUES ('LIVE_MANUAL_POSITION_WATCH_SYMBOLS', 'NONE', NOW())
ON CONFLICT ("key") DO NOTHING;
