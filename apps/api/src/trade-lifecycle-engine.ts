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

function resolveSameCandle(direction: "LONG" | "SHORT", candleOpen: number, tpPrice: number, slPrice: number): "WIN" | "LOSS" {
  const toTp = Math.abs(candleOpen - tpPrice);
  const toSl = Math.abs(candleOpen - slPrice);
  if (toTp < toSl) return "WIN";
  return "LOSS";
}

function maxHoldMinutes(entryType: LifecycleTrade["entryType"]): number {
  if (entryType === "REVERSAL") return 90;
  if (entryType === "STRONG") return 240;
  return 360;
}

export function simulateTrade(trade: LifecycleTrade, candles: LifecycleCandle[]): LifecycleResult {
  const absoluteMaxMinutes = 360;

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
