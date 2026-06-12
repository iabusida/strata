import "./env.js";
import { PrismaClient } from "@prisma/client";
import { scanRsi, type ScanResult, fetchPerpContexts, searchTokens, MARKET_DATA_PROVIDER } from "./market-data-service.js";
import { fetchActiveBitunixPerpSymbols } from "./bitunix-service.js";
import { loadLatestScanPayload, persistSimulationState } from "./simulation-store.js";
import { getTradeSimulationSnapshot, processTradeSimulation } from "./trade-engine.js";
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

type CandlestickPatternBucket = {
  hits: number;
  bullishHits: number;
  bearishHits: number;
  alignedHits: number;
};

type CandlestickPatternStats = {
  totalRows: number;
  rowsWithPatterns: number;
  bullishRows: number;
  bearishRows: number;
  alignedWithDirectionalSignal: number;
  byPattern: Record<string, CandlestickPatternBucket>;
};

type ResultRow = ScanResult["results"][number] & {
  maxLeverage?: number;
};

function attachTokenLeverageProfile<Row extends ResultRow>(row: Row): Row {
  return row;
}

function attachTokenLeverageProfiles(rows: ResultRow[], contexts: Map<string, { maxLeverage?: number }>): ResultRow[] {
  return rows.map((row) => {
    const leverage = contexts.get(row.symbol)?.maxLeverage;
    return {
      ...row,
      maxLeverage: Number.isFinite(leverage) && Number(leverage) > 0 ? Number(leverage) : row.maxLeverage
    };
  });
}

type ServiceState = Omit<ScanResult, "results"> & {
  results: ResultRow[];
  meta: {
    onlySignals: boolean;
    filteredOutNoSignal: number;
  };
  signalCounts: SignalCounts;
  candlestickStats: CandlestickPatternStats;
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

const SIGNAL_INTERVAL_MS = Math.max(10_000, Math.trunc(resolveNumberEnv("SIGNAL_SCAN_INTERVAL_MS", 300_000)));
const TRADE_INTERVAL_MS = Math.max(1_000, Math.trunc(resolveNumberEnv("TRADE_REFRESH_INTERVAL_MS", 60_000)));
const PRICE_TICK_INTERVAL_MS = Math.max(1_000, Math.trunc(resolveNumberEnv("PRICE_TICK_INTERVAL_MS", 1_000)));
const REALTIME_TRADE_ON_PRICE_TICK = resolveBooleanEnv("REALTIME_TRADE_ON_PRICE_TICK", true);
const REALTIME_TRADE_MIN_INTERVAL_MS = Math.max(500, Math.trunc(resolveNumberEnv("REALTIME_TRADE_MIN_INTERVAL_MS", 1_000)));
const TRADE_STATE_PERSIST_INTERVAL_MS = Math.max(1_000, Math.trunc(resolveNumberEnv("TRADE_STATE_PERSIST_INTERVAL_MS", 5_000)));
const SIGNAL_CYCLE_STEP_TIMEOUT_MS = Math.max(10_000, Math.trunc(resolveNumberEnv("SIGNAL_CYCLE_STEP_TIMEOUT_MS", 90_000)));

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

function resolveBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean env ${name}: ${raw}`);
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
}

const DEFAULT_SCAN_ROTATION_CHUNK_SIZE = MARKET_DATA_PROVIDER === "OKX" ? 8 : 30;
const SCAN_ROTATION_CHUNK_SIZE = Math.max(5, Math.trunc(resolveNumberEnv("SCAN_ROTATION_CHUNK_SIZE", DEFAULT_SCAN_ROTATION_CHUNK_SIZE)));
const SIGNAL_SNAPSHOT_TTL_MS = Math.max(300_000, Math.trunc(resolveNumberEnv("SIGNAL_SNAPSHOT_TTL_MS", 21_600_000)));
const SCAN_ALLOW_SYMBOLS = resolveSymbolSetEnv("SCAN_ALLOW_SYMBOLS");
const SCAN_BLOCK_SYMBOLS = resolveSymbolSetEnv("SCAN_BLOCK_SYMBOLS");
const SCAN_PRIORITY_SYMBOLS = Array.from(resolveSymbolSetEnv("SCAN_PRIORITY_SYMBOLS"));
const CORE_PRIORITY_SYMBOLS = [
  "BTC",
  "ETH",
  "SOL",
  "BNB",
  "XRP",
  "ADA",
  "DOGE",
  "TRX",
  "TON",
  "AVAX",
  "DOT",
  "LINK",
  "LTC",
  "BCH",
  "ATOM",
  "NEAR",
  "ICP",
  "APT",
  "SUI"
];

const defaultParams = {
  query: undefined,
  market: (process.env.SCAN_MARKET === "spot" ? "spot" : "perp") as "perp" | "spot",
  limitTokens: Number(process.env.SCAN_LIMIT_TOKENS ?? 25)
};

const startedAt = new Date().toISOString();

const CANDLESTICK_PATTERN_NAMES = [
  "BULLISH_ENGULFING",
  "BEARISH_ENGULFING",
  "HAMMER",
  "SHOOTING_STAR",
  "MORNING_STAR",
  "EVENING_STAR"
] as const;

let latestState: ServiceState | null = null;
let signalInterval: NodeJS.Timeout | null = null;
let tradeInterval: NodeJS.Timeout | null = null;
let priceTickInterval: NodeJS.Timeout | null = null;
let runningSignalCycle = false;
let runningTradeCycle = false;
let runningPriceTickCycle = false;
let lastTradeCycleAtMs = 0;
let lastTradeStatePersistAtMs = 0;
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
    candlestickStats: persisted.candlestickStats ?? createEmptyCandlestickStats(),
    results: persisted.results as ResultRow[],
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
    candlestickStats: createEmptyCandlestickStats(),
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

function createEmptyCandlestickStats(): CandlestickPatternStats {
  return {
    totalRows: 0,
    rowsWithPatterns: 0,
    bullishRows: 0,
    bearishRows: 0,
    alignedWithDirectionalSignal: 0,
    byPattern: CANDLESTICK_PATTERN_NAMES.reduce<Record<string, CandlestickPatternBucket>>((acc, pattern) => {
      acc[pattern] = { hits: 0, bullishHits: 0, bearishHits: 0, alignedHits: 0 };
      return acc;
    }, {})
  };
}

function computeCandlestickStats(results: ScanResult["results"]): CandlestickPatternStats {
  const stats = createEmptyCandlestickStats();
  stats.totalRows = results.length;

  for (const row of results) {
    const candlestick = row.tradeContext?.candlestick;
    if (!candlestick) {
      continue;
    }

    const bullishPatterns = Array.isArray(candlestick.bullishPatterns) ? candlestick.bullishPatterns : [];
    const bearishPatterns = Array.isArray(candlestick.bearishPatterns) ? candlestick.bearishPatterns : [];
    const hasAny = bullishPatterns.length > 0 || bearishPatterns.length > 0;
    if (!hasAny) {
      continue;
    }

    stats.rowsWithPatterns += 1;
    if (bullishPatterns.length > 0) {
      stats.bullishRows += 1;
    }
    if (bearishPatterns.length > 0) {
      stats.bearishRows += 1;
    }

    const signalDir: "LONG" | "SHORT" | null = row.signal.type.includes("LONG")
      ? "LONG"
      : row.signal.type.includes("SHORT")
        ? "SHORT"
        : null;

    let rowAligned = false;

    for (const pattern of bullishPatterns) {
      const bucket = stats.byPattern[pattern] ?? (stats.byPattern[pattern] = { hits: 0, bullishHits: 0, bearishHits: 0, alignedHits: 0 });
      bucket.hits += 1;
      bucket.bullishHits += 1;
      if (signalDir === "LONG") {
        bucket.alignedHits += 1;
        rowAligned = true;
      }
    }

    for (const pattern of bearishPatterns) {
      const bucket = stats.byPattern[pattern] ?? (stats.byPattern[pattern] = { hits: 0, bullishHits: 0, bearishHits: 0, alignedHits: 0 });
      bucket.hits += 1;
      bucket.bearishHits += 1;
      if (signalDir === "SHORT") {
        bucket.alignedHits += 1;
        rowAligned = true;
      }
    }

    if (rowAligned) {
      stats.alignedWithDirectionalSignal += 1;
    }
  }

  return stats;
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

let _activeBitunixPerpSymbols: Set<string> | null = null;
let _activeBitunixPerpSymbolsAt = 0;
const ACTIVE_BITUNIX_PERP_SYMBOLS_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getActiveBitunixPerpSymbols(): Promise<Set<string> | null> {
  if (MARKET_DATA_PROVIDER !== "BITUNIX") {
    return null;
  }

  const nowMs = Date.now();
  if (_activeBitunixPerpSymbols && nowMs - _activeBitunixPerpSymbolsAt < ACTIVE_BITUNIX_PERP_SYMBOLS_TTL_MS) {
    return _activeBitunixPerpSymbols;
  }

  try {
    const fetched = await fetchActiveBitunixPerpSymbols();
    // Normalize symbols so merge filtering is stable across provider naming variants (e.g. BTCUSDT vs BTC-PERP).
    _activeBitunixPerpSymbols = new Set(
      Array.from(fetched)
        .map((symbol) => normalizePerpSymbol(symbol.replace(/USDT$/i, "")))
        .filter((symbol) => symbol.length > 0)
    );
    _activeBitunixPerpSymbolsAt = Date.now();
    return _activeBitunixPerpSymbols;
  } catch (error) {
    console.warn("[scan-service] failed to fetch active Bitunix perp symbols; skipping contract validation", {
      error: error instanceof Error ? error.message : String(error)
    });
    return _activeBitunixPerpSymbols; // return stale if available
  }
}

function mergeSnapshotRows(
  previousRows: ResultRow[],
  freshRows: ResultRow[],
  nowIso: string,
  activeSymbols: Set<string> | null,
  universeSymbols: Set<string>,
  protectedSymbols: Set<string>
): ResultRow[] {
  const nowMs = Date.parse(nowIso);
  const merged = new Map<string, ResultRow>();

  for (const row of previousRows) {
    const normalizedSymbol = normalizePerpSymbol(row.symbol.replace(/USDT$/i, ""));
    const isProtected = protectedSymbols.has(normalizedSymbol);
    const inUniverse = universeSymbols.has(normalizedSymbol);

    if (!isProtected && activeSymbols && !activeSymbols.has(normalizedSymbol)) {
      continue;
    }

    const rowWithMeta = row as ResultRow & { updatedAt?: string };
    const lastSeenMs = rowWithMeta.updatedAt ? Date.parse(rowWithMeta.updatedAt) : nowMs;
    if (!isProtected && !inUniverse && Number.isFinite(lastSeenMs) && nowMs - lastSeenMs > SIGNAL_SNAPSHOT_TTL_MS) {
      continue;
    }

    merged.set(normalizedSymbol, {
      ...row,
      symbol: normalizedSymbol
    });
  }

  for (const row of freshRows) {
    const normalizedSymbol = normalizePerpSymbol(row.symbol.replace(/USDT$/i, ""));
    const nextRow = {
      ...row,
      symbol: normalizedSymbol,
      updatedAt: nowIso
    } as ResultRow;
    merged.set(normalizedSymbol, nextRow);
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
    [...CORE_PRIORITY_SYMBOLS, ...SCAN_PRIORITY_SYMBOLS]
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
    const { universe, chunk, chunkIndex } = await withTimeout(
      buildUniverseChunk(),
      SIGNAL_CYCLE_STEP_TIMEOUT_MS,
      "buildUniverseChunk"
    );
    if (chunk.length === 0) {
      return;
    }

    // Trigger backfill check in background for this chunk
    // This will gradually fill in missing data without blocking the scan
    triggerBackfillCheckForSymbols(chunk);

    const scan = await withTimeout(
      scanRsi({
        ...defaultParams,
        limitTokens: chunk.length,
        symbols: chunk
      }),
      SIGNAL_CYCLE_STEP_TIMEOUT_MS,
      "scanRsi"
    );

    const now = new Date().toISOString();
    const activeSymbols = await withTimeout(
      getActiveBitunixPerpSymbols(),
      SIGNAL_CYCLE_STEP_TIMEOUT_MS,
      "getActiveBitunixPerpSymbols"
    );
    const universeSymbols = new Set(universe.map((symbol) => normalizePerpSymbol(symbol)));
    const protectedSymbols = new Set(
      (latestState?.tradeSimulation?.activeTrades ?? [])
        .map((trade) => normalizePerpSymbol(String(trade.token ?? "")))
        .filter((symbol) => symbol.length > 0)
    );

    const mergedResults = mergeSnapshotRows(
      previousResults,
      scan.results,
      now,
      activeSymbols,
      universeSymbols,
      protectedSymbols
    );
    const perpContexts = await withTimeout(
      fetchPerpContexts(mergedResults.map((row) => row.symbol)),
      SIGNAL_CYCLE_STEP_TIMEOUT_MS,
      "fetchPerpContexts"
    );
    const mergedResultsWithLeverage = attachTokenLeverageProfiles(mergedResults, perpContexts);
    const tradeSimulation = await withTimeout(
      processTradeSimulation(mergedResultsWithLeverage),
      SIGNAL_CYCLE_STEP_TIMEOUT_MS,
      "processTradeSimulation"
    );

    const signalCounts = computeSignalCounts(mergedResultsWithLeverage);
    const candlestickStats = computeCandlestickStats(mergedResultsWithLeverage);

    latestState = {
      ...scan,
      params: {
        ...scan.params,
        limitTokens: universe.length
      },
      results: mergedResultsWithLeverage,
      meta: {
        onlySignals: false,
        filteredOutNoSignal: 0
      },
      signalCounts,
        candlestickStats,
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
      results: mergedResultsWithLeverage.length,
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
        patternRows: candlestickStats.rowsWithPatterns,
        patternAlignedRows: candlestickStats.alignedWithDirectionalSignal,
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

async function runTradeCycle(options?: { skipPriceRefresh?: boolean }): Promise<void> {
  if (runningTradeCycle || !latestState) {
    return;
  }

  runningTradeCycle = true;
  try {
    // Keep the bottom monitoring table prices live between full signal scans.
    if (!options?.skipPriceRefresh && Array.isArray(latestState.results) && latestState.results.length > 0) {
      try {
        const symbols = latestState.results.map((row) => row.symbol);
        const perpContexts = await fetchPerpContexts(symbols);

        for (const row of latestState.results) {
          const ctx = perpContexts.get(row.symbol);
          if (ctx && Number.isFinite(ctx.markPrice) && ctx.markPrice > 0) {
            row.close = ctx.markPrice;
          }
          if (ctx && typeof ctx.maxLeverage === "number" && Number.isFinite(ctx.maxLeverage) && ctx.maxLeverage > 0) {
            row.maxLeverage = ctx.maxLeverage;
          }
        }
      } catch (priceError) {
        console.error("[scan-service] trade cycle price refresh failed", {
          error: priceError instanceof Error ? priceError.message : String(priceError)
        });
      }
    }

    // Re-run trade simulation on each trade cycle so entries can trigger from
    // websocket-updated prices without waiting for the slower signal cycle.
    const tradeSimulation = await processTradeSimulation(latestState.results);

    latestState = {
      ...latestState,
      tradeSimulation,
      service: {
        ...latestState.service,
        lastTradeRefreshAt: new Date().toISOString()
      }
    };

    const nowMs = Date.now();
    if (nowMs - lastTradeStatePersistAtMs >= TRADE_STATE_PERSIST_INTERVAL_MS) {
      await persistSimulationState(latestState);
      lastTradeStatePersistAtMs = nowMs;
    }

    lastTradeCycleAtMs = nowMs;
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
      if (ctx && typeof ctx.maxLeverage === "number" && Number.isFinite(ctx.maxLeverage) && ctx.maxLeverage > 0) {
        result.maxLeverage = ctx.maxLeverage;
      }
    }

    notifySubscribers();
  } catch (error) {
    console.error("[scan-service] Failed to update scan result prices:", error);
  }
}

async function runPriceTickCycle(): Promise<void> {
  if (runningPriceTickCycle) {
    return;
  }

  runningPriceTickCycle = true;
  try {
    await updateScanResultPrices();

    if (!REALTIME_TRADE_ON_PRICE_TICK) {
      return;
    }

    const nowMs = Date.now();
    if (nowMs - lastTradeCycleAtMs < REALTIME_TRADE_MIN_INTERVAL_MS) {
      return;
    }

    await runTradeCycle({ skipPriceRefresh: true });
  } finally {
    runningPriceTickCycle = false;
  }
}

export async function startScanService(): Promise<void> {
  if (signalInterval || tradeInterval || priceTickInterval) {
    return;
  }

  await ensureLatestServiceState();

  signalInterval = setInterval(() => {
    void runSignalCycle();
  }, SIGNAL_INTERVAL_MS);

  tradeInterval = setInterval(() => {
    void runTradeCycle();
  }, TRADE_INTERVAL_MS);

  priceTickInterval = setInterval(() => {
    void runPriceTickCycle();
  }, PRICE_TICK_INTERVAL_MS);

  // Kick off the first cycle without blocking the refresh loops.
  void runSignalCycle();
  void runTradeCycle();
  void runPriceTickCycle();
}

export function stopScanService(): void {
  if (signalInterval) {
    clearInterval(signalInterval);
    signalInterval = null;
  }

  if (tradeInterval) {
    clearInterval(tradeInterval);
    tradeInterval = null;
  }

  if (priceTickInterval) {
    clearInterval(priceTickInterval);
    priceTickInterval = null;
  }
}

export async function ensureLatestServiceState(): Promise<void> {
  if (!latestState) {
    latestState = (await hydrateStateFromPersistedSnapshot()) ?? buildBootstrapState();
  }
}

export function getLatestServiceState(): ServiceState | null {
  return latestState;
}

export async function setLatestServiceState(
  state: Omit<ServiceState, "service" | "candlestickStats"> & Partial<Pick<ServiceState, "candlestickStats">>
): Promise<void> {
  const now = new Date().toISOString();
  const candlestickStats = state.candlestickStats ?? computeCandlestickStats(state.results);
  latestState = {
    ...state,
    candlestickStats,
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
