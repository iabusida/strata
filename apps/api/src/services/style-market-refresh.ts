import {
  AssetType,
  CandleInterval,
  TradingStyle,
} from "@prisma/client";
import { fetchLatestOhlc } from "../market-data-service.js";
import multiAssetMarketData from "./multi-asset-market-data.js";
import { ingestSchwabCandles } from "./schwab-connector.js";
import { prisma } from "../prisma-client.js";

export type RefreshItemStatus = "UPDATED" | "SKIPPED" | "ERROR";

export interface RefreshItemResult {
  symbol: string;
  assetType: AssetType;
  status: RefreshItemStatus;
  message: string;
}

export interface StyleRefreshSummary {
  userId: string;
  tradingStyle: TradingStyle;
  interval: CandleInterval;
  attempted: number;
  updated: number;
  skipped: number;
  errored: number;
  items: RefreshItemResult[];
  startedAt: string;
  endedAt: string;
}

interface SchedulerState {
  running: boolean;
  inProgress: boolean;
  intervalSeconds: number;
  lastStartedAt: string | null;
  lastEndedAt: string | null;
  lastError: string | null;
  lastRunPolicyCount: number;
}

const schedulerState: SchedulerState = {
  running: false,
  inProgress: false,
  intervalSeconds: 60,
  lastStartedAt: null,
  lastEndedAt: null,
  lastError: null,
  lastRunPolicyCount: 0,
};

let schedulerTimer: NodeJS.Timeout | null = null;

function mapStyleToInterval(style: TradingStyle): CandleInterval {
  if (style === TradingStyle.DAY_TRADING) return CandleInterval.M15;
  if (style === TradingStyle.LONG_TERM) return CandleInterval.D1;
  if (style === TradingStyle.SPOT_SHORT) return CandleInterval.H1;
  return CandleInterval.H1;
}

function mapCandleIntervalToOhlcInterval(
  interval: CandleInterval
): "1m" | "5m" | "15m" | "1h" | "4h" {
  if (interval === CandleInterval.M15) return "15m";
  if (interval === CandleInterval.H4 || interval === CandleInterval.H12 || interval === CandleInterval.D1) {
    return "4h";
  }
  return "1h";
}

function resolveTimestamp(value: number): Date {
  if (!Number.isFinite(value) || value <= 0) return new Date();
  const ms = value < 1_000_000_000_000 ? value * 1000 : value;
  return new Date(ms);
}

async function refreshCryptoSymbol(
  symbol: string,
  interval: CandleInterval
): Promise<RefreshItemResult> {
  const mapped = mapCandleIntervalToOhlcInterval(interval);
  const latest = await fetchLatestOhlc(symbol, mapped);
  if (!latest) {
    return {
      symbol,
      assetType: AssetType.CRYPTO,
      status: "SKIPPED",
      message: "No OHLC returned from configured market provider",
    };
  }

  await multiAssetMarketData.upsertCandles([
    {
      symbol,
      assetType: AssetType.CRYPTO,
      interval,
      timestamp: resolveTimestamp(latest.time),
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
      volume: 0,
    },
  ]);

  return {
    symbol,
    assetType: AssetType.CRYPTO,
    status: "UPDATED",
    message: "Refreshed from configured crypto provider",
  };
}

async function refreshStockSymbol(
  symbol: string
): Promise<RefreshItemResult> {
  try {
    const result = await ingestSchwabCandles({
      symbol,
      periodType: "day",
      period: 2,
      frequencyType: "minute",
      frequency: 30,
    });

    return {
      symbol,
      assetType: AssetType.STOCK,
      status: result.insertedCandles > 0 ? "UPDATED" : "SKIPPED",
      message:
        result.insertedCandles > 0
          ? `Ingested ${result.insertedCandles} Schwab candles`
          : "No Schwab candles returned",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      symbol,
      assetType: AssetType.STOCK,
      status: "ERROR",
      message,
    };
  }
}

async function refreshFutureSymbol(
  symbol: string,
  interval: CandleInterval
): Promise<RefreshItemResult> {
  try {
    const mapped = mapCandleIntervalToOhlcInterval(interval);
    const latest = await fetchLatestOhlc(symbol, mapped);
    if (!latest) {
      return {
        symbol,
        assetType: AssetType.FUTURE,
        status: "SKIPPED",
        message: "No OHLC returned from configured futures provider",
      };
    }

    await multiAssetMarketData.upsertCandles([
      {
        symbol,
        assetType: AssetType.FUTURE,
        interval,
        timestamp: resolveTimestamp(latest.time),
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
        volume: 0,
      },
    ]);

    return {
      symbol,
      assetType: AssetType.FUTURE,
      status: "UPDATED",
      message: "Refreshed from configured futures provider",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      symbol,
      assetType: AssetType.FUTURE,
      status: "ERROR",
      message,
    };
  }
}

async function refreshOptionSymbol(
  symbol: string,
  interval: CandleInterval
): Promise<RefreshItemResult> {
  try {
    const mapped = mapCandleIntervalToOhlcInterval(interval);
    const latest = await fetchLatestOhlc(symbol, mapped);
    if (!latest) {
      return {
        symbol,
        assetType: AssetType.OPTION,
        status: "SKIPPED",
        message: "No OHLC returned from configured options provider",
      };
    }

    await multiAssetMarketData.upsertCandles([
      {
        symbol,
        assetType: AssetType.OPTION,
        interval,
        timestamp: resolveTimestamp(latest.time),
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
        volume: 0,
      },
    ]);

    return {
      symbol,
      assetType: AssetType.OPTION,
      status: "UPDATED",
      message: "Refreshed from configured options provider",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      symbol,
      assetType: AssetType.OPTION,
      status: "ERROR",
      message,
    };
  }
}

export async function refreshStyleMarketData(
  userId: string,
  tradingStyle: TradingStyle
): Promise<StyleRefreshSummary> {
  const startedAt = new Date();

  const config = await prisma.userConfiguration.findUnique({
    where: {
      userId_tradingStyle: {
        userId,
        tradingStyle,
      },
    },
  });

  if (!config) {
    return {
      userId,
      tradingStyle,
      interval: mapStyleToInterval(tradingStyle),
      attempted: 0,
      updated: 0,
      skipped: 0,
      errored: 0,
      items: [],
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
    };
  }

  const policy = await prisma.styleMarketPolicy.findUnique({
    where: {
      userId_tradingStyle: {
        userId,
        tradingStyle,
      },
    },
  });

  const interval = policy?.allowedIntervals?.[0] ?? mapStyleToInterval(tradingStyle);
  const maxUniverseSize = policy?.maxUniverseSize ?? 50;
  const symbols = (config.symbolUniverse ?? []).slice(0, maxUniverseSize);
  const allowedAssetTypes = policy?.allowedAssetTypes ?? [AssetType.CRYPTO];

  const items: RefreshItemResult[] = [];

  for (const symbol of symbols) {
    for (const assetType of allowedAssetTypes) {
      try {
        if (assetType === AssetType.CRYPTO) {
          items.push(await refreshCryptoSymbol(symbol, interval));
          continue;
        }

        if (assetType === AssetType.STOCK) {
          items.push(await refreshStockSymbol(symbol));
          continue;
        }

        if (assetType === AssetType.FUTURE) {
          items.push(await refreshFutureSymbol(symbol, interval));
          continue;
        }

        if (assetType === AssetType.OPTION) {
          items.push(await refreshOptionSymbol(symbol, interval));
          continue;
        }

        items.push({
          symbol,
          assetType,
          status: "SKIPPED",
          message: "Unknown asset type",
        });
      } catch (error) {
        items.push({
          symbol,
          assetType,
          status: "ERROR",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const updated = items.filter((it) => it.status === "UPDATED").length;
  const skipped = items.filter((it) => it.status === "SKIPPED").length;
  const errored = items.filter((it) => it.status === "ERROR").length;

  return {
    userId,
    tradingStyle,
    interval,
    attempted: items.length,
    updated,
    skipped,
    errored,
    items,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
  };
}

export async function refreshAllStylePolicies(): Promise<StyleRefreshSummary[]> {
  const policies = await prisma.styleMarketPolicy.findMany({
    select: {
      userId: true,
      tradingStyle: true,
    },
  });

  const summaries: StyleRefreshSummary[] = [];
  for (const policy of policies) {
    summaries.push(await refreshStyleMarketData(policy.userId, policy.tradingStyle));
  }

  schedulerState.lastRunPolicyCount = policies.length;
  return summaries;
}

async function runSchedulerTick(): Promise<void> {
  if (schedulerState.inProgress) return;
  schedulerState.inProgress = true;
  schedulerState.lastStartedAt = new Date().toISOString();
  schedulerState.lastError = null;

  try {
    await refreshAllStylePolicies();
  } catch (error) {
    schedulerState.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    schedulerState.lastEndedAt = new Date().toISOString();
    schedulerState.inProgress = false;
  }
}

export function startStyleRefreshScheduler(intervalSeconds = 60): SchedulerState {
  const normalized = Math.max(10, Math.trunc(intervalSeconds));

  if (schedulerTimer) {
    schedulerState.intervalSeconds = normalized;
    return { ...schedulerState };
  }

  schedulerState.running = true;
  schedulerState.intervalSeconds = normalized;
  schedulerTimer = setInterval(() => {
    void runSchedulerTick();
  }, normalized * 1000);

  void runSchedulerTick();
  return { ...schedulerState };
}

export function stopStyleRefreshScheduler(): SchedulerState {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerState.running = false;
  schedulerState.inProgress = false;
  return { ...schedulerState };
}

export function getStyleRefreshSchedulerStatus(): SchedulerState {
  return { ...schedulerState };
}
