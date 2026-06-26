-- CreateTable
CREATE TABLE "AdvisorTurn" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "telegramChatId" BIGINT,
    "telegramUserId" BIGINT,
    "channel" TEXT NOT NULL DEFAULT 'WEB',
    "prompt" TEXT NOT NULL,
    "reply" TEXT NOT NULL,
    "symbol" TEXT,
    "side" TEXT,
    "market" TEXT,
    "action" TEXT,
    "confidence" INTEGER,
    "analyzedAt" TIMESTAMP(3),
    "advice" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvisorTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdvisorTurn_userId_createdAt_idx" ON "AdvisorTurn"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdvisorTurn_telegramChatId_createdAt_idx" ON "AdvisorTurn"("telegramChatId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdvisorTurn_symbol_createdAt_idx" ON "AdvisorTurn"("symbol", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AdvisorTurn" ADD CONSTRAINT "AdvisorTurn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
