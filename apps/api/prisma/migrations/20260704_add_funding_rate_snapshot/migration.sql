-- CreateTable FundingRateSnapshot
CREATE TABLE "FundingRateSnapshot" (
    "id" SERIAL NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "fundingRate" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingRateSnapshot_symbol_createdAt_key" UNIQUE ("symbol", "createdAt")
);

-- CreateIndex
CREATE INDEX "FundingRateSnapshot_symbol_idx" ON "FundingRateSnapshot"("symbol");
CREATE INDEX "FundingRateSnapshot_createdAt_idx" ON "FundingRateSnapshot"("createdAt");
