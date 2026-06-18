/*
  Warnings:

  - A unique constraint covering the columns `[symbol,assetType,interval,timestamp]` on the table `MarketCandle` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "TradingStyle" AS ENUM ('DAY_TRADING', 'SWING', 'LONG_TERM', 'SPOT_SHORT');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('CRYPTO', 'STOCK', 'FUTURE', 'OPTION');

-- DropIndex
DROP INDEX "MarketCandle_symbol_interval_timestamp_idx";

-- DropIndex
DROP INDEX "MarketCandle_symbol_interval_timestamp_key";

-- AlterTable
ALTER TABLE "MarketCandle" ADD COLUMN     "assetType" "AssetType" NOT NULL DEFAULT 'CRYPTO';

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformConfiguration" (
    "id" TEXT NOT NULL,
    "exchangeCredentials" JSONB NOT NULL,
    "backfillPolicy" JSONB NOT NULL,
    "indicatorDefaults" JSONB NOT NULL,
    "alertChannels" JSONB NOT NULL,
    "riskDefaults" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserConfiguration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tradingStyle" "TradingStyle" NOT NULL DEFAULT 'SWING',
    "symbolUniverse" TEXT[],
    "riskPerTrade" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "maxConcurrentTrades" INTEGER NOT NULL DEFAULT 3,
    "dayTradeSettings" JSONB,
    "swingSettings" JSONB,
    "longTermSettings" JSONB,
    "spotSettings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_organizationId_idx" ON "ApiKey"("organizationId");

-- CreateIndex
CREATE INDEX "ApiKey_revokedAt_idx" ON "ApiKey"("revokedAt");

-- CreateIndex
CREATE INDEX "UserConfiguration_userId_idx" ON "UserConfiguration"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserConfiguration_userId_tradingStyle_key" ON "UserConfiguration"("userId", "tradingStyle");

-- CreateIndex
CREATE INDEX "MarketCandle_symbol_assetType_interval_timestamp_idx" ON "MarketCandle"("symbol", "assetType", "interval", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "MarketCandle_assetType_interval_timestamp_idx" ON "MarketCandle"("assetType", "interval", "timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "MarketCandle_symbol_assetType_interval_timestamp_key" ON "MarketCandle"("symbol", "assetType", "interval", "timestamp");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserConfiguration" ADD CONSTRAINT "UserConfiguration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
