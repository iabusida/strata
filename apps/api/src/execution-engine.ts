export type ExecutionValidationContext = {
  spreadPct: number;
  depthUsd: number;
  orderNotional: number;
  maxSpread: number;
  minDepthMultiplier?: number;
  maxSlippage?: number;
  ignoreSlippageGuard?: boolean;
};

export function estimateSlippage(orderNotional: number, depthUsd: number): number {
  if (!Number.isFinite(orderNotional) || !Number.isFinite(depthUsd) || depthUsd <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return orderNotional / depthUsd;
}

export function validateExecution(ctx: ExecutionValidationContext): {
  ok: boolean;
  slippage: number;
} {
  const minDepthMultiplier = Number.isFinite(ctx.minDepthMultiplier) && (ctx.minDepthMultiplier ?? 0) > 0
    ? (ctx.minDepthMultiplier as number)
    : 2;
  const maxSlippage = Number.isFinite(ctx.maxSlippage) && (ctx.maxSlippage ?? 0) > 0
    ? (ctx.maxSlippage as number)
    : 0.002;
  const slippage = estimateSlippage(ctx.orderNotional, ctx.depthUsd);

  if (!Number.isFinite(ctx.spreadPct) || ctx.spreadPct <= 0 || ctx.spreadPct > ctx.maxSpread) {
    return { ok: false, slippage };
  }

  if (!Number.isFinite(ctx.depthUsd) || ctx.depthUsd < ctx.orderNotional * minDepthMultiplier) {
    return { ok: false, slippage };
  }

  if (!ctx.ignoreSlippageGuard && (!Number.isFinite(slippage) || slippage > maxSlippage)) {
    return { ok: false, slippage };
  }

  return { ok: true, slippage };
}

export function effectiveEntryPrice(price: number, signalType: string, slippage: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    return Number.NaN;
  }

  if (!Number.isFinite(slippage) || slippage <= 0) {
    return Number(price.toFixed(6));
  }

  if (signalType.includes("LONG")) {
    return Number((price * (1 + slippage)).toFixed(6));
  }

  if (signalType.includes("SHORT")) {
    return Number((price * (1 - slippage)).toFixed(6));
  }

  return Number(price.toFixed(6));
}
