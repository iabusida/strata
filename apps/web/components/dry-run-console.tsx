"use client";

import { useEffect, useMemo, useState } from "react";

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

export function DryRunConsole() {
  const [dryRunPlans, setDryRunPlans] = useState<DryRunExecutionPlan[]>([]);
  const [dryRunWsConnected, setDryRunWsConnected] = useState(false);
  const [clearingDryRun, setClearingDryRun] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const baselineBalanceUsd = 100;

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
            Bitunix Dry Run
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

        <div className="dry-run-metrics">
          <div className="dry-run-metric">
            <span>Baseline Balance</span>
            <strong>${baselineBalanceUsd.toFixed(2)}</strong>
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

                  return (
                    <tr key={plan.id}>
                      <td>{new Date(plan.createdAt).toLocaleTimeString()}</td>
                      <td>{plan.source === "AUTO_SIGNAL" ? "Auto" : "Manual"}</td>
                      <td>{plan.symbol}</td>
                      <td className={`dir ${plan.side.toLowerCase()}`}>{plan.side}</td>
                      <td><span className={statusClass}>{plan.status}</span></td>
                      <td>{plan.entryPrice.toFixed(6)} / {plan.tpPrice.toFixed(6)} / {plan.slPrice.toFixed(6)}</td>
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