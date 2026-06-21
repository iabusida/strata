"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../contexts/auth-context";

type DryRunExecutionPlan = {
  id: string;
  createdAt: string;
  source: "AUTO_SIGNAL" | "MANUAL_OPEN";
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  leverageRequested: number;
  stakeUsd: number;
  orderNotionalUsd: number;
  status: "PLANNED" | "BLOCKED";
  reason?: string;
  leverageCheck?: {
    symbol: string;
    marginCoin: string;
    currentLeverage: number;
    marginMode: string;
    minRequiredLeverage: number;
    meetsMinLeverage: boolean;
  };
};

type DryRunExecutionResponse = {
  count: number;
  plans: DryRunExecutionPlan[];
};

type TradeSnapshotResponse = {
  stats?: {
    initialCapitalUsd?: number;
    accountBalanceUsd?: number;
  };
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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787";

function calculateProjectedPnlUsd(plan: DryRunExecutionPlan, targetPrice: number): number {
  if (!Number.isFinite(plan.entryPrice) || plan.entryPrice <= 0) {
    return 0;
  }

  const returnPct = plan.side === "LONG"
    ? ((targetPrice - plan.entryPrice) / plan.entryPrice) * plan.leverageRequested * 100
    : ((plan.entryPrice - targetPrice) / plan.entryPrice) * plan.leverageRequested * 100;

  return plan.stakeUsd * (returnPct / 100);
}

function calculateDirectionalMovePct(plan: DryRunExecutionPlan, targetPrice: number): number {
  if (!Number.isFinite(plan.entryPrice) || plan.entryPrice <= 0) {
    return 0;
  }

  const movePct = plan.side === "LONG"
    ? ((targetPrice - plan.entryPrice) / plan.entryPrice) * 100
    : ((plan.entryPrice - targetPrice) / plan.entryPrice) * 100;

  return Number(movePct.toFixed(3));
}

function formatMaybeUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }

  return `$${value.toFixed(2)}`;
}

export function DryRunConsole() {
  const { user } = useAuth();
  const [dryRunPlans, setDryRunPlans] = useState<DryRunExecutionPlan[]>([]);
  const [dryRunWsConnected, setDryRunWsConnected] = useState(false);
  const [clearingDryRun, setClearingDryRun] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [initialCapitalUsd, setInitialCapitalUsd] = useState<number | null>(null);
  const [accountBalanceUsd, setAccountBalanceUsd] = useState<number | null>(null);
  const [profile, setProfile] = useState<TradeProfileResponse | null>(null);
  const [exchangeProviderLabel, setExchangeProviderLabel] = useState("EXCHANGE");

  const latestPlan = dryRunPlans[0] ?? null;
  const latestPlanTpPnlUsd = useMemo(() => {
    if (!latestPlan) {
      return 0;
    }
    return calculateProjectedPnlUsd(latestPlan, latestPlan.tpPrice);
  }, [latestPlan]);

  const latestPlanSlPnlUsd = useMemo(() => {
    if (!latestPlan) {
      return 0;
    }
    return calculateProjectedPnlUsd(latestPlan, latestPlan.slPrice);
  }, [latestPlan]);

  const strategyModeLabel = useMemo(() => {
    if (!profile) {
      return "Strategy mode: n/a";
    }

    const tpSlMode = profile.setupPolicy?.tpSlMode ?? "n/a";
    const hunt = profile.liquidityHunt;
    if (!hunt?.enabled) {
      return `Strategy mode: liquidity hunt off (${tpSlMode})`;
    }

    const leverage = Number.isFinite(hunt.leverage) ? `${hunt.leverage}x` : "n/a";
    const tp = Number.isFinite(hunt.takeProfitPct) ? `${hunt.takeProfitPct}%` : "n/a";
    const sl = Number.isFinite(hunt.stopLossPct) ? `${hunt.stopLossPct}%` : "n/a";
    const mode = hunt.onlyMode ? "Liquidity Hunt Only" : "Mixed Entries";
    return `Strategy mode: ${mode} | ${leverage} | TP ${tp} ROE / SL ${sl} ROE | ${tpSlMode}`;
  }, [profile]);

  useEffect(() => {
    const wsUrl = `${API_BASE.replace(/^http/i, "ws")}/ws/execution-dry-run?limit=50`;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let closedByCleanup = false;
    let socket: WebSocket | null = null;

    const connect = () => {
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        setDryRunWsConnected(true);
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as DryRunExecutionResponse;
          setDryRunPlans(Array.isArray(payload.plans) ? payload.plans : []);
        } catch {
          // Ignore malformed payloads from stream.
        }
      };

      socket.onclose = () => {
        setDryRunWsConnected(false);
        if (!closedByCleanup) {
          reconnectTimeout = setTimeout(connect, 3000);
        }
      };

      socket.onerror = () => {
        setDryRunWsConnected(false);
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
      setDryRunWsConnected(false);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadUiContext(): Promise<void> {
      try {
        const response = await fetch(`${API_BASE}/api/ui/context`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as { exchangeProviderLabel?: string };
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
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadProfile = async () => {
      try {
        const profileResponse = await fetch(`${API_BASE}/api/trades/profile`);
        if (!profileResponse.ok) {
          return;
        }

        const profilePayload = (await profileResponse.json().catch(() => ({}))) as TradeProfileResponse;
        if (!cancelled) {
          setProfile(profilePayload);
        }
      } catch {
        if (!cancelled) {
          setProfile(null);
        }
      }
    };

    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const connect = (): void => {
      const params = new URLSearchParams({ mode: "live" });
      if (user?.organizationId) {
        params.set("tenantId", user.organizationId);
      }
      socket = new WebSocket(`${API_BASE.replace(/^http/i, "ws")}/ws/state?${params.toString()}`);

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as { tradeSimulation?: TradeSnapshotResponse };
          const nextInitial = payload.tradeSimulation?.stats?.initialCapitalUsd;
          const nextBalance = payload.tradeSimulation?.stats?.accountBalanceUsd;
          setInitialCapitalUsd(Number.isFinite(nextInitial) ? Number(nextInitial) : null);
          setAccountBalanceUsd(Number.isFinite(nextBalance) ? Number(nextBalance) : null);
        } catch {
          if (!cancelled) {
            setInitialCapitalUsd(null);
            setAccountBalanceUsd(null);
          }
        }
      };

      socket.onclose = () => {
        if (cancelled) {
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

    void loadProfile();
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [user?.organizationId]);

  async function clearDryRunPlans(): Promise<void> {
    setClearingDryRun(true);
    setFeedback(null);

    try {
      const response = await fetch(`${API_BASE}/api/execution/dry-run/clear`, {
        method: "POST"
      });
      const payload = (await response.json().catch(() => ({}))) as { cleared?: number; error?: string; details?: string };

      if (!response.ok) {
        const message = payload.error ?? payload.details ?? "Failed to clear dry-run plans";
        setFeedback(`Clear dry-run failed: ${message}`);
        return;
      }

      // Optimistic clear so UI updates instantly, even before stream message arrives.
      setDryRunPlans([]);
      setFeedback(`Cleared ${payload.cleared ?? 0} dry-run plan${(payload.cleared ?? 0) === 1 ? "" : "s"}.`);
    } catch (error) {
      setFeedback(`Clear dry-run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setClearingDryRun(false);
    }
  }

  return (
    <main id="section-top" className="shell">
      <section className="panel simulation-panel">
        <div className="table-header">
          <h2>
            {exchangeProviderLabel} Dry Run
            <span className={`dry-run-stream-status ${dryRunWsConnected ? "connected" : "disconnected"}`}>
              {dryRunWsConnected ? "Stream Live" : "Stream Offline"}
            </span>
          </h2>
          <div className="simulation-header-actions">
            <button
              type="button"
              className="reset-sim-btn"
              onClick={() => void clearDryRunPlans()}
              disabled={clearingDryRun}
            >
              {clearingDryRun ? "Clearing..." : "Clear Dry Run"}
            </button>
          </div>
        </div>

        {feedback ? <p className="trade-action-feedback">{feedback}</p> : null}
        <p className="dry-run-context-hint">{strategyModeLabel}</p>

        <div className="dry-run-metrics">
          <div className="dry-run-metric">
            <span>Simulation Baseline</span>
            <strong>{formatMaybeUsd(initialCapitalUsd)}</strong>
          </div>
          <div className="dry-run-metric">
            <span>Simulation Balance</span>
            <strong>{formatMaybeUsd(accountBalanceUsd)}</strong>
          </div>
          <div className="dry-run-metric">
            <span>Latest TP P&amp;L</span>
            <strong className={latestPlanTpPnlUsd > 0 ? "pnl-positive" : latestPlanTpPnlUsd < 0 ? "pnl-negative" : "pnl-neutral"}>
              {latestPlanTpPnlUsd >= 0 ? "+" : ""}${latestPlanTpPnlUsd.toFixed(2)}
            </strong>
          </div>
          <div className="dry-run-metric">
            <span>Latest SL P&amp;L</span>
            <strong className={latestPlanSlPnlUsd > 0 ? "pnl-positive" : latestPlanSlPnlUsd < 0 ? "pnl-negative" : "pnl-neutral"}>
              {latestPlanSlPnlUsd >= 0 ? "+" : ""}${latestPlanSlPnlUsd.toFixed(2)}
            </strong>
          </div>
        </div>

        <div className="trade-table-wrap">
          <table className="trade-table dry-run-table">
            <thead>
              <tr>
                <th>At</th>
                <th>Source</th>
                <th>Token</th>
                <th>Side</th>
                <th>Status</th>
                <th>Entry / TP / SL</th>
                <th>Stake / Notional</th>
                <th>P&L at TP / SL</th>
                <th>Lev Req</th>
                <th>Lev Check</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {dryRunPlans.length > 0 ? (
                dryRunPlans.map((plan) => {
                  const statusClass = plan.status === "BLOCKED" ? "dry-run-status blocked" : "dry-run-status planned";
                  const leverageOk = plan.leverageCheck?.meetsMinLeverage;
                  const tpPnlUsd = calculateProjectedPnlUsd(plan, plan.tpPrice);
                  const slPnlUsd = calculateProjectedPnlUsd(plan, plan.slPrice);
                  const tpMovePct = calculateDirectionalMovePct(plan, plan.tpPrice);
                  const slMovePct = calculateDirectionalMovePct(plan, plan.slPrice);
                  const tpRoePct = tpMovePct * plan.leverageRequested;
                  const slRoePct = slMovePct * plan.leverageRequested;

                  return (
                    <tr key={plan.id}>
                      <td>{new Date(plan.createdAt).toLocaleTimeString()}</td>
                      <td>{plan.source === "AUTO_SIGNAL" ? "Auto" : "Manual"}</td>
                      <td>{plan.symbol}</td>
                      <td className={`dir ${plan.side.toLowerCase()}`}>{plan.side}</td>
                      <td><span className={statusClass}>{plan.status}</span></td>
                      <td>
                        <div>{plan.entryPrice.toFixed(6)} / {plan.tpPrice.toFixed(6)} / {plan.slPrice.toFixed(6)}</div>
                        <div className="dry-run-level-context">
                          TP move {tpMovePct >= 0 ? "+" : ""}{tpMovePct.toFixed(2)}% ({tpRoePct >= 0 ? "+" : ""}{tpRoePct.toFixed(1)}% ROE)
                          {" | "}
                          SL move {slMovePct >= 0 ? "+" : ""}{slMovePct.toFixed(2)}% ({slRoePct >= 0 ? "+" : ""}{slRoePct.toFixed(1)}% ROE)
                        </div>
                      </td>
                      <td>${plan.stakeUsd.toFixed(2)} / ${plan.orderNotionalUsd.toFixed(2)}</td>
                      <td>
                        <span className={tpPnlUsd >= 0 ? "pnl-positive" : "pnl-negative"}>
                          TP {tpPnlUsd >= 0 ? "+" : ""}${tpPnlUsd.toFixed(2)}
                        </span>
                        <br />
                        <span className={slPnlUsd >= 0 ? "pnl-positive" : "pnl-negative"}>
                          SL {slPnlUsd >= 0 ? "+" : ""}${slPnlUsd.toFixed(2)}
                        </span>
                      </td>
                      <td>{plan.leverageRequested}x</td>
                      <td className={leverageOk === false ? "pnl-negative" : leverageOk === true ? "pnl-positive" : "pnl-neutral"}>
                        {plan.leverageCheck
                          ? `${plan.leverageCheck.currentLeverage}x / min ${plan.leverageCheck.minRequiredLeverage}x`
                          : "n/a"}
                      </td>
                      <td>{plan.reason ?? "-"}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={11}>No dry-run execution plans yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}