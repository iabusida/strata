"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useAuth } from "../contexts/auth-context";
import { useJwtToken } from "../hooks/use-jwt-token";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787").replace(/\/+$/, "");

function getApiWebSocketBase(): string {
  if (process.env.NEXT_PUBLIC_API_BASE_URL) {
    return process.env.NEXT_PUBLIC_API_BASE_URL.replace(/^http/i, "ws").replace(/\/+$/, "");
  }

  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.hostname}:8787`;
  }

  return "ws://localhost:8787";
}

interface SignalData {
  symbol: string;
  tradingStyle: string;
  state: string;
  metrics: Record<string, number>;
}

interface Position {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  realizedPnl?: number;
  pnlPercent: number;
  status: string;
}

interface AlertEvent {
  id: string;
  symbol: string;
  signalState: string;
  tradingStyle: string;
  recommendation: string;
  createdAt: string;
}

interface Summary {
  total: number;
  bySignalState: Record<string, number>;
  byStyle: Record<string, number>;
  readySymbols: Array<{ symbol: string; count: number }>;
}

type SaaSDashboardStreamPayload = {
  positions?: Position[];
  alerts?: AlertEvent[];
  summary?: Summary | null;
  error?: string;
  details?: string;
};

export function SaaSDashboard() {
  const { data: session } = useSession();
  const { user: legacyUser, token: legacyToken } = useAuth();
  const { token: jwtToken } = useJwtToken();

  // Use NextAuth session user if available, fall back to legacy auth
  const user = session?.user as any || legacyUser;
  const authToken = jwtToken || legacyToken;

  const [socketEpoch, setSocketEpoch] = useState(0);

  const [positions, setPositions] = useState<Position[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let closedByCleanup = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const connect = (): void => {
      if (!authToken || !user?.userId) {
        setLoading(false);
        setError("Not authenticated");
        return;
      }

      setLoading(true);
      socket = new WebSocket(
        `${getApiWebSocketBase()}/ws/saas-dashboard?scope=full&token=${encodeURIComponent(authToken)}&pollMs=30000`
      );

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as SaaSDashboardStreamPayload;
          if (payload.error) {
            setError(payload.details ?? payload.error);
            setLoading(false);
            return;
          }

          setPositions(Array.isArray(payload.positions) ? payload.positions : []);
          setAlerts(Array.isArray(payload.alerts) ? payload.alerts : []);
          setSummary(payload.summary ?? null);
          setError(null);
          setLoading(false);
        } catch (parseError) {
          setError(parseError instanceof Error ? parseError.message : "Invalid websocket payload");
          setLoading(false);
        }
      };

      socket.onerror = () => {
        setError("Dashboard stream interrupted");
        setLoading(false);
      };

      socket.onclose = () => {
        if (closedByCleanup) {
          return;
        }

        reconnectTimeout = setTimeout(() => {
          connect();
        }, 3000);
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
  }, [authToken, user?.userId, socketEpoch]);

  if (loading && !positions.length) {
    return <div className="p-6 text-center">Loading dashboard...</div>;
  }

  const openPositions = positions.filter((p) => p.status === "OPEN");
  const totalPnL = positions.reduce((sum, p) => sum + (p.realizedPnl || p.pnl), 0);
  const winRate =
    positions.length > 0
      ? (
          (positions.filter(
            (p) => (p.realizedPnl || p.pnl) > 0
          ).length / positions.length) *
          100
        ).toFixed(1)
      : "N/A";

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Header */}
      <header className="bg-[#0F172A] border-b border-white/10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex justify-between items-center">
            <h1 className="text-3xl font-bold text-white">Trading Dashboard</h1>
            <button
              onClick={() => {
                setLoading(true);
                setSocketEpoch((value) => value + 1);
              }}
              className="px-4 py-2 bg-cyan-600 text-white rounded hover:bg-cyan-700 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="max-w-7xl mx-auto px-6 py-4 bg-red-900/30 border border-red-500/30 rounded text-red-400">
          {error}
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Key Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <MetricCard label="Open Positions" value={openPositions.length} />
          <MetricCard label="Total P&L" value={`$${totalPnL.toFixed(2)}`} color={totalPnL >= 0 ? "green" : "red"} />
          <MetricCard label="Win Rate" value={`${winRate}%`} />
          <MetricCard label="Total Trades" value={positions.length} />
        </div>

        {/* Signal State Summary */}
        {summary && (
          <div className="bg-[#0F172A] rounded-lg border border-white/10 shadow-lg p-6 mb-8">
            <h2 className="text-xl font-bold mb-4 text-white">Signal State Summary (Last 7 Days)</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <SummaryItem
                label="Ready"
                value={summary.bySignalState.READY}
                color="bg-green-900/40 text-green-400"
              />
              <SummaryItem
                label="Caution"
                value={summary.bySignalState.CAUTION}
                color="bg-yellow-900/40 text-yellow-400"
              />
              <SummaryItem
                label="Blocked"
                value={summary.bySignalState.BLOCKED}
                color="bg-red-900/40 text-red-400"
              />
              <SummaryItem
                label="Unresolved"
                value={summary.bySignalState.UNRESOLVED}
                color="bg-gray-800/40 text-gray-400"
              />
            </div>

            {summary.readySymbols.length > 0 && (
              <div className="mt-6 pt-6 border-t border-white/10">
                <h3 className="font-semibold mb-3 text-white">Top Ready Symbols</h3>
                <div className="flex gap-2 flex-wrap">
                  {summary.readySymbols.map((item) => (
                    <span
                      key={item.symbol}
                      className="px-3 py-1 bg-green-900/40 text-green-400 rounded-full text-sm"
                    >
                      {item.symbol} ({item.count})
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Open Positions Table */}
        {openPositions.length > 0 && (
          <div className="bg-[#0F172A] rounded-lg border border-white/10 shadow-lg overflow-hidden mb-8">
            <div className="px-6 py-4 border-b border-white/10">
              <h2 className="text-xl font-bold text-white">Open Positions ({openPositions.length})</h2>
            </div>
            <table className="w-full">
              <thead className="bg-[#0B1220] border-b border-white/10">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Symbol</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Side</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-gray-300">Qty</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-gray-300">Entry</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-gray-300">Current</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-gray-300">PnL</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-gray-300">%</th>
                </tr>
              </thead>
              <tbody>
                {openPositions.map((pos) => (
                  <tr key={pos.id} className="border-b border-white/10 hover:bg-[#0B1220] transition-colors">
                    <td className="px-6 py-3 font-medium text-white">{pos.symbol}</td>
                    <td className="px-6 py-3 text-gray-300">{pos.side}</td>
                    <td className="px-6 py-3 text-right text-gray-300">{pos.quantity}</td>
                    <td className="px-6 py-3 text-right text-gray-300">${pos.entryPrice.toFixed(2)}</td>
                    <td className="px-6 py-3 text-right text-gray-300">${pos.currentPrice.toFixed(2)}</td>
                    <td
                      className={`px-6 py-3 text-right font-semibold ${
                        pos.pnl >= 0 ? "text-green-400" : "text-red-400"
                      }`}
                    >
                      ${pos.pnl.toFixed(2)}
                    </td>
                    <td
                      className={`px-6 py-3 text-right font-semibold ${
                        pos.pnlPercent >= 0 ? "text-green-400" : "text-red-400"
                      }`}
                    >
                      {pos.pnlPercent.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Recent Alert Events */}
        {alerts.length > 0 && (
          <div className="bg-[#0F172A] rounded-lg border border-white/10 shadow-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-white/10">
              <h2 className="text-xl font-bold text-white">Recent Alert Events</h2>
            </div>
            <div className="divide-y divide-white/10">
              {alerts.slice(0, 10).map((alert) => (
                <div key={alert.id} className="px-6 py-4 hover:bg-[#0B1220] transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-1">
                        <span className="font-semibold text-lg text-white">{alert.symbol}</span>
                        <StateBadge state={alert.signalState} />
                        <span className="text-sm text-gray-400">{alert.tradingStyle}</span>
                      </div>
                      {alert.recommendation && (
                        <p className="text-sm text-gray-400">
                          Recommendation: <span className="font-medium text-gray-300">{alert.recommendation}</span>
                        </p>
                      )}
                    </div>
                    <span className="text-sm text-gray-500">
                      {new Date(alert.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {positions.length === 0 && alerts.length === 0 && (
          <div className="bg-[#0F172A] rounded-lg border border-white/10 shadow-lg p-12 text-center">
            <p className="text-gray-400 mb-4">No data available yet</p>
            <Link href="/settings" className="text-cyan-400 hover:text-cyan-300 transition-colors">
              Configure your trading styles and symbols
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}

function MetricCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="bg-[#0F172A] rounded-lg border border-white/10 shadow-lg p-6">
      <p className="text-gray-400 text-sm mb-2">{label}</p>
      <p className={`text-2xl font-bold ${color ? (color === "green" ? "text-green-400" : "text-red-400") : "text-white"}`}>
        {value}
      </p>
    </div>
  );
}

function SummaryItem({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className={`${color} rounded-lg p-4 text-center border border-white/10`}>
      <p className="text-sm font-medium mb-1">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    READY: "bg-green-900/40 text-green-400",
    CAUTION: "bg-yellow-900/40 text-yellow-400",
    BLOCKED: "bg-red-900/40 text-red-400",
    UNRESOLVED: "bg-gray-800/40 text-gray-400",
  };

  return (
    <span className={`px-3 py-1 rounded-full text-xs font-semibold border border-white/10 ${colors[state] || colors.UNRESOLVED}`}>
      {state}
    </span>
  );
}
