-- Add pre-fire signal fields to WeeklyCapToken (order book + funding snapshot)
ALTER TABLE "WeeklyCapToken"
ADD COLUMN "bidAskImbalance" DOUBLE PRECISION,
ADD COLUMN "fundingRateLevel" TEXT NOT NULL DEFAULT 'NEUTRAL',
ADD COLUMN "preFireScore" INTEGER NOT NULL DEFAULT 0;

-- Add pre-fire signal fields to WeeklyCapMonitor (15m rolling averages)
ALTER TABLE "WeeklyCapMonitor"
ADD COLUMN "bidAskImbalance" DOUBLE PRECISION,
ADD COLUMN "bidAskImbalanceAvg15m" DOUBLE PRECISION,
ADD COLUMN "spreadPct" DOUBLE PRECISION,
ADD COLUMN "preFireScore" INTEGER NOT NULL DEFAULT 0;
