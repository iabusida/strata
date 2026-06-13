-- CreateTable
CREATE TABLE "LiveOrderLedger" (
    "id" BIGSERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "perpToken" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "localTradeId" TEXT,
    "clientId" TEXT,
    "orderId" TEXT,
    "positionId" TEXT,
    "stakeUsd" DOUBLE PRECISION,
    "leverage" DOUBLE PRECISION,
    "entryPrice" DOUBLE PRECISION,
    "tpPrice" DOUBLE PRECISION,
    "slPrice" DOUBLE PRECISION,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveOrderLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveOrderLedger_provider_clientId_key" ON "LiveOrderLedger"("provider", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveOrderLedger_provider_orderId_key" ON "LiveOrderLedger"("provider", "orderId");

-- CreateIndex
CREATE INDEX "LiveOrderLedger_provider_symbol_createdAt_idx" ON "LiveOrderLedger"("provider", "symbol", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "LiveOrderLedger_positionId_idx" ON "LiveOrderLedger"("positionId");

-- CreateIndex
CREATE INDEX "LiveOrderLedger_status_updatedAt_idx" ON "LiveOrderLedger"("status", "updatedAt" DESC);
