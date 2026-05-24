export type MicroTrendContext = {
  price: number;
  ema20: number;
  prevEma20: number;
};

export function evaluateMicroTrend(ctx: MicroTrendContext, signalType: string): boolean {
  const slope = ctx.ema20 - ctx.prevEma20;

  if (signalType.includes("LONG")) {
    return Number.isFinite(ctx.price) && Number.isFinite(ctx.ema20) && ctx.price > ctx.ema20 && slope > 0;
  }

  if (signalType.includes("SHORT")) {
    return Number.isFinite(ctx.price) && Number.isFinite(ctx.ema20) && ctx.price < ctx.ema20 && slope < 0;
  }

  return true;
}
