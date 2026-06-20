"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { AlignmentPoint, SignalItem, SignalState } from "./system/types";
import { SignalStateBadge } from "./system/signal-state-badge";
import { ScanControlBar } from "./system/scan-control-bar";
import { SignalCard } from "./system/signal-card";

type DashboardView = "results" | "simulation";

type DashboardProps = {
  initialView?: DashboardView;
  tradeMode?: "test" | "live";
};

type RawDirection = "UP" | "DOWN" | "MIXED";

type RawRow = {
  symbol: string;
  market: "perp" | "spot";
  close: number;
  entryTiming: "EARLY" | "MID" | "LATE" | null;
  signal: { type: string };
  confluence: { score: number };
  rsi: number;
  volume24h: number;
  volatilityPct: number;
  tradeContext: {
    emaSlope: number;
    passedVolatility: boolean;
    passedLiquidity: boolean;
    orderBookImbalance?: number;
  };
  timeframes: {
    macro: { trend: { direction: RawDirection }; rsi: number; stochK: number };
    intermediary: { trend: { direction: RawDirection }; rsi: number; stochK: number };
    microTrigger: { trend: { direction: RawDirection }; rsi: number; stochK: number };
  };
};

type StatePayload = {
  analyzedAt?: string;
  results?: RawRow[];
  service?: {
    lastSignalScanAt?: string;
    signalIntervalMs?: number;
  };
  tradeSimulation?: {
    stats?: {
      totalTrades: number;
      activeTrades: number;
      winRate: number;
      totalPnlUsd: number;
      unrealizedPnlUsd: number;
    };
  };
};

type PrimaryTab = "Scan" | "Forecast" | "Execute" | "Simulate";

type MarketFilter = "CRYPTO" | "STOCKS";

type TimeframeFilter = "15M" | "1H" | "4H" | "1D";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim();

function getApiBase(): string {
  if (API_BASE) {
    return API_BASE.replace(/\/+$/, "");
  }

  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:8787`;
  }

  return "http://127.0.0.1:8787";
}

function toSignalState(row: RawRow): SignalState {
  const directional = row.signal.type.includes("LONG") || row.signal.type.includes("SHORT");
  const qualityGate = row.tradeContext.passedVolatility && row.tradeContext.passedLiquidity;
  const score = row.confluence.score;

  if (!directional && score >= 6.5) return "BUILDING";
  if (!directional || !qualityGate || score < 4.5) return "BLOCKED";
  if (row.entryTiming === "EARLY" && score >= 7.5) return "READY";
  return "CAUTION";
}

function rowToSignalItem(row: RawRow): SignalItem {
  const state = toSignalState(row);
  const alignment: AlignmentPoint[] = [
    { label: "1D", direction: row.timeframes.macro.trend.direction, dominant: true },
    { label: "4H", direction: row.timeframes.intermediary.trend.direction },
    {
      label: "1H",
      direction: row.timeframes.microTrigger.trend.direction,
      blocked:
        row.timeframes.macro.trend.direction !== "MIXED"
        && row.timeframes.microTrigger.trend.direction !== "MIXED"
        && row.timeframes.macro.trend.direction !== row.timeframes.microTrigger.trend.direction,
    },
    {
      label: "15M",
      direction: row.timeframes.microTrigger.stochK >= 50 ? "UP" : "DOWN",
    },
  ];

  const hasConflict = alignment.some((point) => point.blocked);
  const directionWord = row.signal.type.includes("LONG") ? "upside" : row.signal.type.includes("SHORT") ? "downside" : "neutral";

  const liquiditySweep = Math.abs(Number(row.tradeContext.orderBookImbalance ?? 0)) > 0.06
    ? "HIGH"
    : Math.abs(Number(row.tradeContext.orderBookImbalance ?? 0)) > 0.02
      ? "MEDIUM"
      : "LOW";

  const entry = row.close;
  const stopLoss = row.signal.type.includes("LONG") ? row.close * 0.985 : row.close * 1.015;
  const takeProfit = row.signal.type.includes("LONG") ? row.close * 1.03 : row.close * 0.97;

  return {
    symbol: row.symbol,
    displayName: row.symbol,
    price: row.close,
    score: row.confluence.score,
    state,
    summary: hasConflict
      ? `Layered structure conflict detected. ${directionWord} bias remains ${state.toLowerCase()}.`
      : `Multi-timeframe structure is coherent with ${directionWord} bias.`,
    alignment,
    entryTiming: row.entryTiming,
    rsi: row.rsi,
    stochastic: row.timeframes.microTrigger.stochK,
    emaSlope: row.tradeContext.emaSlope,
    volume24h: row.volume24h,
    volatilityPct: row.volatilityPct,
    liquiditySweep,
    fibZone: row.signal.type.includes("LONG") ? "0.5-0.618 retrace" : "0.382-0.5 rejection",
    htfConfirmed: !hasConflict,
    suggestedEntry: entry,
    stopLoss,
    takeProfit,
  };
}

function getPrimaryTab(pathname: string, initialView: DashboardView): PrimaryTab {
  if (initialView === "simulation" || pathname.startsWith("/test-simulation")) return "Simulate";
  if (pathname.startsWith("/live-order-simulation") || pathname.startsWith("/dry-run")) return "Execute";
  if (pathname.startsWith("/markets/forecast")) return "Forecast";
  return "Scan";
}

export function Dashboard({ initialView = "results", tradeMode = "live" }: DashboardProps) {
  const pathname = usePathname();
  const [payload, setPayload] = useState<StatePayload | null>(null);
  const [status, setStatus] = useState<"Idle" | "Scanning" | "Error">("Idle");
  const [isRunning, setIsRunning] = useState(false);
  const [market, setMarket] = useState<MarketFilter>(pathname.includes("/stocks") ? "STOCKS" : "CRYPTO");
  const [timeframe, setTimeframe] = useState<TimeframeFilter>("1H");
  const [executionFocus, setExecutionFocus] = useState<SignalItem | null>(null);

  const primaryTab = useMemo(() => getPrimaryTab(pathname, initialView), [pathname, initialView]);

  const refreshState = useCallback(async () => {
    try {
      setStatus("Scanning");
      const response = await fetch(`${getApiBase()}/api/state?mode=${tradeMode}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`State request failed (${response.status})`);
      }

      const data = (await response.json()) as StatePayload;
      setPayload(data);
      setStatus("Idle");
    } catch {
      setStatus("Error");
    }
  }, [tradeMode]);

  useEffect(() => {
    void refreshState();
    const intervalId = setInterval(() => {
      void refreshState();
    }, 12000);

    return () => {
      clearInterval(intervalId);
    };
  }, [refreshState]);

  const runScan = useCallback(async () => {
    setIsRunning(true);
    await refreshState();
    setIsRunning(false);
  }, [refreshState]);

  const signals = useMemo(() => {
    const rows = payload?.results ?? [];
    const filtered = rows.filter((row) => (market === "CRYPTO" ? row.market !== "spot" : row.market === "spot"));
    return filtered.map(rowToSignalItem);
  }, [payload?.results, market]);

  const summary = useMemo(() => {
    const counts = { READY: 0, CAUTION: 0, BLOCKED: 0, BUILDING: 0 };
    for (const item of signals) {
      counts[item.state] += 1;
    }

    return {
      total: signals.length,
      ...counts,
    };
  }, [signals]);

  const forecastMetrics = useMemo(() => {
    const bullish = signals.filter((item) => item.summary.includes("upside")).length;
    const bearish = signals.filter((item) => item.summary.includes("downside")).length;
    const neutral = Math.max(0, signals.length - bullish - bearish);
    const total = Math.max(1, bullish + bearish + neutral);

    return {
      bullishPct: (bullish / total) * 100,
      bearishPct: (bearish / total) * 100,
      neutralPct: (neutral / total) * 100,
      confidence: Math.min(95, Math.max(40, (summary.READY / Math.max(1, signals.length)) * 100 + 35)),
      minRange: signals.length ? Math.min(...signals.map((item) => item.price)) : 0,
      maxRange: signals.length ? Math.max(...signals.map((item) => item.price)) : 0,
    };
  }, [signals, summary.READY]);

  const actionable = useMemo(() => signals.filter((item) => item.state === "READY" || item.state === "CAUTION").slice(0, 8), [signals]);

  const onExecuteSignal = useCallback((item: SignalItem) => {
    setExecutionFocus(item);
  }, []);

  return (
    <main className="mx-auto grid w-[min(1680px,99vw)] gap-4 px-0 py-5 text-[#E6EDF3]">
      {primaryTab === "Scan" ? (
        <>
          <ScanControlBar
            market={market}
            timeframe={timeframe}
            status={status}
            isRunning={isRunning}
            lastUpdated={payload?.analyzedAt ?? null}
            onRunScan={() => {
              void runScan();
            }}
            onMarketChange={setMarket}
            onTimeframeChange={setTimeframe}
          />

          <section className="grid grid-cols-2 gap-3 rounded-strata border border-white/10 bg-[#0F172A] p-4 shadow-strata-card md:grid-cols-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Total Scanned</p>
              <p className="mt-1 text-xl font-semibold">{summary.total}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Ready</p>
              <div className="mt-1"><SignalStateBadge state="READY" /></div>
              <p className="mt-1 text-lg font-semibold text-[#22C55E]">{summary.READY}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Caution</p>
              <div className="mt-1"><SignalStateBadge state="CAUTION" /></div>
              <p className="mt-1 text-lg font-semibold text-[#F59E0B]">{summary.CAUTION}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Blocked</p>
              <div className="mt-1"><SignalStateBadge state="BLOCKED" /></div>
              <p className="mt-1 text-lg font-semibold text-[#EF4444]">{summary.BLOCKED}</p>
            </div>
          </section>

          <section className="grid gap-3">
            {signals.map((item) => (
              <SignalCard key={item.symbol} item={item} onExecute={onExecuteSignal} />
            ))}
          </section>
        </>
      ) : null}

      {primaryTab === "Forecast" ? (
        <section className="grid gap-4 rounded-strata border border-white/10 bg-[#0F172A] p-5 shadow-strata-card">
          <header>
            <p className="text-xs uppercase tracking-[0.14em] text-[#6B859E]">Forecast Engine</p>
            <h2 className="mt-1 text-xl font-semibold">Bias Probability & Range Projection</h2>
            <p className="mt-1 text-sm text-[#9FB3C8]">Neutral analytical distribution based on current multi-timeframe structure.</p>
          </header>

          <div className="grid gap-3 md:grid-cols-3">
            {[
              { label: "Bullish", value: forecastMetrics.bullishPct, color: "from-[#22C55E] to-[#3EC6FF]" },
              { label: "Bearish", value: forecastMetrics.bearishPct, color: "from-[#EF4444] to-[#F59E0B]" },
              { label: "Neutral", value: forecastMetrics.neutralPct, color: "from-[#6B859E] to-[#9FB3C8]" },
            ].map((bar) => (
              <div key={bar.label} className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">{bar.label}</p>
                  <p className="text-sm font-semibold">{bar.value.toFixed(1)}%</p>
                </div>
                <div className="mt-2 h-2 rounded-full bg-white/10">
                  <div className={`h-2 rounded-full bg-gradient-to-r ${bar.color}`} style={{ width: `${bar.value}%` }} />
                </div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Price Range</p>
              <p className="mt-1 text-sm">${forecastMetrics.minRange.toFixed(4)} {"->"} ${forecastMetrics.maxRange.toFixed(4)}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Confidence</p>
              <p className="mt-1 text-sm">{forecastMetrics.confidence.toFixed(1)}%</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Universe</p>
              <p className="mt-1 text-sm">{summary.total} assets sampled</p>
            </div>
          </div>
        </section>
      ) : null}

      {primaryTab === "Execute" ? (
        <section className="grid gap-4 rounded-strata border border-white/10 bg-[#0F172A] p-5 shadow-strata-card">
          <header>
            <p className="text-xs uppercase tracking-[0.14em] text-[#6B859E]">Execution Panel</p>
            <h2 className="mt-1 text-xl font-semibold">Controlled Entry Queue ({tradeMode === "live" ? "Live" : "Dry Run"})</h2>
          </header>

          {executionFocus && executionFocus.state === "BLOCKED" ? (
            <div className="rounded-lg border border-[#EF4444]/40 bg-[#EF4444]/10 p-3 text-sm text-[#FCA5A5]">
              Alignment is BLOCKED for {executionFocus.symbol}. Execution is paused until structure resolves.
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2">
            {(executionFocus ? [executionFocus] : actionable).map((item) => (
              <div key={item.symbol} className="rounded-lg border border-white/10 bg-[#0B1220] p-4">
                <div className="flex items-center justify-between">
                  <p className="text-base font-semibold">{item.symbol}</p>
                  <SignalStateBadge state={item.state} />
                </div>
                <p className="mt-2 text-sm text-[#9FB3C8]">Suggested entry ${item.suggestedEntry.toFixed(4)}</p>
                <p className="text-sm text-[#9FB3C8]">HTF confirmation: {item.htfConfirmed ? "Confirmed" : "Conflicted"}</p>
                <p className="text-sm text-[#9FB3C8]">Stop ${item.stopLoss.toFixed(4)} / Exit ${item.takeProfit.toFixed(4)}</p>
                <button
                  type="button"
                  onClick={() => setExecutionFocus(item)}
                  className="mt-3 rounded-md border border-white/15 px-3 py-1.5 text-xs uppercase tracking-[0.08em] text-[#9FB3C8]"
                >
                  Focus Asset
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {primaryTab === "Simulate" ? (
        <section className="grid gap-4 rounded-strata border border-white/10 bg-[#0F172A] p-5 shadow-strata-card">
          <header>
            <p className="text-xs uppercase tracking-[0.14em] text-[#6B859E]">Simulation</p>
            <h2 className="mt-1 text-xl font-semibold">Strategy Stress Snapshot</h2>
          </header>

          <div className="grid gap-3 md:grid-cols-5">
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Total Trades</p>
              <p className="mt-1 text-lg font-semibold">{payload?.tradeSimulation?.stats?.totalTrades ?? 0}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Active</p>
              <p className="mt-1 text-lg font-semibold">{payload?.tradeSimulation?.stats?.activeTrades ?? 0}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Win Rate</p>
              <p className="mt-1 text-lg font-semibold">{Number(payload?.tradeSimulation?.stats?.winRate ?? 0).toFixed(1)}%</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Realized PnL</p>
              <p className="mt-1 text-lg font-semibold">${Number(payload?.tradeSimulation?.stats?.totalPnlUsd ?? 0).toFixed(2)}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Unrealized</p>
              <p className="mt-1 text-lg font-semibold">${Number(payload?.tradeSimulation?.stats?.unrealizedPnlUsd ?? 0).toFixed(2)}</p>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
