-- CreateTable
CREATE TABLE "WeeklyCapToken" (
    "id" BIGSERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "baseSymbol" TEXT NOT NULL,
    "marketCapUsd" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION,
    "atl365" DOUBLE PRECISION,
    "distanceFromAtlPct" DOUBLE PRECISION,
    "weeklyRsi" DOUBLE PRECISION,
    "weeklyStochK" DOUBLE PRECISION,
    "weeklyStochD" DOUBLE PRECISION,
    "weeklyStochCrossUp" BOOLEAN NOT NULL DEFAULT false,
    "dailyRsi" DOUBLE PRECISION,
    "dailyStochK" DOUBLE PRECISION,
    "dailyStochD" DOUBLE PRECISION,
    "dailyStochCrossUp" BOOLEAN NOT NULL DEFAULT false,
    "inCapitulation" BOOLEAN NOT NULL DEFAULT false,
    "indicatorError" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeeklyCapToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyCapMonitor" (
    "id" BIGSERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" DOUBLE PRECISION NOT NULL,
    "pricePrev15m" DOUBLE PRECISION,
    "changePct15m" DOUBLE PRECISION,
    "volume15mUsd" DOUBLE PRECISION,
    "bidDepthUsd" DOUBLE PRECISION,
    "askDepthUsd" DOUBLE PRECISION,
    "fundingRate" DOUBLE PRECISION,
    "alertLevel" TEXT NOT NULL DEFAULT 'NORMAL',
    "alertTriggeredAt" TIMESTAMP(3),
    "alertReason" TEXT,

    CONSTRAINT "WeeklyCapMonitor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyCapToken_symbol_key" ON "WeeklyCapToken"("symbol");

-- CreateIndex
CREATE INDEX "WeeklyCapToken_inCapitulation_distanceFromAtlPct_idx" ON "WeeklyCapToken"("inCapitulation", "distanceFromAtlPct");

-- CreateIndex
CREATE INDEX "WeeklyCapToken_refreshedAt_idx" ON "WeeklyCapToken"("refreshedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyCapMonitor_symbol_key" ON "WeeklyCapMonitor"("symbol");

-- CreateIndex
CREATE INDEX "WeeklyCapMonitor_alertLevel_snapshotAt_idx" ON "WeeklyCapMonitor"("alertLevel", "snapshotAt");

-- AddForeignKey
ALTER TABLE "WeeklyCapMonitor" ADD CONSTRAINT "WeeklyCapMonitor_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "WeeklyCapToken"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "ScannerTokenState_market_setupDirection_burstReady_bearishCount" RENAME TO "ScannerTokenState_market_setupDirection_burstReady_bearishC_idx";
