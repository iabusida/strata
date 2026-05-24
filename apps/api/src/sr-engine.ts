export type SupportResistanceContext = {
  price: number;
  high1h: number;
  low1h: number;
};

export function evaluateSupportResistance(ctx: SupportResistanceContext, signalType: string): boolean {
  if (!Number.isFinite(ctx.price) || !Number.isFinite(ctx.high1h) || !Number.isFinite(ctx.low1h) || ctx.high1h <= ctx.low1h) {
    return true;
  }

  const range = ctx.high1h - ctx.low1h;
  const buffer = range * 0.1;

  const nearResistance = ctx.price >= ctx.high1h - buffer;
  const nearSupport = ctx.price <= ctx.low1h + buffer;

  if (signalType.includes("LONG") && nearResistance) return false;
  if (signalType.includes("SHORT") && nearSupport) return false;

  return true;
}
