-- CreateEnum
CREATE TYPE "BackfillTokenStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'NO_DATA', 'SKIPPED');

-- CreateTable
CREATE TABLE "BackfillToken" (
    "id" BIGSERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "status" "BackfillTokenStatus" NOT NULL DEFAULT 'PENDING',
    "lastAttemptedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "dataAvailableFrom" TIMESTAMP(3),
    "candleCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackfillToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackfillToken_symbol_key" ON "BackfillToken"("symbol");

-- CreateIndex
CREATE INDEX "BackfillToken_status_updatedAt_idx" ON "BackfillToken"("status", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "BackfillToken_symbol_status_idx" ON "BackfillToken"("symbol", "status");
