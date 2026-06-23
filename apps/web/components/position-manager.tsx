"use client";

import { useEffect, useState } from "react";
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

interface Position {
  id: string;
  symbol: string;
  assetType: string;
  side: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  status: string;
  stopLoss?: number;
  takeProfit?: number;
  entryAt: string;
  closedAt?: string;
  closePrice?: number;
}

interface UpdateForm {
  currentPrice: number;
  stopLoss?: number;
  takeProfit?: number;
}

type PositionStreamPayload = {
  positions?: Position[];
  error?: string;
  details?: string;
};

export function PositionManager() {
  const { data: session } = useSession();
  const { user: legacyUser, token: legacyToken } = useAuth();
  const { token: jwtToken } = useJwtToken();

  // Use NextAuth session user if available, fall back to legacy auth
  const user = session?.user as any || legacyUser;
  const authToken = jwtToken || legacyToken;
  const baseUrl = `${API_BASE}/api`;

  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
  const [updateForm, setUpdateForm] = useState<UpdateForm>({ currentPrice: 0 });
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closePrice, setClosePrice] = useState<string>("");
  const [socketEpoch, setSocketEpoch] = useState(0);

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
        `${getApiWebSocketBase()}/ws/saas-dashboard?scope=positions&token=${encodeURIComponent(authToken)}&pollMs=30000`
      );

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as PositionStreamPayload;
          if (payload.error) {
            setError(payload.details ?? payload.error);
            setLoading(false);
            return;
          }

          setPositions(Array.isArray(payload.positions) ? payload.positions : []);
          setError(null);
          setLoading(false);
        } catch (parseError) {
          setError(parseError instanceof Error ? parseError.message : "Invalid websocket payload");
          setLoading(false);
        }
      };

      socket.onerror = () => {
        setError("Position stream interrupted");
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

  async function handleUpdatePosition() {
    if (!selectedPosition) return;
    if (!authToken) {
      setError("Not authenticated");
      return;
    }

    try {
      const res = await fetch(
        `${baseUrl}/positions/${selectedPosition.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(updateForm),
        }
      );

      const data = await res.json();
      if (data.success || res.ok) {
        setSocketEpoch((value) => value + 1);
        setShowUpdateModal(false);
        setSelectedPosition(null);
      } else {
        setError(data.error || "Failed to update position");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update position");
    }
  }

  async function handleClosePosition() {
    if (!selectedPosition || !closePrice) return;
    if (!authToken) {
      setError("Not authenticated");
      return;
    }

    try {
      const res = await fetch(
        `${baseUrl}/positions/${selectedPosition.id}/close`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            closePrice: parseFloat(closePrice),
            reason: "Closed via dashboard",
          }),
        }
      );

      const data = await res.json();
      if (data.success || res.ok) {
        setSocketEpoch((value) => value + 1);
        setShowCloseModal(false);
        setSelectedPosition(null);
        setClosePrice("");
      } else {
        setError(data.error || "Failed to close position");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close position");
    }
  }

  const openPositions = positions.filter((p) => p.status === "OPEN");
  const closedPositions = positions.filter((p) => p.status === "CLOSED");
  const totalPnL = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Position Manager</h1>
              <p className="text-gray-600 text-sm mt-1">
                Open: {openPositions.length} | Closed: {closedPositions.length} | Total P&L: $
                {totalPnL.toFixed(2)}
              </p>
            </div>
            <button
              onClick={() => {
                setLoading(true);
                setSocketEpoch((value) => value + 1);
              }}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="max-w-7xl mx-auto px-6 py-4 mt-6 bg-red-50 border border-red-200 rounded text-red-700">
          {error}
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Open Positions */}
        {openPositions.length > 0 && (
          <div className="bg-white rounded-lg shadow overflow-hidden mb-8">
            <div className="px-6 py-4 border-b bg-green-50">
              <h2 className="text-xl font-bold text-green-900">Open Positions ({openPositions.length})</h2>
            </div>
            <table className="w-full">
              <thead className="bg-gray-100 border-b">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold">Symbol</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold">Asset</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold">Side</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold">Qty</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold">Entry</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold">Current</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold">P&L</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold">%</th>
                  <th className="px-6 py-3 text-center text-sm font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {openPositions.map((pos) => (
                  <tr key={pos.id} className="border-b hover:bg-gray-50">
                    <td className="px-6 py-3 font-medium">{pos.symbol}</td>
                    <td className="px-6 py-3 text-sm text-gray-600">{pos.assetType}</td>
                    <td className="px-6 py-3">{pos.side}</td>
                    <td className="px-6 py-3 text-right">{pos.quantity}</td>
                    <td className="px-6 py-3 text-right">${pos.entryPrice.toFixed(2)}</td>
                    <td className="px-6 py-3 text-right">${pos.currentPrice.toFixed(2)}</td>
                    <td
                      className={`px-6 py-3 text-right font-semibold ${
                        pos.pnl >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      ${pos.pnl.toFixed(2)}
                    </td>
                    <td
                      className={`px-6 py-3 text-right font-semibold ${
                        pos.pnlPercent >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {pos.pnlPercent.toFixed(2)}%
                    </td>
                    <td className="px-6 py-3 text-center">
                      <button
                        onClick={() => {
                          setSelectedPosition(pos);
                          setUpdateForm({
                            currentPrice: pos.currentPrice,
                            stopLoss: pos.stopLoss,
                            takeProfit: pos.takeProfit,
                          });
                          setShowUpdateModal(true);
                        }}
                        className="text-blue-600 hover:underline text-sm mr-3"
                      >
                        Update
                      </button>
                      <button
                        onClick={() => {
                          setSelectedPosition(pos);
                          setClosePrice(pos.currentPrice.toString());
                          setShowCloseModal(true);
                        }}
                        className="text-red-600 hover:underline text-sm"
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Closed Positions */}
        {closedPositions.length > 0 && (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="px-6 py-4 border-b bg-gray-50">
              <h2 className="text-xl font-bold">Closed Positions ({closedPositions.length})</h2>
            </div>
            <table className="w-full">
              <thead className="bg-gray-100 border-b">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold">Symbol</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold">Side</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold">Entry</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold">Exit</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold">P&L</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold">%</th>
                </tr>
              </thead>
              <tbody>
                {closedPositions.slice(0, 10).map((pos) => (
                  <tr key={pos.id} className="border-b hover:bg-gray-50">
                    <td className="px-6 py-3 font-medium">{pos.symbol}</td>
                    <td className="px-6 py-3">{pos.side}</td>
                    <td className="px-6 py-3 text-right">${pos.entryPrice.toFixed(2)}</td>
                    <td className="px-6 py-3 text-right">${pos.closePrice?.toFixed(2)}</td>
                    <td
                      className={`px-6 py-3 text-right font-semibold ${
                        (pos.pnl || 0) >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      ${pos.pnl.toFixed(2)}
                    </td>
                    <td
                      className={`px-6 py-3 text-right font-semibold ${
                        (pos.pnlPercent || 0) >= 0 ? "text-green-600" : "text-red-600"
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

        {openPositions.length === 0 && closedPositions.length === 0 && (
          <div className="bg-white rounded-lg shadow p-12 text-center">
            <p className="text-gray-600">No positions yet</p>
          </div>
        )}
      </main>

      {/* Update Position Modal */}
      {showUpdateModal && selectedPosition && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
          <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full mx-4">
            <h2 className="text-2xl font-bold mb-6">Update Position - {selectedPosition.symbol}</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Current Price</label>
                <input
                  type="number"
                  step="0.01"
                  value={updateForm.currentPrice}
                  onChange={(e) =>
                    setUpdateForm((prev) => ({
                      ...prev,
                      currentPrice: parseFloat(e.target.value),
                    }))
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Stop Loss (optional)</label>
                <input
                  type="number"
                  step="0.01"
                  value={updateForm.stopLoss || ""}
                  onChange={(e) =>
                    setUpdateForm((prev) => ({
                      ...prev,
                      stopLoss: e.target.value ? parseFloat(e.target.value) : undefined,
                    }))
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded"
                  placeholder="Leave blank to remove"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Take Profit (optional)</label>
                <input
                  type="number"
                  step="0.01"
                  value={updateForm.takeProfit || ""}
                  onChange={(e) =>
                    setUpdateForm((prev) => ({
                      ...prev,
                      takeProfit: e.target.value ? parseFloat(e.target.value) : undefined,
                    }))
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded"
                  placeholder="Leave blank to remove"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-8">
              <button
                onClick={handleUpdatePosition}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Update
              </button>
              <button
                onClick={() => {
                  setShowUpdateModal(false);
                  setSelectedPosition(null);
                }}
                className="flex-1 px-4 py-2 bg-gray-300 text-gray-800 rounded hover:bg-gray-400"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Close Position Modal */}
      {showCloseModal && selectedPosition && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
          <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full mx-4">
            <h2 className="text-2xl font-bold mb-6">Close Position - {selectedPosition.symbol}</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Close Price</label>
                <input
                  type="number"
                  step="0.01"
                  value={closePrice}
                  onChange={(e) => setClosePrice(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded"
                />
              </div>
              <div className="bg-gray-50 p-3 rounded">
                <p className="text-sm text-gray-600">
                  Expected P&L: <span className="font-bold">
                    ${((parseFloat(closePrice || "0") - selectedPosition.entryPrice) * selectedPosition.quantity).toFixed(2)}
                  </span>
                </p>
              </div>
            </div>

            <div className="flex gap-3 mt-8">
              <button
                onClick={handleClosePosition}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
              >
                Close Position
              </button>
              <button
                onClick={() => {
                  setShowCloseModal(false);
                  setSelectedPosition(null);
                  setClosePrice("");
                }}
                className="flex-1 px-4 py-2 bg-gray-300 text-gray-800 rounded hover:bg-gray-400"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
