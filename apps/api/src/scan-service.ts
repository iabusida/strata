import "./env.js";
import { scanRsi, type ScanResult, fetchPerpContexts } from "./hyperliquid-service.js";
import { loadLatestScanPayload, persistSimulationState } from "./simulation-store.js";
import { getTradeSimulationSnapshot, processTradeSimulation, refreshTradeSimulation } from "./trade-engine.js";

type SignalCounts = {
  strongShort: number;
  strongLong: number;
  noSignal: number;
};

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
    noSignal: results.filter((item) => item.signal.type.startsWith("NO SIGNAL")).length
  };
}

async function runSignalCycle(): Promise<void> {
  if (runningSignalCycle) {
    return;
  }

  runningSignalCycle = true;
  try {
    const scan = await scanRsi(defaultParams);
    const tradeSimulation = await processTradeSimulation(scan.results);
    const signalCounts = computeSignalCounts(scan.results);
    const now = new Date().toISOString();

    latestState = {
      ...scan,
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
      results: scan.results.length,
      strongShort: signalCounts.strongShort,
      strongLong: signalCounts.strongLong,
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
