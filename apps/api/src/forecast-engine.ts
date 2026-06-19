import { CandleInterval, PrismaClient } from "@prisma/client";
import { fetchLatestOhlc } from "./market-data-service.js";

type AssetType = "CRYPTO" | "STOCK";

type ForecastIntervalConfig = {
  requested: string;
  label: string;
  baseInterval: CandleInterval;
  bucketSize: number;
  fallbackNote?: string;
  profile: "SCALP" | "DAY_TRADE" | "SWING" | "POSITION";
};

type ForecastProbability = {
  upPct: number;
  downPct: number;
  flatPct: number;
  score: number;
};

export type MomentumForecastResult = {
  timestamp: string;
  symbol: string;
  assetType: AssetType;
  intervalRequested: string;
  intervalUsed: string;
  baseIntervalUsed: CandleInterval;
  aggregationBucketSize: number;
  traderProfile: ForecastIntervalConfig["profile"];
  candlesUsed: number;
  latestPrice: number;
  latestPriceSource: "REALTIME" | "CANDLE_CLOSE";
  latestPriceAsOf: string;
  forecast: {
    directionBias: "UP_BIAS" | "DOWN_BIAS" | "SIDEWAYS_BIAS";
    probabilitiesPct: {
      up: number;
      down: number;
      sideways: number;
    };
    momentumScore: number;
  };
  notes: string[];
};

const prisma = new PrismaClient();

const INTERVALS: Record<string, ForecastIntervalConfig> = {
  "5m": {
    requested: "5m",
    label: "5m",
    baseInterval: CandleInterval.M15,
    bucketSize: 1,
    fallbackNote: "5m currently uses 15m base candles until native 5m storage is added.",
    profile: "SCALP"
  },
  "15m": {
    requested: "15m",
    label: "15m",
    baseInterval: CandleInterval.M15,
    bucketSize: 1,
    profile: "SCALP"
  },
  "30m": {
    requested: "30m",
    label: "30m",
    baseInterval: CandleInterval.M15,
    bucketSize: 2,
    profile: "DAY_TRADE"
  },
  "1h": {
    requested: "1h",
    label: "1h",
    baseInterval: CandleInterval.H1,
    bucketSize: 1,
    profile: "DAY_TRADE"
  },
  "2h": {
    requested: "2h",
    label: "2h",
    baseInterval: CandleInterval.H1,
    bucketSize: 2,
    profile: "DAY_TRADE"
  },
  "4h": {
    requested: "4h",
    label: "4h",
    baseInterval: CandleInterval.H4,
    bucketSize: 1,
    profile: "SWING"
  },
  "6h": {
    requested: "6h",
    label: "6h",
    baseInterval: CandleInterval.H1,
    bucketSize: 6,
    profile: "SWING"
  },
  "8h": {
    requested: "8h",
    label: "8h",
    baseInterval: CandleInterval.H1,
    bucketSize: 8,
    profile: "SWING"
  },
  "12h": {
    requested: "12h",
    label: "12h",
    baseInterval: CandleInterval.H12,
    bucketSize: 1,
    profile: "SWING"
  },
  "1d": {
    requested: "1d",
    label: "1d",
    baseInterval: CandleInterval.D1,
    bucketSize: 1,
    profile: "SWING"
  },
  "3d": {
    requested: "3d",
    label: "3d",
    baseInterval: CandleInterval.D1,
    bucketSize: 3,
    profile: "POSITION"
  },
  "1w": {
    requested: "1w",
    label: "1w",
    baseInterval: CandleInterval.D1,
    bucketSize: 7,
    profile: "POSITION"
  },
  "2w": {
    requested: "2w",
    label: "2w",
    baseInterval: CandleInterval.D1,
    bucketSize: 14,
    profile: "POSITION"
  },
  "1m": {
    requested: "1m",
    label: "1m",
    baseInterval: CandleInterval.D1,
    bucketSize: 30,
    fallbackNote: "1m uses rolling 30-day aggregation from daily candles.",
    profile: "POSITION"
  }
};

export const DEFAULT_FORECAST_INTERVAL = "1h";
export const SUPPORTED_FORECAST_INTERVALS = Object.keys(INTERVALS);

function mapRealtimeProbeInterval(requested: string): "1m" | "5m" | "15m" | "1h" | "4h" {
  const value = requested.trim().toLowerCase();
  if (value === "5m") return "5m";
  if (value === "15m" || value === "30m") return "15m";
  if (value === "1h" || value === "2h") return "1h";
  return "4h";
}

function normalizeInterval(raw: string | undefined): ForecastIntervalConfig {
  const normalized = String(raw ?? DEFAULT_FORECAST_INTERVAL).trim().toLowerCase();
  return INTERVALS[normalized] ?? INTERVALS[DEFAULT_FORECAST_INTERVAL];
}

function aggregateCloses(closes: number[], bucketSize: number): number[] {
  if (bucketSize <= 1) {
    return closes;
  }

  if (closes.length < bucketSize) {
    return [];
  }

  const remainder = closes.length % bucketSize;
  const start = remainder === 0 ? 0 : remainder;
  const result: number[] = [];

  for (let i = start; i < closes.length; i += bucketSize) {
    const bucket = closes.slice(i, i + bucketSize);
    if (bucket.length !== bucketSize) {
      continue;
    }
    result.push(bucket[bucket.length - 1]);
  }

  return result;
}

function momentumProbability(closes: number[]): ForecastProbability {
  if (closes.length < 10) {
    return { upPct: 33.3, downPct: 33.3, flatPct: 33.4, score: 0 };
  }

  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const next = closes[i];
    if (prev > 0) returns.push((next - prev) / prev);
  }

  const last = returns[returns.length - 1] ?? 0;
  const shortWindow = returns.slice(-5);
  const mediumWindow = returns.slice(-14);
  const shortMomentum = shortWindow.reduce((sum, r) => sum + r, 0);
  const mediumMomentum = mediumWindow.reduce((sum, r) => sum + r, 0);
  const volatility = mediumWindow.length > 0
    ? Math.sqrt(mediumWindow.reduce((sum, r) => sum + r * r, 0) / mediumWindow.length)
    : 0;

  const rawScore = (shortMomentum * 3) + (mediumMomentum * 2) + (last * 1.5);
  const normalized = Math.max(-1, Math.min(1, rawScore / 0.08));
  const confidence = Math.max(0, Math.min(1, Math.abs(normalized) * (1 - Math.min(0.8, volatility * 12))));

  const directional = 50 + normalized * 35;
  const flat = Math.max(8, 30 - confidence * 20);
  const up = Math.max(5, Math.min(90, directional - flat / 2));
  const down = Math.max(5, 100 - up - flat);

  return {
    upPct: Number(up.toFixed(1)),
    downPct: Number(down.toFixed(1)),
    flatPct: Number(flat.toFixed(1)),
    score: Number(normalized.toFixed(4))
  };
}

export async function buildMomentumForecast(params: {
  symbol: string;
  intervalRequested?: string;
  assetType?: string;
}): Promise<MomentumForecastResult> {
  const symbol = String(params.symbol).trim().toUpperCase();
  if (!symbol) {
    throw new Error("Symbol is required");
  }

  const interval = normalizeInterval(params.intervalRequested);
  const assetTypeRaw = String(params.assetType ?? "CRYPTO").trim().toUpperCase();
  const assetType: AssetType = assetTypeRaw === "STOCK" ? "STOCK" : "CRYPTO";

  const minimumAggregatedCandles = interval.requested === "1m" || interval.requested === "2w" ? 6 : 10;
  const neededBase = Math.max(60, minimumAggregatedCandles * interval.bucketSize + interval.bucketSize * 8);

  const candles = await prisma.marketCandle.findMany({
    where: {
      symbol,
      assetType,
      interval: interval.baseInterval
    },
    orderBy: { timestamp: "asc" },
    take: Math.min(1200, neededBase * 3)
  });

  if (candles.length < Math.max(12, interval.bucketSize * 2)) {
    throw new Error(
      `Insufficient base candles for ${interval.label}. Found ${candles.length} ${interval.baseInterval} candles for ${symbol}.`
    );
  }

  const closes = candles.map((c) => Number(c.close));
  const aggregatedCloses = aggregateCloses(closes, interval.bucketSize);

  if (aggregatedCloses.length < minimumAggregatedCandles) {
    throw new Error(
      `Insufficient aggregated candles for ${interval.label}. Found ${aggregatedCloses.length}, required ${minimumAggregatedCandles}.`
    );
  }

  const prob = momentumProbability(aggregatedCloses);
  const directionBias = prob.upPct >= prob.downPct && prob.upPct >= prob.flatPct
    ? "UP_BIAS"
    : prob.downPct >= prob.upPct && prob.downPct >= prob.flatPct
      ? "DOWN_BIAS"
      : "SIDEWAYS_BIAS";

  const latest = candles[candles.length - 1];
  let latestPrice = Number(latest.close);
  let latestPriceAsOf = latest.timestamp.toISOString();
  let latestPriceSource: "REALTIME" | "CANDLE_CLOSE" = "CANDLE_CLOSE";

  if (assetType === "CRYPTO") {
    try {
      const probeInterval = mapRealtimeProbeInterval(interval.label);
      const realtime = await fetchLatestOhlc(symbol, probeInterval);
      if (realtime && Number.isFinite(realtime.close) && realtime.close > 0) {
        latestPrice = Number(realtime.close);
        latestPriceAsOf = new Date(realtime.time).toISOString();
        latestPriceSource = "REALTIME";
      }
    } catch {
      // Keep candle-close fallback if realtime probe fails.
    }
  }

  const notes = [
    "Momentum forecast uses historical candles already stored in MarketCandle.",
    "Probabilities are analytical context only and not a trade instruction.",
    `Trader profile fit: ${interval.profile}.`
  ];

  if (latestPriceSource === "REALTIME") {
    notes.push("Latest price is from realtime market feed.");
  } else {
    notes.push("Latest price fell back to most recent stored candle close.");
  }

  if (interval.fallbackNote) {
    notes.push(interval.fallbackNote);
  }

  return {
    timestamp: new Date().toISOString(),
    symbol,
    assetType,
    intervalRequested: String(params.intervalRequested ?? DEFAULT_FORECAST_INTERVAL),
    intervalUsed: interval.label,
    baseIntervalUsed: interval.baseInterval,
    aggregationBucketSize: interval.bucketSize,
    traderProfile: interval.profile,
    candlesUsed: aggregatedCloses.length,
    latestPrice,
    latestPriceSource,
    latestPriceAsOf,
    forecast: {
      directionBias,
      probabilitiesPct: {
        up: prob.upPct,
        down: prob.downPct,
        sideways: prob.flatPct
      },
      momentumScore: prob.score
    },
    notes
  };
}
