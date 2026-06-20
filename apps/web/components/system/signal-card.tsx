import { useMemo, useState } from "react";
import { AlignmentBar } from "./alignment-bar";
import { SignalStateBadge } from "./signal-state-badge";
import { SignalItem } from "./types";

type DetailTab = "Overview" | "Indicators" | "Liquidity" | "Structure" | "Heatmap";

type SignalCardProps = {
  item: SignalItem;
  onExecute: (item: SignalItem) => void;
};

function formatMarketCap(marketCapUsd: number | null): string {
  if (!Number.isFinite(marketCapUsd ?? Number.NaN) || marketCapUsd == null || marketCapUsd <= 0) {
    return "Unknown";
  }

  if (marketCapUsd >= 1_000_000_000_000) {
    return `$${(marketCapUsd / 1_000_000_000_000).toFixed(2)}T`;
  }

  if (marketCapUsd >= 1_000_000_000) {
    return `$${(marketCapUsd / 1_000_000_000).toFixed(2)}B`;
  }

  return `$${(marketCapUsd / 1_000_000).toFixed(0)}M`;
}

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

  const tokenHeatmap = useMemo(() => {
    const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
    const formatMoney = (value: number) => `$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

    const isLongBias = item.takeProfit > item.suggestedEntry;
    const scoreComponent = clamp(item.score * 9.5);
    const structureComponent = item.htfConfirmed ? 14 : -10;
    const sweepPenalty = item.liquiditySweep === "HIGH" ? -8 : item.liquiditySweep === "MEDIUM" ? -3 : 4;
    const confidence = clamp(scoreComponent + structureComponent + sweepPenalty);

    const directionalPressure = clamp((item.volatilityPct * 4) + (item.liquiditySweep === "HIGH" ? 26 : item.liquiditySweep === "MEDIUM" ? 14 : 6));

    const longPctBase = clamp(50 + (isLongBias ? 12 : -12) + Math.round((item.score - 5) * 4));
    const longPct = Math.max(5, Math.min(95, longPctBase));
    const shortPct = 100 - longPct;

    const liquidityBase = item.volume24h * Math.max(0.02, item.volatilityPct / 100);
    const longStopLiq = liquidityBase * (longPct / 100) * 0.92;
    const shortStopLiq = liquidityBase * (shortPct / 100) * 0.92;
    const pooledStopLiq = longStopLiq + shortStopLiq;

    const longSlAvg = item.stopLoss;
    const shortHuntTop = isLongBias ? item.takeProfit * 1.015 : item.suggestedEntry * 1.01;

    return {
      label: isLongBias ? "Long stops likely below" : "Short stops likely above",
      confidence,
      directionalPressure,
      longSlAvg,
      shortHuntTop,
      longPct,
      shortPct,
      longStopLiq: formatMoney(longStopLiq),
      shortStopLiq: formatMoney(shortStopLiq),
      pooledStopLiq: formatMoney(pooledStopLiq),
    };
  }, [item]);

  

  return (
    <article className="rounded-strata border border-white/10 bg-[#0F172A] p-4 shadow-strata-card transition hover:border-white/20">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:items-center">
        <div className="lg:col-span-2">
          <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Token</p>
          <p className="text-base font-semibold text-[#E6EDF3]">{item.symbol}</p>
          <p className="text-xs text-[#9FB3C8]">{item.displayName}</p>
          <p className="mt-1 text-[11px] uppercase tracking-[0.08em] text-[#6B859E]">MCap {formatMarketCap(item.marketCapUsd)}</p>
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
            {(["Overview", "Indicators", "Liquidity", "Structure", "Heatmap"] as const).map((tab) => (
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

          {activeTab === "Heatmap" ? (
            <div className="grid grid-cols-1 gap-3">
              <article className="rounded-lg border border-white/15 bg-[#0B1220] p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex rounded-full border border-[#F43F5E]/45 bg-[#7F1D1D]/30 px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-[#FECACA]">
                    {tokenHeatmap.label}
                  </span>
                  <span className="text-xs text-[#9FB3C8]">Confidence {tokenHeatmap.confidence}%</span>
                </div>

                <div className="mt-2 h-2 rounded-full bg-[#122033]">
                  <div
                    className="h-2 rounded-full bg-gradient-to-r from-[#F43F5E] to-[#FB7185]"
                    style={{ width: `${tokenHeatmap.directionalPressure}%` }}
                  />
                </div>

                <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-[#C7D6E7] md:grid-cols-2">
                  <div>Long SL avg <span className="font-semibold text-[#E6EDF3]">${tokenHeatmap.longSlAvg.toFixed(4)}</span></div>
                  <div>Short hunt top <span className="font-semibold text-[#E6EDF3]">${tokenHeatmap.shortHuntTop.toFixed(4)}</span></div>
                  <div>Positioning est <span className="font-semibold text-[#E6EDF3]">{tokenHeatmap.longPct}% long / {tokenHeatmap.shortPct}% short</span></div>
                  <div>Directional pressure <span className="font-semibold text-[#E6EDF3]">{tokenHeatmap.directionalPressure}%</span></div>
                  <div>Long stop liq est. <span className="font-semibold text-[#E6EDF3]">{tokenHeatmap.longStopLiq}</span></div>
                  <div>Short stop liq est. <span className="font-semibold text-[#E6EDF3]">{tokenHeatmap.shortStopLiq}</span></div>
                </div>

                <p className="mt-2 text-xs text-[#9FB3C8]">
                  Stop liquidity pool est. <span className="font-semibold text-[#E6EDF3]">{tokenHeatmap.pooledStopLiq}</span>
                </p>
              </article>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
