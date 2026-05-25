export type EntryTiming = "EARLY" | "MID" | "LATE";
export type EntryTimingMax = EntryTiming;

type EntryTimingInput = {
  direction: "LONG" | "SHORT";
  price: number;
  atr: number;
  supportDistancePct: number;
  resistanceDistancePct: number;
  ema20?: number;
};

function toFinitePositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function toFiniteNonNegative(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return value;
}

export function classifyEntryTiming(input: EntryTimingInput): EntryTiming {
  const price = toFinitePositive(input.price, 0);
  if (price <= 0) {
    return "MID";
  }

  const atr = toFinitePositive(input.atr, price * 0.01);
  const atrPct = Math.max((atr / price) * 100, 0.15);

  const supportDistancePct = toFiniteNonNegative(input.supportDistancePct, atrPct);
  const resistanceDistancePct = toFiniteNonNegative(input.resistanceDistancePct, atrPct);

  const directionalRoomPct = input.direction === "LONG" ? resistanceDistancePct : supportDistancePct;
  const roomMultiple = directionalRoomPct / atrPct;

  let emaDistancePct = 0;
  if (Number.isFinite(input.ema20) && (input.ema20 ?? 0) > 0) {
    emaDistancePct = Math.abs(((price - (input.ema20 ?? price)) / price) * 100);
  }
  const stretchMultiple = emaDistancePct / atrPct;

  if (directionalRoomPct <= atrPct * 0.35 || stretchMultiple >= 1.7) {
    return "LATE";
  }

  if (roomMultiple >= 1.8 && stretchMultiple <= 0.9) {
    return "EARLY";
  }

  return "MID";
}

const timingRank: Record<EntryTiming, number> = {
  EARLY: 0,
  MID: 1,
  LATE: 2
};

export function isEntryTimingAllowed(entryTiming: EntryTiming, maxAllowed: EntryTimingMax): boolean {
  return timingRank[entryTiming] <= timingRank[maxAllowed];
}
