-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PARTIAL', 'FILLED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED', 'CLOSING');

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "assetType" "AssetType" NOT NULL,
    "side" "OrderSide" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "currentPrice" DOUBLE PRECISION NOT NULL,
    "pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pnlPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "brokerAccount" TEXT,
    "brokerPositionId" TEXT,
    "entryAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closePrice" DOUBLE PRECISION,
    "realizedPnl" DOUBLE PRECISION,
    "stopLoss" DOUBLE PRECISION,
    "takeProfit" DOUBLE PRECISION,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "positionId" TEXT,
    "symbol" TEXT NOT NULL,
    "assetType" "AssetType" NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION,
    "filledQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "filledPrice" DOUBLE PRECISION,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "broker" TEXT NOT NULL,
    "brokerOrderId" TEXT,
    "brokerAccount" TEXT,
    "clientOrderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "metadata" JSONB,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Position_userId_status_idx" ON "Position"("userId", "status");

-- CreateIndex
CREATE INDEX "Position_userId_symbol_assetType_idx" ON "Position"("userId", "symbol", "assetType");

-- CreateIndex
CREATE INDEX "Position_status_updatedAt_idx" ON "Position"("status", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Position_userId_symbol_assetType_side_status_key" ON "Position"("userId", "symbol", "assetType", "side", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_clientOrderId_key" ON "Order"("clientOrderId");

-- CreateIndex
CREATE INDEX "Order_userId_status_idx" ON "Order"("userId", "status");

-- CreateIndex
CREATE INDEX "Order_symbol_status_idx" ON "Order"("symbol", "status");

-- CreateIndex
CREATE INDEX "Order_broker_brokerOrderId_idx" ON "Order"("broker", "brokerOrderId");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;
