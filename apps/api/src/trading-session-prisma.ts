import { PrismaClient, SessionTradeStatus, TradingSessionStatus } from "@prisma/client";
import { prisma as sharedPrisma } from "./prisma-client.js";

type EnsureSessionInput = {
  startingBalanceUsd: number;
  currentBalanceUsd: number;
  leverage: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxConcurrentTrades: number;
};

type SessionOpportunityInput = {
  symbol: string;
  direction: "LONG" | "SHORT";
  signalType: string;
  entryScore: number;
  weightedScore: number;
  takeProfitPct: number;
  stopLossPct: number;
  volatilityPct: number;
  marketCondition: "TRENDING" | "RANGING";
  availableForEntry: boolean;
  reason: string;
};

type RecentOpportunityQuery = {
  symbol: string;
  direction: "LONG" | "SHORT";
  signalType: string;
  withinMinutes: number;
  reason?: string;
};

type SessionTradeOpenedInput = {
  externalTradeId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  signalType: string;
  entryScore: number;
  weightedScore: number;
  takeProfitPct: number;
  stopLossPct: number;
  stakeUsd: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  leverage: number;
  openedAt: string;
};

type SessionTradeClosedInput = {
  externalTradeId: string;
  status: "WIN" | "LOSS";
  closedAt: string;
  resultPct: number;
  resultUsd: number;
  closeReason: string;
};

let prismaClient: PrismaClient | null = null;
let activeSessionId: bigint | null = null;

function getPrismaClient(): PrismaClient {
  if (prismaClient) {
    return prismaClient;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required for trading session persistence");
  }

  prismaClient = sharedPrisma;
  return prismaClient;
}

export async function ensureActiveTradingSession(input: EnsureSessionInput): Promise<bigint> {
  const prisma = getPrismaClient();

  if (activeSessionId != null) {
    return activeSessionId;
  }

  const existing = await prisma.tradingSession.findFirst({
    where: { status: TradingSessionStatus.OPEN },
    orderBy: { startedAt: "desc" },
    select: { id: true }
  });

  if (existing) {
    activeSessionId = existing.id;
    return existing.id;
  }

  const created = await prisma.tradingSession.create({
    data: {
      status: TradingSessionStatus.OPEN,
      startingBalanceUsd: input.startingBalanceUsd,
      currentBalanceUsd: input.currentBalanceUsd,
      leverage: input.leverage,
      takeProfitPct: input.takeProfitPct,
      stopLossPct: input.stopLossPct,
      maxConcurrentTrades: input.maxConcurrentTrades
    },
    select: { id: true }
  });

  activeSessionId = created.id;
  return created.id;
}

export async function updateActiveSessionBalance(currentBalanceUsd: number, maxConcurrentTrades: number): Promise<void> {
  if (activeSessionId == null) {
    throw new Error("No active trading session. Call ensureActiveTradingSession first.");
  }

  const prisma = getPrismaClient();
  await prisma.tradingSession.update({
    where: { id: activeSessionId },
    data: {
      currentBalanceUsd,
      maxConcurrentTrades
    }
  });
}

export async function appendSessionOpportunity(input: SessionOpportunityInput): Promise<void> {
  if (activeSessionId == null) {
    throw new Error("No active trading session. Call ensureActiveTradingSession first.");
  }

  const prisma = getPrismaClient();
  await prisma.sessionOpportunity.create({
    data: {
      sessionId: activeSessionId,
      symbol: input.symbol,
      direction: input.direction,
      signalType: input.signalType,
      entryScore: input.entryScore,
      weightedScore: input.weightedScore,
      takeProfitPct: input.takeProfitPct,
      stopLossPct: input.stopLossPct,
      volatilityPct: input.volatilityPct,
      marketCondition: input.marketCondition,
      availableForEntry: input.availableForEntry,
      reason: input.reason
    }
  });
}

export async function hasRecentSessionOpportunity(input: RecentOpportunityQuery): Promise<boolean> {
  if (activeSessionId == null) {
    return false;
  }

  const prisma = getPrismaClient();
  const since = new Date(Date.now() - Math.max(1, Math.trunc(input.withinMinutes)) * 60 * 1000);

  const recent = await prisma.sessionOpportunity.findFirst({
    where: {
      sessionId: activeSessionId,
      symbol: input.symbol,
      direction: input.direction,
      signalType: input.signalType,
      reason: input.reason,
      createdAt: {
        gte: since
      }
    },
    select: {
      id: true
    },
    orderBy: {
      createdAt: "desc"
    }
  });

  return recent != null;
}

export async function appendSessionTradeOpened(input: SessionTradeOpenedInput): Promise<void> {
  if (activeSessionId == null) {
    throw new Error("No active trading session. Call ensureActiveTradingSession first.");
  }

  const prisma = getPrismaClient();
  await prisma.sessionTrade.create({
    data: {
      sessionId: activeSessionId,
      externalTradeId: input.externalTradeId,
      symbol: input.symbol,
      direction: input.direction,
      signalType: input.signalType,
      entryScore: input.entryScore,
      weightedScore: input.weightedScore,
      takeProfitPct: input.takeProfitPct,
      stopLossPct: input.stopLossPct,
      stakeUsd: input.stakeUsd,
      entryPrice: input.entryPrice,
      tpPrice: input.tpPrice,
      slPrice: input.slPrice,
      leverage: input.leverage,
      status: SessionTradeStatus.OPEN,
      openedAt: new Date(input.openedAt)
    }
  });
}

export async function markSessionTradeClosed(input: SessionTradeClosedInput): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.sessionTrade.updateMany({
    where: { externalTradeId: input.externalTradeId },
    data: {
      status: input.status === "WIN" ? SessionTradeStatus.WIN : SessionTradeStatus.LOSS,
      closedAt: new Date(input.closedAt),
      resultPct: input.resultPct,
      resultUsd: input.resultUsd,
      closeReason: input.closeReason
    }
  });
}
