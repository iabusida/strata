export type LifecycleTrade = {
  direction: "LONG" | "SHORT";
  tpPrice: number;
  slPrice: number;
  entryType: "REVERSAL" | "STRONG" | "CONTINUATION" | "SCORE_BASED";
};

export type LifecycleCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  elapsedMinutes: number;
};

export type LifecycleResult = {
  outcome: "WIN" | "LOSS" | "TIME_EXIT" | "OPEN";
  reason: string;
  closePrice?: number;
};

function resolveNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env ${name}: ${raw}`);
  }

  return parsed;
}

const REVERSAL_MAX_HOLD_MINUTES = Math.max(15, Math.trunc(resolveNumberEnv("REVERSAL_MAX_HOLD_MINUTES", 360)));
const STRONG_MAX_HOLD_MINUTES = Math.max(15, Math.trunc(resolveNumberEnv("STRONG_MAX_HOLD_MINUTES", 720)));
const DEFAULT_MAX_HOLD_MINUTES = Math.max(15, Math.trunc(resolveNumberEnv("DEFAULT_MAX_HOLD_MINUTES", 1440)));
const ABSOLUTE_MAX_HOLD_MINUTES = Math.max(
  DEFAULT_MAX_HOLD_MINUTES,
  Math.trunc(resolveNumberEnv("ABSOLUTE_MAX_HOLD_MINUTES", 1440))
);

function resolveSameCandle(direction: "LONG" | "SHORT", candleOpen: number, tpPrice: number, slPrice: number): "WIN" | "LOSS" {
  const toTp = Math.abs(candleOpen - tpPrice);
  const toSl = Math.abs(candleOpen - slPrice);
  if (toTp < toSl) return "WIN";
  return "LOSS";
}

function maxHoldMinutes(entryType: LifecycleTrade["entryType"]): number {
  if (entryType === "REVERSAL") return REVERSAL_MAX_HOLD_MINUTES;
  if (entryType === "STRONG") return STRONG_MAX_HOLD_MINUTES;
  return DEFAULT_MAX_HOLD_MINUTES;
}

export function simulateTrade(trade: LifecycleTrade, candles: LifecycleCandle[]): LifecycleResult {
  const absoluteMaxMinutes = ABSOLUTE_MAX_HOLD_MINUTES;

  for (const candle of candles) {
    const maxMinutes = Math.min(maxHoldMinutes(trade.entryType), absoluteMaxMinutes);

    if (trade.direction === "LONG") {
      const hitTp = candle.high >= trade.tpPrice;
      const hitSl = candle.low <= trade.slPrice;

      if (hitTp && hitSl) {
        const outcome = resolveSameCandle("LONG", candle.open, trade.tpPrice, trade.slPrice);
        return { outcome, reason: "TP_SL_SAME_CANDLE" };
      }
      if (hitTp) return { outcome: "WIN", reason: "TP_HIT", closePrice: trade.tpPrice };
      if (hitSl) return { outcome: "LOSS", reason: "SL_HIT", closePrice: trade.slPrice };
    } else {
      const hitTp = candle.low <= trade.tpPrice;
      const hitSl = candle.high >= trade.slPrice;

      if (hitTp && hitSl) {
        const outcome = resolveSameCandle("SHORT", candle.open, trade.tpPrice, trade.slPrice);
        return { outcome, reason: "TP_SL_SAME_CANDLE" };
      }
      if (hitTp) return { outcome: "WIN", reason: "TP_HIT", closePrice: trade.tpPrice };
      if (hitSl) return { outcome: "LOSS", reason: "SL_HIT", closePrice: trade.slPrice };
    }

    if (candle.elapsedMinutes > maxMinutes) {
      return { outcome: "TIME_EXIT", reason: "MAX_HOLD_EXCEEDED", closePrice: candle.close };
    }
  }

  return { outcome: "OPEN", reason: "NO_EXIT_TRIGGERED" };
}
