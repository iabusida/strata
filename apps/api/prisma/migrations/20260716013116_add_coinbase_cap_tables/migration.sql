-- CreateTable
CREATE TABLE "CoinbaseCapToken" (
    "id" BIGSERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "baseSymbol" TEXT NOT NULL,
    "marketCapUsd" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION,
    "atl300" DOUBLE PRECISION,
    "distanceFromAtlPct" DOUBLE PRECISION,
    "weeklyRsi" DOUBLE PRECISION,
    "weeklyStochK" DOUBLE PRECISION,
    "weeklyStochD" DOUBLE PRECISION,
    "weeklyStochCrossUp" BOOLEAN NOT NULL DEFAULT false,
    "dailyRsi" DOUBLE PRECISION,
    "dailyStochK" DOUBLE PRECISION,
    "dailyStochD" DOUBLE PRECISION,
    "dailyStochCrossUp" BOOLEAN NOT NULL DEFAULT false,
    "stoch6hK" DOUBLE PRECISION,
    "stoch6hD" DOUBLE PRECISION,
    "stoch6hCrossUp" BOOLEAN NOT NULL DEFAULT false,
    "stoch1hK" DOUBLE PRECISION,
    "stoch1hD" DOUBLE PRECISION,
    "stoch1hCrossUp" BOOLEAN NOT NULL DEFAULT false,
    "stoch15mK" DOUBLE PRECISION,
    "stoch15mD" DOUBLE PRECISION,
    "stoch15mCrossUp" BOOLEAN NOT NULL DEFAULT false,
    "timeframeCrossCount" INTEGER NOT NULL DEFAULT 0,
    "atrPct" DOUBLE PRECISION,
    "macdHistRising" BOOLEAN NOT NULL DEFAULT false,
    "priceAbovePrevClose" BOOLEAN NOT NULL DEFAULT false,
    "volVsAvg14d" DOUBLE PRECISION,
    "inCapitulation" BOOLEAN NOT NULL DEFAULT false,
    "indicatorError" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinbaseCapToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinbaseCapMonitor" (
    "id" BIGSERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" DOUBLE PRECISION NOT NULL,
    "pricePrev15m" DOUBLE PRECISION,
    "changePct15m" DOUBLE PRECISION,
    "volume15mUsd" DOUBLE PRECISION,
    "alertLevel" TEXT NOT NULL DEFAULT 'NORMAL',
    "alertReason" TEXT,
    "alertTriggeredAt" TIMESTAMP(3),

    CONSTRAINT "CoinbaseCapMonitor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CoinbaseCapToken_symbol_key" ON "CoinbaseCapToken"("symbol");

-- CreateIndex
CREATE INDEX "CoinbaseCapToken_inCapitulation_distanceFromAtlPct_idx" ON "CoinbaseCapToken"("inCapitulation", "distanceFromAtlPct");

-- CreateIndex
CREATE INDEX "CoinbaseCapToken_refreshedAt_idx" ON "CoinbaseCapToken"("refreshedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoinbaseCapMonitor_symbol_key" ON "CoinbaseCapMonitor"("symbol");

-- CreateIndex
CREATE INDEX "CoinbaseCapMonitor_alertLevel_snapshotAt_idx" ON "CoinbaseCapMonitor"("alertLevel", "snapshotAt");

-- AddForeignKey
ALTER TABLE "CoinbaseCapMonitor" ADD CONSTRAINT "CoinbaseCapMonitor_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "CoinbaseCapToken"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;
