import { getProfileConfig, TradingProfile } from "../profile-selector";
import { SignalItem } from "./types";

export type ProfileDecision = "BUY" | "SELL" | "WAIT" | "AVOID" | "HOLD";
export type ProfileStructure = "bullish" | "bearish" | "mixed";

// Global 3-state signal system: ACTIVE (act now), PREPARE (forming), AVOID (no trade).
export type SignalActionState = "ACTIVE" | "PREPARE" | "AVOID";

export type ProfileEvaluation = {
  decision: ProfileDecision;
  signalState: SignalActionState;
  triggerMet: boolean;
  confidence: number;
  structure: ProfileStructure;
  nextStep: string;
  reasons: string[];
  triggerCondition: string;
  actionLabel: string;
  opportunityLabel: string;
  decisionTitle: string;
  decisionExplanation: string;
  strategy: string;
  structureLabel: string;
};

// Lower number = higher priority when ordering opportunity queues.
export const SIGNAL_STATE_PRIORITY: Record<SignalActionState, number> = {
  ACTIVE: 0,
  PREPARE: 1,
  AVOID: 2,
};

export type SignalStatePresentation = {
  badge: string;
  badgeClass: string;
  bannerText: string;
  bannerClass: string;
  microCopy: string;
  nextStep: string;
};

// Derives the global action state from the profile decision + whether the entry
// trigger is confirmed. ACTIVE requires an actionable direction AND a met trigger.
export function deriveSignalState(decision: ProfileDecision, triggerMet: boolean): SignalActionState {
  if (decision === "AVOID") {
    return "AVOID";
  }
  if ((decision === "BUY" || decision === "SELL") && triggerMet) {
    return "ACTIVE";
  }
  return "PREPARE";
}

export function getSignalStatePresentation(state: SignalActionState): SignalStatePresentation {
  if (state === "ACTIVE") {
    return {
      badge: "🔥 ACTIVE",
      badgeClass: "border-[#22C55E]/45 bg-[#0F2E25]/70 text-[#BBF7D0]",
      bannerText: "🔥 ACTIVE TRADE — Entry condition met",
      bannerClass: "border-[#22C55E]/35 bg-[#0F2E25]/45 text-[#BBF7D0]",
      microCopy: "🔥 High conviction setup — take action",
      nextStep: "Enter position now based on confirmed trigger",
    };
  }

  if (state === "PREPARE") {
    return {
      badge: "⚠️ PREPARE",
      badgeClass: "border-[#F59E0B]/45 bg-[#3A2A0E]/70 text-[#FDE68A]",
      bannerText: "⚠️ SETUP FORMING — Do not enter yet",
      bannerClass: "border-[#F59E0B]/35 bg-[#3A2A0E]/45 text-[#FDE68A]",
      microCopy: "⚠️ Not ready — patience required",
      nextStep: "Wait for trigger condition before entering",
    };
  }

  return {
    badge: "🚫 AVOID",
    badgeClass: "border-[#EF4444]/45 bg-[#3F1218]/70 text-[#FECACA]",
    bannerText: "🚫 NO TRADE — Low probability",
    bannerClass: "border-[#EF4444]/35 bg-[#3F1218]/40 text-[#FECACA]",
    microCopy: "🚫 Most traders lose money in this zone",
    nextStep: "Stand aside — no safe opportunity",
  };
}

// Maps a directional forecast distribution into an interpretation + strategy so
// probabilities are never shown without an action.
export function getForecastInterpretation(bullishPct: number, bearishPct: number): {
  interpretation: string;
  strategy: string;
  tone: "green" | "red" | "yellow";
} {
  const spread = bullishPct - bearishPct;

  if (spread >= 20) {
    return {
      interpretation: "High probability of an upward move",
      strategy: "Look for long entry on breakout confirmation",
      tone: "green",
    };
  }

  if (spread <= -20) {
    return {
      interpretation: "High probability of a downward move",
      strategy: "Look for short entry on breakdown confirmation",
      tone: "red",
    };
  }

  return {
    interpretation: "No clear directional edge yet",
    strategy: "Stay flat and wait for a decisive break before committing",
    tone: "yellow",
  };
}

type ProfileRule = {
  minConfidence: number;
  scoreFloor: number;
  holdLabel: string;
};

export const PROFILE_RULES: Record<TradingProfile, ProfileRule> = {
  scalp: { minConfidence: 40, scoreFloor: 2.5, holdLabel: "minutes" },
  day: { minConfidence: 50, scoreFloor: 3.5, holdLabel: "hours" },
  swing: { minConfidence: 60, scoreFloor: 4.5, holdLabel: "days" },
  long_term: { minConfidence: 65, scoreFloor: 5, holdLabel: "months" },
};

const PROFILE_TIMEFRAME_WEIGHTS: Record<TradingProfile, Record<keyof SignalItem["timeframeMetrics"], number>> = {
  scalp: { "1M": 0.28, "5M": 0.28, "15M": 0.2, "1H": 0.14, "4H": 0.07, "1D": 0.03 },
  day: { "1M": 0.08, "5M": 0.16, "15M": 0.32, "1H": 0.26, "4H": 0.12, "1D": 0.06 },
  swing: { "1M": 0.02, "5M": 0.04, "15M": 0.12, "1H": 0.3, "4H": 0.32, "1D": 0.2 },
  long_term: { "1M": 0.01, "5M": 0.02, "15M": 0.07, "1H": 0.15, "4H": 0.3, "1D": 0.45 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function inferProfileBias(item: SignalItem): "LONG" | "SHORT" | "NEUTRAL" {
  if (item.takeProfit > item.suggestedEntry && item.stopLoss < item.suggestedEntry) {
    return "LONG";
  }
  if (item.takeProfit < item.suggestedEntry && item.stopLoss > item.suggestedEntry) {
    return "SHORT";
  }
  return "NEUTRAL";
}

function directionScore(direction: SignalItem["timeframeMetrics"][keyof SignalItem["timeframeMetrics"]]["direction"]): number {
  if (direction === "UP") return 1;
  if (direction === "DOWN") return -1;
  return 0;
}

export function computeProfileConfidence(item: SignalItem, profile: TradingProfile): number {
  const weights = PROFILE_TIMEFRAME_WEIGHTS[profile];
  const weightedDirection = Object.entries(weights).reduce((sum, [timeframe, weight]) => {
    return sum + (directionScore(item.timeframeMetrics[timeframe as keyof SignalItem["timeframeMetrics"]].direction) * weight);
  }, 0);

  const base = (item.score / 10) * 100;
  const timeframeBoost = Math.round(weightedDirection * 22);
  const structureBoost = item.htfConfirmed ? 8 : -10;
  const stateBoost = item.state === "READY" ? 10 : item.state === "CAUTION" ? 2 : item.state === "BUILDING" ? -2 : -12;
  const profileBoost =
    profile === "scalp"
      ? item.volatilityPct >= 2 ? 12 : -8
      : profile === "day"
        ? item.volume24h > 2_000_000 ? 10 : -2
        : profile === "swing"
          ? item.htfConfirmed ? 10 : -6
          : item.emaSlope > 0 ? 12 : -6;

  return clamp(Math.round(base + timeframeBoost + structureBoost + stateBoost + profileBoost), 5, 99);
}

export function computeProfileStructure(item: SignalItem, profile: TradingProfile): ProfileStructure {
  const blocked = item.alignment.some((point) => point.blocked);
  const weights = PROFILE_TIMEFRAME_WEIGHTS[profile];
  const weightedUp = Object.entries(weights).reduce((sum, [timeframe, weight]) => {
    return sum + (item.timeframeMetrics[timeframe as keyof SignalItem["timeframeMetrics"]].direction === "UP" ? weight : 0);
  }, 0);
  const weightedDown = Object.entries(weights).reduce((sum, [timeframe, weight]) => {
    return sum + (item.timeframeMetrics[timeframe as keyof SignalItem["timeframeMetrics"]].direction === "DOWN" ? weight : 0);
  }, 0);

  if (blocked || Math.abs(weightedUp - weightedDown) < 0.18) {
    return "mixed";
  }

  return weightedUp > weightedDown ? "bullish" : "bearish";
}

function adjustProfileConfidence(options: {
  rawConfidence: number;
  item: SignalItem;
  structure: ProfileStructure;
  bias: ReturnType<typeof inferProfileBias>;
}): number {
  const { rawConfidence, item, structure, bias } = options;

  let adjusted = rawConfidence;

  if (structure === "mixed") {
    adjusted = Math.min(adjusted, 58);
  }

  if ((structure === "bullish" && bias === "SHORT") || (structure === "bearish" && bias === "LONG")) {
    adjusted = Math.min(adjusted, 52);
  }

  if (item.state === "CAUTION") {
    adjusted = Math.min(adjusted, 72);
  }

  if (item.state === "BUILDING") {
    adjusted = Math.min(adjusted, 60);
  }

  return clamp(Math.round(adjusted), 5, 99);
}

function getDecision(
  item: SignalItem,
  profile: TradingProfile,
  confidence: number,
  structure: ProfileStructure,
): ProfileDecision {
  const config = getProfileConfig(profile);
  const bias = inferProfileBias(item);

  if (item.state === "BLOCKED" || confidence < config.minConfidence) {
    return "AVOID";
  }

  if (bias === "NEUTRAL") {
    return "WAIT";
  }

  if (structure === "mixed") {
    return "WAIT";
  }

  if (structure === "bullish") {
    if (bias === "SHORT") {
      return "WAIT";
    }

    return profile === "long_term" ? "HOLD" : "BUY";
  }

  if (structure === "bearish") {
    if (bias === "LONG") {
      return "WAIT";
    }

    return profile === "scalp" ? "SELL" : "AVOID";
  }

  return "WAIT";
}

function buildStructureLabel(structure: ProfileStructure, profile: TradingProfile): string {
  const config = getProfileConfig(profile);

  if (structure === "mixed") {
    return `⚠️ Structure: Not Aligned (${config.name} Criteria)`;
  }

  if (structure === "bullish") {
    return `✅ Structure: Aligned (${config.name} Criteria)`;
  }

  if (profile === "scalp") {
    return "🔻 Structure: Downside Aligned (Scalper Criteria)";
  }

  return `⚠️ Structure: Bearish Against ${config.name} Criteria`;
}

function buildNextStep(
  profile: TradingProfile,
  decision: ProfileDecision,
): string {
  const config = getProfileConfig(profile);

  if (decision === "AVOID") {
    return `Stand aside. This does not satisfy ${config.name} criteria yet.`;
  }
  if (decision === "WAIT") {
    return config.nextStepGuidance;
  }

  if (decision === "HOLD") {
    return "Accumulate gradually";
  }

  if (decision === "SELL") {
    return "Enter on momentum spike within minutes";
  }

  return config.nextStepGuidance;
}

function buildReasons(
  item: SignalItem,
  profile: TradingProfile,
  decision: ProfileDecision,
  structure: ProfileStructure,
): string[] {
  const reasons: string[] = [];
  const bias = inferProfileBias(item);

  if (structure === "mixed") {
    reasons.push("Conflicting signals across timeframes");
  }
  if ((structure === "bullish" && bias === "SHORT") || (structure === "bearish" && bias === "LONG")) {
    reasons.push("Trade setup direction conflicts with the active profile structure");
  }
  if (!item.htfConfirmed) {
    reasons.push("Higher timeframe structure is not fully aligned");
  }
  if (item.state !== "READY" && decision !== "HOLD") {
    reasons.push("Breakout confirmation is still missing");
  }
  if (profile === "scalp" && item.volatilityPct < 2) {
    reasons.push("Short-term momentum is too muted for a scalp");
  }
  if (profile === "day" && item.volume24h < 2_000_000) {
    reasons.push("Session volume is not strong enough yet");
  }
  if (profile === "swing" && item.emaSlope <= 0 && inferProfileBias(item) === "LONG") {
    reasons.push("Trend slope is not supporting the long idea");
  }
  if (profile === "long_term" && item.rsi > 70) {
    reasons.push("Price is stretched for a patient long-term entry");
  }

  if ((decision === "BUY" || decision === "HOLD") && reasons.length === 0) {
    reasons.push("Momentum and structure are aligned");
    reasons.push("Higher timeframe context supports continuation");
    reasons.push("Risk can be defined around nearby support");
  }

  if (decision === "SELL" && reasons.length === 0) {
    reasons.push("Downside structure is in control");
    reasons.push("Weakness is confirmed across key timeframes");
    reasons.push("Risk can be defined around nearby resistance");
  }

  return reasons.slice(0, 3);
}

function buildTriggerCondition(
  item: SignalItem,
  profile: TradingProfile,
  decision: ProfileDecision,
): string {
  if (decision === "AVOID") {
    return "No safe entry right now";
  }

  if (decision === "WAIT") {
    return inferProfileBias(item) === "SHORT"
      ? `Wait for a break below $${item.stopLoss.toFixed(4)} with real follow-through.`
      : `Wait for a break above $${item.takeProfit.toFixed(4)} with real follow-through.`;
  }

  if (decision === "HOLD") {
    return "Accumulate only on controlled pullbacks with steady volume";
  }

  if (profile === "scalp") {
    return inferProfileBias(item) === "SHORT"
      ? `Enter only if price loses $${item.suggestedEntry.toFixed(4)} fast with a volume surge.`
      : `Enter only if price reclaims $${item.suggestedEntry.toFixed(4)} fast with a volume surge.`;
  }
  if (profile === "day") {
    return inferProfileBias(item) === "SHORT"
      ? `Short the session breakdown below $${item.stopLoss.toFixed(4)} with expanding volume.`
      : `Buy the session breakout above $${item.takeProfit.toFixed(4)} with expanding volume.`;
  }
  if (profile === "swing") {
    return inferProfileBias(item) === "SHORT"
      ? `Enter on rejection near $${item.suggestedEntry.toFixed(4)} and target continuation lower.`
      : `Enter on pullback support near $${item.suggestedEntry.toFixed(4)} and target continuation higher.`;
  }

  return inferProfileBias(item) === "SHORT"
    ? "Use rallies to reduce exposure instead of forcing a tactical short."
    : "Accumulate in smaller tranches rather than chasing strength.";
}

export function evaluateSignalForProfile(item: SignalItem, profile: TradingProfile): ProfileEvaluation {
  const rules = PROFILE_RULES[profile];
  const config = getProfileConfig(profile);
  const bias = inferProfileBias(item);
  const rawConfidence = computeProfileConfidence(item, profile);
  const structure = computeProfileStructure(item, profile);
  const confidence = adjustProfileConfidence({ rawConfidence, item, structure, bias });
  const decision = getDecision(item, profile, confidence, structure);
  const triggerMet = item.state === "READY";
  const signalState = deriveSignalState(decision, triggerMet);

  const decisionTitle =
    decision === "BUY"
      ? "✅ STRONG BUY"
      : decision === "HOLD"
        ? "🏦 HOLD / ACCUMULATE"
      : decision === "SELL"
        ? "🔻 STRONG SELL"
        : decision === "WAIT"
          ? "⚠️ PREPARE - Criteria Building"
          : "🚫 AVOID TRADE — Low probability setup";

  const decisionExplanation =
    decision === "BUY"
      ? `${config.name} criteria are aligned and the setup is actionable.`
      : decision === "HOLD"
        ? `Bullish structure remains aligned, so this ${config.name.toLowerCase()} should hold and accumulate.`
      : decision === "SELL"
        ? `This setup fits a scalp-style downside move with aligned momentum.`
        : decision === "WAIT"
          ? `Structure is visible, but it is not fully aligned for ${config.name} criteria yet.`
          : `This setup does not meet the ${rules.minConfidence}% confidence threshold for a ${config.name.toLowerCase()}.`;

  const actionLabel =
    decision === "BUY"
      ? "BUY"
      : decision === "HOLD"
        ? "HOLD"
      : decision === "SELL"
        ? "SELL"
        : decision === "WAIT"
        ? "PREPARE"
          : "Avoid";

  const opportunityLabel =
    decision === "BUY"
      ? profile === "scalp"
        ? "✅ BUY — Momentum Spike"
        : profile === "day"
          ? "✅ BUY — Intraday Breakout"
          : "✅ BUY — Swing Continuation"
      : decision === "HOLD"
        ? "🏦 HOLD — Position Build"
      : decision === "SELL"
        ? "🔻 SELL — Scalp Reversal"
      : decision === "WAIT"
        ? `⚠️ PREPARE — ${config.name} Setup`
      : `🚫 AVOID — ${config.name} Filter`;

  const strategy =
    decision === "BUY" || decision === "HOLD"
      ? config.strategy
      : decision === "SELL"
        ? "Fast downside execution only"
        : decision === "WAIT"
          ? `Wait for ${config.name.toLowerCase()} trigger`
          : "Stand aside";

  return {
    decision,
    signalState,
    triggerMet,
    confidence,
    structure,
    nextStep: buildNextStep(profile, decision),
    reasons: buildReasons(item, profile, decision, structure),
    triggerCondition: buildTriggerCondition(item, profile, decision),
    actionLabel,
    opportunityLabel,
    decisionTitle,
    decisionExplanation,
    strategy,
    structureLabel: buildStructureLabel(structure, profile),
  };
}

export function getProfileMarketStatus(
  items: SignalItem[],
  profile: TradingProfile,
): { title: string; subtitle: string; viableCount: number; tone: "green" | "yellow" | "red" } {
  const config = getProfileConfig(profile);
  const evaluations = items.map((item) => evaluateSignalForProfile(item, profile));
  const viableCount = evaluations.filter((item) => item.decision === "BUY" || item.decision === "SELL" || item.decision === "HOLD").length;
  const avoidCount = evaluations.filter((item) => item.decision === "AVOID").length;
  const avoidRatio = items.length > 0 ? avoidCount / items.length : 1;

  if (items.length === 0 || avoidRatio > 0.7) {
    return {
      title: "No Trade Zone",
      subtitle: `No setups meet ${config.name} criteria (${config.minConfidence}%+ confidence).`,
      viableCount,
      tone: "red",
    };
  }

  if (viableCount >= 3) {
    return {
      title: "Active Opportunities",
      subtitle: `${viableCount} setups currently meet ${config.name} criteria at ${config.minConfidence}%+ confidence.`,
      viableCount,
      tone: "green",
    };
  }

  return {
    title: "Mixed Market",
    subtitle: `Only a few setups satisfy ${config.name} rules. Stay selective above ${config.minConfidence}% confidence.`,
    viableCount,
    tone: "yellow",
  };
}
