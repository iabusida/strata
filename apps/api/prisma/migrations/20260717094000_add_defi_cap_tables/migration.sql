-- DeFi spot scanner persistence + monitor state + alert history

CREATE TABLE "DefiCapToken" (
    "id" BIGSERIAL NOT NULL,
    "poolId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "pairName" TEXT NOT NULL,
    "baseSymbol" TEXT NOT NULL,
    "quoteSymbol" TEXT NOT NULL,
    "dex" TEXT,
    "marketCapUsd" DOUBLE PRECISION NOT NULL,
    "fdvUsd" DOUBLE PRECISION,
    "liquidityUsd" DOUBLE PRECISION NOT NULL,
    "volume24hUsd" DOUBLE PRECISION NOT NULL,
    "priceChange24hPct" DOUBLE PRECISION,
    "ageDays" INTEGER NOT NULL,
    "close" DOUBLE PRECISION,
    "weeklyRsi" DOUBLE PRECISION,
    "weeklyStochK" DOUBLE PRECISION,
    "weeklyStochD" DOUBLE PRECISION,
    "weeklyStochCrossUp" BOOLEAN NOT NULL DEFAULT false,
    "dailyRsi" DOUBLE PRECISION,
    "dailyStochK" DOUBLE PRECISION,
    "dailyStochD" DOUBLE PRECISION,
    "dailyStochCrossUp" BOOLEAN NOT NULL DEFAULT false,
    "dailyAtrPct" DOUBLE PRECISION,
    "distanceFromAtlPct" DOUBLE PRECISION,
    "candleCount" INTEGER NOT NULL DEFAULT 0,
    "inCapitulation" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'NO_SETUP',
    "indicatorError" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DefiCapToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DefiCapMonitor" (
    "id" BIGSERIAL NOT NULL,
    "poolId" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" DOUBLE PRECISION NOT NULL,
    "pricePrev15m" DOUBLE PRECISION,
    "changePct15m" DOUBLE PRECISION,
    "volume15mUsd" DOUBLE PRECISION,
    "alertLevel" TEXT NOT NULL DEFAULT 'NORMAL',
    "alertReason" TEXT,
    "alertTriggeredAt" TIMESTAMP(3),

    CONSTRAINT "DefiCapMonitor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DefiCapMonitorHistory" (
    "id" BIGSERIAL NOT NULL,
    "poolId" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" DOUBLE PRECISION,
    "changePct15m" DOUBLE PRECISION,
    "volume15mUsd" DOUBLE PRECISION,
    "alertLevel" TEXT NOT NULL DEFAULT 'NORMAL',

    CONSTRAINT "DefiCapMonitorHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DefiCapAlertEvent" (
    "id" BIGSERIAL NOT NULL,
    "poolId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "pairName" TEXT NOT NULL,
    "alertLevel" TEXT NOT NULL,
    "alertReason" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DefiCapAlertEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DefiCapToken_poolId_key" ON "DefiCapToken"("poolId");
CREATE UNIQUE INDEX "DefiCapMonitor_poolId_key" ON "DefiCapMonitor"("poolId");
CREATE UNIQUE INDEX "DefiCapAlertEvent_dedupeKey_key" ON "DefiCapAlertEvent"("dedupeKey");

CREATE INDEX "DefiCapToken_inCapitulation_status_idx" ON "DefiCapToken"("inCapitulation", "status");
CREATE INDEX "DefiCapToken_network_refreshedAt_idx" ON "DefiCapToken"("network", "refreshedAt");
CREATE INDEX "DefiCapToken_pairName_idx" ON "DefiCapToken"("pairName");

CREATE INDEX "DefiCapMonitor_alertLevel_snapshotAt_idx" ON "DefiCapMonitor"("alertLevel", "snapshotAt");

CREATE INDEX "DefiCapMonitorHistory_poolId_snapshotAt_idx" ON "DefiCapMonitorHistory"("poolId", "snapshotAt" DESC);
CREATE INDEX "DefiCapMonitorHistory_alertLevel_snapshotAt_idx" ON "DefiCapMonitorHistory"("alertLevel", "snapshotAt" DESC);

CREATE INDEX "DefiCapAlertEvent_poolId_sentAt_idx" ON "DefiCapAlertEvent"("poolId", "sentAt" DESC);
CREATE INDEX "DefiCapAlertEvent_alertLevel_sentAt_idx" ON "DefiCapAlertEvent"("alertLevel", "sentAt" DESC);

ALTER TABLE "DefiCapMonitor" ADD CONSTRAINT "DefiCapMonitor_poolId_fkey"
FOREIGN KEY ("poolId") REFERENCES "DefiCapToken"("poolId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DefiCapMonitorHistory" ADD CONSTRAINT "DefiCapMonitorHistory_poolId_fkey"
FOREIGN KEY ("poolId") REFERENCES "DefiCapToken"("poolId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DefiCapAlertEvent" ADD CONSTRAINT "DefiCapAlertEvent_poolId_fkey"
FOREIGN KEY ("poolId") REFERENCES "DefiCapToken"("poolId") ON DELETE CASCADE ON UPDATE CASCADE;
