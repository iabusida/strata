-- CreateEnum
CREATE TYPE "TradingProfileStyle" AS ENUM ('SCALP', 'DAY', 'SWING', 'LONG_TERM');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP DEFAULT;

-- CreateTable
CREATE TABLE "UserTradingProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "style" "TradingProfileStyle" NOT NULL DEFAULT 'SWING',
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "minConfidence" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTradingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserTradingProfile_userId_key" ON "UserTradingProfile"("userId");

-- CreateIndex
CREATE INDEX "UserTradingProfile_userId_idx" ON "UserTradingProfile"("userId");

-- AddForeignKey
ALTER TABLE "UserTradingProfile" ADD CONSTRAINT "UserTradingProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
