import { useEffect, useMemo, useRef, useState } from "react";
import { AlignmentBar } from "./alignment-bar";
import { SignalStateBadge } from "./signal-state-badge";
import { Direction, SignalItem } from "./types";
import { getProfileConfig, TradingProfile } from "../profile-selector";
import { evaluateSignalForProfile, getSignalStatePresentation } from "./profile-decision";
import { getDefaultTimeframeForProfile, getTimeframeDirectionLabel } from "./timeframe-analysis";
import type { AccessEntitlements } from "../../hooks/use-app-access";
import type { UpgradeIntent } from "./upgrade-modal";

type DetailTab = "Overview" | "Indicators" | "Liquidity" | "Structure" | "Heatmap";

type SignalCardProps = {
  item: SignalItem;
  onExecute: (item: SignalItem) => void;
  onSimulate?: (item: SignalItem, options?: { forced?: boolean }) => void;
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

function tradeMapCell(label: string, value: string, tone: "neutral" | "entry" | "risk" | "reward" = "neutral") {
  const toneClass = tone === "entry"
    ? "border-[#3EC6FF]/25 bg-[#10243C]"
    : tone === "risk"
      ? "border-[#EF4444]/25 bg-[#33161C]"
      : tone === "reward"
        ? "border-[#22C55E]/25 bg-[#0F2E25]"
        : "border-white/10 bg-[#0B1220]";

  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <p className="text-[10px] uppercase tracking-[0.12em] text-[#6B859E]">{label}</p>
      <p className="mt-1 text-sm font-semibold text-[#E6EDF3]">{value}</p>
    </div>
  );
}

function formatTradePrice(value: number): string {
  return value >= 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(6)}`;
}

function getTradeMapPresentation(profile: TradingProfile) {
  switch (profile) {
    case "scalp":
      return {
        executionLabel: "5m execution",
        holdWindowLabel: "minutes hold",
        entryLabel: "Scalp Entry",
        invalidationLabel: "Tight Stop",
        tp1Label: "TP1",
        tp2Label: "TP2",
        tp3Label: "Runner",
        setupDescriptor: "fast breakout map",
      };
    case "day":
      return {
        executionLabel: "15m execution",
        holdWindowLabel: "intraday hold",
        entryLabel: "Entry Zone",
        invalidationLabel: "Session Stop",
        tp1Label: "TP1",
        tp2Label: "TP2",
        tp3Label: "Session Extension",
        setupDescriptor: "intraday continuation map",
      };
    case "long_term":
      return {
        executionLabel: "1d execution",
        holdWindowLabel: "months hold",
        entryLabel: "Accumulation Zone",
        invalidationLabel: "Thesis Break",
        tp1Label: "Reduce Risk",
        tp2Label: "Position Target",
        tp3Label: "Macro Target",
        setupDescriptor: "macro accumulation map",
      };
    case "swing":
    default:
      return {
        executionLabel: "4h execution",
        holdWindowLabel: "days hold",
        entryLabel: "Pullback Zone",
        invalidationLabel: "Swing Stop",
        tp1Label: "TP1 Trim",
        tp2Label: "TP2 Swing",
        tp3Label: "TP3 Extension",
        setupDescriptor: "trend pullback map",
      };
  }
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

// ============================================================================
// MARKET STRUCTURE ALIGNMENT — Unified Multi-Timeframe View
// ============================================================================

type AlignmentContext = "TREND_ALIGNED" | "PARTIAL_ALIGNMENT" | "COUNTER_TREND" | "CHOP_NO_TREND";

/**
 * Determines alignment context from multi-timeframe structure.
 * Uses fixed mapping: Macro (1D/4H), Intermediary (4H/1H), Trigger (15M)
 */
function getAlignmentContext(options: {
  macroDirection: Direction;
  intermediaryDirection: Direction;
  triggerDirection: Direction;
}): {
  context: AlignmentContext;
  message: string;
  icon: string;
  color: string;
} {
  const { macroDirection: macro, intermediaryDirection: intermediary, triggerDirection: trigger } = options;

  const macroMixed = macro === "MIXED";
  const intermediaryMixed = intermediary === "MIXED";
  const macroOpposesTrigger = !macroMixed && macro !== trigger;

  if (macroMixed && intermediaryMixed) {
    return {
      context: "CHOP_NO_TREND",
      message: "Mixed conditions — low clarity market",
      icon: "❌",
      color: "text-[#9FB3C8]"
    };
  }

  if (macroOpposesTrigger) {
    return {
      context: "COUNTER_TREND",
      message: "No alignment — conflicting signals across timeframes",
      icon: "⚠️",
      color: "text-[#FDE68A]"
    };
  }

  if (intermediaryMixed) {
    return {
      context: "PARTIAL_ALIGNMENT",
      message: "Bullish trigger, but structure is incomplete",
      icon: "⚠️",
      color: "text-[#FDE68A]"
    };
  }

  return {
    context: "TREND_ALIGNED",
    message: "Timeframes aligned — high probability setup",
    icon: "✅",
    color: "text-[#86EFAC]"
  };
}

/**
 * Formats a single timeframe layer with arrow and label.
 */
function formatTimeframeDirection(direction: "UP" | "DOWN" | "MIXED", timeframeLabel: string): {
  arrow: string;
  color: string;
  label: string;
} {
  if (direction === "UP") {
    return { arrow: "↑", color: "text-[#86EFAC]", label: `${timeframeLabel} UP` };
  }
  if (direction === "DOWN") {
    return { arrow: "↓", color: "text-[#FCA5A5]", label: `${timeframeLabel} DOWN` };
  }
  return { arrow: "→", color: "text-[#FDE68A]", label: `${timeframeLabel} MIXED` };
}

/**
 * Generates context-aware decision message based on alignment.
 */
function getMarketStructureDecision(alignment: AlignmentContext, item: SignalItem): {
  execution: string;
  confidence: string;
} {
  if (alignment === "TREND_ALIGNED") {
    return {
      execution: item.state === "READY" ? "Proceed — entry conditions align across timeframes" : "Wait for trigger confirmation in aligned trend",
      confidence: item.state === "READY" ? "High" : "Medium"
    };
  }

  if (alignment === "PARTIAL_ALIGNMENT") {
    return {
      execution: "Wait for trigger confirmation before treating this as a real setup",
      confidence: "Medium"
    };
  }

  if (alignment === "COUNTER_TREND") {
    return {
      execution: "Avoid — Wait for alignment or confirmed reversal",
      confidence: "Low"
    };
  }

  return {
    execution: "Avoid — No trade in mixed conditions",
    confidence: "Low"
  };
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
  const [showDetails, setShowDetails] = useState(false);
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  const profileConfig = useMemo(() => getProfileConfig(userProfile), [userProfile]);
  const activeSetupPlan = useMemo(
    () => item.profileSetupPlans?.[userProfile] ?? item.setupPlan,
    [item.profileSetupPlans, item.setupPlan, userProfile],
  );
  const activeSuggestedEntry = useMemo(() => {
    if (activeSetupPlan.entryZoneLow != null && activeSetupPlan.entryZoneHigh != null) {
      return (activeSetupPlan.entryZoneLow + activeSetupPlan.entryZoneHigh) / 2;
    }

    return item.suggestedEntry;
  }, [activeSetupPlan.entryZoneHigh, activeSetupPlan.entryZoneLow, item.suggestedEntry]);
  const activeStopLoss = activeSetupPlan.invalidation ?? item.stopLoss;
  const activeTakeProfit = activeSetupPlan.tp1 ?? item.takeProfit;
  const activeItem = useMemo(
    () => ({
      ...item,
      suggestedEntry: activeSuggestedEntry,
      stopLoss: activeStopLoss,
      takeProfit: activeTakeProfit,
      setupPlan: activeSetupPlan,
    }),
    [activeSetupPlan, activeStopLoss, activeSuggestedEntry, activeTakeProfit, item],
  );
  const activeIsLongBias = activeTakeProfit >= activeSuggestedEntry;

  const scorePct = useMemo(() => Math.max(0, Math.min(100, (item.score / 10) * 100)), [item.score]);
  const profileEvaluation = useMemo(() => evaluateSignalForProfile(activeItem, userProfile), [activeItem, userProfile]);
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
      : "🚫 No safe entry";
  const confidenceBand = useMemo(() => getConfidenceBand(confidencePct), [confidencePct]);
  const scoreTranslation = useMemo(() => getScoreTranslation(item.score), [item.score]);
  const actionInsight = useMemo(() => getActionInsight(activeItem), [activeItem]);
  const nextStep = profileEvaluation.nextStep;
  const fallbackWhyList = useMemo(() => whyBullets(activeItem), [activeItem]);
  const whyList = profileEvaluation.reasons.length > 0 ? profileEvaluation.reasons : fallbackWhyList;
  const triggerCondition = profileEvaluation.triggerCondition;
  const executionTimeframe = useMemo(() => getDefaultTimeframeForProfile(userProfile), [userProfile]);
  const tradeMapPresentation = useMemo(() => getTradeMapPresentation(userProfile), [userProfile]);
  const preEntryWatch = activeItem.preEntryWatch;
  const shouldShowPreEntryWatch = profileEvaluation.signalState !== "ACTIVE";
  const watchState = preEntryWatch?.state ?? "NO_WATCH";
  const watchDirectionLabel = watchState === "WATCH_SHORT"
    ? "WATCH SHORT"
    : watchState === "WATCH_LONG"
      ? "WATCH LONG"
      : "NO WATCH";
  const watchShellClass = watchState === "WATCH_SHORT"
    ? "border-[#EF4444]/30 bg-[#3F1218]/35"
    : watchState === "WATCH_LONG"
      ? "border-[#F59E0B]/30 bg-[#3A2A0E]/30"
      : "border-white/15 bg-[#0B1220]";
  const watchBadgeClass = watchState === "WATCH_SHORT"
    ? "border-[#EF4444]/40 bg-[#3F1218]/60 text-[#FCA5A5]"
    : watchState === "WATCH_LONG"
      ? "border-[#F59E0B]/40 bg-[#3A2A0E]/60 text-[#FDE68A]"
      : "border-white/20 bg-[#0F172A] text-[#9FB3C8]";
  const watchZoneLabel = preEntryWatch?.zoneLow != null && preEntryWatch?.zoneHigh != null
    ? `${formatTradePrice(preEntryWatch.zoneLow)} - ${formatTradePrice(preEntryWatch.zoneHigh)}`
    : "Not available yet";
  const watchInvalidationLabel = preEntryWatch?.invalidation != null
    ? formatTradePrice(preEntryWatch.invalidation)
    : "Not available yet";
  const watchTriggerLabel = preEntryWatch?.trigger != null
    ? formatTradePrice(preEntryWatch.trigger)
    : "Not available yet";
  const watchStatusLabel = useMemo(() => {
    if (!preEntryWatch || preEntryWatch.state === "NO_WATCH" || preEntryWatch.zoneLow == null || preEntryWatch.zoneHigh == null) {
      return "No active watch zone yet";
    }

    if (item.price >= preEntryWatch.zoneLow && item.price <= preEntryWatch.zoneHigh) {
      return "Price is inside watch zone";
    }

    if (preEntryWatch.state === "WATCH_LONG") {
      return item.price < preEntryWatch.zoneLow ? "Below watch zone — wait for reclaim" : "Above watch zone — wait for confirmation";
    }

    return item.price > preEntryWatch.zoneHigh ? "Above watch zone — wait for rejection" : "Below watch zone — wait for confirmation";
  }, [item.price, preEntryWatch]);
  const hasStructureSetupPlan = Boolean(
    activeSetupPlan.direction !== "NEUTRAL"
    && activeSetupPlan.entryZoneLow != null
    && activeSetupPlan.entryZoneHigh != null
    && activeSetupPlan.invalidation != null
    && activeSetupPlan.tp1 != null
  );
  const tradeMapValues = useMemo(() => {
    if (!hasStructureSetupPlan) {
      return {
        entry: "No setup yet",
        invalidation: "No setup yet",
        tp1: "No setup yet",
        tp2: "No setup yet",
        tp3: "No setup yet",
      };
    }

    const entryLow = activeSetupPlan.entryZoneLow ?? activeSuggestedEntry;
    const entryHigh = activeSetupPlan.entryZoneHigh ?? activeSuggestedEntry;

    return {
      entry: `${formatTradePrice(entryLow)} - ${formatTradePrice(entryHigh)}`,
      invalidation: activeSetupPlan.invalidation != null ? formatTradePrice(activeSetupPlan.invalidation) : "n/a",
      tp1: activeSetupPlan.tp1 != null ? formatTradePrice(activeSetupPlan.tp1) : "n/a",
      tp2: activeSetupPlan.tp2 != null ? formatTradePrice(activeSetupPlan.tp2) : "n/a",
      tp3: activeSetupPlan.tp3 != null ? formatTradePrice(activeSetupPlan.tp3) : "n/a",
    };
  }, [activeSetupPlan.entryZoneHigh, activeSetupPlan.entryZoneLow, activeSetupPlan.invalidation, activeSetupPlan.tp1, activeSetupPlan.tp2, activeSetupPlan.tp3, activeSuggestedEntry, hasStructureSetupPlan]);

  const triggerMetric = useMemo(() => item.timeframeMetrics[executionTimeframe], [executionTimeframe, item]);
  const triggerStructureLabel = useMemo(() => getTimeframeDirectionLabel(triggerMetric.direction), [triggerMetric.direction]);
  const macroDirection = item.alignment[0]?.direction ?? "MIXED";
  const intermediaryDirection = item.alignment[1]?.direction ?? "MIXED";
  const triggerDirection = triggerMetric.direction;

  const alignmentCtx = useMemo(
    () => getAlignmentContext({ macroDirection, intermediaryDirection, triggerDirection }),
    [intermediaryDirection, macroDirection, triggerDirection],
  );
  const marketStructureDecision = useMemo(() => getMarketStructureDecision(alignmentCtx.context, activeItem), [activeItem, alignmentCtx.context]);
  const triggerBiasLabel =
    triggerDirection === "UP" ? "BULLISH" : triggerDirection === "DOWN" ? "BEARISH" : "NEUTRAL";
  const triggerCounterTrendSuffix = macroDirection !== "MIXED" && macroDirection !== triggerDirection
    ? " (Counter-Trend)"
    : "";
  const alignmentSummary = alignmentCtx.message;
  const tradeContextLabel = alignmentCtx.context === "TREND_ALIGNED"
    ? "✅ Trend-Aligned"
    : alignmentCtx.context === "PARTIAL_ALIGNMENT"
      ? "⚠️ Partial Alignment"
      : alignmentCtx.context === "COUNTER_TREND"
        ? "⚠️ Counter-Trend Bounce"
        : "❌ Chop / No Trend";
  const isFreeTier = accessEntitlements?.isFreeTier ?? false;
  const isExecutionLocked = isFreeTier && Boolean(accessEntitlements?.lockTradeSetup);
  const isHighConvictionPaywall = isExecutionLocked && (profileEvaluation.signalState === "ACTIVE" || confidencePct > 70);
  const isHighConfidenceTeaser = isExecutionLocked && (confidencePct >= 75 || profileEvaluation.actionLabel.includes("BUY"));
  const isAvoidSetup =
    item.state === "BLOCKED" ||
    profileEvaluation.decision === "AVOID" ||
    profileEvaluation.actionLabel.toUpperCase().includes("AVOID");

  // Decision block: compressed 2-line label + subtext
  const decisionLabel = useMemo(() => {
    if (isAvoidSetup) {
      if (alignmentCtx.context === "COUNTER_TREND") {
        return "🚫 AVOID — Counter-Trend Setup (Low Probability)";
      }
      if (alignmentCtx.context === "CHOP_NO_TREND") {
        return "🚫 AVOID — No Clear Direction";
      }
      return `🚫 AVOID — Low Probability (${confidencePct}%)`;
    }
    if (profileEvaluation.signalState !== "ACTIVE") {
      if (profileEvaluation.decision === "BUY") return `⚡ PREPARE LONG — ${confidencePct}% Confidence`;
      if (profileEvaluation.decision === "SELL") return `⚡ PREPARE SHORT — ${confidencePct}% Confidence`;
      if (profileEvaluation.decision === "HOLD") return `⚡ PREPARE — Watch for trigger (${confidencePct}%)`;
    }
    if (profileEvaluation.decision === "BUY") return `✅ BUY — ${confidencePct}% Confidence`;
    if (profileEvaluation.decision === "SELL") return `🔻 SELL — ${confidencePct}% Confidence`;
    if (profileEvaluation.decision === "WAIT") return `⏳ WAIT — Setup forming (${confidencePct}%)`;
    if (profileEvaluation.decision === "HOLD") return `⚡ PREPARE — Watch for trigger (${confidencePct}%)`;
    return `⏳ CAUTION — ${confidencePct}% Confidence`;
  }, [isAvoidSetup, profileEvaluation.decision, profileEvaluation.signalState, confidencePct, alignmentCtx.context]);

  const decisionSubtext = useMemo(() => {
    if (isAvoidSetup) {
      if (alignmentCtx.context === "COUNTER_TREND") {
        return "Short-term bounce against a downtrend — no confirmation yet";
      }
      if (alignmentCtx.context === "CHOP_NO_TREND") {
        return "Market conditions are mixed — low probability environment";
      }
      if (alignmentCtx.context === "TREND_ALIGNED") {
        return "Trend is aligned, but entry confirmation is incomplete — patience protects capital";
      }
      return "Low probability setup — wait for better alignment";
    }
    if (profileEvaluation.signalState !== "ACTIVE") {
      if (profileEvaluation.decision === "BUY") return "Bullish structure is strong, but the entry trigger has not fired yet";
      if (profileEvaluation.decision === "SELL") return "Bearish structure is strong, but the entry trigger has not fired yet";
    }
    if (profileEvaluation.decision === "BUY") return "Momentum and structure aligned for entry";
    if (profileEvaluation.decision === "SELL") return "Downtrend and structure aligned for short";
    if (profileEvaluation.decision === "WAIT") return "Signals building — confirmation incomplete";
    if (profileEvaluation.decision === "HOLD") return "Wait for breakout to confirm";
    return "No clear directional edge yet";
  }, [isAvoidSetup, profileEvaluation.decision, profileEvaluation.signalState, alignmentCtx.context]);

  // Single-line next step directive
  const nextStepDirective = useMemo(() => {
    if (isAvoidSetup) return "➡️ Stand aside — no safe entry";
    if (profileEvaluation.decision === "BUY") {
      return profileEvaluation.signalState === "ACTIVE"
        ? `➡️ ${stateNextStep || nextStep || "Enter on confirmation"}`
        : `➡️ ${triggerCondition || nextStep || "Wait for long trigger confirmation"}`;
    }
    if (profileEvaluation.decision === "SELL") {
      return profileEvaluation.signalState === "ACTIVE"
        ? `➡️ ${stateNextStep || nextStep || "Enter on breakdown confirmation"}`
        : `➡️ ${triggerCondition || nextStep || "Wait for short trigger confirmation"}`;
    }
    return `➡️ ${stateNextStep || nextStep || "Wait for trend to confirm"}`;
  }, [isAvoidSetup, nextStep, profileEvaluation.decision, profileEvaluation.signalState, stateNextStep, triggerCondition]);

  // Tag-based signal assessment (max 3)
  const signalTags = useMemo(() => {
    const tags: Array<{ label: string; icon: string; ok: boolean }> = [];
    const hasActionableSignal = profileEvaluation.signalState !== "AVOID" && !isAvoidSetup;
    tags.push({ label: "Signals", icon: hasActionableSignal ? "✅" : "❌", ok: hasActionableSignal });

    const structureAligned = alignmentCtx.context === "TREND_ALIGNED";
    tags.push({ label: "Structure", icon: structureAligned ? "✅" : "❌", ok: structureAligned });

    const hasConfirmation = profileEvaluation.signalState === "ACTIVE";
    tags.push({ label: "Confirmation", icon: hasConfirmation ? "✅" : "❌", ok: hasConfirmation });
    return tags;
  }, [alignmentCtx.context, isAvoidSetup, profileEvaluation.signalState]);

  // Blocked → Below threshold terminology
  const normalizedState = item.state === "BLOCKED" ? "BELOW_THRESHOLD" : item.state;

  const tokenHeatmap = useMemo(() => {
    const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
    const formatMoney = (value: number) => `$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

    const isLongBias = activeIsLongBias;
    const scoreComponent = clamp(item.score * 9.5);
    const structureComponent = triggerMetric.direction === "MIXED" ? -6 : triggerMetric.direction === "UP" ? 14 : 8;
    const sweepPenalty = item.liquiditySweep === "HIGH" ? -8 : item.liquiditySweep === "MEDIUM" ? -3 : 4;
    const confidence = clamp(scoreComponent + structureComponent + sweepPenalty);

    const stochasticPressure = triggerMetric.stochastic > 80 ? 18 : triggerMetric.stochastic < 20 ? 10 : 14;
    const directionalPressure = clamp((item.volatilityPct * 4) + stochasticPressure + (item.liquiditySweep === "HIGH" ? 12 : item.liquiditySweep === "MEDIUM" ? 6 : 0));

    const longPctBase = clamp(50 + (isLongBias ? 12 : -12) + Math.round((item.score - 5) * 4));
    const longPct = Math.max(5, Math.min(95, longPctBase));
    const shortPct = 100 - longPct;

    const liquidityBase = item.volume24h * Math.max(0.02, item.volatilityPct / 100);
    const longStopLiq = liquidityBase * (longPct / 100) * 0.92;
    const shortStopLiq = liquidityBase * (shortPct / 100) * 0.92;
    const pooledStopLiq = longStopLiq + shortStopLiq;

    const longSlAvg = activeStopLoss;
    const shortHuntTop = isLongBias ? activeTakeProfit * 1.015 : activeSuggestedEntry * 1.01;

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
  }, [activeIsLongBias, activeStopLoss, activeSuggestedEntry, activeTakeProfit, item.liquiditySweep, item.score, item.volume24h, item.volatilityPct, triggerMetric.direction, triggerMetric.stochastic]);

  const entryDisplay = useMemo(() => {
    if (!hasStructureSetupPlan || item.state === "BLOCKED" || !item.htfConfirmed) {
      return "No Entry Recommended";
    }

    const lower = activeSetupPlan.entryZoneLow ?? (activeSuggestedEntry * 0.995);
    const upper = activeSetupPlan.entryZoneHigh ?? (activeSuggestedEntry * 1.005);
    const breakoutNote = item.state === "CAUTION" || item.state === "BUILDING" ? " (Breakout Required)" : "";
    return `Entry Zone: $${lower.toFixed(4)} - $${upper.toFixed(4)}${breakoutNote}`;
  }, [activeSetupPlan.entryZoneHigh, activeSetupPlan.entryZoneLow, activeSuggestedEntry, hasStructureSetupPlan, item.htfConfirmed, item.state]);

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
    onExecute(activeItem);
  };

  const handleSimulation = () => {
    if (isAvoidSetup) {
      setShowOverrideModal(true);
    } else {
      onSimulate?.(activeItem, { forced: false });
    }
  };

  const confirmOverrideSimulation = () => {
    setShowOverrideModal(false);
    onSimulate?.(activeItem, { forced: true });
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
      {/* Override confirmation modal */}
      {showOverrideModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm rounded-xl border border-[#EF4444]/40 bg-[#1A0A0A] p-6">
            <p className="text-lg font-bold text-[#FCA5A5]">You are overriding Strata ⚠️</p>
            <p className="mt-2 text-sm text-[#FECACA]">
              Strata flags this as a low-probability setup. Simulating it helps you understand why these trades fail.
            </p>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={confirmOverrideSimulation}
                className="flex-1 rounded-lg border border-[#EF4444]/50 bg-[#3F1218]/60 px-4 py-2 text-sm font-semibold text-[#FCA5A5] transition hover:bg-[#3F1218]/90"
              >
                Simulate Anyway
              </button>
              <button
                type="button"
                onClick={() => setShowOverrideModal(false)}
                className="flex-1 rounded-lg border border-white/20 bg-[#0F172A] px-4 py-2 text-sm font-semibold text-[#C7D6E7] transition hover:border-white/35"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* DECISION BLOCK — dominant, instant read */}
      <section className={`rounded-xl border p-4 ${decisionShellClass}`}>
        <p className="text-xl font-extrabold tracking-tight leading-tight">{decisionLabel}</p>
        <p className="mt-1 text-sm opacity-80">{decisionSubtext}</p>
      </section>

      {/* TOKEN + PRICE HEADER (compact) */}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xl font-extrabold tracking-tight text-[#E6EDF3]">{item.symbol}</span>
        <span
          className={`font-mono text-xl font-bold tabular-nums text-[#E6EDF3] transition-colors ${
            priceTicking ? "price-tick-flash" : ""
          }`}
        >
          ${item.price >= 1 ? item.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : item.price.toFixed(6)}
        </span>
        {priceTicking && (
          <span className="rounded-full bg-[#22D3EE]/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest text-[#67E8F9]">live</span>
        )}
        <span className="text-xs text-[#6B859E]">{item.displayName}</span>
        <span className="text-[10px] uppercase tracking-[0.08em] text-[#6B859E]">MCap {formatMarketCap(item.marketCapUsd)}</span>
      </div>

      {/* CONFIDENCE BAR */}
      <div className="mt-3">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Confidence</p>
          <p className="text-sm font-bold text-[#E6EDF3]">{confidencePct}%</p>
        </div>
        <div className="mt-1 h-2 rounded-full bg-[#0B1220]">
          <div
            className="h-2 rounded-full bg-gradient-to-r from-[#EF4444] via-[#F59E0B] to-[#22C55E] transition-all"
            style={{ width: `${confidencePct}%` }}
          />
        </div>
      </div>

      {/* SIGNAL TAGS (3 max, scannable) */}
      <div className="mt-3 flex flex-wrap gap-2">
        {signalTags.map((tag) => (
          <span
            key={tag.label}
            className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium ${
              tag.ok
                ? "border-[#22C55E]/30 bg-[#0F2E25]/50 text-[#86EFAC]"
                : "border-[#EF4444]/30 bg-[#3F1218]/40 text-[#FCA5A5]"
            }`}
          >
            {tag.icon} {tag.label}: {tag.ok ? "OK" : "Not aligned"}
          </span>
        ))}
      </div>

      {/* MARKET STRUCTURE — unified, always visible */}
      <section className="mt-3 rounded-lg border border-white/15 bg-[#0B1220] p-3">
        <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E] font-semibold">Market Structure</p>

        <div className="mt-2 space-y-2">
          <div className="flex items-center justify-between rounded-md border border-white/10 bg-[#0F172A] px-3 py-2">
            <span className="text-xs font-medium text-[#E6EDF3]">Macro (1D / 4H)</span>
            <span className={`text-xs font-bold ${formatTimeframeDirection(macroDirection, "").color}`}>
              {formatTimeframeDirection(macroDirection, "").arrow} {macroDirection}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-white/10 bg-[#0F172A] px-3 py-2">
            <span className="text-xs font-medium text-[#E6EDF3]">Intermediary (4H / 1H)</span>
            <span className={`text-xs font-bold ${formatTimeframeDirection(intermediaryDirection, "").color}`}>
              {formatTimeframeDirection(intermediaryDirection, "").arrow} {intermediaryDirection}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-white/10 bg-[#0F172A] px-3 py-2">
            <span className="text-xs font-medium text-[#E6EDF3]">
              Trigger ({executionTimeframe})
            </span>
            <span className={`text-xs font-bold ${formatTimeframeDirection(triggerDirection, "").color}`}>
              {formatTimeframeDirection(triggerDirection, "").arrow} {triggerBiasLabel}{triggerCounterTrendSuffix}
            </span>
          </div>
        </div>

        {/* Alignment Summary */}
        <p className="mt-3 text-xs font-semibold text-[#C7D6E7]">{alignmentSummary}</p>

        {/* Counter-trend warning */}
        {alignmentCtx.context === "COUNTER_TREND" ? (
          <p className="mt-2 text-xs text-[#FDE68A] opacity-95">
            ⚠️ Short-term bullish move against a macro downtrend — higher risk, wait for structure confirmation
          </p>
        ) : null}

        {/* Trade Context */}
        <div className="mt-3 rounded-md border border-white/10 bg-[#0F172A] px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Trade Context</p>
          <p className={`mt-1 text-xs font-semibold ${alignmentCtx.color}`}>{tradeContextLabel}</p>
        </div>

        {/* Execution */}
        <div className="mt-2 rounded-md border border-white/10 bg-[#0F172A] px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Execution</p>
          <p className="mt-1 text-xs font-semibold text-[#E6EDF3]">{marketStructureDecision.execution}</p>
          <p className="mt-1 text-xs text-[#9FB3C8]">Confidence: {marketStructureDecision.confidence}</p>
        </div>
      </section>

      {/* DUMP-REVERSAL PHASE — post-dump entry safety gate */}
      {item.dumpReversalContext && item.dumpReversalContext.phase !== "NORMAL" ? (
        <div className="mt-2">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Market Phase</p>
            <p className={`text-xs font-bold ${
              item.dumpReversalContext.phase === "DUMP_IN_PROGRESS"
                ? "text-[#FCA5A5]"
                : item.dumpReversalContext.phase === "REACTION_FORMING"
                  ? "text-[#FDE68A]"
                  : "text-[#86EFAC]"
            }`}>
              {item.dumpReversalContext.phase === "DUMP_IN_PROGRESS"
                ? "⚠️ Dump in Progress"
                : item.dumpReversalContext.phase === "REACTION_FORMING"
                  ? "🟡 Reaction Forming"
                  : "✅ Structure Confirmed"}
            </p>
          </div>
          {item.dumpReversalContext.stateMessage && (
            <p className={`mt-1 text-xs opacity-90 ${
              item.dumpReversalContext.phase === "DUMP_IN_PROGRESS"
                ? "text-[#FCA5A5]"
                : item.dumpReversalContext.phase === "REACTION_FORMING"
                  ? "text-[#FDE68A]"
                  : "text-[#86EFAC]"
            }`}>
              {item.dumpReversalContext.stateMessage}
            </p>
          )}
        </div>
      ) : null}

      {/* NEXT STEP — single directive */}
      <p className="mt-3 text-sm font-semibold text-[#E6EDF3]">{nextStepDirective}</p>

      {/* PRE-ENTRY WATCH — early zone guidance before trigger confirmation */}
      {shouldShowPreEntryWatch ? (
        <section className={`mt-3 rounded-lg border p-3 ${watchShellClass}`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Pre-Entry Watch</p>
            <span className={`rounded-md border px-2 py-1 text-[10px] font-semibold tracking-[0.08em] ${watchBadgeClass}`}>
              {watchDirectionLabel}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
            {tradeMapCell("Watch Zone", watchZoneLabel, "entry")}
            {tradeMapCell("Invalidation", watchInvalidationLabel, "risk")}
            {tradeMapCell("Trigger", watchTriggerLabel, "reward")}
          </div>
          <p className="mt-2 text-xs font-medium text-[#E6EDF3]">{watchStatusLabel}</p>
          <p className="mt-1 text-xs text-[#9FB3C8]">{preEntryWatch?.rationale ?? "Waiting for directional structure and reliable support/resistance levels."}</p>
        </section>
      ) : null}

      {/* TRADE MAP — compact executable setup summary */}
      <section className="mt-3 rounded-lg border border-white/10 bg-[#0B1220] p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Trade Map</p>
            <p className="mt-1 text-[11px] text-[#9FB3C8]">
              {profileConfig.name} • {tradeMapPresentation.executionLabel} • {tradeMapPresentation.holdWindowLabel}
            </p>
          </div>
          <p className="text-[11px] text-[#9FB3C8]">
            {hasStructureSetupPlan ? `${activeSetupPlan.direction} ${tradeMapPresentation.setupDescriptor}` : "Waiting for setup"}
          </p>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-5">
          {tradeMapCell(tradeMapPresentation.entryLabel, tradeMapValues.entry, "entry")}
          {tradeMapCell(tradeMapPresentation.invalidationLabel, tradeMapValues.invalidation, "risk")}
          {tradeMapCell(tradeMapPresentation.tp1Label, tradeMapValues.tp1, "reward")}
          {tradeMapCell(tradeMapPresentation.tp2Label, tradeMapValues.tp2, "reward")}
          {tradeMapCell(tradeMapPresentation.tp3Label, tradeMapValues.tp3, "reward")}
        </div>
      </section>

      {/* TRIGGER — locked vs unlocked */}
      {isFreeTier && accessEntitlements?.lockTriggerDetails ? (
        <section className="mt-3 rounded-lg border border-[#F59E0B]/25 bg-[#78350F]/25 p-3">
          <p className="text-[11px] uppercase tracking-[0.12em] text-[#FCD34D]">{triggerHeadline}</p>
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
          <p className="text-[11px] uppercase tracking-[0.12em] text-[#FCD34D]">{triggerHeadline}</p>
          <p className="mt-1 text-sm font-medium text-[#FDE68A]">
            {profileEvaluation.signalState === "ACTIVE" ? "Entry is valid now — act on the confirmed trigger." : triggerCondition}
          </p>
        </section>
      )}

      {/* ACTION BUTTONS */}
      <section className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSeeTradeSetup}
          className={`rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] transition ${isHighConvictionPaywall ? "border-[#22C55E]/50 bg-[#22C55E]/20 text-[#BBF7D0] hover:bg-[#22C55E]/30" : "border-[#2F7BFF]/40 bg-[#2F7BFF]/20 text-[#8ED8FF] hover:bg-[#2F7BFF]/35"}`}
        >
          🔍 Unlock Full Trade Setup
        </button>
        {/* Simulation button — ghost when avoid */}
        <button
          type="button"
          onClick={handleSimulation}
          className={`rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] transition ${
            isAvoidSetup
              ? "border-white/15 bg-transparent text-[#6B859E] hover:border-white/25 hover:text-[#9FB3C8]"
              : activeIsLongBias
                ? "border-[#22C55E]/40 bg-[#0F2E25]/40 text-[#86EFAC] hover:bg-[#0F2E25]/60"
                : "border-[#F59E0B]/40 bg-[#3A2A0E]/40 text-[#FDE68A] hover:bg-[#3A2A0E]/60"
          }`}
        >
          {isAvoidSetup
            ? `Simulate ${activeIsLongBias ? "Long" : "Short"} Anyway`
            : activeIsLongBias
              ? "🟢 Simulate Long"
              : "🔴 Simulate Short"}
        </button>
        <button
          type="button"
          onClick={handleViewEntryZone}
          className="rounded-lg border border-white/20 bg-[#0F172A] px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#C7D6E7] transition hover:border-white/35"
        >
          📊 View Entry Plan
        </button>
      </section>

      {/* DETAILS — collapsed by default */}
      <div className="mt-4 border-t border-white/10 pt-3">
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="flex items-center gap-1 text-xs text-[#6B859E] transition hover:text-[#9FB3C8]"
        >
          <span>{showDetails ? "▲" : "▼"}</span>
          <span>{showDetails ? "Hide Details" : "View Details"}</span>
        </button>
      </div>

      {showDetails ? (
      <div className="mt-3">
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
              {metricCell("Confidence", `${confidencePct}%`)}
              {isFreeTier && accessEntitlements?.lockEntryZone
                ? metricCell("Entry Timing", "Visible in Pro")
                : metricCell("Entry Timing", item.entryTiming ?? "No Entry Recommended")}
              {metricCell("HTF Confirm", item.htfConfirmed ? "Confirmed" : "Conflicted")}
              {isFreeTier && accessEntitlements?.lockEntryZone
                ? metricCell("Suggested Entry", "Pro only")
                : metricCell("Suggested Entry", hasStructureSetupPlan ? formatTradePrice(activeSuggestedEntry) : "No setup yet")}
              {isFreeTier && accessEntitlements?.lockEntryZone
                ? metricCell("Fib Zone", "Pro only")
                : metricCell("Fib Zone", item.fibZone)}
              {isFreeTier && accessEntitlements?.lockEntryZone
                ? metricCell("TP1", "Pro only")
                : metricCell("TP1", hasStructureSetupPlan && activeSetupPlan.tp1 != null ? formatTradePrice(activeSetupPlan.tp1) : "No setup yet")}
              {isFreeTier && accessEntitlements?.lockEntryZone
                ? metricCell("TP2", "Pro only")
                : metricCell("TP2", hasStructureSetupPlan && activeSetupPlan.tp2 != null ? formatTradePrice(activeSetupPlan.tp2) : "No setup yet")} 
              {isFreeTier && accessEntitlements?.lockEntryZone
                ? metricCell("TP3", "Pro only")
                : metricCell("TP3", hasStructureSetupPlan && activeSetupPlan.tp3 != null ? formatTradePrice(activeSetupPlan.tp3) : "No setup yet")} 
              {isFreeTier && accessEntitlements?.lockEntryZone
                ? metricCell("Invalidation", "Pro only")
                : metricCell("Invalidation", hasStructureSetupPlan && activeSetupPlan.invalidation != null ? formatTradePrice(activeSetupPlan.invalidation) : "No setup yet")}
            </div>
          ) : null}

          {activeTab === "Indicators" ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
              {metricCell(`${executionTimeframe} RSI`, `${triggerMetric.rsi.toFixed(1)} (${getRsiLabel(triggerMetric.rsi)})`)}
              {metricCell(`${executionTimeframe} Stochastic`, `${triggerMetric.stochastic.toFixed(1)} (${getStochasticLabel(triggerMetric.stochastic)})`)}
              {metricCell(`${executionTimeframe} Trend`, triggerStructureLabel)}
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
                {metricCell("Invalidation", hasStructureSetupPlan && activeSetupPlan.invalidation != null ? formatTradePrice(activeSetupPlan.invalidation) : "No setup yet")}
                {metricCell("TP1", hasStructureSetupPlan && activeSetupPlan.tp1 != null ? formatTradePrice(activeSetupPlan.tp1) : "No setup yet")}
                {metricCell("TP2", hasStructureSetupPlan && activeSetupPlan.tp2 != null ? formatTradePrice(activeSetupPlan.tp2) : "No setup yet")}
                {metricCell("TP3", hasStructureSetupPlan && activeSetupPlan.tp3 != null ? formatTradePrice(activeSetupPlan.tp3) : "No setup yet")}
              </div>
            )
          ) : null}

          {activeTab === "Overview" ? (
            <div className="mt-3 rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Setup Plan</p>
              <p className="mt-1 text-sm text-[#C7D6E7]">{hasStructureSetupPlan ? activeSetupPlan.rationale : "No executable structure-based plan is available yet. Wait for resistance/support interaction and confirmation."}</p>
            </div>
          ) : null}

          {activeTab === "Structure" ? (
            <div className="space-y-4">
              {/* MARKET STRUCTURE — Unified Multi-Timeframe View */}
              <div className="rounded-lg border border-white/15 bg-[#0B1220] p-4">
                <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E] font-semibold">Market Structure</p>
                
                <div className="mt-3 space-y-2">
                  {/* Macro (1D / 4H) */}
                  <div className="flex items-center justify-between rounded-md border border-white/10 bg-[#0F172A] p-3">
                    <span className="text-xs font-medium text-[#E6EDF3]">Macro (1D / 4H)</span>
                    <span className={`text-sm font-bold ${formatTimeframeDirection(item.alignment[0]?.direction as "UP" | "DOWN" | "MIXED" ?? "MIXED", "").color}`}>
                      {formatTimeframeDirection(item.alignment[0]?.direction as "UP" | "DOWN" | "MIXED" ?? "MIXED", "").arrow} {item.alignment[0]?.direction ?? "MIXED"}
                    </span>
                  </div>
                  
                  {/* Intermediary (4H / 1H) */}
                  <div className="flex items-center justify-between rounded-md border border-white/10 bg-[#0F172A] p-3">
                    <span className="text-xs font-medium text-[#E6EDF3]">Intermediary (4H / 1H)</span>
                    <span className={`text-sm font-bold ${formatTimeframeDirection(item.alignment[1]?.direction as "UP" | "DOWN" | "MIXED" ?? "MIXED", "").color}`}>
                      {formatTimeframeDirection(item.alignment[1]?.direction as "UP" | "DOWN" | "MIXED" ?? "MIXED", "").arrow} {item.alignment[1]?.direction ?? "MIXED"}
                    </span>
                  </div>
                  
                  {/* Trigger (15M) */}
                  <div className="flex items-center justify-between rounded-md border border-white/10 bg-[#0F172A] p-3">
                    <span className="text-xs font-medium text-[#E6EDF3]">
                      Trigger (${executionTimeframe})
                      {(alignmentCtx.context === "COUNTER_TREND" || alignmentCtx.context === "PARTIAL_ALIGNMENT") ? <span className="ml-2 text-[#FDE68A]">{alignmentCtx.icon}</span> : null}
                    </span>
                    <span className={`text-sm font-bold ${formatTimeframeDirection(triggerDirection, "").color}`}>
                      {formatTimeframeDirection(triggerDirection, "").arrow} {triggerDirection}
                    </span>
                  </div>
                </div>

                {/* CONTEXT TAG */}
                <div className={`mt-4 rounded-md border-l-4 bg-opacity-20 p-3 ${
                  alignmentCtx.context === "TREND_ALIGNED"
                    ? "border-l-[#86EFAC] bg-[#0F2E25] text-[#86EFAC]"
                    : alignmentCtx.context === "COUNTER_TREND" || alignmentCtx.context === "PARTIAL_ALIGNMENT"
                      ? "border-l-[#FDE68A] bg-[#3A2A0E] text-[#FDE68A]"
                      : "border-l-[#9FB3C8] bg-[#1A2332] text-[#9FB3C8]"
                }`}>
                  <p className="text-xs font-semibold uppercase tracking-[0.08em]">{alignmentCtx.icon} {alignmentCtx.context.replace(/_/g, " ")}</p>
                  <p className="mt-1 text-xs opacity-90">{alignmentCtx.message}</p>
                </div>

                {/* EXECUTION DECISION */}
                <div className="mt-3 rounded-md border border-white/10 bg-[#0F172A] p-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Execution</p>
                  <p className="mt-1 text-sm font-medium text-[#E6EDF3]">{marketStructureDecision.execution}</p>
                  <p className="mt-1 text-xs text-[#9FB3C8]">Confidence: {marketStructureDecision.confidence}</p>
                </div>
              </div>
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
                      15M {tokenHeatmap.label}
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
      ) : null}
    </article>
  );
}
