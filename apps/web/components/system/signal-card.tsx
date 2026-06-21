import { useEffect, useMemo, useRef, useState } from "react";
import { AlignmentBar } from "./alignment-bar";
import { SignalStateBadge } from "./signal-state-badge";
import { SignalItem, TimeframeView } from "./types";
import { getProfileConfig, TradingProfile } from "../profile-selector";
import { evaluateSignalForProfile, getSignalStatePresentation } from "./profile-decision";
import { getDefaultTimeframeForProfile, getTimeframeDirectionLabel, TIMEFRAME_VIEWS } from "./timeframe-analysis";
import type { AccessEntitlements } from "../../hooks/use-app-access";
import type { UpgradeIntent } from "./upgrade-modal";

type DetailTab = "Overview" | "Indicators" | "Liquidity" | "Structure" | "Heatmap";

type SignalCardProps = {
  item: SignalItem;
  onExecute: (item: SignalItem) => void;
  onSimulate?: (item: SignalItem) => void;
  userProfile?: TradingProfile;
  accessEntitlements?: AccessEntitlements;
  onUpgradeRequest?: (intent: UpgradeIntent) => void;
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

function inferBias(item: SignalItem): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (item.takeProfit > item.suggestedEntry && item.stopLoss < item.suggestedEntry) return "BULLISH";
  if (item.takeProfit < item.suggestedEntry && item.stopLoss > item.suggestedEntry) return "BEARISH";
  return "NEUTRAL";
}

function getConfidencePercent(item: SignalItem): number {
  const base = (item.score / 10) * 100;
  const htfBoost = item.htfConfirmed ? 8 : -10;
  const stateBoost = item.state === "READY" ? 12 : item.state === "CAUTION" ? 2 : -14;
  return Math.max(5, Math.min(99, Math.round(base + htfBoost + stateBoost)));
}

function getDecisionContent(item: SignalItem): {
  title: string;
  explanation: string;
  shellClass: string;
} {
  const bias = inferBias(item);

  if (item.state === "READY") {
    if (bias === "BEARISH") {
      return {
        title: "🔻 STRONG SELL",
        explanation: "Downtrend and structure are aligned across timeframes.",
        shellClass: "border-[#EF4444]/35 bg-[#3F1218]/40 text-[#FECACA]",
      };
    }

    return {
      title: "✅ STRONG BUY",
      explanation: "Momentum and structure align for a higher probability long setup.",
      shellClass: "border-[#22C55E]/35 bg-[#0F2E25]/45 text-[#BBF7D0]",
    };
  }

  if (item.state === "CAUTION" || item.state === "BUILDING") {
    return {
      title: "⚠️ WATCH - Setup forming",
      explanation: "Signals are building but confirmation is incomplete.",
      shellClass: "border-[#F59E0B]/35 bg-[#3A2A0E]/45 text-[#FDE68A]",
    };
  }

  return {
    title: "🚫 AVOID TRADE - Low probability setup",
    explanation: "Weak momentum and conflicting structure reduce probability.",
    shellClass: "border-[#EF4444]/35 bg-[#3F1218]/40 text-[#FECACA]",
  };
}

function getScoreTranslation(score: number): { label: string; action: string } {
  if (score <= 3) return { label: "Weak Signal", action: "Avoid" };
  if (score <= 6) return { label: "Moderate Signal", action: "Watch" };
  return { label: "Strong Signal", action: "Action" };
}

function getTrendInterpretation(item: SignalItem): { text: string; confidence: "High" | "Medium" | "Low" } {
  const up = item.alignment.filter((point) => point.direction === "UP").length;
  const down = item.alignment.filter((point) => point.direction === "DOWN").length;
  const blocked = item.alignment.some((point) => point.blocked);

  if (up >= 3 && !blocked) {
    return { text: "Trend Alignment: Bullish", confidence: "High" };
  }

  if (down >= 3 && !blocked) {
    return { text: "Trend Alignment: Bearish", confidence: "High" };
  }

  if ((up >= 2 || down >= 2) && !blocked) {
    return { text: up > down ? "Trend Alignment: Bullish" : "Trend Alignment: Bearish", confidence: "Medium" };
  }

  return { text: "Trend Alignment: Mixed", confidence: "Low" };
}

function getActionInsight(item: SignalItem): string {
  const trend = getTrendInterpretation(item);

  if (item.state === "BLOCKED") {
    return "Conflicting signals across timeframes - avoid entering now.";
  }

  if (trend.text.includes("Bullish") && trend.confidence !== "Low") {
    return "Uptrend forming across multiple timeframes with improving structure.";
  }

  if (trend.text.includes("Bearish") && trend.confidence !== "Low") {
    return "Downtrend pressure is building across key timeframes.";
  }

  return "Market is moving sideways with no clear directional edge yet.";
}

function getRsiLabel(rsi: number): string {
  if (rsi < 30) return "Oversold";
  if (rsi > 70) return "Overbought";
  return "Neutral";
}

function getStochasticLabel(value: number): string {
  if (value < 20) return "Oversold";
  if (value > 80) return "Overbought";
  return "Neutral";
}

function getEmaSlopeLabel(value: number): string {
  if (value > 0) return "Uptrend";
  if (value < 0) return "Downtrend";
  return "Flat";
}

function getTriggerCondition(
  item: SignalItem,
  profile: TradingProfile = "swing"
): string {
  const isBullish = item.takeProfit > item.suggestedEntry;
  const state = item.state;

  if (state === "BLOCKED") {
    return "🚫 No Safe Entry Right Now - Wait for structure to align";
  }

  switch (profile) {
    case "scalp":
      if (isBullish) {
        return `Enter on volume spike above $${item.suggestedEntry.toFixed(4)} with RSI 50-70`;
      } else {
        return `Enter on volume spike below $${item.suggestedEntry.toFixed(4)} with RSI 30-50`;
      }

    case "day":
      const resistance = item.takeProfit;
      const support = item.stopLoss;
      if (isBullish) {
        return `Break above $${resistance.toFixed(4)} with volume`;
      } else {
        return `Break below $${support.toFixed(4)} with volume`;
      }

    case "swing":
      if (isBullish) {
        return `Pullback to $${item.stopLoss.toFixed(4)} with bounce confirmation`;
      } else {
        return `Recovery to $${item.takeProfit.toFixed(4)} with rejection`;
      }

    case "long_term":
      if (isBullish) {
        return "Buy on any pullback, accumulate $500+ per position";
      } else {
        return "Sell 25-50% on +15% moves";
      }

    default:
      return `Entry at $${item.suggestedEntry.toFixed(4)}`;
  }
}

function getVolatilityLabel(value: number): string {
  if (value < 2) return "Low";
  if (value < 5) return "Medium";
  return "High";
}

function getConfidenceBand(value: number): "Very Low" | "Low" | "Medium" | "High" | "Very High" {
  if (value < 20) return "Very Low";
  if (value < 40) return "Low";
  if (value < 60) return "Medium";
  if (value < 80) return "High";
  return "Very High";
}

function nextStepGuidance(item: SignalItem): string {
  if (item.state === "READY") {
    return inferBias(item) === "BULLISH"
      ? "Look for pullback before entering"
      : "Monitor volume increase before entry";
  }

  if (item.state === "CAUTION" || item.state === "BUILDING") {
    return "Wait for breakout above resistance";
  }

  return "Stand aside until trend confirms";
}

function whyBullets(item: SignalItem): string[] {
  const bullets: string[] = [];
  const structureMixed = item.alignment.some((point) => point.blocked) || item.alignment.some((point) => point.direction === "MIXED");

  if (structureMixed) {
    bullets.push("Conflicting signals across timeframes");
  }

  if (item.emaSlope <= 0 && inferBias(item) === "BULLISH") {
    bullets.push("Weak buying pressure");
  }

  if (item.emaSlope >= 0 && inferBias(item) === "BEARISH") {
    bullets.push("Weak selling pressure");
  }

  if (item.state !== "READY") {
    bullets.push("No breakout confirmation");
  }

  if (item.volatilityPct < 1.5) {
    bullets.push("Momentum is muted");
  }

  return bullets.slice(0, 3);
}

export function SignalCard({
  item,
  onExecute,
  onSimulate,
  userProfile = "swing",
  accessEntitlements,
  onUpgradeRequest,
}: SignalCardProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>("Overview");
  const [selectedTimeframe, setSelectedTimeframe] = useState<TimeframeView>(getDefaultTimeframeForProfile(userProfile));
  const profileConfig = useMemo(() => getProfileConfig(userProfile), [userProfile]);

  useEffect(() => {
    setSelectedTimeframe(getDefaultTimeframeForProfile(userProfile));
  }, [userProfile]);

  const scorePct = useMemo(() => Math.max(0, Math.min(100, (item.score / 10) * 100)), [item.score]);
  const profileEvaluation = useMemo(() => evaluateSignalForProfile(item, userProfile), [item, userProfile]);
  const decisionShellClass = useMemo(() => {
    if (profileEvaluation.decision === "BUY") {
      return "border-[#22C55E]/35 bg-[#0F2E25]/45 text-[#BBF7D0]";
    }
    if (profileEvaluation.decision === "HOLD") {
      return "border-[#60A5FA]/35 bg-[#102A56]/50 text-[#BFDBFE]";
    }
    if (profileEvaluation.decision === "SELL") {
      return "border-[#EF4444]/35 bg-[#3F1218]/40 text-[#FECACA]";
    }
    if (profileEvaluation.decision === "WAIT") {
      return "border-[#F59E0B]/35 bg-[#3A2A0E]/45 text-[#FDE68A]";
    }
    return "border-[#EF4444]/35 bg-[#3F1218]/40 text-[#FECACA]";
  }, [profileEvaluation.decision]);
  const confidencePct = profileEvaluation.confidence;
  const statePresentation = useMemo(() => getSignalStatePresentation(profileEvaluation.signalState), [profileEvaluation.signalState]);
  const stateNextStep = statePresentation.nextStep;
  const triggerHeadline = profileEvaluation.signalState === "ACTIVE"
    ? "✅ Trigger Met — Entry is valid"
    : profileEvaluation.signalState === "PREPARE"
      ? "⚡ Trigger Condition"
      : "🚫 No Safe Entry Right Now";
  const confidenceBand = useMemo(() => getConfidenceBand(confidencePct), [confidencePct]);
  const scoreTranslation = useMemo(() => getScoreTranslation(item.score), [item.score]);
  const actionInsight = useMemo(() => getActionInsight(item), [item]);
  const nextStep = profileEvaluation.nextStep;
  const fallbackWhyList = useMemo(() => whyBullets(item), [item]);
  const whyList = profileEvaluation.reasons.length > 0 ? profileEvaluation.reasons : fallbackWhyList;
  const triggerCondition = profileEvaluation.triggerCondition;
  const timeframeMetric = useMemo(() => item.timeframeMetrics[selectedTimeframe], [item, selectedTimeframe]);
  const timeframeStructureLabel = useMemo(() => getTimeframeDirectionLabel(timeframeMetric.direction), [timeframeMetric.direction]);
  const isFreeTier = accessEntitlements?.isFreeTier ?? false;
  const isExecutionLocked = isFreeTier && Boolean(accessEntitlements?.lockTradeSetup);
  const isHighConvictionPaywall = isExecutionLocked && (profileEvaluation.signalState === "ACTIVE" || confidencePct > 70);
  const isHighConfidenceTeaser = isExecutionLocked && (confidencePct >= 75 || profileEvaluation.actionLabel.includes("BUY"));

  const tokenHeatmap = useMemo(() => {
    const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
    const formatMoney = (value: number) => `$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

    const isLongBias = item.takeProfit > item.suggestedEntry;
    const scoreComponent = clamp(item.score * 9.5);
    const structureComponent = timeframeMetric.direction === "MIXED" ? -6 : timeframeMetric.direction === "UP" ? 14 : 8;
    const sweepPenalty = item.liquiditySweep === "HIGH" ? -8 : item.liquiditySweep === "MEDIUM" ? -3 : 4;
    const confidence = clamp(scoreComponent + structureComponent + sweepPenalty);

    const stochasticPressure = timeframeMetric.stochastic > 80 ? 18 : timeframeMetric.stochastic < 20 ? 10 : 14;
    const directionalPressure = clamp((item.volatilityPct * 4) + stochasticPressure + (item.liquiditySweep === "HIGH" ? 12 : item.liquiditySweep === "MEDIUM" ? 6 : 0));

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
  }, [item, timeframeMetric.direction, timeframeMetric.stochastic]);

  const entryDisplay = useMemo(() => {
    if (item.state === "BLOCKED" || !item.htfConfirmed) {
      return "No Entry Recommended";
    }

    const lower = item.suggestedEntry * 0.995;
    const upper = item.suggestedEntry * 1.005;
    const breakoutNote = item.state === "CAUTION" || item.state === "BUILDING" ? " (Breakout Required)" : "";
    return `Entry Zone: $${lower.toFixed(4)} - $${upper.toFixed(4)}${breakoutNote}`;
  }, [item]);

  const requestUpgrade = (feature: UpgradeIntent["feature"], context?: string) => {
    onUpgradeRequest?.({
      feature,
      symbol: item.symbol,
      marketLabel: "Crypto",
      confidence: confidencePct,
      actionLabel: profileEvaluation.actionLabel,
      context,
    });
  };

  const handleSeeTradeSetup = () => {
    if (isExecutionLocked) {
      requestUpgrade("trade_setup", "Unlock the exact trade");
      return;
    }

    setActiveTab("Overview");
    onExecute(item);
  };

  const handleSimulation = () => {
    if (isExecutionLocked) {
      requestUpgrade("simulation", "Test this trade in Pro");
      return;
    }

    onSimulate?.(item);
  };

  const handleViewEntryZone = () => {
    setActiveTab("Overview");

    if (isExecutionLocked) {
      requestUpgrade("entry_zone", "View the entry plan in Pro");
    }
  };

  // ── Live price flash on WebSocket tick ──────────────────────────────────────
  const prevPriceRef = useRef<number>(item.price);
  const [priceTicking, setPriceTicking] = useState(false);

  useEffect(() => {
    if (prevPriceRef.current !== item.price) {
      prevPriceRef.current = item.price;
      setPriceTicking(true);
      const t = setTimeout(() => setPriceTicking(false), 750);
      return () => clearTimeout(t);
    }
  }, [item.price]);

  return (
    <article className="rounded-strata border border-white/10 bg-[#0F172A] p-4 shadow-strata-card transition hover:border-white/20">
      <section className={`rounded-xl border p-4 ${decisionShellClass}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xl font-extrabold tracking-tight">{profileEvaluation.decisionTitle}</p>
          <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-[0.08em] ${statePresentation.badgeClass}`}>
            {statePresentation.badge}
          </span>
        </div>
        <p className="mt-1 text-sm text-[#D7E4F2]">{profileEvaluation.decisionExplanation}</p>
        <div className={`mt-3 rounded-lg border px-3 py-2 ${statePresentation.bannerClass}`}>
          <p className="text-sm font-bold tracking-tight">{statePresentation.bannerText}</p>
          <p className="mt-0.5 text-xs font-medium opacity-90">{statePresentation.microCopy}</p>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:items-center">
        <div className="lg:col-span-3">
          <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Token</p>
          {/* ── Prominent live price ticker ── */}
          <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
            <span className="text-xl font-extrabold tracking-tight text-[#E6EDF3]">{item.symbol}</span>
            <span
              className={`font-mono text-2xl font-bold tabular-nums text-[#E6EDF3] transition-colors ${
                priceTicking ? "price-tick-flash" : ""
              }`}
            >
              ${item.price >= 1 ? item.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : item.price.toFixed(6)}
            </span>
            {priceTicking && (
              <span className="rounded-full bg-[#22D3EE]/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest text-[#67E8F9]">live</span>
            )}
          </div>
          <p className="text-xs text-[#9FB3C8]">{item.displayName}</p>
          <p className="mt-1 text-[10px] uppercase tracking-[0.08em] text-[#6B859E]">MCap {formatMarketCap(item.marketCapUsd)}</p>
        </div>

        <div className="lg:col-span-3">
          <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Score</p>
          <p className="text-sm font-semibold text-[#E6EDF3]">
            {scoreTranslation.label} ({item.score.toFixed(1)} / 10)
          </p>
          <div className="mt-1 h-2 rounded-full bg-[#0B1220]">
            <div
              className="h-2 rounded-full bg-gradient-to-r from-[#2F7BFF] to-[#3EC6FF]"
              style={{ width: `${scorePct}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-[#9FB3C8]">Signal Quality: {scoreTranslation.action}</p>
        </div>

        <div className="lg:col-span-2">
          <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Confidence</p>
          <p className="text-lg font-bold text-[#E6EDF3]">Confidence: {confidencePct}% ({confidenceBand})</p>
          <div className="mt-1 h-2 rounded-full bg-[#0B1220]">
            <div
              className="h-2 rounded-full bg-gradient-to-r from-[#EF4444] via-[#F59E0B] to-[#22C55E] transition-all"
              style={{ width: `${confidencePct}%` }}
            />
          </div>
          <div className="mt-1">
            <SignalStateBadge state={item.state} />
          </div>
        </div>

        <div className="lg:col-span-4">
          <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Market Structure</p>
          <p className="mt-1 text-sm font-semibold text-[#E6EDF3]">{profileEvaluation.structureLabel}</p>
          <div className="mt-1">
            <AlignmentBar points={item.alignment} />
          </div>
        </div>

      </div>

      <p className="mt-3 text-sm text-[#9FB3C8]">{actionInsight}</p>

      <section className="mt-3 rounded-lg border border-white/10 bg-[#0B1220] p-3">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Next Step</p>
        <p className="mt-1 text-sm font-semibold text-[#E6EDF3]">{stateNextStep}</p>
        <p className="mt-1 text-xs text-[#9FB3C8]">{nextStep}</p>
      </section>

      <section className="mt-3 rounded-lg border border-white/10 bg-[#0B1220] p-3">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Why This Decision</p>
        <ul className="mt-2 space-y-1 text-sm text-[#C7D6E7]">
          {whyList.map((reason) => (
            <li key={reason}>• {reason}</li>
          ))}
        </ul>
      </section>

      {isHighConfidenceTeaser ? (
        <section className="mt-3 rounded-lg border border-[#F59E0B]/30 bg-[linear-gradient(135deg,rgba(120,53,15,0.45),rgba(15,23,42,0.9))] p-3">
          <p className="text-[11px] uppercase tracking-[0.12em] text-[#FCD34D]">High-confidence Pro teaser</p>
          <p className="mt-1 text-sm font-semibold text-[#FFF7ED]">You already have a strong read here. Pro adds the exact trigger, entry zone, and risk framing.</p>
          <button
            type="button"
            onClick={() => requestUpgrade("trade_setup", "High-confidence setup")}
            className="mt-3 rounded-lg border border-[#FCD34D]/35 bg-[#451A03]/70 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#FDE68A] transition hover:bg-[#5B2107]"
          >
            Unlock this setup
          </button>
        </section>
      ) : null}

      {isFreeTier && accessEntitlements?.lockTriggerDetails ? (
        <section className="mt-3 rounded-lg border border-[#F59E0B]/25 bg-[#78350F]/25 p-3">
          <p className="text-[11px] uppercase tracking-[0.12em] text-[#FCD34D]">{triggerHeadline} ({profileConfig.name})</p>
          <p className="mt-1 text-sm font-medium text-[#FDE68A]">You know the direction. Pro reveals the exact confirmation trigger.</p>
          <button
            type="button"
            onClick={() => requestUpgrade("trigger_details", "Trigger details locked")}
            className="mt-3 rounded-lg border border-[#FCD34D]/35 bg-[#451A03]/70 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#FDE68A] transition hover:bg-[#5B2107]"
          >
            Unlock Trigger
          </button>
        </section>
      ) : (
        <section className="mt-3 rounded-lg border border-[#F59E0B]/25 bg-[#78350F]/25 p-3">
          <p className="text-[11px] uppercase tracking-[0.12em] text-[#FCD34D]">{triggerHeadline} ({profileConfig.name})</p>
          <p className="mt-1 text-sm font-medium text-[#FDE68A]">
            {profileEvaluation.signalState === "ACTIVE" ? "Entry is valid now — act on the confirmed trigger." : triggerCondition}
          </p>
        </section>
      )}

      <section className="mt-3 rounded-lg border border-white/10 bg-[#0B1220] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Token Timeframe</p>
          <div className="rounded-lg border border-white/10 bg-[#0F172A] p-1">
            {TIMEFRAME_VIEWS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setSelectedTimeframe(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium tracking-[0.08em] ${selectedTimeframe === value ? "bg-[#3EC6FF]/20 text-[#E6EDF3]" : "text-[#9FB3C8] hover:text-[#E6EDF3]"}`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-3 grid grid-cols-1 gap-2 rounded-lg border border-white/10 bg-[#0B1220] p-3 md:grid-cols-3">
        <p className="text-sm text-[#E6EDF3]"><span className="text-[#9FB3C8]">Action:</span> {profileEvaluation.actionLabel}</p>
        <p className="text-sm text-[#E6EDF3]"><span className="text-[#9FB3C8]">Confidence:</span> {confidencePct >= 67 ? "High" : confidencePct >= 40 ? "Medium" : "Low"} ({confidencePct}%)</p>
        <p className="text-sm text-[#E6EDF3]"><span className="text-[#9FB3C8]">Strategy:</span> {profileEvaluation.strategy}</p>
      </section>

      <section className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSeeTradeSetup}
          className={`rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] transition ${isHighConvictionPaywall ? "border-[#22C55E]/50 bg-[#22C55E]/20 text-[#BBF7D0] hover:bg-[#22C55E]/30" : "border-[#2F7BFF]/40 bg-[#2F7BFF]/20 text-[#8ED8FF] hover:bg-[#2F7BFF]/35"}`}
        >
          🔍 Unlock Full Trade Setup
        </button>
        <button
          type="button"
          onClick={handleSimulation}
          className="rounded-lg border border-white/20 bg-[#0F172A] px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#C7D6E7] transition hover:border-white/35"
        >
          🧪 Test This Trade
        </button>
        <button
          type="button"
          onClick={handleViewEntryZone}
          className="rounded-lg border border-white/20 bg-[#0F172A] px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#C7D6E7] transition hover:border-white/35"
        >
          📊 View Entry Plan
        </button>
      </section>

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
              {isFreeTier && accessEntitlements?.lockEntryZone
                ? metricCell("Entry", "Unlock Pro to reveal the exact zone")
                : metricCell("Entry", entryDisplay)}
              {metricCell("Active TF", selectedTimeframe)}
              {isFreeTier && accessEntitlements?.lockEntryZone
                ? metricCell("Entry Timing", "Visible in Pro")
                : metricCell("Entry Timing", item.entryTiming ?? "No Entry Recommended")}
              {metricCell("HTF Confirm", item.htfConfirmed ? "Confirmed" : "Conflicted")}
              {isFreeTier && accessEntitlements?.lockEntryZone
                ? metricCell("Suggested Entry", "Pro only")
                : metricCell("Suggested Entry", `$${item.suggestedEntry.toFixed(4)}`)}
              {isFreeTier && accessEntitlements?.lockEntryZone
                ? metricCell("Fib Zone", "Pro only")
                : metricCell("Fib Zone", item.fibZone)}
            </div>
          ) : null}

          {activeTab === "Indicators" ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
              {metricCell(`${selectedTimeframe} RSI`, `${timeframeMetric.rsi.toFixed(1)} (${getRsiLabel(timeframeMetric.rsi)})`)}
              {metricCell(`${selectedTimeframe} Stochastic`, `${timeframeMetric.stochastic.toFixed(1)} (${getStochasticLabel(timeframeMetric.stochastic)})`)}
              {metricCell(`${selectedTimeframe} Trend`, timeframeStructureLabel)}
              {metricCell("EMA Slope", `${item.emaSlope.toFixed(4)} (${getEmaSlopeLabel(item.emaSlope)})`)}
              {metricCell("Volatility", `${item.volatilityPct.toFixed(2)}% (${getVolatilityLabel(item.volatilityPct)})`)}
            </div>
          ) : null}

          {activeTab === "Liquidity" ? (
            isFreeTier && accessEntitlements?.lockRiskDetails ? (
              <div className="rounded-lg border border-[#F59E0B]/25 bg-[#78350F]/25 p-3">
                <p className="text-sm font-semibold text-[#FFF7ED]">Risk and liquidity framing are part of Pro.</p>
                <p className="mt-1 text-sm text-[#FDE7C7]">Free keeps the decision layer visible. Pro unlocks stop context, take-profit map, and liquidity pressure.</p>
                <button
                  type="button"
                  onClick={() => requestUpgrade("risk_map", "Risk map locked")}
                  className="mt-3 rounded-lg border border-[#FCD34D]/35 bg-[#451A03]/70 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#FDE68A] transition hover:bg-[#5B2107]"
                >
                  Unlock Risk Map
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
                {metricCell("24h Volume", `$${(item.volume24h / 1_000_000).toFixed(2)}M`)}
                {metricCell("Sweep Risk", item.liquiditySweep)}
                {metricCell("Stop", `$${item.stopLoss.toFixed(4)}`)}
                {metricCell("Take Profit", `$${item.takeProfit.toFixed(4)}`)}
              </div>
            )
          ) : null}

          {activeTab === "Structure" ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
              {metricCell("Macro", item.alignment[0]?.direction ?? "MIXED")}
              {metricCell("Intermediary", item.alignment[1]?.direction ?? "MIXED")}
              {metricCell("Trigger", item.alignment[2]?.direction ?? "MIXED")}
              {metricCell(`Selected ${selectedTimeframe}`, timeframeStructureLabel)}
              {metricCell("Execution", item.state === "BLOCKED" ? "Hold" : "Watchlist")}
            </div>
          ) : null}

          {activeTab === "Heatmap" ? (
            isFreeTier && accessEntitlements?.lockRiskDetails ? (
              <div className="rounded-lg border border-[#F59E0B]/25 bg-[#78350F]/25 p-3">
                <p className="text-sm font-semibold text-[#FFF7ED]">Execution heatmap is a Pro layer.</p>
                <p className="mt-1 text-sm text-[#FDE7C7]">Free gives the setup direction. Pro reveals pressure zones, stop-liquidity estimates, and the deeper execution map.</p>
                <button
                  type="button"
                  onClick={() => requestUpgrade("risk_map", "Heatmap locked")}
                  className="mt-3 rounded-lg border border-[#FCD34D]/35 bg-[#451A03]/70 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#FDE68A] transition hover:bg-[#5B2107]"
                >
                  Unlock Heatmap
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3">
                <article className="rounded-lg border border-white/15 bg-[#0B1220] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex rounded-full border border-[#F43F5E]/45 bg-[#7F1D1D]/30 px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-[#FECACA]">
                      {selectedTimeframe} {tokenHeatmap.label}
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

                  <div className="mt-3 rounded-md border border-white/10 bg-[#0F172A] p-3 text-xs text-[#C7D6E7]">
                    <p className="font-semibold text-[#E6EDF3]">Meaning: {inferBias(item) === "BULLISH" ? "Price may spike upward to liquidate short positions" : inferBias(item) === "BEARISH" ? "Price may sweep downward to liquidate long positions" : "Range sweep likely before direction confirms"}</p>
                    <p className="mt-1">Confidence: {confidencePct >= 67 ? "High" : confidencePct >= 40 ? "Medium" : "Low"} ({confidencePct}%)</p>
                    <p className="mt-1">Action: {profileEvaluation.actionLabel}</p>
                  </div>
                </article>
              </div>
            )
          ) : null}

      </div>
    </article>
  );
}
