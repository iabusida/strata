export type DryRunLeverageCheck = {
  symbol: string;
  marginCoin: string;
  currentLeverage: number;
  marginMode: string;
  minRequiredLeverage: number;
  meetsMinLeverage: boolean;
};

export type DryRunExecutionPlan = {
  id: string;
  createdAt: string;
  source: "AUTO_SIGNAL" | "MANUAL_OPEN";
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  leverageRequested: number;
  stakeUsd: number;
  orderNotionalUsd: number;
  status: "PLANNED" | "BLOCKED";
  reason?: string;
  leverageCheck?: DryRunLeverageCheck;
};

const MAX_PLANS = 500;
const plans: DryRunExecutionPlan[] = [];
const listeners = new Set<(plans: DryRunExecutionPlan[]) => void>();

function emitDryRunPlanUpdate(): void {
  const snapshot = [...plans];
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // Keep other listeners alive even if one consumer throws.
    }
  }
}

export function recordDryRunExecutionPlan(plan: DryRunExecutionPlan): void {
  plans.unshift(plan);
  if (plans.length > MAX_PLANS) {
    plans.length = MAX_PLANS;
  }
  emitDryRunPlanUpdate();
}

export function listDryRunExecutionPlans(limit: number = 50): DryRunExecutionPlan[] {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  return plans.slice(0, safeLimit);
}

export function clearDryRunExecutionPlans(): { cleared: number } {
  const cleared = plans.length;
  plans.length = 0;
  emitDryRunPlanUpdate();
  return { cleared };
}

export function subscribeDryRunExecutionPlans(
  listener: (plans: DryRunExecutionPlan[]) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
