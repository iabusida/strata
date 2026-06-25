/*
  Warnings:

  - A unique constraint covering the columns `[dedupeKey,stage,alertChannel]` on the table `TelegramAlertEvent` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "Account" DROP CONSTRAINT "Account_userId_fkey";

-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_userId_fkey";

-- DropIndex
DROP INDEX "TelegramAlertEvent_dedupeKey_stage_key";

-- AlterTable
ALTER TABLE "TelegramAlertEvent" ADD COLUMN     "alertChannel" TEXT NOT NULL DEFAULT 'PUBLIC',
ADD COLUMN     "recipientUserId" TEXT;

-- CreateTable
CREATE TABLE "TelegramUser" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "telegramChatId" BIGINT NOT NULL,
    "telegramUsername" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramUserWatchlist" (
    "id" TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "assetType" TEXT NOT NULL DEFAULT 'CRYPTO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramUserWatchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramUserPreferences" (
    "id" TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "alertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertFrequency" TEXT NOT NULL DEFAULT 'SWING',
    "muteUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramUserPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramUser_userId_key" ON "TelegramUser"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramUser_telegramUserId_key" ON "TelegramUser"("telegramUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramUser_telegramChatId_key" ON "TelegramUser"("telegramChatId");

-- CreateIndex
CREATE INDEX "TelegramUser_telegramUserId_idx" ON "TelegramUser"("telegramUserId");

-- CreateIndex
CREATE INDEX "TelegramUser_isActive_idx" ON "TelegramUser"("isActive");

-- CreateIndex
CREATE INDEX "TelegramUserWatchlist_telegramUserId_idx" ON "TelegramUserWatchlist"("telegramUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramUserWatchlist_telegramUserId_symbol_key" ON "TelegramUserWatchlist"("telegramUserId", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramUserPreferences_telegramUserId_key" ON "TelegramUserPreferences"("telegramUserId");

-- CreateIndex
CREATE INDEX "TelegramAlertEvent_alertChannel_sentAt_idx" ON "TelegramAlertEvent"("alertChannel", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "TelegramAlertEvent_recipientUserId_sentAt_idx" ON "TelegramAlertEvent"("recipientUserId", "sentAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramAlertEvent_dedupeKey_stage_alertChannel_key" ON "TelegramAlertEvent"("dedupeKey", "stage", "alertChannel");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramUser" ADD CONSTRAINT "TelegramUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramUserWatchlist" ADD CONSTRAINT "TelegramUserWatchlist_telegramUserId_fkey" FOREIGN KEY ("telegramUserId") REFERENCES "TelegramUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramUserPreferences" ADD CONSTRAINT "TelegramUserPreferences_telegramUserId_fkey" FOREIGN KEY ("telegramUserId") REFERENCES "TelegramUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
