-- Create table for persisted Telegram watchlists by chat.
CREATE TABLE "TelegramWatchlistEntry" (
  "id" BIGSERIAL NOT NULL,
  "chatId" BIGINT NOT NULL,
  "symbol" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TelegramWatchlistEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TelegramWatchlistEntry_chatId_symbol_key"
  ON "TelegramWatchlistEntry"("chatId", "symbol");

CREATE INDEX "TelegramWatchlistEntry_chatId_createdAt_idx"
  ON "TelegramWatchlistEntry"("chatId", "createdAt" DESC);
