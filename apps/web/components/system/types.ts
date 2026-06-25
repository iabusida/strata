export type SignalState = "READY" | "CAUTION" | "BLOCKED" | "BUILDING";

export type Direction = "UP" | "DOWN" | "MIXED";

export type TimeframeView = "1M" | "5M" | "15M" | "1H" | "4H" | "1D";

export type AlignmentPoint = {
  label: string;
  direction: Direction;
  blocked?: boolean;
  dominant?: boolean;
};

export type SetupPlan = {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  invalidation: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  rationale: string;
};

export type ProfileSetupPlans = {
  scalp: SetupPlan;
  day: SetupPlan;
  swing: SetupPlan;
  long_term: SetupPlan;
};

export type SignalItem = {
  symbol: string;
  displayName: string;
  price: number;
  marketCapUsd: number | null;
  score: number;
  state: SignalState;
  summary: string;
  alignment: AlignmentPoint[];
  entryTiming: "EARLY" | "MID" | "LATE" | null;
  rsi: number;
  stochastic: number;
  emaSlope: number;
  volume24h: number;
  volatilityPct: number;
  liquiditySweep: "HIGH" | "MEDIUM" | "LOW";
  fibZone: string;
  htfConfirmed: boolean;
  suggestedEntry: number;
  stopLoss: number;
  takeProfit: number;
  setupPlan: SetupPlan;
  profileSetupPlans: ProfileSetupPlans;
  timeframeMetrics: Record<TimeframeView, {
    label: TimeframeView;
    direction: Direction;
    rsi: number;
    stochastic: number;
  }>;
  counterTrendContext?: {
    status: "TREND_ALIGNED" | "COUNTER_TREND" | "CHOP_NO_TREND";
    macroTrend: "UP" | "DOWN" | "MIXED";
    intermediaryTrend: "UP" | "DOWN" | "MIXED";
    triggerDirection: "UP" | "DOWN" | "MIXED";
    isCounterTrend: boolean;
    confidenceMultiplier: number;
  };
  dumpReversalContext?: {
    inDumpZone: boolean;
    dumpDrop: number;
    dumpConfidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
    reactionDetected: boolean;
    reactionStrength: number;
    structureShiftConfirmed: boolean;
    highestLowAfterDump: number | null;
    lowestDumpPrice: number | null;
    bounceHigh: number | null;
    phase: "DUMP_IN_PROGRESS" | "REACTION_FORMING" | "STRUCTURE_CONFIRMED" | "NORMAL";
    stateMessage: string;
    confidenceMultiplier: number;
  };
};
