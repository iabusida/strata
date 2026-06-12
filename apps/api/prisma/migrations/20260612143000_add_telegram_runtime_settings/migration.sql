-- Seed Telegram alert behavior controls into strict runtime settings.
-- Secrets like TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID remain env-backed.
INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt") VALUES
('TELEGRAM_ALERTS_ENABLED', 'true', NOW()),
('TELEGRAM_ALERT_STAGES', 'READY,OPENED,CLOSED,CAUTION', NOW()),
('TELEGRAM_ALERT_DEDUPE_MINUTES', '15', NOW()),
('TELEGRAM_TOKEN_REPEAT_MINUTES', '180', NOW()),
('TELEGRAM_OPENED_REPEAT_MINUTES', '30', NOW()),
('TELEGRAM_ALERT_GRAPHICS_ENABLED', 'true', NOW()),
('TELEGRAM_COMMANDS_ENABLED', 'true', NOW()),
('TELEGRAM_TOKEN_ALERT_MATCH_WINDOW_SECONDS', '180', NOW())
ON CONFLICT ("key") DO UPDATE
SET "value" = EXCLUDED."value",
    "updatedAt" = NOW();
