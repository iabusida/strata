export type TrendDirection = "UP" | "DOWN" | "MIXED";
export type TradeDirection = "LONG" | "SHORT";

export type ReversalPhase =
  | "COUNTER_TREND_BOUNCE"
  | "TRANSITION_REVERSAL"
  | "CONFIRMED_REVERSAL"
  | "UNRESOLVED";

export type ReversalPhaseMin = "COUNTER_TREND_BOUNCE" | "TRANSITION_REVERSAL" | "CONFIRMED_REVERSAL";

type ReversalPhaseInput = {
  direction: TradeDirection;
  dailyTrend?: TrendDirection | null;
  twelvehTrend?: TrendDirection | null;
  macroTrend?: TrendDirection | null;
  intermediaryTrend?: TrendDirection | null;
  microTrend?: TrendDirection | null;
  structureState?: "TRENDING" | "BREAKOUT" | "BREAKDOWN" | "REVERSAL" | "CHOP" | null;
};

function oppositeTrend(target: TrendDirection): TrendDirection {
  return target === "UP" ? "DOWN" : "UP";
}

function bumpPhase(phase: ReversalPhase): ReversalPhase {
  if (phase === "COUNTER_TREND_BOUNCE") {
    return "TRANSITION_REVERSAL";
  }

  if (phase === "TRANSITION_REVERSAL") {
    return "CONFIRMED_REVERSAL";
  }

  return phase;
}

export function classifyReversalPhase(input: ReversalPhaseInput): ReversalPhase {
  const targetTrend: TrendDirection = input.direction === "LONG" ? "UP" : "DOWN";
  const opposite = oppositeTrend(targetTrend);

  const higher = [input.dailyTrend, input.twelvehTrend];
  const setup = [input.macroTrend, input.intermediaryTrend];
  const trigger = [input.microTrend];

  const countAligned = (items: Array<TrendDirection | null | undefined>): number =>
    items.filter((item) => item === targetTrend).length;
  const countOpposed = (items: Array<TrendDirection | null | undefined>): number =>
    items.filter((item) => item === opposite).length;

  const higherAligned = countAligned(higher);
  const higherOpposed = countOpposed(higher);
  const setupAligned = countAligned(setup);
  const setupOpposed = countOpposed(setup);
  const triggerAligned = countAligned(trigger);

  let phase: ReversalPhase;

  if (higherAligned === 2 && setupAligned >= 1) {
    phase = "CONFIRMED_REVERSAL";
  } else if (higherAligned >= 1 && setupAligned >= 1 && triggerAligned >= 1) {
    phase = "TRANSITION_REVERSAL";
  } else if (higherAligned === 0 && higherOpposed >= 1 && setupAligned >= 1 && triggerAligned >= 1) {
    phase = "COUNTER_TREND_BOUNCE";
  } else if (higherAligned >= 1 && setupAligned === 2) {
    phase = "TRANSITION_REVERSAL";
  } else {
    phase = "UNRESOLVED";
  }

  if (input.structureState === "REVERSAL" && setupOpposed === 0 && phase !== "CONFIRMED_REVERSAL") {
    phase = bumpPhase(phase);
  }

  return phase;
}

export function isReversalPhaseAllowed(phase: ReversalPhase, minPhase: ReversalPhaseMin): boolean {
  if (phase === "UNRESOLVED") {
    return false;
  }

  const rank: Record<ReversalPhaseMin, number> = {
    COUNTER_TREND_BOUNCE: 0,
    TRANSITION_REVERSAL: 1,
    CONFIRMED_REVERSAL: 2
  };

  return rank[phase] >= rank[minPhase];
}
