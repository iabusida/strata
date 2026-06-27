"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession, signIn } from "next-auth/react";
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
  results?: Array<{
    symbol?: string;
    close?: number;
  }>;
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

function normalizePriceSymbol(value: string | null | undefined): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/-(USDT|USDC|USD)-?(SWAP|PERP)?$/i, "")
    .replace(/-(SWAP|PERP)$/i, "")
    .trim();
}

function applyResultPricesToTrades(
  trades: Trade[],
  results: Array<{ symbol?: string; close?: number }> | null | undefined
): Trade[] {
  if (!Array.isArray(trades) || trades.length === 0 || !Array.isArray(results) || results.length === 0) {
    return trades;
  }

  const priceBySymbol = new Map<string, number>();
  for (const row of results) {
    const symbol = normalizePriceSymbol(row?.symbol);
    const price = Number(row?.close ?? Number.NaN);
    if (symbol && Number.isFinite(price) && price > 0) {
      priceBySymbol.set(symbol, price);
    }
  }

  if (priceBySymbol.size === 0) {
    return trades;
  }

  return trades.map((trade) => {
    const symbol = normalizePriceSymbol(trade.token);
    const nextPrice = priceBySymbol.get(symbol);
    if (!symbol || !Number.isFinite(Number(nextPrice ?? Number.NaN)) || Number(nextPrice) <= 0) {
      return trade;
    }
    return {
      ...trade,
      currentPrice: Number(nextPrice)
    };
  });
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

function CloseTradeButton({
  symbol,
  token,
  tenantId,
  onClosed
}: {
  symbol: string;
  token: string | null | undefined;
  tenantId: string;
  onClosed: (snap: { stats?: SimulationStats; activeTrades?: Trade[]; recentClosedTrades?: Trade[] }) => void;
}) {
  const [closing, setClosing] = useState(false);

  async function handleClose() {
    if (closing) return;
    setClosing(true);
    try {
      const response = await fetch(`${getApiHttpBase()}/api/trades/close-symbol`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ mode: "test", tenantId, symbol })
      });
      const body = await response.json().catch(() => ({})) as {
        stats?: SimulationStats;
        activeTrades?: Trade[];
        recentClosedTrades?: Trade[];
      };
      onClosed(body);
    } catch {
      // silently fail; websocket will sync
    } finally {
      setClosing(false);
    }
  }

  return (
    <button
      type="button"
      disabled={closing}
      onClick={() => void handleClose()}
      className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs font-semibold text-red-400 transition hover:bg-red-500/20 disabled:opacity-50"
    >
      {closing ? "..." : "✕ Close"}
    </button>
  );
}

export function SimulationHub() {
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const { token: legacyToken } = useAuth();
  const { profile, riskLevel } = useUserProfile();

  // Use NextAuth session if available, fall back to legacy auth
  const user = session?.user as any;
  const token = session?.user?.jwtToken || legacyToken;
  const isLoading = status === "loading";
  const requiresAuthGate = !isLoading && (!status || status === "unauthenticated" || !user?.organizationId);

  // Debug logs
  useEffect(() => {
    if (status !== "loading") {
      console.log("[SimulationHub] NextAuth session status:", {
        status,
        userId: user?.userId,
        organizationId: user?.organizationId,
        email: user?.email,
        hasJwt: !!user?.jwtToken
      });
    }
  }, [status, user?.userId, user?.organizationId, user?.email, user?.jwtToken]);

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
  const testTenantId = String(user?.organizationId ?? "").trim();

  const autoOpenFiredRef = useRef(false);
  const lastWsCountsRef = useRef<{ active: number; closed: number } | null>(null);
  const wsLastMessageAtRef = useRef(0);

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

  const stripPerp = (s: string) => s.replace(/-PERP$/i, "");
  const heroSymbol = stripPerp(forcedSymbol || heroTrade?.token || "--");
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
      return String(trade.token ?? "").toUpperCase().replace(/-PERP$/i, "") === forcedSymbol.replace(/-PERP$/i, "");
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

    // CRITICAL: Don't connect until we have a valid organizationId from NextAuth
    // If organizationId is missing, we'd connect to "default" and share data with other users
    if (!user?.organizationId) {
      console.log("[SimulationHub] Waiting for organizationId...", { hasUser: !!user, organizationId: user?.organizationId });
      setSocketConnected(false);
      return;
    }

    console.log("[SimulationHub] Connecting with organizationId:", user.organizationId);

    const apiBase = getApiWebSocketBase();
    let closedByCleanup = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let socket: WebSocket | null = null;

    const connect = (): void => {
      const params = new URLSearchParams({ mode: "test", tenantId: testTenantId });
      const wsUrl = `${apiBase}/ws/state?${params.toString()}`;
      console.log("[SimulationHub] Connecting to WebSocket:", { apiBase, testTenantId, wsUrl });
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        setSocketConnected(true);
        wsLastMessageAtRef.current = Date.now();
        console.log("[SimulationHub] WebSocket connected with tenantId:", testTenantId);
      };

      socket.onmessage = (event) => {
        try {
          wsLastMessageAtRef.current = Date.now();
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
          const incomingStats = {
            totalTrades: Number(stats?.totalTrades ?? Number.NaN),
            activeTrades: Number(stats?.activeTrades ?? Number.NaN),
            winRate: Number(stats?.winRate ?? Number.NaN),
            totalPnlUsd: Number(stats?.totalPnlUsd ?? Number.NaN),
            unrealizedPnlUsd: Number(stats?.unrealizedPnlUsd ?? Number.NaN)
          };

          const wsActiveCount = Array.isArray(activeTrades) ? activeTrades.length : -1;
          const wsClosedCount = Array.isArray(recentClosedTrades) ? recentClosedTrades.length : -1;
          const prevWs = lastWsCountsRef.current;
          if (!prevWs || prevWs.active !== wsActiveCount || prevWs.closed !== wsClosedCount) {
            console.log("[SimulationHub][WS] snapshot", {
              tenantId: testTenantId,
              activeCount: wsActiveCount,
              closedCount: wsClosedCount,
              totalTrades: incomingStats.totalTrades,
              activeTradesStat: incomingStats.activeTrades
            });
            lastWsCountsRef.current = { active: wsActiveCount, closed: wsClosedCount };
          }

          setSnapshot((prev) => {
            const incomingActiveTrades = applyResultPricesToTrades(
              activeTrades ?? prev.activeTrades,
              payload.results
            );
            const incomingRecentClosedTrades = recentClosedTrades ?? prev.recentClosedTrades;
            const incomingIsEmpty = incomingActiveTrades.length === 0
              && incomingRecentClosedTrades.length === 0
              && incomingStats.totalTrades === 0
              && incomingStats.activeTrades === 0;
            const hadVisibleTrades = prev.activeTrades.length > 0 || prev.recentClosedTrades.length > 0;

            // Keep visible rows stable: empty websocket frames should not wipe the table
            // after trades were already displayed in this session.
            if (incomingIsEmpty && hadVisibleTrades) {
              const repricedActiveTrades = applyResultPricesToTrades(prev.activeTrades, payload.results);
              return {
                ...prev,
                activeTrades: repricedActiveTrades
              };
            }

            return {
              stats: {
                totalTrades: Number.isFinite(incomingStats.totalTrades) ? incomingStats.totalTrades : prev.stats.totalTrades,
                activeTrades: Number.isFinite(incomingStats.activeTrades) ? incomingStats.activeTrades : prev.stats.activeTrades,
                winRate: Number.isFinite(incomingStats.winRate) ? incomingStats.winRate : prev.stats.winRate,
                totalPnlUsd: Number.isFinite(incomingStats.totalPnlUsd) ? incomingStats.totalPnlUsd : prev.stats.totalPnlUsd,
                unrealizedPnlUsd: Number.isFinite(incomingStats.unrealizedPnlUsd) ? incomingStats.unrealizedPnlUsd : prev.stats.unrealizedPnlUsd
              },
              activeTrades: incomingActiveTrades,
              recentClosedTrades: incomingRecentClosedTrades
            };
          });
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

    // WebSocket-only resilience: if stream goes stale, force reconnect.
    watchdogTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const lastMessageAt = wsLastMessageAtRef.current;
      if (lastMessageAt <= 0) {
        return;
      }

      const ageMs = Date.now() - lastMessageAt;
      if (ageMs > 20000) {
        console.warn("[SimulationHub] WebSocket stale; reconnecting", {
          tenantId: testTenantId,
          ageMs
        });
        try {
          socket.close();
        } catch {
          // no-op
        }
      }
    }, 5000);

    return () => {
      closedByCleanup = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [isLoading, testTenantId]);

  // Auto-open forced trade when FORCED mode and all params are present
  useEffect(() => {
    // Wait for session to fully load including organizationId
    // Without organizationId the trade would open under "default" tenant and immediately disappear
    if (isLoading || !token || !user?.organizationId) {
      return;
    }

    if (simulationMode !== "FORCED" || !forcedSymbol || !Number.isFinite(prefilledEntry)) {
      return;
    }

    // Guard against double-open across re-renders (token/session loading)
    if (autoOpenFiredRef.current) {
      return;
    }
    autoOpenFiredRef.current = true;

    let cancelled = false;

    async function autoOpenForcedTrade(): Promise<void> {
      if (cancelled) {
        return;
      }

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
            signalType: "FORCED_SIMULATION",
            ...(Number.isFinite(prefilledEntry) && prefilledEntry > 0 ? { entryPrice: prefilledEntry } : {})
          })
        });
        const body = await response.json().catch(() => ({})) as {
          snapshot?: {
            stats?: SimulationStats;
            activeTrades?: Trade[];
            recentClosedTrades?: Trade[];
          };
          error?: string;
          reason?: string;
        };
        const apiSnapshot = body.snapshot;
        if (apiSnapshot && !cancelled) {
          setSnapshot({
            stats: apiSnapshot.stats ?? {
              totalTrades: 0,
              activeTrades: 0,
              winRate: 0,
              totalPnlUsd: 0,
              unrealizedPnlUsd: 0
            },
            activeTrades: Array.isArray(apiSnapshot.activeTrades) ? apiSnapshot.activeTrades : [],
            recentClosedTrades: Array.isArray(apiSnapshot.recentClosedTrades) ? apiSnapshot.recentClosedTrades : []
          });
        }
        if (!response.ok) {
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
  // autoOpenFiredRef is intentionally excluded - it's a ref, not reactive state
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationMode, forcedSymbol, prefilledEntry, prefilledSide, testTenantId, token, user?.organizationId]);

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

  if (requiresAuthGate) {
    return (
      <main className="shell">
        <section className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
          <h1 className="text-lg font-semibold text-red-500">Authentication Required</h1>
          <p className="mt-2 text-sm text-slate-300">
            You must be logged in to access the simulation feature.
          </p>
          <button
            onClick={() => void signIn(undefined, { callbackUrl: "/simulation" })}
            className="mt-3 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
          >
            Sign In
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="grid gap-3">
        <section className={`rounded-lg border ${statusTone.border} ${statusTone.bg} p-3`}>
          <h1 className={`text-base font-semibold ${statusTone.text}`}>
            {simulationMode === "FORCED" ? "You Overrode Strata ⚠️" : "Strategy Simulation"}
          </h1>
          <p className="mt-1 text-xs text-slate-300">
            {simulationMode === "FORCED"
              ? "STRATA: Avoid · You: Forced Trade"
              : `STRATA: ${decision.status} · You: STRATA Simulation`}
          </p>
          <p className="mt-1.5 text-xs text-slate-200">
            {heroSymbol} | {heroSide} | Entry {Number.isFinite(heroEntry) ? formatPrice(heroEntry) : "--"} | TP {Number.isFinite(heroTp) ? formatPrice(heroTp) : "--"} | SL {Number.isFinite(heroSl) ? formatPrice(heroSl) : "--"}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">{socketConnected ? "Live simulation stream connected" : "Connecting..."}</p>
        </section>

        <section className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-slate-300">
          <p>Trades: <span className="font-semibold text-slate-100">{snapshot.stats.totalTrades}</span></p>
          <p>Win Rate: <span className="font-semibold text-slate-100">{Number(snapshot.stats.winRate).toFixed(1)}%</span></p>
          <p>PnL: <span className={`font-semibold ${netPnlUsd >= 0 ? "text-green-500" : "text-red-500"}`}>{formatUsd(netPnlUsd)}</span></p>
          <p>Active: <span className="font-semibold text-slate-100">{snapshot.stats.activeTrades}</span></p>
        </section>

        <section className="grid gap-3 lg:grid-cols-[2fr_1fr] lg:gap-4">
          <article className="rounded-lg border border-slate-800 bg-slate-900 p-3">
            <h2 className="text-sm font-semibold">Simulation</h2>

            {simulationRows.length === 0 ? (
              <div className="mt-2 rounded-lg border border-slate-800 bg-slate-900 p-2.5 text-xs text-slate-300">
                <p className="font-medium text-[#FCA5A5]">Simulation in progress — watch this play out.</p>
                <p className="mt-0.5 text-slate-400">Price will hit your TP, SL, or expire. This is where low-probability setups usually fail.</p>
              </div>
            ) : (
              <div className="mt-2 overflow-x-auto rounded-lg border border-slate-800">
                <table className="min-w-full divide-y divide-slate-800 text-xs">
                  <thead className="bg-slate-900 text-slate-300">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">Token</th>
                      <th className="px-2 py-1.5 text-left font-medium">Current</th>
                      <th className="px-2 py-1.5 text-left font-medium">Side</th>
                      <th className="px-2 py-1.5 text-left font-medium">Entry</th>
                      <th className="px-2 py-1.5 text-left font-medium">TP</th>
                      <th className="px-2 py-1.5 text-left font-medium">SL</th>
                      <th className="px-2 py-1.5 text-left font-medium">Status</th>
                      <th className="px-2 py-1.5 text-left font-medium">PnL</th>
                      <th className="px-2 py-1.5 text-left font-medium">PnL %</th>
                      <th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 bg-slate-900">
                    {simulationRows.map((trade, index) => (
                      <tr key={`${trade.token}-${trade.direction}-${index}`}>
                        <td className="px-2 py-1.5 font-medium text-slate-100">{String(trade.token ?? "").replace(/-PERP$/i, "")}</td>
                        <td className="px-2 py-1.5 text-slate-300">{formatPrice(trade.currentPrice)}</td>
                        <td className="px-2 py-1.5 text-slate-300">{trade.direction === "LONG" ? "Buy" : "Sell"}</td>
                        <td className="px-2 py-1.5 text-slate-300">{formatPrice(trade.entryPrice)}</td>
                        <td className="px-2 py-1.5 text-slate-300">{formatPrice(trade.tpPrice)}</td>
                        <td className="px-2 py-1.5 text-slate-300">{formatPrice(trade.slPrice)}</td>
                        <td className="px-2 py-1.5 text-slate-300">{trade.uiStatus}</td>
                        <td className={`px-2 py-1.5 font-medium ${trade.pnl >= 0 ? "text-green-500" : "text-red-500"}`}>{formatUsd(trade.pnl)}</td>
                        <td className={`px-2 py-1.5 font-medium ${trade.pnlPct >= 0 ? "text-green-500" : "text-red-500"}`}>{trade.pnlPct >= 0 ? "+" : ""}{trade.pnlPct.toFixed(2)}%</td>
                        <td className="px-2 py-1.5">
                          {trade.uiStatus === "Open" ? (
                            <CloseTradeButton
                              symbol={trade.token}
                              token={token}
                              tenantId={testTenantId}
                              onClosed={(snap) => setSnapshot({
                                stats: snap.stats ?? snapshot.stats,
                                activeTrades: Array.isArray(snap.activeTrades) ? snap.activeTrades : snapshot.activeTrades,
                                recentClosedTrades: Array.isArray(snap.recentClosedTrades) ? snap.recentClosedTrades : snapshot.recentClosedTrades
                              })}
                            />
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>

          <aside className="rounded-lg border border-slate-800 bg-slate-900 p-3">
            <h2 className="text-sm font-semibold">STRATA Insight</h2>
            <div className="mt-1.5 text-xs text-slate-300">
              <p className="font-medium text-slate-200">Why:</p>
              <ul className="mt-1 list-disc space-y-0.25 pl-4 text-xs">
                {whyBullets.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>

              <p className="mt-2 font-medium text-slate-200">Next:</p>
              <ul className="mt-1 space-y-0.25 text-slate-300 text-xs">
                {nextActions.map((item) => (
                  <li key={item}>→ {item}</li>
                ))}
              </ul>

              {forcedOutcomeInsight ? (
                <p className="mt-2 text-xs text-slate-200">{forcedOutcomeInsight}</p>
              ) : null}
            </div>
          </aside>
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-900 p-3">
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-slate-200">[▼ Strategy Config]</summary>
            <div className="mt-2 grid gap-0.5 text-xs text-slate-300">
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
