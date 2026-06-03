import { Prisma, PrismaClient } from "@prisma/client";

type TradeSummary = {
  id: string;
  token: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  status: "OPEN" | "WIN" | "LOSS";
  openTime: string;
  closeTime?: string;
  result?: number;
  maxDrawdown?: number;
  timeToClose?: number;
};

type PersistedRuntimeTrade = {
  id: string;
  token: string;
  direction: "LONG" | "SHORT";
  signalType: string;
  signalCategory: "STRONG" | "CONTINUATION" | "REVERSAL" | "SCORE_BASED";
  entryType: "STRONG" | "CONTINUATION" | "REVERSAL" | "SCORE_BASED";
  entryScore: number;
  riskPctUsed: number;
  volatilityPct: number;
  volume24h: number;
  passedVolatility: boolean;
  passedLiquidity: boolean;
  assetType: "LARGE_CAP" | "ALT";
  regime: "TRENDING" | "CHOPPY" | "EXPANSION" | "LOW_VOL";
  cluster: "L1" | "L2" | "DEFI" | "OTHER";
  takeProfitPct: number;
  stopLossPct: number;
  atr: number;
  tpDistance: number;
  slDistance: number;
  expectedValue: number;
  slippageEstimate: number;
  effectiveEntryPrice?: number;
  marketCondition: "TRENDING" | "RANGING";
  stakeUsd: number;
  entryPrice: number;
  currentPrice: number;
  tpPrice: number;
  slPrice: number;
  leverage: number;
  status: "OPEN" | "WIN" | "LOSS";
  openTime: string;
  closeTime?: string;
  result?: number;
  resultUsd?: number;
  openFeeUsd?: number;
  closeFeeUsd?: number;
  currentPnlPct: number;
  currentPnlUsd: number;
  positionValueUsd: number;
  distanceToTP: number;
  distanceToSL: number;
  maxDrawdown?: number;
  timeToClose?: number;
  entryContextJson?: string;
  closeContextJson?: string;
  closeReason?: string;
  isLiveTrade?: boolean;
  liveOrderId?: string;
  liveClientId?: string;
  livePositionId?: string;
};

type PersistRuntimeStateInput = {
  accountBalanceUsd: number;
  dailyStartBalanceUsd: number;
  openTrades: PersistedRuntimeTrade[];
  recentClosedTrades: PersistedRuntimeTrade[];
  metrics: {
    totalTrades: number;
    winRate: number;
    totalPnlUsd: number;
    totalPnlPct: number;
    maxDrawdown: number;
  };
};

type LoadedRuntimeState = {
  accountBalanceUsd: number;
  dailyStartBalanceUsd: number;
  openTrades: PersistedRuntimeTrade[];
  recentClosedTrades: PersistedRuntimeTrade[];
  metrics: {
    totalTrades: number;
    winRate: number;
    totalPnlUsd: number;
    totalPnlPct: number;
    maxDrawdown: number;
    lastUpdated: string;
  } | null;
};

type PersistableState = {
  analyzedAt: string;
  params: {
    query?: string;
    market: "perp" | "spot";
    limitTokens: number;
  };
  meta?: {
    onlySignals: boolean;
    filteredOutNoSignal: number;
  };
  signalCounts: {
    strongShort: number;
    strongLong: number;
    noSignal: number;
  };
  results: Array<unknown>;
  skipped: Array<unknown>;
  tradeSimulation?: {
    stats: {
      totalTrades: number;
      activeTrades: number;
      wins: number;
      losses: number;
      winRate: number;
      avgMinutesToWin: number;
      avgMinutesToLoss: number;
      totalSimulatedPnl: number;
    };
    recentClosedTrades: TradeSummary[];
  };
};

let prismaClient: PrismaClient | null = null;

function getPrismaClient(): PrismaClient {
  if (prismaClient) {
    return prismaClient;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required for PostgreSQL simulation state persistence");
  }

  prismaClient = new PrismaClient();
  return prismaClient;
}

export function getSimulationStorageBackend(): string {
  return "PostgreSQL (Prisma)";
}

export async function persistSimulationState(state: PersistableState): Promise<void> {
  const prisma = getPrismaClient();

  const payload = JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue;

  await prisma.scanState.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      payload,
      analyzedAt: new Date(state.analyzedAt)
    },
    update: {
      payload,
      analyzedAt: new Date(state.analyzedAt)
    }
  });
}

export async function persistTradeRuntimeState(state: PersistRuntimeStateInput): Promise<void> {
  const prisma = getPrismaClient();

  await prisma.tradeRuntimeState.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      accountBalanceUsd: state.accountBalanceUsd,
      dailyStartBalanceUsd: state.dailyStartBalanceUsd,
      openTrades: state.openTrades,
      recentClosedTrades: state.recentClosedTrades,
      metrics: {
        ...state.metrics,
        lastUpdated: new Date().toISOString()
      }
    },
    update: {
      accountBalanceUsd: state.accountBalanceUsd,
      dailyStartBalanceUsd: state.dailyStartBalanceUsd,
      openTrades: state.openTrades,
      recentClosedTrades: state.recentClosedTrades,
      metrics: {
        ...state.metrics,
        lastUpdated: new Date().toISOString()
      }
    }
  });
}

export async function loadTradeRuntimeState(): Promise<LoadedRuntimeState | null> {
  const prisma = getPrismaClient();
  const row = await prisma.tradeRuntimeState.findUnique({ where: { id: 1 } });

  if (!row) {
    return null;
  }

  const openTrades = Array.isArray(row.openTrades) ? row.openTrades as PersistedRuntimeTrade[] : [];
  const recentClosedTrades = Array.isArray(row.recentClosedTrades) ? row.recentClosedTrades as PersistedRuntimeTrade[] : [];
  const metricsObj = row.metrics as Record<string, unknown>;

  return {
    accountBalanceUsd: row.accountBalanceUsd,
    dailyStartBalanceUsd: row.dailyStartBalanceUsd,
    openTrades,
    recentClosedTrades,
    metrics: {
      totalTrades: Number(metricsObj.totalTrades ?? 0),
      winRate: Number(metricsObj.winRate ?? 0),
      totalPnlUsd: Number(metricsObj.totalPnlUsd ?? 0),
      totalPnlPct: Number(metricsObj.totalPnlPct ?? 0),
      maxDrawdown: Number(metricsObj.maxDrawdown ?? 0),
      lastUpdated: String(metricsObj.lastUpdated ?? new Date().toISOString())
    }
  };
}

export async function loadLatestScanPayload<T = unknown>(): Promise<T | null> {
  const prisma = getPrismaClient();
  const row = await prisma.scanState.findUnique({ where: { id: 1 } });

  if (!row) {
    return null;
  }

  return row.payload as T;
}
