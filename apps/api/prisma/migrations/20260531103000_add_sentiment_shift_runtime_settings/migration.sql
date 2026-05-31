-- Seed sentiment-shift lifecycle controls into strict runtime settings.
INSERT INTO "RuntimeSetting" ("key", "value", "updatedAt") VALUES
('SENTIMENT_SHIFT_EXIT_ENABLED', 'true', NOW()),
('SENTIMENT_SHIFT_MIN_HOLD_MINUTES', '5', NOW()),
('SENTIMENT_SHIFT_MIN_CONFLUENCE_SCORE', '6.5', NOW()),
('SENTIMENT_SHIFT_REQUIRE_BIAS_ALIGNMENT', 'true', NOW())
ON CONFLICT ("key") DO UPDATE
SET "value" = EXCLUDED."value",
    "updatedAt" = NOW();
