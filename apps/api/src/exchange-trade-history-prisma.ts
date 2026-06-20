import { Prisma, PrismaClient } from "@prisma/client";
import type { BitunixClosedTradeHistoryItem } from "./bitunix-service.js";
import { prisma as sharedPrisma } from "./prisma-client.js";

type ExchangeProvider = "BITUNIX";

let prismaSingleton: PrismaClient | null = null;

function prisma(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = sharedPrisma;
  }
  return prismaSingleton;
}

function toInputJsonValue(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function upsertExchangeTradeHistory(
  provider: ExchangeProvider,
  rows: BitunixClosedTradeHistoryItem[]
): Promise<{ insertedOrUpdated: number }> {
  if (!rows.length) {
    return { insertedOrUpdated: 0 };
  }

  let insertedOrUpdated = 0;

  for (const row of rows) {
    await prisma().exchangeTradeHistory.upsert({
      where: { dedupeKey: row.dedupeKey },
      create: {
        provider,
        dedupeKey: row.dedupeKey,
        exchangeTradeId: row.exchangeTradeId,
        symbol: row.symbol,
        direction: row.direction,
        marginCoin: row.marginCoin,
        status: row.status,
        openedAt: row.openedAt ? new Date(row.openedAt) : null,
        closedAt: new Date(row.closedAt),
        entryPrice: row.entryPrice,
        closePrice: row.closePrice,
        leverage: row.leverage,
        qty: row.qty,
        realizedPnlUsd: row.realizedPnlUsd,
        roiPct: row.roiPct,
        rawPayload: toInputJsonValue(row.rawPayload),
        syncedAt: new Date()
      },
      update: {
        exchangeTradeId: row.exchangeTradeId,
        symbol: row.symbol,
        direction: row.direction,
        marginCoin: row.marginCoin,
        status: row.status,
        openedAt: row.openedAt ? new Date(row.openedAt) : null,
        closedAt: new Date(row.closedAt),
        entryPrice: row.entryPrice,
        closePrice: row.closePrice,
        leverage: row.leverage,
        qty: row.qty,
        realizedPnlUsd: row.realizedPnlUsd,
        roiPct: row.roiPct,
        rawPayload: toInputJsonValue(row.rawPayload),
        syncedAt: new Date()
      }
    });
    insertedOrUpdated += 1;
  }

  return { insertedOrUpdated };
}

export async function listExchangeTradeHistory(input: {
  provider?: ExchangeProvider;
  symbol?: string;
  limit?: number;
}): Promise<Array<{
  id: string;
  provider: string;
  dedupeKey: string;
  exchangeTradeId: string | null;
  symbol: string;
  direction: string;
  marginCoin: string | null;
  status: string;
  openedAt: string | null;
  closedAt: string;
  entryPrice: number | null;
  closePrice: number | null;
  leverage: number | null;
  qty: number | null;
  realizedPnlUsd: number | null;
  roiPct: number | null;
  syncedAt: string;
}>> {
  const provider = input.provider ?? "BITUNIX";
  const symbol = input.symbol?.trim().toUpperCase();
  const limit = Number.isFinite(Number(input.limit))
    ? Math.min(500, Math.max(1, Math.trunc(Number(input.limit))))
    : 100;

  const rows = await prisma().exchangeTradeHistory.findMany({
    where: {
      provider,
      ...(symbol ? { symbol: { contains: symbol, mode: "insensitive" } } : {})
    },
    orderBy: { closedAt: "desc" },
    take: limit
  });

  return rows.map((row) => ({
    id: String(row.id),
    provider: row.provider,
    dedupeKey: row.dedupeKey,
    exchangeTradeId: row.exchangeTradeId,
    symbol: row.symbol,
    direction: row.direction,
    marginCoin: row.marginCoin,
    status: row.status,
    openedAt: row.openedAt ? row.openedAt.toISOString() : null,
    closedAt: row.closedAt.toISOString(),
    entryPrice: row.entryPrice,
    closePrice: row.closePrice,
    leverage: row.leverage,
    qty: row.qty,
    realizedPnlUsd: row.realizedPnlUsd,
    roiPct: row.roiPct,
    syncedAt: row.syncedAt.toISOString()
  }));
}
