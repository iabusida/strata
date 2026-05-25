-- CreateEnum
CREATE TYPE "TokenVolatilityRegime" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "TokenTrade" (
    "id" BIGSERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "pnlPct" DOUBLE PRECISION NOT NULL,
    "hitTP" BOOLEAN NOT NULL,
    "hitSL" BOOLEAN NOT NULL,
    "maxDrawdownPct" DOUBLE PRECISION NOT NULL,
    "durationCandles" INTEGER NOT NULL,
    "regime" "TokenVolatilityRegime" NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenTrade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TokenTrade_symbol_closedAt_idx" ON "TokenTrade"("symbol", "closedAt" DESC);

-- CreateIndex
CREATE INDEX "TokenTrade_symbol_regime_closedAt_idx" ON "TokenTrade"("symbol", "regime", "closedAt" DESC);
