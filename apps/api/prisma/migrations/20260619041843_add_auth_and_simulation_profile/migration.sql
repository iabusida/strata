-- AlterTable
ALTER TABLE "User" ADD COLUMN     "name" TEXT,
ADD COLUMN     "passwordHash" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "UserSimulationProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "initialBalanceUsd" DOUBLE PRECISION NOT NULL DEFAULT 10000,
    "riskPerTradePct" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "leverage" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "maxOpenTrades" INTEGER NOT NULL DEFAULT 8,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSimulationProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSimulationProfile_userId_key" ON "UserSimulationProfile"("userId");

-- CreateIndex
CREATE INDEX "UserSimulationProfile_userId_idx" ON "UserSimulationProfile"("userId");

-- AddForeignKey
ALTER TABLE "UserSimulationProfile" ADD CONSTRAINT "UserSimulationProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
