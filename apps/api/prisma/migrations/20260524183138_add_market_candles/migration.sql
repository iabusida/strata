-- CreateEnum
CREATE TYPE "CandleInterval" AS ENUM ('M15', 'H1', 'H4', 'H12', 'D1');

-- CreateTable
CREATE TABLE "MarketCandle" (
    "id" BIGSERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "interval" "CandleInterval" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketCandle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketCandle_interval_timestamp_idx" ON "MarketCandle"("interval", "timestamp");

-- CreateIndex
CREATE INDEX "MarketCandle_symbol_interval_timestamp_idx" ON "MarketCandle"("symbol", "interval", "timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "MarketCandle_symbol_interval_timestamp_key" ON "MarketCandle"("symbol", "interval", "timestamp");
