export type TradeRejectionEntry = {
  symbol: string;
  signal: string;
  score: number;
  direction?: string;
  reason: string;
  details: Record<string, unknown>;
  rejectedAt: string;
};

const MAX_REJECTION_LOG = 200;
const rejectionLog: TradeRejectionEntry[] = [];

export function logTradeRejection(entry: Omit<TradeRejectionEntry, "rejectedAt">): void {
  rejectionLog.unshift({ ...entry, rejectedAt: new Date().toISOString() });
  if (rejectionLog.length > MAX_REJECTION_LOG) {
    rejectionLog.length = MAX_REJECTION_LOG;
  }
}

export function getTradeRejectionLog(): TradeRejectionEntry[] {
  return [...rejectionLog];
}

export function clearTradeRejectionLog(): void {
  rejectionLog.length = 0;
}
