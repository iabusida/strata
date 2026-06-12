CREATE TABLE "TelegramAlertEvent" (
  "id" BIGSERIAL NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "signalType" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TelegramAlertEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TelegramAlertEvent_dedupeKey_stage_key" ON "TelegramAlertEvent"("dedupeKey", "stage");
CREATE INDEX "TelegramAlertEvent_symbol_direction_signalType_sentAt_idx" ON "TelegramAlertEvent"("symbol", "direction", "signalType", "sentAt" DESC);
CREATE INDEX "TelegramAlertEvent_stage_sentAt_idx" ON "TelegramAlertEvent"("stage", "sentAt" DESC);
