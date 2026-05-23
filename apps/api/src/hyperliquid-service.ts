import { Hyperliquid } from "hyperliquid";
import {
  applySupportFloorGuard,
  calculateLatestMacdHistogram,
  calculateLatestRsi,
  calculateSupportResistance,
  calculateStochasticRsi,
  classifyRsi,
  computeConfluenceScore,
  determineSignal,
  getSignalCategory,
  getSignalBadge,
  translateTimeframeTrend,
  type MarketType,
  type ScanParams,
  type SkippedToken,
  type TimeframeRsi,
  type TokenRsiResult
} from "./rsi.js";

const sdk = new Hyperliquid({ enableWs: false, disableAssetMapRefresh: true });
let connectPromise: Promise<void> | null = null;

const INTERVALS_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000
};

function resolveNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env ${name}: ${raw}`);
  }

  return parsed;
}

const VOLATILITY_LOOKBACK_CANDLES = Math.max(10, Math.trunc(resolveNumberEnv("VOLATILITY_LOOKBACK_CANDLES", 14)));
const MIN_VOLATILITY_PCT = resolveNumberEnv("MIN_VOLATILITY_PCT", 1.5);
const MIN_VOLUME_USD = resolveNumberEnv("MIN_VOLUME_USD", 50_000_000);

async function getClient(): Promise<Hyperliquid> {
  if (!connectPromise) {
    connectPromise = sdk.connect();
  }

  await connectPromise;
  return sdk;
}

export type LatestOhlc = {
  open: number;
  high: number;
  low: number;
  close: number;
  time: number;
};

export async function fetchLatestOhlc(
  symbol: string,
  interval: "1m" | "5m" | "15m" | "1h" | "4h" = "5m"
): Promise<LatestOhlc | null> {
  const client = await getClient();
  const now = Date.now();
  const intervalMs = INTERVALS_MS[interval] ?? 300_000;
  const start = now - intervalMs * 4;

  const candles = await client.info.getCandleSnapshot(symbol, interval, start, now);
  const latest = candles.at(-1);
  if (!latest) {
    return null;
  }

  const open = Number(latest.o ?? 0);
  const high = Number(latest.h ?? 0);
  const low = Number(latest.l ?? 0);
  const close = Number(latest.c ?? 0);
  const time = Number(latest.t ?? latest.T ?? now);

  if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }

  return { open, high, low, close, time };
}

export async function searchTokens(query: string | undefined, market: MarketType): Promise<string[]> {
  const client = await getClient();
  const assets = await client.info.getAllAssets();
  const list = market === "perp" ? assets.perp : assets.spot;

  if (!query) {
    return list;
  }

  const q = query.trim().toUpperCase();
  return list.filter((symbol) => symbol.toUpperCase().includes(q));
}

async function fetchAndCalculateTimeframeRsi(
  client: Hyperliquid,
  symbol: string,
  interval: "4h" | "1h" | "15m",
  lookbackCandles: number
): Promise<TimeframeRsi | null> {
  const intervalsMs: Record<string, number> = {
    "4h": 14_400_000,
    "1h": 3_600_000,
    "15m": 900_000
  };

  const intervalMs = intervalsMs[interval];
  const now = Date.now();
  const start = now - intervalMs * (lookbackCandles + 30);

  const candles = await client.info.getCandleSnapshot(symbol, interval, start, now);
  const closes = candles
    .map((candle) => Number(candle.c))
    .filter((value) => Number.isFinite(value));

  if (closes.length < 30) {
    return null;
  }

  const rsi = calculateLatestRsi(closes, 14);
  if (rsi === null) {
    return null;
  }

  const macdHist = calculateLatestMacdHistogram(closes);
  if (macdHist === null) {
    return null;
  }

  const stochRsi = calculateStochasticRsi(closes, 14, 3, 3);
  if (stochRsi === null) {
    return null;
  }

  return {
    interval,
    rsi: Number(rsi.toFixed(2)),
    macdHist,
    stochRsi: stochRsi.stochRsi,
    stochK: stochRsi.k,
    stochD: stochRsi.d,
    prevStochK: stochRsi.prevK,
    prevStochD: stochRsi.prevD,
    trend: translateTimeframeTrend(
      stochRsi.k,
      stochRsi.d,
      stochRsi.prevK,
      stochRsi.prevD,
      Number(rsi.toFixed(2))
    )
  };
}

async function fetchAllVolumes24h(client: Hyperliquid, market: MarketType): Promise<Map<string, number>> {
  const [meta, ctxs] = await client.info.perpetuals.getMetaAndAssetCtxs();
  const volumeMap = new Map<string, number>();
  const universe: Array<{ name: string }> = (meta as any).universe;
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name;
    const symbol = market === "perp" ? name : name;
    const dayNtlVlm = Number((ctxs as any)[i]?.dayNtlVlm ?? 0);
    if (Number.isFinite(dayNtlVlm) && dayNtlVlm > 0) {
      volumeMap.set(symbol, dayNtlVlm);
    }
  }
  return volumeMap;
}

function calculateVolatilityPctFromCandles(candles: any[], lookbackCandles: number): number {
  const window = candles.slice(-lookbackCandles);
  if (window.length === 0) {
    return 0;
  }

  let highestHigh = Number.NEGATIVE_INFINITY;
  let lowestLow = Number.POSITIVE_INFINITY;

  for (const candle of window) {
    const high = Number(candle?.h ?? NaN);
    const low = Number(candle?.l ?? NaN);
    if (!Number.isFinite(high) || !Number.isFinite(low) || low <= 0) {
      continue;
    }

    if (high > highestHigh) highestHigh = high;
    if (low < lowestLow) lowestLow = low;
  }

  if (!Number.isFinite(highestHigh) || !Number.isFinite(lowestLow) || lowestLow <= 0) {
    return 0;
  }

  return Number((((highestHigh - lowestLow) / lowestLow) * 100).toFixed(3));
}

export type ScanResult = {
  analyzedAt: string;
  params: ScanParams;
  results: TokenRsiResult[];
  skipped: SkippedToken[];
};

export async function scanRsi(params: ScanParams): Promise<ScanResult> {
  const client = await getClient();
  const matching = await searchTokens(params.query, params.market);
  const skipped: SkippedToken[] = [];

  const allVolumes = await fetchAllVolumes24h(client, params.market);

  const volumeBySymbol = new Map<string, number>();
  for (const symbol of matching) {
    const vol = allVolumes.get(symbol);
    if (vol != null) {
      volumeBySymbol.set(symbol, vol);
    } else {
      skipped.push({
        symbol,
        reason: "FETCH_ERROR",
        details: "No 24h volume data available"
      });
    }
  }

  const topByVolume = Array.from(volumeBySymbol.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, params.limitTokens)
    .map(([symbol]) => symbol);

  const settled = await Promise.allSettled(
    topByVolume.map(async (symbol) => {
      const lookbackCandles = 200;
      const now = Date.now();
      const fourHourMs = 14_400_000;
      const oneHourMs = 3_600_000;
      const volume24h = volumeBySymbol.get(symbol);
      if (volume24h == null) {
        throw new Error("Missing ranked volume for symbol");
      }

      const [macro, intermediary, microTrigger, fourHourCandles, supportWindowCandles] = await Promise.all([
        fetchAndCalculateTimeframeRsi(client, symbol, "4h", lookbackCandles),
        fetchAndCalculateTimeframeRsi(client, symbol, "1h", lookbackCandles),
        fetchAndCalculateTimeframeRsi(client, symbol, "15m", lookbackCandles),
        client.info.getCandleSnapshot(symbol, "4h", now - fourHourMs * (200 + 30), now),
        client.info.getCandleSnapshot(symbol, "1h", now - oneHourMs * (48 + 8), now)
      ]);

      if (!macro || !intermediary || !microTrigger) {
        return {
          skipped: {
            symbol,
            reason: "INSUFFICIENT_CANDLES" as const,
            details: `Could not fetch all three timeframes (macro: ${macro ? "ok" : "fail"}, intermediary: ${intermediary ? "ok" : "fail"}, micro: ${microTrigger ? "ok" : "fail"})`
          } as SkippedToken
        };
      }

      const signal = determineSignal(macro, intermediary, microTrigger);
      const close = fourHourCandles.length > 0 ? Number(fourHourCandles.at(-1)?.c ?? 0) : 0;
      const levelsCalc = calculateSupportResistance(supportWindowCandles.slice(-48));
      const volatilityPct = calculateVolatilityPctFromCandles(supportWindowCandles, VOLATILITY_LOOKBACK_CANDLES);
      const passedVolatility = volatilityPct >= MIN_VOLATILITY_PCT;
      const passedLiquidity = volume24h >= MIN_VOLUME_USD;
        const guarded = applySupportFloorGuard(
          signal,
          close,
          levelsCalc.localSupport,
          levelsCalc.localResistance,
          0.005
        );
      const adjustedSignalBadge = getSignalBadge(guarded.adjustedSignal);
        const signalCategory = getSignalCategory(guarded.adjustedSignal);

      const result: TokenRsiResult = {
        symbol,
        market: params.market,
        rsi: intermediary.rsi,
        close,
        volume24h,
        volatilityPct,
        tradeContext: {
          volatilityPct,
          volume24h,
          passedVolatility,
          passedLiquidity
        },
        confluence: {
          score: 0,
          bias: "SHORT",
          maxScore: 10
        },
        levels: {
          localSupport: levelsCalc.localSupport,
          localResistance: levelsCalc.localResistance,
          nearSupportFloor: guarded.nearSupportFloor,
            nearResistance: guarded.nearResistance,
            supportDistancePct: guarded.supportDistancePct,
            resistanceDistancePct: guarded.resistanceDistancePct
        },
        status: classifyRsi(intermediary.rsi, 70, 30),
        signal: adjustedSignalBadge,
          signalCategory,
        timeframes: {
          macro,
          intermediary,
          microTrigger
        }
      };

      return { result };
    })
  );

  const results: TokenRsiResult[] = [];

  for (let i = 0; i < settled.length; i += 1) {
    const item = settled[i];
    const symbol = topByVolume[i];

    if (item.status === "rejected") {
      skipped.push({
        symbol,
        reason: "FETCH_ERROR",
        details: item.reason instanceof Error ? item.reason.message : String(item.reason)
      });
      continue;
    }

    if (item.value.result) {
      results.push(item.value.result);
      continue;
    }

    skipped.push(item.value.skipped);
  }

  const averageMarketVolume =
    results.length > 0 ? results.reduce((sum, item) => sum + item.volume24h, 0) / results.length : 0;

  const scoredResults = results.map((item) => ({
    ...item,
    confluence: computeConfluenceScore({
      macro: item.timeframes.macro,
      intermediary: item.timeframes.intermediary,
      microTrigger: item.timeframes.microTrigger,
      volume24h: item.volume24h,
      averageMarketVolume
    })
  }));

  return {
    analyzedAt: new Date().toISOString(),
    params,
    results: scoredResults.slice(0, params.limitTokens),
    skipped
  };
}
