-- CreateEnum
CREATE TYPE "OptionSide" AS ENUM ('CALL', 'PUT');

-- CreateTable
CREATE TABLE "StyleMarketPolicy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tradingStyle" "TradingStyle" NOT NULL,
    "allowedAssetTypes" "AssetType"[],
    "allowedIntervals" "CandleInterval"[],
    "refreshSeconds" INTEGER NOT NULL DEFAULT 60,
    "maxUniverseSize" INTEGER NOT NULL DEFAULT 50,
    "includeExtendedHours" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StyleMarketPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DerivativeInstrument" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "assetType" "AssetType" NOT NULL,
    "venue" TEXT NOT NULL,
    "underlyingSymbol" TEXT NOT NULL,
    "expiration" TIMESTAMP(3),
    "strike" DOUBLE PRECISION,
    "optionSide" "OptionSide",
    "contractSize" DOUBLE PRECISION,
    "tickSize" DOUBLE PRECISION,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DerivativeInstrument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StyleMarketPolicy_userId_tradingStyle_idx" ON "StyleMarketPolicy"("userId", "tradingStyle");

-- CreateIndex
CREATE UNIQUE INDEX "StyleMarketPolicy_userId_tradingStyle_key" ON "StyleMarketPolicy"("userId", "tradingStyle");

-- CreateIndex
CREATE UNIQUE INDEX "DerivativeInstrument_symbol_key" ON "DerivativeInstrument"("symbol");

-- CreateIndex
CREATE INDEX "DerivativeInstrument_assetType_underlyingSymbol_idx" ON "DerivativeInstrument"("assetType", "underlyingSymbol");

-- CreateIndex
CREATE INDEX "DerivativeInstrument_venue_assetType_idx" ON "DerivativeInstrument"("venue", "assetType");

-- AddForeignKey
ALTER TABLE "StyleMarketPolicy" ADD CONSTRAINT "StyleMarketPolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
