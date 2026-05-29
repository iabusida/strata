-- CreateEnum
CREATE TYPE "TradingMode" AS ENUM ('DAY_TRADING', 'SWING_TRADING');

-- CreateTable
CREATE TABLE "StrategyConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tradingMode" "TradingMode" NOT NULL DEFAULT 'DAY_TRADING',
    "enableFibonacci" BOOLEAN NOT NULL DEFAULT true,
    "enableCipherB" BOOLEAN NOT NULL DEFAULT true,
    "enableVWAP" BOOLEAN NOT NULL DEFAULT true,
    "enableEMA" BOOLEAN NOT NULL DEFAULT true,
    "enableStructure" BOOLEAN NOT NULL DEFAULT true,
    "enableOrderFlow" BOOLEAN NOT NULL DEFAULT true,
    "enableATR" BOOLEAN NOT NULL DEFAULT true,
    "enableRSI" BOOLEAN NOT NULL DEFAULT true,
    "fiboTargetLevels" TEXT NOT NULL DEFAULT '0.23,0.38,0.5,0.618,0.786',
    "cipherBSensitivity" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "dayTradingMaxHoldTime" INTEGER NOT NULL DEFAULT 1440,
    "swingTradingMaxHoldTime" INTEGER NOT NULL DEFAULT 10080,
    "dayTradingTpPct" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "swingTradingTpPct" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "dayTradingSlPct" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "swingTradingSlPct" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StrategyConfig_pkey" PRIMARY KEY ("id")
);
