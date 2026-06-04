-- CreateTable
CREATE TABLE "ExchangeTradeHistory" (
    "id" BIGSERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "exchangeTradeId" TEXT,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "marginCoin" TEXT,
    "status" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3) NOT NULL,
    "entryPrice" DOUBLE PRECISION,
    "closePrice" DOUBLE PRECISION,
    "leverage" DOUBLE PRECISION,
    "qty" DOUBLE PRECISION,
    "realizedPnlUsd" DOUBLE PRECISION,
    "roiPct" DOUBLE PRECISION,
    "rawPayload" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeTradeHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeTradeHistory_dedupeKey_key" ON "ExchangeTradeHistory"("dedupeKey");

-- CreateIndex
CREATE INDEX "ExchangeTradeHistory_provider_closedAt_idx" ON "ExchangeTradeHistory"("provider", "closedAt" DESC);

-- CreateIndex
CREATE INDEX "ExchangeTradeHistory_symbol_closedAt_idx" ON "ExchangeTradeHistory"("symbol", "closedAt" DESC);

-- CreateIndex
CREATE INDEX "ExchangeTradeHistory_exchangeTradeId_idx" ON "ExchangeTradeHistory"("exchangeTradeId");
