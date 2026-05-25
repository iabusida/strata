-- CreateTable
CREATE TABLE "ScanState" (
    "id" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "analyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScanState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeRuntimeState" (
    "id" INTEGER NOT NULL,
    "accountBalanceUsd" DOUBLE PRECISION NOT NULL,
    "dailyStartBalanceUsd" DOUBLE PRECISION NOT NULL,
    "openTrades" JSONB NOT NULL,
    "recentClosedTrades" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeRuntimeState_pkey" PRIMARY KEY ("id")
);
