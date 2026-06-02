"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787";
const DEFAULT_MARGIN_COIN = "USDT";
const SOCKET_RETRY_MS = 1500;

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

function formatTimestamp(value: number | string | undefined): string {
  const millis = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isFinite(millis) || millis <= 0) {
    return "-";
  }

  return new Date(millis).toLocaleString();
}

export function BitunixAccountConsole() {
  const [snapshot, setSnapshot] = useState<BitunixAccountSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marginCoin, setMarginCoin] = useState(DEFAULT_MARGIN_COIN);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("CONNECTING");
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const loadSnapshot = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setError(null);

    try {
      const response = await fetch(
        `${API_BASE}/api/bitunix/account?marginCoin=${encodeURIComponent(marginCoin)}`,
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
  }, [marginCoin]);

  const socketUrl = useMemo(() => {
    const base = new URL(API_BASE);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = "/ws/bitunix-account";
    base.search = "";
    base.searchParams.set("marginCoin", marginCoin);
    return base.toString();
  }, [marginCoin]);

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
            <p className="eyebrow">Bitunix Mirror</p>
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
          <p className="endpoint-indicator">API Endpoint: <span>{API_BASE}</span></p>
        </section>

        {!loading && !error && snapshot ? (
          <section className="bitunix-compact-metrics">
            <div className="bitunix-metric">
              <span>Available</span>
              <strong>{formatUsd(snapshot.account?.available, 4)}</strong>
            </div>
            <div className="bitunix-metric">
              <span>Position Margin</span>
              <strong>{formatUsd(snapshot.account?.margin, 4)}</strong>
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

        {loading ? <p className="section-collapsed-note">Loading Bitunix account snapshot...</p> : null}
        {error ? <p className="error">{error}</p> : null}

        {!loading && !error && snapshot ? (
          <section className="bitunix-positions-panel">
            {snapshot.positions.length === 0 ? (
              <p className="section-collapsed-note">No open Bitunix futures positions.</p>
            ) : (
              <div className="bitunix-terminal-table-wrap">
                <table className="trade-table bitunix-positions-table">
                  <thead>
                    <tr>
                      <th>Futures</th>
                      <th>Size</th>
                      <th>Entry Price</th>
                      <th>Mark Price</th>
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
                      const side = String(position.side ?? "").toUpperCase();
                      const upnl = Number(position.unrealizedPNL ?? NaN);
                      const realizedPnl = Number(position.realizedPNL ?? NaN);
                      const sideClass = (side === "LONG" || side === "BUY")
                        ? "long"
                        : (side === "SHORT" || side === "SELL")
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
                          <td>{position.avgOpenPrice ?? "-"}</td>
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
