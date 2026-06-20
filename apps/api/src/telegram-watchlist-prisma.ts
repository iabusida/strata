import { PrismaClient } from "@prisma/client";
import { prisma as sharedPrisma } from "./prisma-client.js";

let prismaClient: PrismaClient | null = null;

function getPrismaClient(): PrismaClient {
  if (prismaClient) {
    return prismaClient;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required for Telegram watchlist persistence");
  }

  prismaClient = sharedPrisma;
  return prismaClient;
}

export async function addWatchSymbol(chatId: number, symbol: string): Promise<boolean> {
  const prisma = getPrismaClient();

  await prisma.telegramWatchlistEntry.upsert({
    where: {
      chatId_symbol: {
        chatId: BigInt(chatId),
        symbol
      }
    },
    create: {
      chatId: BigInt(chatId),
      symbol
    },
    update: {}
  });

  return true;
}

export async function removeWatchSymbol(chatId: number, symbol: string): Promise<boolean> {
  const prisma = getPrismaClient();

  const result = await prisma.telegramWatchlistEntry.deleteMany({
    where: {
      chatId: BigInt(chatId),
      symbol
    }
  });

  return result.count > 0;
}

export async function listWatchSymbols(chatId: number): Promise<string[]> {
  const prisma = getPrismaClient();

  const rows = await prisma.telegramWatchlistEntry.findMany({
    where: {
      chatId: BigInt(chatId)
    },
    orderBy: [
      {
        symbol: "asc"
      }
    ],
    select: {
      symbol: true
    }
  });

  return rows.map((row) => row.symbol);
}
