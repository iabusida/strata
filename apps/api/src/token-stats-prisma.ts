import { PrismaClient, TokenVolatilityRegime } from "@prisma/client";

type VolatilityRegime = "LOW" | "MEDIUM" | "HIGH";

export type PersistedTokenTrade = {
  symbol: string;
  pnlPct: number;
  hitTP: boolean;
  hitSL: boolean;
  maxDrawdownPct: number;
  durationCandles: number;
  regime: VolatilityRegime;
  closedAt: Date;
};

let prismaClient: PrismaClient | null = null;

function getPrismaClient(): PrismaClient {
  if (prismaClient) {
    return prismaClient;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required for token stats persistence");
  }

  prismaClient = new PrismaClient();
  return prismaClient;
}

function toPrismaRegime(regime: VolatilityRegime): TokenVolatilityRegime {
  if (regime === "LOW") {
    return TokenVolatilityRegime.LOW;
  }
  if (regime === "HIGH") {
    return TokenVolatilityRegime.HIGH;
  }
  return TokenVolatilityRegime.MEDIUM;
}

function fromPrismaRegime(regime: TokenVolatilityRegime): VolatilityRegime {
  if (regime === TokenVolatilityRegime.LOW) {
    return "LOW";
  }
  if (regime === TokenVolatilityRegime.HIGH) {
    return "HIGH";
  }
  return "MEDIUM";
}

export async function appendTokenTrade(trade: PersistedTokenTrade): Promise<void> {
  const prisma = getPrismaClient();

  await prisma.tokenTrade.create({
    data: {
      symbol: trade.symbol,
      pnlPct: trade.pnlPct,
      hitTP: trade.hitTP,
      hitSL: trade.hitSL,
      maxDrawdownPct: trade.maxDrawdownPct,
      durationCandles: trade.durationCandles,
      regime: toPrismaRegime(trade.regime),
      closedAt: trade.closedAt
    }
  });
}

export async function loadRecentTokenTrades(limit: number = 5000): Promise<PersistedTokenTrade[]> {
  const prisma = getPrismaClient();

  const rows = await prisma.tokenTrade.findMany({
    orderBy: { closedAt: "desc" },
    take: limit
  });

  return rows.map((row) => ({
    symbol: row.symbol,
    pnlPct: row.pnlPct,
    hitTP: row.hitTP,
    hitSL: row.hitSL,
    maxDrawdownPct: row.maxDrawdownPct,
    durationCandles: row.durationCandles,
    regime: fromPrismaRegime(row.regime),
    closedAt: row.closedAt
  }));
}
