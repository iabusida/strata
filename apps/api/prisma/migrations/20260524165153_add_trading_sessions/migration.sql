-- CreateEnum
CREATE TYPE "TradingSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "SessionTradeStatus" AS ENUM ('OPEN', 'WIN', 'LOSS');

-- CreateTable
CREATE TABLE "TradingSession" (
    "id" BIGSERIAL NOT NULL,
    "status" "TradingSessionStatus" NOT NULL DEFAULT 'OPEN',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "startingBalanceUsd" DOUBLE PRECISION NOT NULL,
    "currentBalanceUsd" DOUBLE PRECISION NOT NULL,
    "leverage" DOUBLE PRECISION NOT NULL,
    "takeProfitPct" DOUBLE PRECISION NOT NULL,
    "stopLossPct" DOUBLE PRECISION NOT NULL,
    "maxConcurrentTrades" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionTrade" (
    "id" BIGSERIAL NOT NULL,
    "sessionId" BIGINT NOT NULL,
    "externalTradeId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "entryScore" DOUBLE PRECISION NOT NULL,
    "weightedScore" DOUBLE PRECISION NOT NULL,
    "takeProfitPct" DOUBLE PRECISION NOT NULL,
    "stopLossPct" DOUBLE PRECISION NOT NULL,
    "stakeUsd" DOUBLE PRECISION NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "tpPrice" DOUBLE PRECISION NOT NULL,
    "slPrice" DOUBLE PRECISION NOT NULL,
    "leverage" DOUBLE PRECISION NOT NULL,
    "status" "SessionTradeStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "resultPct" DOUBLE PRECISION,
    "resultUsd" DOUBLE PRECISION,
    "closeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionOpportunity" (
    "id" BIGSERIAL NOT NULL,
    "sessionId" BIGINT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "entryScore" DOUBLE PRECISION NOT NULL,
    "weightedScore" DOUBLE PRECISION NOT NULL,
    "takeProfitPct" DOUBLE PRECISION NOT NULL,
    "stopLossPct" DOUBLE PRECISION NOT NULL,
    "volatilityPct" DOUBLE PRECISION NOT NULL,
    "marketCondition" TEXT NOT NULL,
    "availableForEntry" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TradingSession_status_startedAt_idx" ON "TradingSession"("status", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SessionTrade_externalTradeId_key" ON "SessionTrade"("externalTradeId");

-- CreateIndex
CREATE INDEX "SessionTrade_sessionId_openedAt_idx" ON "SessionTrade"("sessionId", "openedAt" DESC);

-- CreateIndex
CREATE INDEX "SessionTrade_symbol_openedAt_idx" ON "SessionTrade"("symbol", "openedAt" DESC);

-- CreateIndex
CREATE INDEX "SessionOpportunity_sessionId_createdAt_idx" ON "SessionOpportunity"("sessionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SessionOpportunity_symbol_createdAt_idx" ON "SessionOpportunity"("symbol", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "SessionTrade" ADD CONSTRAINT "SessionTrade_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TradingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionOpportunity" ADD CONSTRAINT "SessionOpportunity_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TradingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
