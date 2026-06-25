import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

/**
 * Link a Telegram user to their profile account.
 * Called when user initiates /link command or OAuth flow.
 */
export async function linkTelegramUser(
  userId: string,
  telegramUserId: bigint,
  telegramChatId: bigint,
  telegramUsername?: string
): Promise<{ id: string; linkedAt: Date }> {
  const db = getPrisma();

  return db.telegramUser.create({
    data: {
      userId,
      telegramUserId,
      telegramChatId,
      telegramUsername,
      isActive: true,
    },
    select: { id: true, linkedAt: true },
  });
}

/**
 * Get Telegram user by Telegram user ID (from message metadata).
 */
export async function getTelegramUserByTelegramId(
  telegramUserId: bigint
): Promise<{
  id: string;
  userId: string;
  telegramUserId: bigint;
  telegramChatId: bigint;
  isActive: boolean;
} | null> {
  const db = getPrisma();

  return db.telegramUser.findUnique({
    where: { telegramUserId },
    select: {
      id: true,
      userId: true,
      telegramUserId: true,
      telegramChatId: true,
      isActive: true,
    },
  });
}

/**
 * Get Telegram user by linked User ID.
 */
export async function getTelegramUserByUserId(
  userId: string
): Promise<{
  id: string;
  telegramChatId: bigint;
  telegramUsername: string | null;
  isActive: boolean;
} | null> {
  const db = getPrisma();

  return db.telegramUser.findUnique({
    where: { userId },
    select: {
      id: true,
      telegramChatId: true,
      telegramUsername: true,
      isActive: true,
    },
  });
}

/**
 * Add a symbol to user's personal watchlist.
 */
export async function addToWatchlist(
  telegramUserId: string,
  symbol: string,
  assetType: "CRYPTO" | "STOCK" = "CRYPTO"
): Promise<void> {
  const db = getPrisma();

  await db.telegramUserWatchlist.upsert({
    where: { telegramUserId_symbol: { telegramUserId, symbol } },
    update: {},
    create: { telegramUserId, symbol, assetType },
  });
}

/**
 * Remove a symbol from user's watchlist.
 */
export async function removeFromWatchlist(
  telegramUserId: string,
  symbol: string
): Promise<void> {
  const db = getPrisma();

  await db.telegramUserWatchlist.deleteMany({
    where: { telegramUserId, symbol },
  });
}

/**
 * Get user's watchlist.
 */
export async function getWatchlist(
  telegramUserId: string
): Promise<Array<{ symbol: string; assetType: string }>> {
  const db = getPrisma();

  const items = await db.telegramUserWatchlist.findMany({
    where: { telegramUserId },
    select: { symbol: true, assetType: true },
    orderBy: { createdAt: "desc" },
  });

  return items;
}

/**
 * Get all active linked users (for broadcasting public alerts).
 */
export async function getAllLinkedUsers(): Promise<
  Array<{
    id: string;
    telegramChatId: bigint;
    watchlist: Array<{ symbol: string }>;
  }>
> {
  const db = getPrisma();

  return db.telegramUser.findMany({
    where: { isActive: true },
    select: {
      id: true,
      telegramChatId: true,
      watchlist: {
        select: { symbol: true },
      },
    },
  });
}

/**
 * Get users interested in a specific symbol (for personal alerts).
 */
export async function getUsersWatchingSymbol(
  symbol: string
): Promise<
  Array<{
    id: string;
    telegramChatId: bigint;
    telegramUsername: string | null;
  }>
> {
  const db = getPrisma();

  const results = await db.telegramUserWatchlist.findMany({
    where: { symbol },
    select: {
      telegramUser: {
        select: {
          id: true,
          telegramChatId: true,
          telegramUsername: true,
        },
      },
    },
  });

  return results.map((r) => r.telegramUser);
}

/**
 * Get user preferences.
 */
export async function getUserPreferences(
  telegramUserId: string
): Promise<{
  alertsEnabled: boolean;
  alertFrequency: string;
  muteUntil: Date | null;
} | null> {
  const db = getPrisma();

  return db.telegramUserPreferences.findUnique({
    where: { telegramUserId },
    select: {
      alertsEnabled: true,
      alertFrequency: true,
      muteUntil: true,
    },
  });
}

/**
 * Update user preferences.
 */
export async function updateUserPreferences(
  telegramUserId: string,
  updates: {
    alertsEnabled?: boolean;
    alertFrequency?: "SCALP" | "SWING" | "LONGTERM";
    muteUntil?: Date | null;
  }
): Promise<void> {
  const db = getPrisma();

  await db.telegramUserPreferences.upsert({
    where: { telegramUserId },
    update: updates,
    create: {
      telegramUserId,
      ...updates,
    },
  });
}

/**
 * Unlink a Telegram user (soft delete).
 */
export async function unlinkTelegramUser(telegramUserId: bigint): Promise<void> {
  const db = getPrisma();

  await db.telegramUser.update({
    where: { telegramUserId },
    data: { isActive: false },
  });
}
