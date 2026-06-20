export type SignalState = "READY" | "CAUTION" | "BLOCKED" | "BUILDING";

export type Direction = "UP" | "DOWN" | "MIXED";

export type AlignmentPoint = {
  label: string;
  direction: Direction;
  blocked?: boolean;
  dominant?: boolean;
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
};
