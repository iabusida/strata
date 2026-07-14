-- CreateTable
CREATE TABLE "WeeklyCapMonitorHistory" (
    "id" BIGSERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" DOUBLE PRECISION,
    "bidAskImbalance" DOUBLE PRECISION,
    "imbalanceAccelPct" DOUBLE PRECISION,
    "preFireScore" INTEGER NOT NULL DEFAULT 0,
    "fundingRate" DOUBLE PRECISION,
    "spreadPct" DOUBLE PRECISION,
    "alertLevel" TEXT NOT NULL DEFAULT 'NORMAL',

    CONSTRAINT "WeeklyCapMonitorHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WeeklyCapMonitorHistory_symbol_snapshotAt_idx" ON "WeeklyCapMonitorHistory"("symbol", "snapshotAt" DESC);

-- CreateIndex
CREATE INDEX "WeeklyCapMonitorHistory_symbol_imbalanceAccelPct_idx" ON "WeeklyCapMonitorHistory"("symbol", "imbalanceAccelPct");
