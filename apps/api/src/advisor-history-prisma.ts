import { PrismaClient } from "@prisma/client";
import { prisma as sharedPrisma } from "./prisma-client.js";
import type { TradeAdvicePayload } from "./trade-advice-agent.js";

export type AdvisorChannel = "WEB" | "TELEGRAM";

export type AdvisorHistoryWriteInput = {
  userId?: string | null;
  telegramChatId?: bigint | null;
  telegramUserId?: bigint | null;
  channel: AdvisorChannel;
  prompt: string;
  reply: string;
  advice: TradeAdvicePayload;
};

export type AdvisorHistoryRow = {
  id: string;
  userId: string | null;
  telegramChatId: string | null;
  channel: AdvisorChannel;
  prompt: string;
  reply: string;
  symbol: string | null;
  side: string | null;
  market: string | null;
  action: string | null;
  confidence: number | null;
  createdAt: string;
};

let prismaClient: PrismaClient | null = null;

function prisma(): PrismaClient {
  if (!prismaClient) {
    prismaClient = sharedPrisma;
  }
  return prismaClient;
}

function toRow(record: any): AdvisorHistoryRow {
  return {
    id: String(record.id),
    userId: record.userId ? String(record.userId) : null,
    telegramChatId: record.telegramChatId != null ? String(record.telegramChatId) : null,
    channel: String(record.channel ?? "WEB") as AdvisorChannel,
    prompt: String(record.prompt ?? ""),
    reply: String(record.reply ?? ""),
    symbol: record.symbol ? String(record.symbol) : null,
    side: record.side ? String(record.side) : null,
    market: record.market ? String(record.market) : null,
    action: record.action ? String(record.action) : null,
    confidence: Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : null,
    createdAt: new Date(record.createdAt).toISOString()
  };
}

function advisorTurnDelegate(): any {
  return (prisma() as any).advisorTurn;
}

export async function saveAdvisorTurn(input: AdvisorHistoryWriteInput): Promise<AdvisorHistoryRow | null> {
  try {
    const created = await advisorTurnDelegate().create({
      data: {
        userId: input.userId ?? null,
        telegramChatId: input.telegramChatId ?? null,
        telegramUserId: input.telegramUserId ?? null,
        channel: input.channel,
        prompt: input.prompt,
        reply: input.reply,
        symbol: input.advice.symbol,
        side: input.advice.side,
        market: input.advice.market,
        action: input.advice.action,
        confidence: input.advice.confidence,
        analyzedAt: new Date(input.advice.analyzedAt),
        advice: input.advice
      }
    });
    return toRow(created);
  } catch (error) {
    console.warn("[advisor-history] failed to save advisor turn", {
      channel: input.channel,
      userId: input.userId ?? null,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

export async function listAdvisorTurnsForUser(userId: string, limit: number): Promise<AdvisorHistoryRow[]> {
  const rows = await advisorTurnDelegate().findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit
  });
  return Array.isArray(rows) ? rows.map(toRow) : [];
}

export async function listAdvisorTurnsForTelegramChat(chatId: bigint, limit: number): Promise<AdvisorHistoryRow[]> {
  const rows = await advisorTurnDelegate().findMany({
    where: { telegramChatId: chatId },
    orderBy: { createdAt: "desc" },
    take: limit
  });
  return Array.isArray(rows) ? rows.map(toRow) : [];
}
