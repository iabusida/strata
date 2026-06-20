import { Prisma, PrismaClient } from "@prisma/client";
import { prisma as sharedPrisma } from "./prisma-client.js";

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
  tenantId?: string;
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
  tenantId: string;
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
  universeCursor?: number;
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
let pendingSimulationState: PersistableState | null = null;
let simulationStateFlushPromise: Promise<void> | null = null;
const DEFAULT_TRADE_TENANT_ID = (process.env.TRADING_TENANT_ID ?? "default").trim() || "default";

function normalizeTenantId(value?: string | null): string {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : DEFAULT_TRADE_TENANT_ID;
}

function getPrismaClient(): PrismaClient {
  if (prismaClient) {
    return prismaClient;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required for PostgreSQL simulation state persistence");
  }

  prismaClient = sharedPrisma;
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

export function scheduleSimulationStatePersist(state: PersistableState): void {
  pendingSimulationState = JSON.parse(JSON.stringify(state)) as PersistableState;

  if (simulationStateFlushPromise) {
    return;
  }

  simulationStateFlushPromise = (async () => {
    while (pendingSimulationState) {
      const nextState = pendingSimulationState;
      pendingSimulationState = null;

      try {
        await persistSimulationState(nextState);
      } catch (error) {
        console.error("[simulation-store] Failed to persist scan snapshot:", error);
      }
    }

    simulationStateFlushPromise = null;

    if (pendingSimulationState) {
      scheduleSimulationStatePersist(pendingSimulationState);
    }
  })();
}

export async function persistTradeRuntimeState(tenantId: string, state: PersistRuntimeStateInput): Promise<void> {
  const prisma = getPrismaClient();
  const resolvedTenantId = normalizeTenantId(tenantId);

  await prisma.tradeRuntimeState.upsert({
    where: { tenantId: resolvedTenantId },
    create: {
      tenantId: resolvedTenantId,
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

function mapLoadedRuntimeState(row: {
  tenantId: string;
  accountBalanceUsd: number;
  dailyStartBalanceUsd: number;
  openTrades: Prisma.JsonValue;
  recentClosedTrades: Prisma.JsonValue;
  metrics: Prisma.JsonValue;
}): LoadedRuntimeState {
  const openTrades = Array.isArray(row.openTrades) ? row.openTrades as PersistedRuntimeTrade[] : [];
  const recentClosedTrades = Array.isArray(row.recentClosedTrades) ? row.recentClosedTrades as PersistedRuntimeTrade[] : [];
  const metricsObj = row.metrics as Record<string, unknown>;

  return {
    tenantId: normalizeTenantId(row.tenantId),
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

export async function loadTradeRuntimeState(tenantId: string): Promise<LoadedRuntimeState | null> {
  const prisma = getPrismaClient();
  const row = await prisma.tradeRuntimeState.findUnique({
    where: { tenantId: normalizeTenantId(tenantId) }
  });

  if (!row) {
    return null;
  }

  return mapLoadedRuntimeState(row);
}

export async function loadAllTradeRuntimeStates(): Promise<LoadedRuntimeState[]> {
  const prisma = getPrismaClient();
  const rows = await prisma.tradeRuntimeState.findMany({
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }]
  });

  return rows.map((row) => mapLoadedRuntimeState(row));
}

export async function loadLatestScanPayload<T = unknown>(): Promise<T | null> {
  const prisma = getPrismaClient();
  const row = await prisma.scanState.findUnique({ where: { id: 1 } });

  if (!row) {
    return null;
  }

  return row.payload as T;
}
