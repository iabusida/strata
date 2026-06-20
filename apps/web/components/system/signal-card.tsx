import { useMemo, useState } from "react";
import { AlignmentBar } from "./alignment-bar";
import { SignalStateBadge } from "./signal-state-badge";
import { SignalItem } from "./types";

type DetailTab = "Overview" | "Indicators" | "Liquidity" | "Structure";

type SignalCardProps = {
  item: SignalItem;
  onExecute: (item: SignalItem) => void;
};

function metricCell(label: string, value: string) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
      <p className="text-[10px] uppercase tracking-[0.12em] text-[#6B859E]">{label}</p>
      <p className="mt-1 text-sm text-[#E6EDF3]">{value}</p>
    </div>
  );
}

export function SignalCard({ item, onExecute }: SignalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("Overview");

  const scorePct = useMemo(() => Math.max(0, Math.min(100, (item.score / 10) * 100)), [item.score]);

  return (
    <article className="rounded-strata border border-white/10 bg-[#0F172A] p-4 shadow-strata-card transition hover:border-white/20">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:items-center">
        <div className="lg:col-span-2">
          <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Token</p>
          <p className="text-base font-semibold text-[#E6EDF3]">{item.symbol}</p>
          <p className="text-xs text-[#9FB3C8]">{item.displayName}</p>
          <p className="mt-1 text-xs text-[#9FB3C8]">${item.price.toFixed(4)}</p>
        </div>

        <div className="lg:col-span-2">
          <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Score</p>
          <p className="text-sm font-semibold text-[#E6EDF3]">{item.score.toFixed(1)} / 10</p>
          <div className="mt-1 h-2 rounded-full bg-[#0B1220]">
            <div
              className="h-2 rounded-full bg-gradient-to-r from-[#2F7BFF] to-[#3EC6FF]"
              style={{ width: `${scorePct}%` }}
            />
          </div>
        </div>

        <div className="lg:col-span-2">
          <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">State</p>
          <div className="mt-1">
            <SignalStateBadge state={item.state} />
          </div>
        </div>

        <div className="lg:col-span-4">
          <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Alignment</p>
          <div className="mt-1">
            <AlignmentBar points={item.alignment} />
          </div>
        </div>

        <div className="lg:col-span-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#9FB3C8] transition hover:text-[#E6EDF3]"
          >
            {expanded ? "Collapse" : "Details"}
          </button>
          <button
            type="button"
            onClick={() => onExecute(item)}
            className="rounded-lg bg-[#2F7BFF]/20 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#3EC6FF] transition hover:bg-[#2F7BFF]/35"
          >
            Action
          </button>
        </div>
      </div>

      <p className="mt-3 text-sm text-[#9FB3C8]">{item.summary}</p>

      {expanded ? (
        <div className="mt-4 border-t border-white/10 pt-4">
          <div className="mb-3 flex flex-wrap gap-2">
            {(["Overview", "Indicators", "Liquidity", "Structure"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium uppercase tracking-[0.1em] ${activeTab === tab ? "bg-[#2F7BFF]/20 text-[#E6EDF3]" : "text-[#9FB3C8] hover:text-[#E6EDF3]"}`}
              >
                {tab}
              </button>
            ))}
          </div>

          {activeTab === "Overview" ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
              {metricCell("Entry Timing", item.entryTiming ?? "N/A")}
              {metricCell("HTF Confirm", item.htfConfirmed ? "Confirmed" : "Conflicted")}
              {metricCell("Suggested Entry", `$${item.suggestedEntry.toFixed(4)}`)}
              {metricCell("Fib Zone", item.fibZone)}
            </div>
          ) : null}

          {activeTab === "Indicators" ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
              {metricCell("RSI", item.rsi.toFixed(1))}
              {metricCell("Stochastic", item.stochastic.toFixed(1))}
              {metricCell("EMA Slope", item.emaSlope.toFixed(4))}
              {metricCell("Volatility", `${item.volatilityPct.toFixed(2)}%`)}
            </div>
          ) : null}

          {activeTab === "Liquidity" ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
              {metricCell("24h Volume", `$${(item.volume24h / 1_000_000).toFixed(2)}M`)}
              {metricCell("Sweep Risk", item.liquiditySweep)}
              {metricCell("Stop", `$${item.stopLoss.toFixed(4)}`)}
              {metricCell("Take Profit", `$${item.takeProfit.toFixed(4)}`)}
            </div>
          ) : null}

          {activeTab === "Structure" ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
              {metricCell("Macro", item.alignment[0]?.direction ?? "MIXED")}
              {metricCell("Intermediary", item.alignment[1]?.direction ?? "MIXED")}
              {metricCell("Trigger", item.alignment[2]?.direction ?? "MIXED")}
              {metricCell("Execution", item.state === "BLOCKED" ? "Hold" : "Watchlist")}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
