export type ExecutionValidationContext = {
  spreadPct: number;
  depthUsd: number;
  orderNotional: number;
  maxSpread: number;
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
  const slippage = estimateSlippage(ctx.orderNotional, ctx.depthUsd);

  if (!Number.isFinite(ctx.spreadPct) || ctx.spreadPct <= 0 || ctx.spreadPct > ctx.maxSpread) {
    return { ok: false, slippage };
  }

  if (!Number.isFinite(ctx.depthUsd) || ctx.depthUsd < ctx.orderNotional * 2) {
    return { ok: false, slippage };
  }

  if (!Number.isFinite(slippage) || slippage > 0.002) {
    return { ok: false, slippage };
  }

  return { ok: true, slippage };
}

export function effectiveEntryPrice(price: number, signalType: string, slippage: number): number {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(slippage) || slippage <= 0) {
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
