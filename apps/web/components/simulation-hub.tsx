"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "../contexts/auth-context";
import { useUserProfile } from "../hooks/use-user-profile";

type DecisionStatus = "AVOID" | "WEAK" | "VALID";

type Trade = {
  token: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  currentPrice: number;
  tpPrice: number;
  slPrice: number;
  status: string;
  resultUsd?: number;
  resultPct?: number;
  currentPnlUsd?: number;
  currentPnlPct?: number;
};

type SimulationStats = {
  totalTrades: number;
  activeTrades: number;
  winRate: number;
  totalPnlUsd: number;
  unrealizedPnlUsd: number;
};

type StatePayload = {
  tradeSimulation?: {
    stats?: SimulationStats;
    activeTrades?: Trade[];
    recentClosedTrades?: Trade[];
  };
};

type TradeProfileResponse = {
  setupPolicy?: {
    tpSlMode?: "ROE" | "ATR";
  };
  liquidityHunt?: {
    enabled?: boolean;
    onlyMode?: boolean;
    takeProfitPct?: number;
    stopLossPct?: number;
  };
};

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim();

function getApiHttpBase(): string {
  if (API_BASE) {
    return API_BASE.replace(/\/+$/, "");
  }

  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:8787`;
  }

  return "http://127.0.0.1:8787";
}

function getApiWebSocketBase(): string {
  if (API_BASE) {
    return API_BASE.replace(/^http/i, "ws").replace(/\/+$/, "");
  }

  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.hostname}:8787`;
  }

  return "ws://127.0.0.1:8787";
}

function formatUsd(value: number): string {
  return `$${Number.isFinite(value) ? value.toFixed(2) : "0.00"}`;
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }

  if (value >= 1) {
    return value.toFixed(2);
  }

  return value.toFixed(6);
}

function normalizeStatus(trade: Trade): string {
  const raw = String(trade.status ?? "").trim().toUpperCase();
  if (raw === "OPEN") return "Open";
  if (raw === "WIN") return "Hit TP";
  if (raw === "LOSS") return "Hit SL";
  if (raw === "CLOSED") return "Closed";
  if (raw.length === 0) return "Open";
  return "Closed";
}

function getDecision(totalTrades: number, winRate: number): { status: DecisionStatus; confidence: number; message: string; subtext: string } {
  if (totalTrades === 0 || winRate === 0) {
    return {
      status: "AVOID",
      confidence: 12,
      message: "Avoid Strategy",
      subtext: "Low confidence - do not deploy"
    };
  }

  if (winRate < 40 || totalTrades < 10) {
    return {
      status: "WEAK",
      confidence: Math.max(20, Math.min(58, Math.round((winRate * 0.8) + (totalTrades * 1.5)))),
      message: "Weak Strategy",
      subtext: "Needs optimization before live trading"
    };
  }

  return {
    status: "VALID",
    confidence: Math.max(60, Math.min(95, Math.round((winRate * 0.85) + Math.min(20, totalTrades * 0.6)))),
    message: "Valid Strategy",
    subtext: "Strategy looks solid"
  };
}

export function SimulationHub() {
  const searchParams = useSearchParams();
  const { token, user, isLoading } = useAuth();
  const { profile, riskLevel } = useUserProfile();

  const [storedPrefill, setStoredPrefill] = useState<{
    symbol?: string;
    mode?: string;
    entry?: number;
    tp?: number;
    sl?: number;
    side?: string;
    savedAt?: number;
  } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const raw = window.sessionStorage.getItem("strata.sim.prefill");
      if (!raw) {
        setStoredPrefill(null);
        return;
      }
      const parsed = JSON.parse(raw) as {
        symbol?: string;
        mode?: string;
        entry?: number;
        tp?: number;
        sl?: number;
        side?: string;
        savedAt?: number;
      };
      setStoredPrefill(parsed);
    } catch {
      setStoredPrefill(null);
    }
  }, []);

  const simulationMode = (
    String(searchParams.get("mode") ?? storedPrefill?.mode ?? "STRATA").toUpperCase() === "FORCED"
      ? "FORCED"
      : "STRATA"
  ) as "FORCED" | "STRATA";
  const forcedSymbol = String(searchParams.get("symbol") ?? storedPrefill?.symbol ?? "").trim().toUpperCase();
  const prefilledEntry = Number(searchParams.get("entry") ?? storedPrefill?.entry ?? Number.NaN);
  const prefilledTp = Number(searchParams.get("tp") ?? storedPrefill?.tp ?? Number.NaN);
  const prefilledSl = Number(searchParams.get("sl") ?? storedPrefill?.sl ?? Number.NaN);
  const prefilledSide = String(searchParams.get("side") ?? storedPrefill?.side ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY";
  const testTenantId = "default";

  const [socketConnected, setSocketConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<{ stats: SimulationStats; activeTrades: Trade[]; recentClosedTrades: Trade[] }>({
    stats: { totalTrades: 0, activeTrades: 0, winRate: 0, totalPnlUsd: 0, unrealizedPnlUsd: 0 },
    activeTrades: [],
    recentClosedTrades: []
  });
  const [profileConfig, setProfileConfig] = useState<TradeProfileResponse | null>(null);

  const decision = useMemo(
    () => getDecision(snapshot.stats.totalTrades, Number(snapshot.stats.winRate ?? 0)),
    [snapshot.stats.totalTrades, snapshot.stats.winRate]
  );

  const statusTone = useMemo(() => {
    if (decision.status === "AVOID") {
      return {
        border: "border-red-500/40",
        bg: "bg-red-500/10",
        text: "text-red-500"
      };
    }

    if (decision.status === "WEAK") {
      return {
        border: "border-yellow-400/40",
        bg: "bg-yellow-400/10",
        text: "text-yellow-400"
      };
    }

    return {
      border: "border-green-500/40",
      bg: "bg-green-500/10",
      text: "text-green-500"
    };
  }, [decision.status]);

  const netPnlUsd = Number((snapshot.stats.totalPnlUsd + snapshot.stats.unrealizedPnlUsd).toFixed(2));

  const heroTrade = useMemo(() => {
    return snapshot.activeTrades[0] ?? snapshot.recentClosedTrades[0] ?? null;
  }, [snapshot.activeTrades, snapshot.recentClosedTrades]);

  const heroSymbol = forcedSymbol || heroTrade?.token || "--";
  const heroSide = simulationMode === "FORCED"
    ? prefilledSide
    : heroTrade?.direction === "SHORT"
      ? "SELL"
      : heroTrade?.direction === "LONG"
        ? "BUY"
        : prefilledSide;
  const heroEntry = Number.isFinite(prefilledEntry) ? prefilledEntry : Number(heroTrade?.entryPrice ?? Number.NaN);
  const heroTp = Number.isFinite(prefilledTp) ? prefilledTp : Number(heroTrade?.tpPrice ?? Number.NaN);
  const heroSl = Number.isFinite(prefilledSl) ? prefilledSl : Number(heroTrade?.slPrice ?? Number.NaN);

  const simulationRows = useMemo(() => {
    const openRows = snapshot.activeTrades.map((trade) => ({
      ...trade,
      uiStatus: "Open",
      pnl: Number(trade.currentPnlUsd ?? 0),
      pnlPct: Number(trade.currentPnlPct ?? 0)
    }));

    const closedRows = snapshot.recentClosedTrades.map((trade) => ({
      ...trade,
      uiStatus: normalizeStatus(trade),
      pnl: Number(trade.resultUsd ?? 0),
      pnlPct: Number(trade.resultPct ?? 0)
    }));

    return [...openRows, ...closedRows].slice(0, 100);
  }, [snapshot.activeTrades, snapshot.recentClosedTrades]);

  const entryRules = useMemo(() => {
    const hunt = profileConfig?.liquidityHunt;
    if (!hunt?.enabled) {
      return "Standard confirmation entries";
    }
    if (hunt.onlyMode) {
      return "Liquidity-hunt only entries with confirmation";
    }
    return "Mixed entries with liquidity-hunt and standard confirmation";
  }, [profileConfig?.liquidityHunt]);

  const tpSlSummary = useMemo(() => {
    const tpSlMode = profileConfig?.setupPolicy?.tpSlMode ?? "ROE";
    const tp = Number(profileConfig?.liquidityHunt?.takeProfitPct ?? 0);
    const sl = Number(profileConfig?.liquidityHunt?.stopLossPct ?? 0);
    return `${tpSlMode} TP ${tp}% / SL ${sl}%`;
  }, [profileConfig?.liquidityHunt?.stopLossPct, profileConfig?.liquidityHunt?.takeProfitPct, profileConfig?.setupPolicy?.tpSlMode]);

  const whyBullets = useMemo(() => {
    if (decision.status === "VALID") {
      return [
        "Confirmation present",
        `Confidence (${decision.confidence}%)`,
        "Structure is aligned"
      ];
    }

    return [
      "No confirmation",
      `Low confidence (${decision.confidence}%)`,
      "Weak structure"
    ];
  }, [decision.confidence, decision.status]);

  const nextActions = useMemo(() => {
    if (decision.status === "AVOID") {
      return ["Avoid deploying", "Wait for confirmation", "Increase threshold"];
    }

    if (decision.status === "WEAK") {
      return ["Avoid deploying", "Wait for confirmation", "Increase threshold"];
    }

    return ["Maintain discipline", "Keep confirmations strict", "Scale carefully"];
  }, [decision.status]);

  const forcedOutcomeInsight = useMemo(() => {
    if (simulationMode !== "FORCED") {
      return null;
    }

    const forcedClosed = snapshot.recentClosedTrades.filter((trade) => {
      if (!forcedSymbol) {
        return true;
      }
      return String(trade.token ?? "").toUpperCase() === forcedSymbol;
    });

    if (forcedClosed.length === 0) {
      return null;
    }

    const forcedPnl = forcedClosed.reduce((sum, trade) => sum + Number(trade.resultUsd ?? 0), 0);
    if (forcedPnl < 0) {
      return "Trade failed due to low probability setup";
    }

    return "Trade succeeded despite low probability - not consistently reliable";
  }, [forcedSymbol, simulationMode, snapshot.recentClosedTrades]);

  useEffect(() => {
    if (isLoading) {
      setSocketConnected(false);
      return;
    }

    const apiBase = getApiWebSocketBase();
    let closedByCleanup = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const connect = (): void => {
      const params = new URLSearchParams({ mode: "test", tenantId: testTenantId });
      socket = new WebSocket(`${apiBase}/ws/state?${params.toString()}`);

      socket.onopen = () => {
        setSocketConnected(true);
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as StatePayload;
          if (!payload.tradeSimulation) {
            return;
          }

          const stats = payload.tradeSimulation.stats;
          const activeTrades = Array.isArray(payload.tradeSimulation.activeTrades)
            ? payload.tradeSimulation.activeTrades
            : null;
          const recentClosedTrades = Array.isArray(payload.tradeSimulation.recentClosedTrades)
            ? payload.tradeSimulation.recentClosedTrades
            : null;

          setSnapshot((prev) => ({
            stats: {
              totalTrades: Number(stats?.totalTrades ?? prev.stats.totalTrades),
              activeTrades: Number(stats?.activeTrades ?? prev.stats.activeTrades),
              winRate: Number(stats?.winRate ?? prev.stats.winRate),
              totalPnlUsd: Number(stats?.totalPnlUsd ?? prev.stats.totalPnlUsd),
              unrealizedPnlUsd: Number(stats?.unrealizedPnlUsd ?? prev.stats.unrealizedPnlUsd)
            },
            activeTrades: activeTrades ?? prev.activeTrades,
            recentClosedTrades: recentClosedTrades ?? prev.recentClosedTrades
          }));
        } catch {
          // Keep last known snapshot if payload cannot be parsed.
        }
      };

      socket.onclose = () => {
        setSocketConnected(false);
        if (closedByCleanup) {
          return;
        }
        reconnectTimeout = setTimeout(connect, 2500);
      };

      socket.onerror = () => {
        setSocketConnected(false);
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.close();
        }
      };
    };

    connect();

    return () => {
      closedByCleanup = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [isLoading, testTenantId]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    let cancelled = false;

    async function refreshSnapshot(): Promise<void> {
      try {
        const params = new URLSearchParams({ mode: "test", tenantId: testTenantId });
        const response = await fetch(`${getApiHttpBase()}/api/trades?${params.toString()}`, {
          cache: "no-store",
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          }
        });

        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as {
          stats?: SimulationStats;
          activeTrades?: Trade[];
          recentClosedTrades?: Trade[];
        };

        if (cancelled) {
          return;
        }

        setSnapshot((prev) => ({
          stats: {
            totalTrades: Number(payload.stats?.totalTrades ?? prev.stats.totalTrades),
            activeTrades: Number(payload.stats?.activeTrades ?? prev.stats.activeTrades),
            winRate: Number(payload.stats?.winRate ?? prev.stats.winRate),
            totalPnlUsd: Number(payload.stats?.totalPnlUsd ?? prev.stats.totalPnlUsd),
            unrealizedPnlUsd: Number(payload.stats?.unrealizedPnlUsd ?? prev.stats.unrealizedPnlUsd)
          },
          activeTrades: Array.isArray(payload.activeTrades) ? payload.activeTrades : prev.activeTrades,
          recentClosedTrades: Array.isArray(payload.recentClosedTrades) ? payload.recentClosedTrades : prev.recentClosedTrades
        }));
      } catch {
        // Keep websocket state if HTTP refresh fails.
      }
    }

    void refreshSnapshot();
    const timer = setInterval(() => {
      void refreshSnapshot();
    }, 6000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isLoading, token, testTenantId]);

  // Auto-open forced trade when FORCED mode and all params are present
  useEffect(() => {
    if (isLoading || !token) {
      return;
    }

    if (simulationMode !== "FORCED" || !forcedSymbol || !Number.isFinite(prefilledEntry)) {
      return;
    }

    let cancelled = false;
    let autoOpenAttempted = false;

    async function autoOpenForcedTrade(): Promise<void> {
      if (autoOpenAttempted || cancelled) {
        return;
      }
      autoOpenAttempted = true;

      try {
        const response = await fetch(`${getApiHttpBase()}/api/trades/open-manual`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify({
            mode: "test",
            tenantId: testTenantId,
            symbol: forcedSymbol,
            direction: prefilledSide === "SELL" ? "SHORT" : "LONG",
            signalType: "FORCED_SIMULATION"
          })
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          console.warn(`[simulation-hub] auto-open failed for ${forcedSymbol}:`, {
            status: response.status,
            error: body.error,
            reason: body.reason
          });
        }
        // Ignore response; websocket will deliver updated state
      } catch (error) {
        console.warn(`[simulation-hub] auto-open error for ${forcedSymbol}:`, error);
      }
    }

    void autoOpenForcedTrade();
    return () => { cancelled = true; };
  }, [isLoading, token, simulationMode, forcedSymbol, prefilledEntry, prefilledSide, testTenantId]);

  useEffect(() => {
    let cancelled = false;

    async function loadProfileConfig(): Promise<void> {
      try {
        const response = await fetch(`${getApiHttpBase()}/api/trades/profile`, { cache: "no-store" });
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as TradeProfileResponse;
        if (!cancelled) {
          setProfileConfig(payload);
        }
      } catch {
        if (!cancelled) {
          setProfileConfig(null);
        }
      }
    }

    void loadProfileConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto w-[min(1280px,96vw)] py-4 text-slate-100">
      <div className="grid gap-4">
        <section className={`rounded-xl border ${statusTone.border} ${statusTone.bg} p-4`}>
          <h1 className={`text-xl font-semibold ${statusTone.text}`}>
            {simulationMode === "FORCED" ? "Forced Trade Simulation ⚠️" : "Strategy Simulation"}
          </h1>
          <p className="mt-1 text-sm text-slate-300">
            {simulationMode === "FORCED"
              ? "STRATA: Avoid | You: Forced Trade"
              : `STRATA: ${decision.status} | You: STRATA Simulation`}
          </p>
          <p className="mt-2 text-sm text-slate-200">
            {heroSymbol} | {heroSide} | Entry {Number.isFinite(heroEntry) ? formatPrice(heroEntry) : "--"} | TP {Number.isFinite(heroTp) ? formatPrice(heroTp) : "--"} | SL {Number.isFinite(heroSl) ? formatPrice(heroSl) : "--"}
          </p>
          <p className="mt-1 text-xs text-slate-400">{socketConnected ? "Live simulation stream connected" : "Connecting to simulation stream..."}</p>
        </section>

        <section className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-slate-300">
          <p>Trades: <span className="font-semibold text-slate-100">{snapshot.stats.totalTrades}</span></p>
          <p>Win Rate: <span className="font-semibold text-slate-100">{Number(snapshot.stats.winRate).toFixed(1)}%</span></p>
          <p>PnL: <span className={`font-semibold ${netPnlUsd >= 0 ? "text-green-500" : "text-red-500"}`}>{formatUsd(netPnlUsd)}</span></p>
          <p>Active: <span className="font-semibold text-slate-100">{snapshot.stats.activeTrades}</span></p>
        </section>

        <section className="grid gap-4 lg:grid-cols-[2fr_1fr] lg:gap-6">
          <article className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <h2 className="text-lg font-semibold">Simulation</h2>

            {simulationRows.length === 0 ? (
              <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-300">
                <p className="font-medium text-slate-200">Simulation in progress...</p>
                <p className="mt-1">Watch how price interacts with:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  <li>entry</li>
                  <li>stop loss</li>
                  <li>target</li>
                </ul>
                <p className="mt-2 text-slate-400">This is where forced trades usually fail</p>
              </div>
            ) : (
              <div className="mt-3 overflow-x-auto rounded-xl border border-slate-800">
                <table className="min-w-full divide-y divide-slate-800 text-sm">
                  <thead className="bg-slate-900 text-slate-300">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Token</th>
                      <th className="px-3 py-2 text-left font-medium">Side</th>
                      <th className="px-3 py-2 text-left font-medium">Entry</th>
                      <th className="px-3 py-2 text-left font-medium">TP</th>
                      <th className="px-3 py-2 text-left font-medium">SL</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                      <th className="px-3 py-2 text-left font-medium">PnL</th>
                      <th className="px-3 py-2 text-left font-medium">PnL %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 bg-slate-900">
                    {simulationRows.map((trade, index) => (
                      <tr key={`${trade.token}-${trade.direction}-${index}`}>
                        <td className="px-3 py-2 font-medium text-slate-100">{trade.token}</td>
                        <td className="px-3 py-2 text-slate-300">{trade.direction === "LONG" ? "Buy" : "Sell"}</td>
                        <td className="px-3 py-2 text-slate-300">{formatPrice(trade.entryPrice)}</td>
                        <td className="px-3 py-2 text-slate-300">{formatPrice(trade.tpPrice)}</td>
                        <td className="px-3 py-2 text-slate-300">{formatPrice(trade.slPrice)}</td>
                        <td className="px-3 py-2 text-slate-300">{trade.uiStatus}</td>
                        <td className={`px-3 py-2 font-medium ${trade.pnl >= 0 ? "text-green-500" : "text-red-500"}`}>{formatUsd(trade.pnl)}</td>
                        <td className={`px-3 py-2 font-medium ${trade.pnlPct >= 0 ? "text-green-500" : "text-red-500"}`}>{trade.pnlPct >= 0 ? "+" : ""}{trade.pnlPct.toFixed(2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>

          <aside className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <h2 className="text-lg font-semibold">STRATA Insight</h2>
            <div className="mt-2 text-sm text-slate-300">
              <p className="font-medium text-slate-200">Why:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {whyBullets.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>

              <p className="mt-3 font-medium text-slate-200">Next:</p>
              <ul className="mt-1 space-y-0.5 text-slate-300">
                {nextActions.map((item) => (
                  <li key={item}>-&gt; {item}</li>
                ))}
              </ul>

              {forcedOutcomeInsight ? (
                <p className="mt-3 text-sm text-slate-200">{forcedOutcomeInsight}</p>
              ) : null}
            </div>
          </aside>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <details>
            <summary className="cursor-pointer text-base font-semibold text-slate-200">[▼ Strategy Config]</summary>
            <div className="mt-3 grid gap-1 text-sm text-slate-300">
              <p><span className="text-slate-400">Mode:</span> {String(profile).replace(/_/g, " ")}</p>
              <p><span className="text-slate-400">Risk:</span> {String(riskLevel).replace(/_/g, " ")}</p>
              <p><span className="text-slate-400">Entry rules:</span> {entryRules}</p>
              <p><span className="text-slate-400">TP/SL:</span> {tpSlSummary}</p>
            </div>
          </details>
        </section>
      </div>
    </main>
  );
}
