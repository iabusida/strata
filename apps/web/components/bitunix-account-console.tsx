"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../contexts/auth-context";

type BitunixAuthState = {
  configured: boolean;
  missing: string[];
  keyPreview: string | null;
};

type BitunixAccountRow = {
  marginCoin?: string;
  available?: string;
  frozen?: string;
  margin?: string;
  transfer?: string;
  positionMode?: string;
  crossUnrealizedPNL?: string;
  isolationUnrealizedPNL?: string;
  bonus?: string;
};

type BitunixPositionRow = {
  positionId?: string;
  symbol?: string;
  qty?: string;
  entryValue?: string;
  side?: string;
  marginMode?: string;
  leverage?: number;
  margin?: string;
  unrealizedPNL?: string;
  realizedPNL?: string;
  markPrice?: string;
  liqPrice?: string;
  avgOpenPrice?: string;
  mtime?: number;
};

type BitunixAccountSnapshot = {
  provider: "BITUNIX";
  fetchedAt: string;
  marginCoin: string;
  account: BitunixAccountRow | null;
  positions: BitunixPositionRow[];
  positionSummary: {
    openPositions: number;
    longPositions: number;
    shortPositions: number;
    grossNotionalUsd: number;
    netUnrealizedPnlUsd: number;
    totalMarginUsd: number;
  };
  auth: BitunixAuthState;
};

type ApiError = {
  error?: string;
  details?: string;
  provider?: string;
  expectedProvider?: string;
  auth?: BitunixAuthState;
};

type SocketStatus = "CONNECTING" | "LIVE" | "RECONNECTING";

type ActiveTradeRow = {
  token?: string;
  direction?: "LONG" | "SHORT";
  currentPrice?: number;
  entryPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  isLiveTrade?: boolean;
};

type TradesSnapshotResponse = {
  activeTrades?: ActiveTradeRow[];
};

type TradeProfileResponse = {
  setupPolicy?: {
    tpSlMode?: "ROE" | "ATR";
  };
  liquidityHunt?: {
    enabled?: boolean;
    onlyMode?: boolean;
    leverage?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
  };
};

type UiContextResponse = {
  exchangeProviderLabel?: string;
};

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim();
const DEFAULT_MARGIN_COIN = "USDT";
const SOCKET_RETRY_MS = 1500;

function getApiHttpBase(): string {
  if (API_BASE) {
    return API_BASE.replace(/\/+$/, "");
  }

  return "";
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

function normalizeTradeSymbolKey(raw: string | undefined): string {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) {
    return "";
  }

  if (value.endsWith("-PERP")) {
    return value.slice(0, -5);
  }

  if (value.endsWith("USDT")) {
    return value.slice(0, -4);
  }

  return value;
}

function normalizeTradeSideKey(raw: string | undefined): "LONG" | "SHORT" | "" {
  const value = String(raw ?? "").trim().toUpperCase();
  if (value === "LONG" || value === "BUY") {
    return "LONG";
  }
  if (value === "SHORT" || value === "SELL") {
    return "SHORT";
  }

  return "";
}

function formatUsd(value: number | string | undefined, fractionDigits: number = 2): string {
  const parsed = typeof value === "number" ? value : Number(value ?? NaN);
  if (!Number.isFinite(parsed)) {
    return "-";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits
  }).format(parsed);
}

function formatSignedUsd(value: number | string | undefined, fractionDigits: number = 4): string {
  const parsed = typeof value === "number" ? value : Number(value ?? NaN);
  if (!Number.isFinite(parsed)) {
    return "-";
  }

  const prefix = parsed > 0 ? "+" : "";
  return `${prefix}${formatUsd(parsed, fractionDigits)}`;
}

function formatSignedNumber(value: number | string | undefined, fractionDigits: number = 4): string {
  const parsed = typeof value === "number" ? value : Number(value ?? NaN);
  if (!Number.isFinite(parsed)) {
    return "-";
  }

  const prefix = parsed > 0 ? "+" : "";
  return `${prefix}${parsed.toFixed(fractionDigits)}`;
}

function formatSignedPercent(value: number | string | undefined, fractionDigits: number = 2): string {
  const parsed = typeof value === "number" ? value : Number(value ?? NaN);
  if (!Number.isFinite(parsed)) {
    return "-";
  }

  const prefix = parsed > 0 ? "+" : "";
  return `${prefix}${parsed.toFixed(fractionDigits)}%`;
}

function formatTimestamp(value: number | string | undefined): string {
  const millis = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isFinite(millis) || millis <= 0) {
    return "-";
  }

  return new Date(millis).toLocaleString();
}

function calculateTotalBalance(account: BitunixAccountRow | null | undefined): number {
  if (!account) return 0;
  const available = Number(account.available ?? 0);
  const frozen = Number(account.frozen ?? 0);
  const margin = Number(account.margin ?? 0);
  const bonus = Number(account.bonus ?? 0);
  return available + frozen + margin + bonus;
}

export function BitunixAccountConsole() {
  const { user } = useAuth();
  const apiHttpBase = useMemo(() => getApiHttpBase(), []);
  const apiWsBase = useMemo(() => getApiWebSocketBase(), []);

  const [snapshot, setSnapshot] = useState<BitunixAccountSnapshot | null>(null);
  const [liveTargetsByPosition, setLiveTargetsByPosition] = useState<
    Record<string, { tpPrice: number; slPrice: number; currentPrice: number; entryPrice: number }>
  >({});
  const [tradeProfile, setTradeProfile] = useState<TradeProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marginCoin, setMarginCoin] = useState(DEFAULT_MARGIN_COIN);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("CONNECTING");
  const [exchangeProviderLabel, setExchangeProviderLabel] = useState("EXCHANGE");
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadUiContext(): Promise<void> {
      try {
        const response = await fetch(`${apiHttpBase}/api/ui/context`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as UiContextResponse;
        if (!cancelled && payload.exchangeProviderLabel) {
          setExchangeProviderLabel(String(payload.exchangeProviderLabel).toUpperCase());
        }
      } catch {
        // Keep fallback label.
      }
    }

    void loadUiContext();
    return () => {
      cancelled = true;
    };
  }, [apiHttpBase]);

  const loadSnapshot = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setError(null);

    try {
      const response = await fetch(
        `${apiHttpBase}/api/bitunix/account?marginCoin=${encodeURIComponent(marginCoin)}`,
        { cache: "no-store" }
      );
      const payload = (await response.json()) as BitunixAccountSnapshot & ApiError;
      if (!response.ok) {
        throw new Error(payload.details ?? payload.error ?? `Request failed (${response.status})`);
      }

      setSnapshot(payload as BitunixAccountSnapshot);
      setLoading(false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setRefreshing(false);
    }
  }, [marginCoin, apiHttpBase]);

  useEffect(() => {
    let cancelled = false;

    async function loadProfile(): Promise<void> {
      try {
        const profileResponse = await fetch(`${apiHttpBase}/api/trades/profile`, { cache: "no-store" });
        if (!profileResponse.ok) {
          return;
        }

        const profilePayload = (await profileResponse.json().catch(() => ({}))) as TradeProfileResponse;
        if (!cancelled) {
          setTradeProfile(profilePayload);
        }
      } catch {
        if (!cancelled) {
          setTradeProfile(null);
        }
      }
    }

    void loadProfile();
    return () => {
      cancelled = true;
    };
  }, [apiHttpBase]);

  useEffect(() => {
    let closedByCleanup = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const connect = (): void => {
      const params = new URLSearchParams({ mode: "live" });
      if (user?.organizationId) {
        params.set("tenantId", user.organizationId);
      }
      socket = new WebSocket(`${apiWsBase}/ws/state?${params.toString()}`);

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as { tradeSimulation?: TradesSnapshotResponse };
          const next: Record<string, { tpPrice: number; slPrice: number; currentPrice: number; entryPrice: number }> = {};
          const activeTrades = Array.isArray(payload.tradeSimulation?.activeTrades)
            ? payload.tradeSimulation?.activeTrades
            : [];

          for (const trade of activeTrades) {
            if (!trade.isLiveTrade) {
              continue;
            }

            const symbol = normalizeTradeSymbolKey(trade.token);
            const side = normalizeTradeSideKey(trade.direction);
            const currentPrice = Number(trade.currentPrice ?? NaN);
            const entryPrice = Number(trade.entryPrice ?? NaN);
            const tpPrice = Number(trade.tpPrice ?? NaN);
            const slPrice = Number(trade.slPrice ?? NaN);
            if (!symbol || !side) {
              continue;
            }

            if (!Number.isFinite(tpPrice) || !Number.isFinite(slPrice) || !Number.isFinite(currentPrice) || !Number.isFinite(entryPrice)) {
              continue;
            }

            next[`${symbol}:${side}`] = {
              tpPrice,
              slPrice,
              currentPrice,
              entryPrice
            };
          }

          setLiveTargetsByPosition(next);
        } catch {
          // Keep last known targets when stream payload is malformed.
        }
      };

      socket.onclose = () => {
        if (closedByCleanup) {
          return;
        }

        reconnectTimeout = setTimeout(() => {
          connect();
        }, 3000);
      };

      socket.onerror = () => {
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
  }, [apiWsBase, user?.organizationId]);

  const fallbackTpSlConfig = useMemo(() => {
    const tpSlMode = tradeProfile?.setupPolicy?.tpSlMode;
    const hunt = tradeProfile?.liquidityHunt;
    if (tpSlMode !== "ROE" || !hunt?.enabled) {
      return null;
    }

    const takeProfitPct = Number(hunt.takeProfitPct ?? NaN);
    const stopLossPct = Number(hunt.stopLossPct ?? NaN);
    if (!Number.isFinite(takeProfitPct) || !Number.isFinite(stopLossPct) || takeProfitPct <= 0 || stopLossPct <= 0) {
      return null;
    }

    return {
      takeProfitPct,
      stopLossPct
    };
  }, [tradeProfile]);

  const socketUrl = useMemo(() => {
    const base = new URL(apiWsBase);
    base.pathname = "/ws/bitunix-account";
    base.search = "";
    base.searchParams.set("marginCoin", marginCoin);
    return base.toString();
  }, [marginCoin, apiWsBase]);

  useEffect(() => {
    let active = true;

    const connect = (): void => {
      if (!active || marginCoin.length === 0) {
        return;
      }

      setSocketStatus((prev) => (prev === "LIVE" ? "RECONNECTING" : "CONNECTING"));
      const ws = new WebSocket(socketUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        if (!active) {
          ws.close();
          return;
        }

        setSocketStatus("LIVE");
      };

      ws.onmessage = (event) => {
        if (!active) {
          return;
        }

        try {
          const payload = JSON.parse(String(event.data)) as BitunixAccountSnapshot & ApiError;
          if (payload.error) {
            setError(payload.details ?? payload.error);
            setLoading(false);
            return;
          }

          setSnapshot(payload as BitunixAccountSnapshot);
          setError(null);
          setLoading(false);
        } catch {
          setError("Invalid websocket payload received from API.");
          setLoading(false);
        }
      };

      ws.onerror = () => {
        if (!active) {
          return;
        }

        setSocketStatus("RECONNECTING");
      };

      ws.onclose = () => {
        if (!active) {
          return;
        }

        setSocketStatus("RECONNECTING");
        reconnectTimerRef.current = setTimeout(() => {
          connect();
        }, SOCKET_RETRY_MS);
      };
    };

    setLoading(true);
    setError(null);
    connect();

    return () => {
      active = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [marginCoin, socketUrl]);

  const fetchedAtLabel = useMemo(() => {
    if (!snapshot?.fetchedAt) {
      return "-";
    }
    return formatTimestamp(snapshot.fetchedAt);
  }, [snapshot]);

  const openPositionsCount = snapshot?.positions.length ?? 0;

  return (
    <main className="shell bitunix-account-shell bitunix-terminal-shell">
      <section className="panel bitunix-terminal-panel">
        <div className="bitunix-terminal-head">
          <div>
            <p className="eyebrow">{exchangeProviderLabel} Mirror</p>
            <p className="brand-subtitle">Live account terminal stream</p>
          </div>
        </div>

        <div className="bitunix-terminal-tabs" role="tablist" aria-label="Account Tabs">
          <button type="button" className="bitunix-tab active" aria-selected="true">Positions ({openPositionsCount})</button>
          <button type="button" className="bitunix-tab" aria-selected="false">Open Orders (0)</button>
          <button type="button" className="bitunix-tab" aria-selected="false">Order History</button>
          <button type="button" className="bitunix-tab" aria-selected="false">Position History</button>
          <button type="button" className="bitunix-tab" aria-selected="false">Trade History</button>
          <button type="button" className="bitunix-tab" aria-selected="false">Assets</button>
        </div>

        <section className="bitunix-account-controls bitunix-terminal-controls">
          <label htmlFor="margin-coin">Margin Coin</label>
          <input
            id="margin-coin"
            value={marginCoin}
            maxLength={12}
            onChange={(event) => setMarginCoin(event.target.value.toUpperCase().trim())}
            placeholder="USDT"
          />
          <button
            type="button"
            className="settings-toggle bitunix-refresh-btn"
            onClick={() => void loadSnapshot()}
            disabled={loading || refreshing || marginCoin.length === 0}
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <span className={`bitunix-live-badge ${socketStatus === "LIVE" ? "live" : "reconnecting"}`}>
            {socketStatus === "LIVE" ? "Live WS" : "Reconnecting WS"}
          </span>
          <p className="settings-note">Last updated: {fetchedAtLabel}</p>
        </section>

        {!loading && !error && snapshot ? (
          <section className="bitunix-compact-metrics">
            <div className="bitunix-metric">
              <span>Available</span>
              <strong>{formatUsd(snapshot.account?.available, 4)}</strong>
            </div>
            <div className="bitunix-metric">
              <span>Frozen</span>
              <strong>{formatUsd(snapshot.account?.frozen, 4)}</strong>
            </div>
            <div className="bitunix-metric">
              <span>Position Margin</span>
              <strong>{formatUsd(snapshot.account?.margin, 4)}</strong>
            </div>
            <div className="bitunix-metric">
              <span>Total Balance</span>
              <strong>{formatUsd(calculateTotalBalance(snapshot.account), 4)}</strong>
            </div>
            <div className="bitunix-metric">
              <span>Cross UPNL</span>
              <strong className={Number(snapshot.account?.crossUnrealizedPNL ?? 0) >= 0 ? "upnl-positive" : "upnl-negative"}>
                {formatSignedUsd(snapshot.account?.crossUnrealizedPNL, 4)}
              </strong>
            </div>
            <div className="bitunix-metric">
              <span>Open Positions</span>
              <strong>{snapshot.positionSummary.openPositions}</strong>
            </div>
            <div className="bitunix-metric">
              <span>Gross Notional</span>
              <strong>{formatUsd(snapshot.positionSummary.grossNotionalUsd, 2)}</strong>
            </div>
            <div className="bitunix-metric">
              <span>Net Unrealized PnL</span>
              <strong className={snapshot.positionSummary.netUnrealizedPnlUsd >= 0 ? "upnl-positive" : "upnl-negative"}>
                {formatSignedUsd(snapshot.positionSummary.netUnrealizedPnlUsd, 4)}
              </strong>
            </div>
          </section>
        ) : null}

        {loading ? <p className="section-collapsed-note">Loading {exchangeProviderLabel} account snapshot...</p> : null}
        {error ? <p className="error">{error}</p> : null}

        {!loading && !error && snapshot ? (
          <section className="bitunix-positions-panel">
            {snapshot.positions.length === 0 ? (
              <p className="section-collapsed-note">No open {exchangeProviderLabel} futures positions.</p>
            ) : (
              <div className="bitunix-terminal-table-wrap">
                <table className="trade-table bitunix-positions-table">
                  <thead>
                    <tr>
                      <th>Futures</th>
                      <th>Size</th>
                      <th>Entry Price</th>
                      <th>Mark Price</th>
                      <th>TP Price</th>
                      <th>SL Price</th>
                      <th>Progress</th>
                      <th>Est. Liq. Price</th>
                      <th>Unrealized PnL</th>
                      <th>Realized PnL</th>
                      <th>Margin</th>
                      <th>Margin Mode</th>
                      <th>Leverage</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.positions.map((position) => {
                      const side = normalizeTradeSideKey(position.side);
                      const symbolKey = normalizeTradeSymbolKey(position.symbol);
                      const liveKey = `${symbolKey}:${side}`;
                      const liveTargets = liveTargetsByPosition[liveKey] ?? null;
                      const entryPrice = Number(position.avgOpenPrice ?? NaN);
                      const qty = Math.abs(Number(position.qty ?? NaN));
                      const unrealizedPnl = Number(position.unrealizedPNL ?? NaN);
                      const inferredMarkPrice = (() => {
                        if (!side || !Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unrealizedPnl)) {
                          return NaN;
                        }

                        return side === "LONG"
                          ? entryPrice + (unrealizedPnl / qty)
                          : entryPrice - (unrealizedPnl / qty);
                      })();
                      const exchangeMarkPrice = Number(position.markPrice ?? NaN);
                      const derivedTargets = (() => {
                        if (liveTargets || !fallbackTpSlConfig || !side) {
                          return null;
                        }

                        const leverage = Number(position.leverage ?? NaN);
                        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(leverage) || leverage <= 0) {
                          return null;
                        }

                        const tpMoveAbs = entryPrice * (fallbackTpSlConfig.takeProfitPct / 100 / leverage);
                        const slMoveAbs = entryPrice * (fallbackTpSlConfig.stopLossPct / 100 / leverage);
                        const tpPrice = side === "LONG" ? entryPrice + tpMoveAbs : entryPrice - tpMoveAbs;
                        const slPrice = side === "LONG" ? entryPrice - slMoveAbs : entryPrice + slMoveAbs;

                        const currentPrice = Number.isFinite(inferredMarkPrice)
                          ? inferredMarkPrice
                          : entryPrice;

                        return {
                          tpPrice,
                          slPrice,
                          currentPrice,
                          entryPrice
                        };
                      })();
                      const effectiveTargets = liveTargets ?? derivedTargets;
                      const currentMarkPrice = Number.isFinite(exchangeMarkPrice)
                        ? exchangeMarkPrice
                        : Number.isFinite(inferredMarkPrice)
                          ? inferredMarkPrice
                          : effectiveTargets?.currentPrice;
                      const progressPct = (() => {
                        if (!effectiveTargets) {
                          return 0;
                        }

                        const tp = effectiveTargets.tpPrice;
                        const sl = effectiveTargets.slPrice;
                        const current = currentMarkPrice;
                        if (!Number.isFinite(tp) || !Number.isFinite(sl) || !Number.isFinite(current)) {
                          return 0;
                        }

                        const denominator = tp - sl;
                        if (denominator === 0) {
                          return 50;
                        }

                        const raw = ((current - sl) / denominator) * 100;
                        return Math.max(0, Math.min(100, raw));
                      })();
                      const tpGoalProgress = (() => {
                        if (!effectiveTargets || !side) {
                          return null;
                        }

                        const entry = effectiveTargets.entryPrice;
                        const current = currentMarkPrice;
                        const tp = effectiveTargets.tpPrice;
                        const leverage = Number(position.leverage ?? NaN);
                        if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(current) || !Number.isFinite(tp)) {
                          return null;
                        }
                        if (!Number.isFinite(leverage) || leverage <= 0) {
                          return null;
                        }

                        const currentMove = side === "LONG" ? (current - entry) / entry : (entry - current) / entry;
                        const tpMove = side === "LONG" ? (tp - entry) / entry : (entry - tp) / entry;
                        const currentRoePct = currentMove * leverage * 100;
                        const tpGoalRoePct = tpMove * leverage * 100;
                        if (!Number.isFinite(currentRoePct) || !Number.isFinite(tpGoalRoePct) || tpGoalRoePct <= 0) {
                          return null;
                        }

                        const completionPct = (currentRoePct / tpGoalRoePct) * 100;
                        return {
                          currentRoePct,
                          tpGoalRoePct,
                          completionPct
                        };
                      })();
                      const progressRatio = progressPct / 100;
                      const progressHue = Math.round(progressRatio * 120);
                      const progressColor = `hsl(${progressHue}, 80%, 58%)`;
                      const upnl = Number(position.unrealizedPNL ?? NaN);
                      const realizedPnl = Number(position.realizedPNL ?? NaN);
                      const sideClass = side === "LONG"
                        ? "long"
                        : side === "SHORT"
                          ? "short"
                          : "neutral";
                      return (
                        <tr key={position.positionId ?? `${position.symbol}-${position.side}-${position.mtime ?? 0}`}>
                          <td>
                            <div className="bitunix-symbol-cell">
                              <strong>{position.symbol ?? "-"}</strong>
                              <span className={side === "LONG" ? "position-side long" : side === "SHORT" ? "position-side short" : "position-side"}>
                                {side || "-"}
                              </span>
                            </div>
                          </td>
                          <td>{position.qty ?? "-"}</td>
                          <td>{position.avgOpenPrice ?? "-"}</td>
                          <td>{Number.isFinite(currentMarkPrice) ? Number(currentMarkPrice).toFixed(6) : position.avgOpenPrice ?? "-"}</td>
                          <td>{effectiveTargets ? effectiveTargets.tpPrice.toFixed(6) : "-"}</td>
                          <td>{effectiveTargets ? effectiveTargets.slPrice.toFixed(6) : "-"}</td>
                          <td>
                            {effectiveTargets ? (
                              <div className="bitunix-progress-cell">
                                <div className="trade-progress" title={`Progress ${progressPct.toFixed(1)}%`}>
                                  <span className="trade-progress-fill" style={{ width: `${progressPct}%`, background: progressColor }} />
                                </div>
                                {tpGoalProgress ? (
                                  <span className={`bitunix-progress-label ${tpGoalProgress.currentRoePct >= 0 ? "upnl-positive" : "upnl-negative"}`}>
                                    {`${formatSignedPercent(tpGoalProgress.currentRoePct, 2)} / ${tpGoalProgress.tpGoalRoePct.toFixed(2)}% TP (${tpGoalProgress.completionPct.toFixed(1)}%)`}
                                  </span>
                                ) : null}
                              </div>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td>{position.liqPrice ?? "-"}</td>
                          <td className={Number.isFinite(upnl) && upnl < 0 ? "upnl-negative" : "upnl-positive"}>
                            <div className="bitunix-pnl-stack">
                              <span className="bitunix-pnl-primary">{formatSignedNumber(position.unrealizedPNL, 4)} USDT</span>
                              <span className="bitunix-pnl-secondary">≈ {formatSignedUsd(position.unrealizedPNL, 2)}</span>
                            </div>
                          </td>
                          <td className={Number.isFinite(realizedPnl) && realizedPnl < 0 ? "upnl-negative" : "upnl-positive"}>
                            <div className="bitunix-pnl-stack">
                              <span className="bitunix-pnl-primary">{formatSignedNumber(position.realizedPNL, 4)} USDT</span>
                              <span className="bitunix-pnl-secondary">≈ {formatSignedUsd(position.realizedPNL, 2)}</span>
                            </div>
                          </td>
                          <td>{formatUsd(position.margin, 4)}</td>
                          <td>{position.marginMode ?? "-"}</td>
                          <td>
                            <span className={`bitunix-leverage ${sideClass}`}>
                              {position.leverage != null ? `${position.leverage}x` : "-"}
                            </span>
                          </td>
                          <td>{formatTimestamp(position.mtime)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}

        {!loading && !error && snapshot ? (
          <section className="bitunix-meta-strip">
            <span>Transferable: {formatUsd(snapshot.account?.transfer, 4)}</span>
            <span>Isolation UPNL: {formatSignedUsd(snapshot.account?.isolationUnrealizedPNL, 4)}</span>
            <span>Total Margin: {formatUsd(snapshot.positionSummary.totalMarginUsd, 4)}</span>
            <span>Auth: {snapshot.auth.configured ? "Configured" : "Missing Keys"}</span>
            <span>Key: {snapshot.auth.keyPreview ?? "-"}</span>
          </section>
        ) : null}
      </section>
    </main>
  );
}
