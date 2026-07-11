CREATE TABLE "ScannerTokenState" (
  "id" BIGSERIAL NOT NULL,
  "symbol" TEXT NOT NULL,
  "market" TEXT NOT NULL,
  "setupDirection" TEXT NOT NULL,
  "setupLabel" TEXT NOT NULL,
  "signalType" TEXT NOT NULL,
  "nearZone" BOOLEAN NOT NULL DEFAULT false,
  "burstReady" BOOLEAN NOT NULL DEFAULT false,
  "bearish1h" BOOLEAN NOT NULL DEFAULT false,
  "bearish4h" BOOLEAN NOT NULL DEFAULT false,
  "bearish6h" BOOLEAN NOT NULL DEFAULT false,
  "bearish12h" BOOLEAN NOT NULL DEFAULT false,
  "bearish1d" BOOLEAN NOT NULL DEFAULT false,
  "bearishCount" INTEGER NOT NULL DEFAULT 0,
  "score" DOUBLE PRECISION NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "details" JSONB NOT NULL,
  "lastCheckedAt" TIMESTAMP(3),
  "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ScannerTokenState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScannerTokenState_symbol_market_key" ON "ScannerTokenState"("symbol", "market");
CREATE INDEX "ScannerTokenState_market_nextCheckAt_idx" ON "ScannerTokenState"("market", "nextCheckAt");
CREATE INDEX "ScannerTokenState_market_setupDirection_burstReady_bearishCount_idx" ON "ScannerTokenState"("market", "setupDirection", "burstReady", "bearishCount");
