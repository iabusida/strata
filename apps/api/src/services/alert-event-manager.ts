import { AssetType, CandleInterval, SignalState, TradingStyle } from "@prisma/client";
import { prisma } from "../prisma-client.js";

export interface CreateAlertEventRequest {
  userId: string;
  symbol: string;
  assetType: AssetType;
  tradingStyle: TradingStyle;
  interval: CandleInterval;
  signalState: SignalState;
  signalType?: string;
  recommendation?: string;
  metrics?: Record<string, any>;
  priceContext?: Record<string, number>;
}

export async function createAlertEvent(req: CreateAlertEventRequest) {
  const alertEvent = await prisma.alertEvent.create({
    data: {
      userId: req.userId,
      symbol: req.symbol,
      assetType: req.assetType,
      tradingStyle: req.tradingStyle,
      interval: req.interval,
      signalState: req.signalState,
      signalType: req.signalType,
      recommendation: req.recommendation,
      metrics: req.metrics,
      priceContext: req.priceContext,
    },
  });

  return alertEvent;
}

export async function getUserAlertEvents(userId: string, limit = 100, offset = 0) {
  const events = await prisma.alertEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });

  const count = await prisma.alertEvent.count({
    where: { userId },
  });

  return { events, count, limit, offset };
}

export async function getSymbolAlertHistory(
  symbol: string,
  assetType: AssetType,
  tradingStyle: TradingStyle,
  limit = 50
) {
  const events = await prisma.alertEvent.findMany({
    where: { symbol, assetType, tradingStyle },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return events;
}

export async function getAlertEventsBySignalState(
  userId: string,
  signalState: SignalState,
  limit = 100
) {
  const events = await prisma.alertEvent.findMany({
    where: { userId, signalState },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return events;
}

export async function getAlertEventsSummary(userId: string, daysBack = 7) {
  const since = new Date();
  since.setDate(since.getDate() - daysBack);

  const events = await prisma.alertEvent.findMany({
    where: {
      userId,
      createdAt: { gte: since },
    },
  });

  // Group by signal state and trading style
  const summary = {
    total: events.length,
    bySignalState: {
      READY: 0,
      CAUTION: 0,
      BLOCKED: 0,
      UNRESOLVED: 0,
    },
    byStyle: {} as Record<string, number>,
    bySymbol: {} as Record<string, number>,
    readySymbols: [] as Array<{ symbol: string; count: number }>,
  };

  events.forEach((e) => {
    // Count by signal state
    (summary.bySignalState as any)[e.signalState]++;

    // Count by style
    summary.byStyle[e.tradingStyle] = (summary.byStyle[e.tradingStyle] || 0) + 1;

    // Count by symbol
    summary.bySymbol[e.symbol] = (summary.bySymbol[e.symbol] || 0) + 1;
  });

  // Get top ready symbols
  summary.readySymbols = events
    .filter((e) => e.signalState === SignalState.READY)
    .reduce(
      (acc: Array<{ symbol: string; count: number }>, e) => {
        const existing = acc.find((x) => x.symbol === e.symbol);
        if (existing) {
          existing.count++;
        } else {
          acc.push({ symbol: e.symbol, count: 1 });
        }
        return acc;
      },
      []
    )
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return summary;
}

export async function deleteOldAlertEvents(daysOld = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  const result = await prisma.alertEvent.deleteMany({
    where: { createdAt: { lt: cutoffDate } },
  });

  return result;
}
