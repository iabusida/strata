-- CreateEnum
CREATE TYPE "SignalState" AS ENUM ('READY', 'CAUTION', 'BLOCKED', 'UNRESOLVED');

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "assetType" "AssetType" NOT NULL,
    "tradingStyle" "TradingStyle" NOT NULL,
    "interval" "CandleInterval" NOT NULL,
    "signalState" "SignalState" NOT NULL,
    "signalType" TEXT,
    "recommendation" TEXT,
    "metrics" JSONB,
    "priceContext" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlertEvent_userId_symbol_tradingStyle_createdAt_idx" ON "AlertEvent"("userId", "symbol", "tradingStyle", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AlertEvent_symbol_assetType_tradingStyle_signalState_create_idx" ON "AlertEvent"("symbol", "assetType", "tradingStyle", "signalState", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AlertEvent_signalState_createdAt_idx" ON "AlertEvent"("signalState", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AlertEvent_userId_signalState_createdAt_idx" ON "AlertEvent"("userId", "signalState", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
