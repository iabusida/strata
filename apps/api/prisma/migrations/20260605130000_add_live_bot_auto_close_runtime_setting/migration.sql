INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt")
VALUES ('LIVE_BOT_AUTO_CLOSE_ENABLED', 'true', NOW())
ON CONFLICT ("key") DO NOTHING;
