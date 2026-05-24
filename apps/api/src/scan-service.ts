import "./env.js";
import { scanRsi, type ScanResult, fetchPerpContexts } from "./hyperliquid-service.js";
import { loadLatestScanPayload, persistSimulationState } from "./simulation-store.js";
import { getTradeSimulationSnapshot, processTradeSimulation, refreshTradeSimulation } from "./trade-engine.js";

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

const STICKY_MONITORED_SYMBOLS_MAX = Math.max(
  25,
  Math.trunc(resolveNumberEnv("SCAN_STICKY_MONITORED_SYMBOLS_MAX", 60))
);
const CANDIDATE_POOL_LIMIT = Math.max(
  25,
  Math.trunc(resolveNumberEnv("SCAN_CANDIDATE_POOL_LIMIT", 50))
);
const REPLACEMENT_MIN_PRIORITY_DELTA = Math.max(
  0,
  resolveNumberEnv("SCAN_REPLACEMENT_MIN_PRIORITY_DELTA", 1.25)
);

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
const subscribers = new Set<(state: ServiceState) => void>();

function hydrateStateFromPersistedSnapshot(): ServiceState | null {
  const persisted = loadLatestScanPayload<Partial<ServiceState>>();
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
      tradeIntervalMs: TRADE_INTERVAL_MS
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
      tradeIntervalMs: TRADE_INTERVAL_MS
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

function signalStrengthScore(row: ResultRow): number {
  const type = row.signal.type;
  if (type === "STRONG LONG" || type === "STRONG SHORT") {
    return 6;
  }

  if (type === "REVERSAL LONG" || type === "REVERSAL SHORT") {
    return 4.5;
  }

  if (type === "CONTINUATION LONG" || type === "CONTINUATION SHORT") {
    return 3;
  }

  return 0;
}

function hasDirectionalSignal(row: ResultRow): boolean {
  const type = row.signal.type;
  return (
    type === "STRONG LONG" ||
    type === "STRONG SHORT" ||
    type === "REVERSAL LONG" ||
    type === "REVERSAL SHORT" ||
    type === "CONTINUATION LONG" ||
    type === "CONTINUATION SHORT"
  );
}

function monitoringPriority(row: ResultRow, wasWatched: boolean, hasOpenTrade: boolean): number {
  // Active positions stay pinned in the monitored roster.
  if (hasOpenTrade) {
    return 1_000;
  }

  const qualityScore = Number.isFinite(row.confluence.score) ? row.confluence.score * 0.35 : 0;
  const orderBookScore = row.tradeContext?.passedOrderBook ? 3 : 0;
  const structureScore = row.tradeContext?.passedStructure ? 2 : 0;
  const microTrendScore = row.tradeContext?.passedMicroTrend ? 1.5 : 0;
  const volatilityScore = row.tradeContext?.passedVolatility ? 0.8 : 0;
  const liquidityScore = row.tradeContext?.passedLiquidity ? 0.5 : 0;
  const directionalSignalScore = hasDirectionalSignal(row) ? 1.5 : 0;
  const watchedBias = wasWatched ? 0.2 : 0;

  return (
    qualityScore +
    signalStrengthScore(row) +
    orderBookScore +
    structureScore +
    microTrendScore +
    volatilityScore +
    liquidityScore +
    directionalSignalScore +
    watchedBias
  );
}

function selectMonitoredResults(args: {
  freshResults: ResultRow[];
  previousResults: ResultRow[];
  activeSymbols: Set<string>;
  limit: number;
  replacementMinDelta: number;
}): {
  selected: ResultRow[];
  replaced: number;
} {
  const { freshResults, previousResults, activeSymbols, limit, replacementMinDelta } = args;

  const previousSet = new Set(previousResults.map((item) => item.symbol));
  const rowBySymbol = new Map<string, ResultRow>();
  for (const row of freshResults) {
    rowBySymbol.set(row.symbol, row);
  }
  for (const row of previousResults) {
    if (!rowBySymbol.has(row.symbol)) {
      rowBySymbol.set(row.symbol, row);
    }
  }

  const watched = previousResults
    .map((item) => {
      const row = rowBySymbol.get(item.symbol);
      if (!row) {
        return null;
      }
      const hasOpenTrade = activeSymbols.has(row.symbol);
      const priority = monitoringPriority(row, true, hasOpenTrade);
      return { row, priority, hasOpenTrade };
    })
    .filter((item): item is { row: ResultRow; priority: number; hasOpenTrade: boolean } => item !== null)
    .slice(0, limit);

  const selected = [...watched];
  let replaced = 0;

  const challengers = freshResults
    .filter((row) => !previousSet.has(row.symbol))
    .map((row) => {
      const hasOpenTrade = activeSymbols.has(row.symbol);
      const priority = monitoringPriority(row, false, hasOpenTrade);
      return { row, priority, hasOpenTrade };
    })
    .sort((left, right) => right.priority - left.priority);

  for (const challenger of challengers) {
    const alreadySelected = selected.some((item) => item.row.symbol === challenger.row.symbol);
    if (alreadySelected) {
      continue;
    }

    if (selected.length < limit) {
      selected.push(challenger);
      continue;
    }

    let weakestIndex = -1;
    for (let i = 0; i < selected.length; i += 1) {
      if (selected[i].hasOpenTrade) {
        continue;
      }

      if (weakestIndex === -1 || selected[i].priority < selected[weakestIndex].priority) {
        weakestIndex = i;
      }
    }

    if (weakestIndex === -1) {
      continue;
    }

    const weakest = selected[weakestIndex];
    if (challenger.priority >= weakest.priority + replacementMinDelta) {
      selected[weakestIndex] = challenger;
      replaced += 1;
    }
  }

  selected.sort((left, right) => right.priority - left.priority);
  return {
    selected: selected.slice(0, limit).map((item) => item.row),
    replaced
  };
}

async function runSignalCycle(): Promise<void> {
  if (runningSignalCycle) {
    return;
  }

  runningSignalCycle = true;
  try {
    const previousResults = latestState?.results ?? [];
    const activeSymbols = new Set(
      (latestState?.tradeSimulation.activeTrades ?? []).map((trade) => trade.token)
    );
    const monitoredLimit = Math.max(1, Math.trunc(defaultParams.limitTokens));
    const watchedSymbols = latestState
      ? latestState.results
          .slice(0, Math.max(monitoredLimit, STICKY_MONITORED_SYMBOLS_MAX))
          .map((item) => item.symbol)
          .filter((symbol) => symbol.trim().length > 0)
      : [];

    const scan = await scanRsi({
      ...defaultParams,
      limitTokens: Math.max(monitoredLimit, CANDIDATE_POOL_LIMIT),
      includeSymbols: watchedSymbols
    });
    const roster = selectMonitoredResults({
      freshResults: scan.results,
      previousResults,
      activeSymbols,
      limit: monitoredLimit,
      replacementMinDelta: REPLACEMENT_MIN_PRIORITY_DELTA
    });
    const tradeSimulation = await processTradeSimulation(roster.selected);

    const signalCounts = computeSignalCounts(roster.selected);
    const now = new Date().toISOString();

    latestState = {
      ...scan,
      params: {
        ...scan.params,
        limitTokens: monitoredLimit
      },
      results: roster.selected,
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
        tradeIntervalMs: TRADE_INTERVAL_MS
      }
    };

    persistSimulationState(latestState);
    notifySubscribers();
    console.info("[scan-service] signal cycle complete", {
      analyzedAt: scan.analyzedAt,
      results: roster.selected.length,
      candidatePool: scan.results.length,
      replaced: roster.replaced,
      stickyWatched: watchedSymbols.length,
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
    latestState = {
      ...latestState,
      tradeSimulation,
      service: {
        ...latestState.service,
        lastTradeRefreshAt: new Date().toISOString()
      }
    };

    persistSimulationState(latestState);
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

  if (!latestState) {
    latestState = hydrateStateFromPersistedSnapshot() ?? buildBootstrapState();
  }

  await runSignalCycle();

  signalInterval = setInterval(() => {
    void runSignalCycle();
  }, SIGNAL_INTERVAL_MS);

  tradeInterval = setInterval(() => {
    void runTradeCycle();
  }, TRADE_INTERVAL_MS);
}

export function getLatestServiceState(): ServiceState | null {
  if (!latestState) {
    latestState = hydrateStateFromPersistedSnapshot();
  }

  return latestState;
}

export function setLatestServiceState(state: Omit<ServiceState, "service">): void {
  const now = new Date().toISOString();
  latestState = {
    ...state,
    service: {
      mode: "background",
      startedAt,
      lastSignalScanAt: now,
      lastTradeRefreshAt: now,
      signalIntervalMs: SIGNAL_INTERVAL_MS,
      tradeIntervalMs: TRADE_INTERVAL_MS
    }
  };

  persistSimulationState(latestState);
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
