import "./env.js";
import { PrismaClient } from "@prisma/client";
import { scanRsi, type ScanResult, fetchPerpContexts, searchTokens, MARKET_DATA_PROVIDER } from "./market-data-service.js";
import { loadLatestScanPayload, persistSimulationState } from "./simulation-store.js";
import { getTradeSimulationSnapshot, processTradeSimulation, refreshTradeSimulation } from "./trade-engine.js";
import { getBackfillBatch, checkBackfillNeed } from "./scan-backfill-integration.js";

type SignalCounts = {
  strongShort: number;
  strongLong: number;
  continuationShort: number;
  continuationLong: number;
  reversalShort: number;
  reversalLong: number;
  noSignal: number;
};

type ResultRow = ScanResult["results"][number];

type ServiceState = ScanResult & {
  meta: {
    onlySignals: boolean;
    filteredOutNoSignal: number;
  };
  signalCounts: SignalCounts;
  tradeSimulation: Awaited<ReturnType<typeof processTradeSimulation>>;
  service: {
    mode: "background";
    startedAt: string;
    lastSignalScanAt: string;
    lastTradeRefreshAt: string;
    signalIntervalMs: number;
    tradeIntervalMs: number;
    universeSize: number;
    chunkSize: number;
    chunkIndex: number;
  };
};

const SIGNAL_INTERVAL_MS = 300_000;
const TRADE_INTERVAL_MS = 60_000;

function resolveNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env ${name}: ${raw}`);
  }

  return parsed;
}

function resolveSymbolSetEnv(name: string): Set<string> {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter((item) => item.length > 0)
  );
}

const DEFAULT_SCAN_ROTATION_CHUNK_SIZE = MARKET_DATA_PROVIDER === "OKX" ? 8 : 30;
const SCAN_ROTATION_CHUNK_SIZE = Math.max(5, Math.trunc(resolveNumberEnv("SCAN_ROTATION_CHUNK_SIZE", DEFAULT_SCAN_ROTATION_CHUNK_SIZE)));
const SIGNAL_SNAPSHOT_TTL_MS = Math.max(300_000, Math.trunc(resolveNumberEnv("SIGNAL_SNAPSHOT_TTL_MS", 21_600_000)));
const SCAN_ALLOW_SYMBOLS = resolveSymbolSetEnv("SCAN_ALLOW_SYMBOLS");
const SCAN_BLOCK_SYMBOLS = resolveSymbolSetEnv("SCAN_BLOCK_SYMBOLS");
const SCAN_PRIORITY_SYMBOLS = Array.from(resolveSymbolSetEnv("SCAN_PRIORITY_SYMBOLS"));

const defaultParams = {
  query: undefined,
  market: (process.env.SCAN_MARKET === "spot" ? "spot" : "perp") as "perp" | "spot",
  limitTokens: Number(process.env.SCAN_LIMIT_TOKENS ?? 25)
};

const startedAt = new Date().toISOString();

let latestState: ServiceState | null = null;
let signalInterval: NodeJS.Timeout | null = null;
let tradeInterval: NodeJS.Timeout | null = null;
let runningSignalCycle = false;
let runningTradeCycle = false;
let universeCursor = 0;
const subscribers = new Set<(state: ServiceState) => void>();
let prismaClient: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!prismaClient) {
    prismaClient = new PrismaClient();
  }
  return prismaClient;
}

/**
 * Check backfill needs for a batch of symbols and trigger backfill in the background.
 * This happens asynchronously while the scan continues.
 */
function triggerBackfillCheckForSymbols(symbols: string[]): void {
  // Run in background, don't await
  void (async () => {
    try {
      const prisma = getPrisma();
      const statusMap: Record<string, string> = {};
      
      for (const symbol of symbols) {
        try {
          const { needsBackfill, reason } = await checkBackfillNeed(prisma, symbol);
          statusMap[symbol] = needsBackfill ? `NEEDS (${reason})` : `OK (${reason})`;
        } catch (err) {
          statusMap[symbol] = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Log backfill status for this chunk
      const needsBackfill = Object.entries(statusMap).filter(([_, status]) => status.includes("NEEDS"));
      if (needsBackfill.length > 0) {
        console.info("[scan-service] backfill check results", {
          chunk: symbols,
          needsBackfill: needsBackfill.map(([s, _]) => s)
        });
      }
    } catch (error) {
      console.error("[scan-service] backfill check failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();
}

async function hydrateStateFromPersistedSnapshot(): Promise<ServiceState | null> {
  const persisted = await loadLatestScanPayload<Partial<ServiceState>>();
  if (!persisted || !Array.isArray(persisted.results) || !persisted.tradeSimulation) {
    return null;
  }

  const now = new Date().toISOString();
  return {
    ...(persisted as ServiceState),
    service: {
      mode: "background",
      startedAt,
      lastSignalScanAt: persisted.service?.lastSignalScanAt ?? persisted.analyzedAt ?? now,
      lastTradeRefreshAt: persisted.service?.lastTradeRefreshAt ?? persisted.analyzedAt ?? now,
      signalIntervalMs: SIGNAL_INTERVAL_MS,
      tradeIntervalMs: TRADE_INTERVAL_MS,
      universeSize: persisted.service?.universeSize ?? 0,
      chunkSize: persisted.service?.chunkSize ?? SCAN_ROTATION_CHUNK_SIZE,
      chunkIndex: persisted.service?.chunkIndex ?? 0
    }
  };
}

function notifySubscribers(): void {
  if (!latestState) {
    return;
  }

  for (const handler of subscribers) {
    handler(latestState);
  }
}

function buildBootstrapState(): ServiceState {
  const now = new Date().toISOString();
  const tradeSimulation = getTradeSimulationSnapshot();

  return {
    analyzedAt: now,
    params: defaultParams,
    results: [],
    skipped: [],
    meta: {
      onlySignals: false,
      filteredOutNoSignal: 0
    },
    signalCounts: {
      strongShort: 0,
      strongLong: 0,
      continuationShort: 0,
      continuationLong: 0,
      reversalShort: 0,
      reversalLong: 0,
      noSignal: 0
    },
    tradeSimulation,
    service: {
      mode: "background",
      startedAt,
      lastSignalScanAt: now,
      lastTradeRefreshAt: now,
      signalIntervalMs: SIGNAL_INTERVAL_MS,
      tradeIntervalMs: TRADE_INTERVAL_MS,
      universeSize: 0,
      chunkSize: SCAN_ROTATION_CHUNK_SIZE,
      chunkIndex: 0
    }
  };
}

function computeSignalCounts(results: ScanResult["results"]): SignalCounts {
  return {
    strongShort: results.filter((item) => item.signal.type === "STRONG SHORT").length,
    strongLong: results.filter((item) => item.signal.type === "STRONG LONG").length,
    continuationShort: results.filter((item) => item.signal.type === "CONTINUATION SHORT").length,
    continuationLong: results.filter((item) => item.signal.type === "CONTINUATION LONG").length,
    reversalShort: results.filter((item) => item.signal.type === "REVERSAL SHORT").length,
    reversalLong: results.filter((item) => item.signal.type === "REVERSAL LONG").length,
    noSignal: results.filter((item) => item.signal.type.startsWith("NO SIGNAL")).length
  };
}

function signalRank(type: ResultRow["signal"]["type"]): number {
  if (type === "STRONG LONG" || type === "STRONG SHORT") {
    return 6;
  }

  if (type === "REVERSAL LONG" || type === "REVERSAL SHORT") {
    return 4;
  }

  if (type === "CONTINUATION LONG" || type === "CONTINUATION SHORT") {
    return 2;
  }

  return 0;
}

function normalizePerpSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  return upper.endsWith("-PERP") ? upper : `${upper}-PERP`;
}

function baseSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/-PERP$/i, "");
}

function sortResultsForMonitoring(results: ResultRow[]): ResultRow[] {
  return [...results].sort((left, right) => {
    const rankDiff = signalRank(right.signal.type) - signalRank(left.signal.type);
    if (rankDiff !== 0) {
      return rankDiff;
    }

    const scoreDiff = (right.confluence?.score ?? 0) - (left.confluence?.score ?? 0);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    return right.volume24h - left.volume24h;
  });
}

function mergeSnapshotRows(previousRows: ResultRow[], freshRows: ResultRow[], nowIso: string): ResultRow[] {
  const nowMs = Date.parse(nowIso);
  const merged = new Map<string, ResultRow>();

  for (const row of previousRows) {
    const rowWithMeta = row as ResultRow & { updatedAt?: string };
    const lastSeenMs = rowWithMeta.updatedAt ? Date.parse(rowWithMeta.updatedAt) : nowMs;
    if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs > SIGNAL_SNAPSHOT_TTL_MS) {
      continue;
    }

    merged.set(row.symbol, row);
  }

  for (const row of freshRows) {
    const nextRow = {
      ...row,
      updatedAt: nowIso
    } as ResultRow;
    merged.set(nextRow.symbol, nextRow);
  }

  return sortResultsForMonitoring(Array.from(merged.values()));
}

async function buildUniverseChunk(): Promise<{ universe: string[]; chunk: string[]; chunkIndex: number }> {
  let symbols: string[];
  try {
    symbols = (await searchTokens(undefined, defaultParams.market))
      .map((symbol) => normalizePerpSymbol(symbol))
      .filter((symbol) => symbol.length > 0);
  } catch (error) {
    const fallbackUniverse = SCAN_PRIORITY_SYMBOLS
      .map((symbol) => normalizePerpSymbol(symbol))
      .filter((symbol) => symbol.length > 0);

    if (fallbackUniverse.length === 0) {
      throw error;
    }

    console.warn("[scan-service] using SCAN_PRIORITY_SYMBOLS fallback universe due searchTokens failure", {
      error: error instanceof Error ? error.message : String(error),
      size: fallbackUniverse.length
    });

    symbols = fallbackUniverse;
  }

  const rawUniverse = Array.from(new Set(symbols));
  const allowActive = SCAN_ALLOW_SYMBOLS.size > 0;

  const filteredUniverse = rawUniverse.filter((symbol) => {
    const base = baseSymbol(symbol);
    if (SCAN_BLOCK_SYMBOLS.has(base) || SCAN_BLOCK_SYMBOLS.has(symbol)) {
      return false;
    }

    if (!allowActive) {
      return true;
    }

    return SCAN_ALLOW_SYMBOLS.has(base) || SCAN_ALLOW_SYMBOLS.has(symbol);
  });

  const prioritySet = new Set(
    SCAN_PRIORITY_SYMBOLS
      .map((symbol) => normalizePerpSymbol(symbol))
      .filter((symbol) => filteredUniverse.includes(symbol))
  );

  const universe = [
    ...Array.from(prioritySet),
    ...filteredUniverse.filter((symbol) => !prioritySet.has(symbol))
  ];

  if (universe.length === 0) {
    return { universe: [], chunk: [], chunkIndex: 0 };
  }

  const chunkSize = Math.min(SCAN_ROTATION_CHUNK_SIZE, universe.length);
  const start = universeCursor % universe.length;
  const chunk: string[] = [];

  for (let i = 0; i < chunkSize; i += 1) {
    const idx = (start + i) % universe.length;
    chunk.push(universe[idx]);
  }

  universeCursor = (start + chunkSize) % universe.length;
  const chunkIndex = Math.floor(start / chunkSize);
  return { universe, chunk, chunkIndex };
}

async function runSignalCycle(): Promise<void> {
  if (runningSignalCycle) {
    return;
  }

  runningSignalCycle = true;
  try {
    console.info("[scan-service] signal cycle start", {
      provider: MARKET_DATA_PROVIDER,
      chunkSize: SCAN_ROTATION_CHUNK_SIZE
    });

    const previousResults = latestState?.results ?? [];
    const { universe, chunk, chunkIndex } = await buildUniverseChunk();
    if (chunk.length === 0) {
      return;
    }

    // Trigger backfill check in background for this chunk
    // This will gradually fill in missing data without blocking the scan
    triggerBackfillCheckForSymbols(chunk);

    const scan = await scanRsi({
      ...defaultParams,
      limitTokens: chunk.length,
      symbols: chunk
    });

    const now = new Date().toISOString();
    const mergedResults = mergeSnapshotRows(previousResults, scan.results, now);
    const tradeSimulation = await processTradeSimulation(mergedResults);

    const signalCounts = computeSignalCounts(mergedResults);

    latestState = {
      ...scan,
      params: {
        ...scan.params,
        limitTokens: universe.length
      },
      results: mergedResults,
      meta: {
        onlySignals: false,
        filteredOutNoSignal: 0
      },
      signalCounts,
      tradeSimulation,
      service: {
        mode: "background",
        startedAt,
        lastSignalScanAt: now,
        lastTradeRefreshAt: now,
        signalIntervalMs: SIGNAL_INTERVAL_MS,
        tradeIntervalMs: TRADE_INTERVAL_MS,
        universeSize: universe.length,
        chunkSize: chunk.length,
        chunkIndex
      }
    };

    await persistSimulationState(latestState);
    notifySubscribers();
    console.info("[scan-service] signal cycle complete", {
      analyzedAt: scan.analyzedAt,
      results: mergedResults.length,
      chunkSize: chunk.length,
      chunkIndex,
      universeSize: universe.length,
      freshRows: scan.results.length,
      strongShort: signalCounts.strongShort,
      strongLong: signalCounts.strongLong,
      continuationShort: signalCounts.continuationShort,
      continuationLong: signalCounts.continuationLong,
      reversalShort: signalCounts.reversalShort,
      reversalLong: signalCounts.reversalLong,
      noSignal: signalCounts.noSignal,
      activeTrades: tradeSimulation.stats.activeTrades,
      totalTrades: tradeSimulation.stats.totalTrades
    });
  } catch (error) {
    console.error("[scan-service] signal cycle failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    runningSignalCycle = false;
  }
}

async function runTradeCycle(): Promise<void> {
  if (runningTradeCycle || !latestState) {
    return;
  }

  runningTradeCycle = true;
  try {
    const tradeSimulation = await refreshTradeSimulation();

    // Keep the bottom monitoring table prices live between full signal scans.
    if (Array.isArray(latestState.results) && latestState.results.length > 0) {
      try {
        const symbols = latestState.results.map((row) => row.symbol);
        const perpContexts = await fetchPerpContexts(symbols);

        for (const row of latestState.results) {
          const ctx = perpContexts.get(row.symbol);
          if (ctx && Number.isFinite(ctx.markPrice) && ctx.markPrice > 0) {
            row.close = ctx.markPrice;
          }
        }
      } catch (priceError) {
        console.error("[scan-service] trade cycle price refresh failed", {
          error: priceError instanceof Error ? priceError.message : String(priceError)
        });
      }
    }

    latestState = {
      ...latestState,
      tradeSimulation,
      service: {
        ...latestState.service,
        lastTradeRefreshAt: new Date().toISOString()
      }
    };

    await persistSimulationState(latestState);
    notifySubscribers();
    console.info("[scan-service] trade cycle complete", {
      at: latestState.service.lastTradeRefreshAt,
      activeTrades: tradeSimulation.stats.activeTrades,
      totalTrades: tradeSimulation.stats.totalTrades,
      winRate: tradeSimulation.stats.winRate,
      pnlUsd: tradeSimulation.stats.totalSimulatedPnlUsd
    });
  } catch (error) {
    console.error("[scan-service] trade cycle failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    runningTradeCycle = false;
  }
}

export async function updateScanResultPrices(): Promise<void> {
  if (!latestState || !Array.isArray(latestState.results) || latestState.results.length === 0) {
    return;
  }

  try {
    const symbols = latestState.results.map((r) => r.symbol);
    const perpContexts = await fetchPerpContexts(symbols);

    for (const result of latestState.results) {
      const ctx = perpContexts.get(result.symbol);
      if (ctx && ctx.markPrice && ctx.markPrice > 0) {
        result.close = ctx.markPrice;
      }
    }

    notifySubscribers();
  } catch (error) {
    console.error("[scan-service] Failed to update scan result prices:", error);
  }
}

export async function startScanService(): Promise<void> {
  if (signalInterval || tradeInterval) {
    return;
  }

  await ensureLatestServiceState();

  signalInterval = setInterval(() => {
    void runSignalCycle();
  }, SIGNAL_INTERVAL_MS);

  tradeInterval = setInterval(() => {
    void runTradeCycle();
  }, TRADE_INTERVAL_MS);

  // Kick off the first cycle without blocking the refresh loops.
  void runSignalCycle();
}

export async function ensureLatestServiceState(): Promise<void> {
  if (!latestState) {
    latestState = (await hydrateStateFromPersistedSnapshot()) ?? buildBootstrapState();
  }
}

export function getLatestServiceState(): ServiceState | null {
  return latestState;
}

export async function setLatestServiceState(state: Omit<ServiceState, "service">): Promise<void> {
  const now = new Date().toISOString();
  latestState = {
    ...state,
    service: {
      mode: "background",
      startedAt,
      lastSignalScanAt: now,
      lastTradeRefreshAt: now,
      signalIntervalMs: SIGNAL_INTERVAL_MS,
      tradeIntervalMs: TRADE_INTERVAL_MS,
      universeSize: state.results.length,
      chunkSize: SCAN_ROTATION_CHUNK_SIZE,
      chunkIndex: 0
    }
  };

  await persistSimulationState(latestState);
  notifySubscribers();
}

export function subscribeStateUpdates(handler: (state: ServiceState) => void): () => void {
  subscribers.add(handler);

  if (latestState) {
    handler(latestState);
  }

  return () => {
    subscribers.delete(handler);
  };
}

export async function triggerTradeRefresh(): Promise<void> {
  await runTradeCycle();
}
