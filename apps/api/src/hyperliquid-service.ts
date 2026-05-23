import "./env.js";
import { Hyperliquid } from "hyperliquid";
import {
  applySupportFloorGuard,
  calculateLatestEma,
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
const MICRO_TREND_EMA_PERIOD = 20;
const ORDERBOOK_DEPTH_BPS = Math.max(1, Math.trunc(resolveNumberEnv("ORDERBOOK_DEPTH_BPS", 10)));
const ORDERBOOK_REFERENCE_NOTIONAL_USD = Math.max(100, resolveNumberEnv("ORDERBOOK_REFERENCE_NOTIONAL_USD", 2000));
const ORDERBOOK_MIN_DEPTH_MULTIPLIER = Math.max(1, resolveNumberEnv("ORDERBOOK_MIN_DEPTH_MULTIPLIER", 2));
const ORDERBOOK_MAX_SPREAD_PCT_LARGE = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_LARGE", 0.03));
const ORDERBOOK_MAX_SPREAD_PCT_ALT = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_ALT", 0.06));
const ORDERBOOK_MAX_AGAINST_IMBALANCE = Math.max(0, Math.min(1, resolveNumberEnv("ORDERBOOK_MAX_AGAINST_IMBALANCE", 0.25)));

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

export type PerpAssetContext = {
  symbol: string;
  fundingRate: number;
  markPrice: number;
  oraclePrice: number;
  midPrice: number;
  openInterest: number;
  openInterestUsd: number;
  dayNtlVolume: number;
};

export type OrderBookExecutionRead = {
  symbol: string;
  bestBid: number;
  bestAsk: number;
  markPrice: number;
  spreadPct: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  combinedDepthUsd: number;
  imbalance: number;
  depthBps: number;
};

function normalizePerpSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (!upper) {
    return upper;
  }

  return upper.endsWith("-PERP") ? upper : `${upper}-PERP`;
}

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

export async function fetchPerpContexts(symbols: string[]): Promise<Map<string, PerpAssetContext>> {
  const normalizedSymbols = symbols
    .map((symbol) => normalizePerpSymbol(symbol))
    .filter((symbol) => symbol.length > 0);
  const wanted = new Set(normalizedSymbols);
  if (wanted.size === 0) {
    return new Map();
  }

  const client = await getClient();
  const [meta, ctxs] = await client.info.perpetuals.getMetaAndAssetCtxs();
  const result = new Map<string, PerpAssetContext>();
  const universe: Array<{ name: string }> = (meta as any).universe;

  for (let i = 0; i < universe.length; i += 1) {
    const symbol = normalizePerpSymbol(universe[i]?.name ?? "");
    if (!wanted.has(symbol)) {
      continue;
    }

    const rawCtx = (ctxs as any)[i] ?? {};
    const markPrice = Number(rawCtx.markPx ?? rawCtx.midPx ?? rawCtx.oraclePx ?? 0);
    const oraclePrice = Number(rawCtx.oraclePx ?? 0);
    const midPrice = Number(rawCtx.midPx ?? markPrice);
    const fundingRate = Number(rawCtx.funding ?? 0);
    const openInterest = Number(rawCtx.openInterest ?? 0);
    const dayNtlVolume = Number(rawCtx.dayNtlVlm ?? 0);
    const openInterestUsd =
      Number.isFinite(markPrice) && markPrice > 0 && Number.isFinite(openInterest) && openInterest > 0
        ? Number((openInterest * markPrice).toFixed(2))
        : 0;

    result.set(symbol, {
      symbol,
      fundingRate: Number.isFinite(fundingRate) ? fundingRate : 0,
      markPrice: Number.isFinite(markPrice) && markPrice > 0 ? markPrice : 0,
      oraclePrice: Number.isFinite(oraclePrice) && oraclePrice > 0 ? oraclePrice : 0,
      midPrice: Number.isFinite(midPrice) && midPrice > 0 ? midPrice : 0,
      openInterest: Number.isFinite(openInterest) && openInterest > 0 ? openInterest : 0,
      openInterestUsd,
      dayNtlVolume: Number.isFinite(dayNtlVolume) && dayNtlVolume > 0 ? dayNtlVolume : 0
    });
  }

  return result;
}

function sumDepthUsdWithinBps(
  levels: Array<{ px: number; sz: number }> | undefined,
  markPrice: number,
  bps: number
): number {
  if (!levels || levels.length === 0 || !Number.isFinite(markPrice) || markPrice <= 0) {
    return 0;
  }

  const limitPct = bps / 10_000;
  let total = 0;
  for (const level of levels) {
    const px = Number(level?.px ?? NaN);
    const sz = Number(level?.sz ?? NaN);
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(sz) || sz <= 0) {
      continue;
    }

    const distancePct = Math.abs(px - markPrice) / markPrice;
    if (distancePct <= limitPct) {
      total += px * sz;
    }
  }

  return Number(total.toFixed(2));
}

export async function fetchOrderBookExecutionRead(symbol: string): Promise<OrderBookExecutionRead | null> {
  const normalized = normalizePerpSymbol(symbol);
  if (!normalized) {
    return null;
  }

  const client = await getClient();
  const book = await client.info.getL2Book(normalized);
  const levels = (book as any)?.levels;
  if (!Array.isArray(levels) || levels.length < 2) {
    return null;
  }

  const bids = Array.isArray(levels[0]) ? levels[0] : [];
  const asks = Array.isArray(levels[1]) ? levels[1] : [];
  const bestBid = Number(bids[0]?.px ?? NaN);
  const bestAsk = Number(asks[0]?.px ?? NaN);
  if (!Number.isFinite(bestBid) || bestBid <= 0 || !Number.isFinite(bestAsk) || bestAsk <= 0 || bestAsk < bestBid) {
    return null;
  }

  const markPrice = Number((((bestBid + bestAsk) / 2)).toFixed(6));
  const spreadPct = Number((((bestAsk - bestBid) / markPrice) * 100).toFixed(5));
  const bidDepthUsd = sumDepthUsdWithinBps(bids, markPrice, ORDERBOOK_DEPTH_BPS);
  const askDepthUsd = sumDepthUsdWithinBps(asks, markPrice, ORDERBOOK_DEPTH_BPS);
  const combinedDepthUsd = Number((bidDepthUsd + askDepthUsd).toFixed(2));
  const imbalance =
    combinedDepthUsd > 0
      ? Number((((bidDepthUsd - askDepthUsd) / combinedDepthUsd)).toFixed(5))
      : 0;

  return {
    symbol: normalized,
    bestBid,
    bestAsk,
    markPrice,
    spreadPct,
    bidDepthUsd,
    askDepthUsd,
    combinedDepthUsd,
    imbalance,
    depthBps: ORDERBOOK_DEPTH_BPS
  };
}

function evaluateOrderBookGate(
  symbol: string,
  direction: "LONG" | "SHORT" | null,
  read: OrderBookExecutionRead | null
): {
  passedOrderBook: boolean;
  orderBookSpreadPct: number;
  orderBookCombinedDepthUsd: number;
  orderBookImbalance: number;
  orderBookReferenceNotionalUsd: number;
  orderBookDepthBps: number;
} {
  if (!read || !direction) {
    return {
      passedOrderBook: false,
      orderBookSpreadPct: 0,
      orderBookCombinedDepthUsd: 0,
      orderBookImbalance: 0,
      orderBookReferenceNotionalUsd: ORDERBOOK_REFERENCE_NOTIONAL_USD,
      orderBookDepthBps: ORDERBOOK_DEPTH_BPS
    };
  }

  const upper = symbol.trim().toUpperCase();
  const isLarge = upper.includes("BTC") || upper.includes("ETH");
  const maxSpreadPct = isLarge ? ORDERBOOK_MAX_SPREAD_PCT_LARGE : ORDERBOOK_MAX_SPREAD_PCT_ALT;
  const minDepthUsd = ORDERBOOK_REFERENCE_NOTIONAL_USD * ORDERBOOK_MIN_DEPTH_MULTIPLIER;

  const spreadPass = read.spreadPct <= maxSpreadPct;
  const depthPass = read.combinedDepthUsd >= minDepthUsd;
  const imbalancePass =
    direction === "LONG"
      ? read.imbalance >= -ORDERBOOK_MAX_AGAINST_IMBALANCE
      : read.imbalance <= ORDERBOOK_MAX_AGAINST_IMBALANCE;

  return {
    passedOrderBook: spreadPass && depthPass && imbalancePass,
    orderBookSpreadPct: read.spreadPct,
    orderBookCombinedDepthUsd: read.combinedDepthUsd,
    orderBookImbalance: read.imbalance,
    orderBookReferenceNotionalUsd: ORDERBOOK_REFERENCE_NOTIONAL_USD,
    orderBookDepthBps: read.depthBps
  };
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

  const topByVolume = matching
    .filter((symbol) => volumeBySymbol.has(symbol))
    .sort((left, right) => {
      const leftVolume = volumeBySymbol.get(left) ?? 0;
      const rightVolume = volumeBySymbol.get(right) ?? 0;
      return rightVolume - leftVolume;
    })
    .slice(0, params.limitTokens);

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
      const direction = signal.includes("LONG") ? "LONG" : signal.includes("SHORT") ? "SHORT" : null;
      const orderBookRead = await fetchOrderBookExecutionRead(symbol);
      const orderBookGate = evaluateOrderBookGate(symbol, direction, orderBookRead);
      const close = fourHourCandles.length > 0 ? Number(fourHourCandles.at(-1)?.c ?? 0) : 0;
      const levelsCalc = calculateSupportResistance(supportWindowCandles.slice(-48));
      const volatilityPct = calculateVolatilityPctFromCandles(supportWindowCandles, VOLATILITY_LOOKBACK_CANDLES);
      const passedVolatility = volatilityPct >= MIN_VOLATILITY_PCT;
      const passedLiquidity = volume24h >= MIN_VOLUME_USD;
      const oneHourWindow = supportWindowCandles.slice(-2);
      const latestOneHour = oneHourWindow.at(-1);
      const previousOneHour = oneHourWindow.at(-2);
      const latestHigh = Number(latestOneHour?.h ?? NaN);
      const latestLow = Number(latestOneHour?.l ?? NaN);
      const previousHigh = Number(previousOneHour?.h ?? NaN);
      const previousLow = Number(previousOneHour?.l ?? NaN);

      const structureLongOk =
        Number.isFinite(latestHigh) &&
        Number.isFinite(previousHigh) &&
        Number.isFinite(latestLow) &&
        Number.isFinite(previousLow) &&
        latestHigh > previousHigh &&
        latestLow >= previousLow;
      const structureShortOk =
        Number.isFinite(latestHigh) &&
        Number.isFinite(previousHigh) &&
        Number.isFinite(latestLow) &&
        Number.isFinite(previousLow) &&
        latestLow < previousLow &&
        latestHigh <= previousHigh;

      const oneHourTrendDirection = macro.trend.direction === "UP" && intermediary.trend.direction === "UP"
        ? "BULLISH"
        : macro.trend.direction === "DOWN" && intermediary.trend.direction === "DOWN"
          ? "BEARISH"
          : "NEUTRAL";
      const alignLongCount = [macro.trend.direction, intermediary.trend.direction, microTrigger.trend.direction].filter(
        (item) => item === "UP"
      ).length;
      const alignShortCount = [macro.trend.direction, intermediary.trend.direction, microTrigger.trend.direction].filter(
        (item) => item === "DOWN"
      ).length;
      const structureState = Math.max(alignLongCount, alignShortCount) >= 2
        ? "TRENDING"
        : (microTrigger.trend.direction === "UP" || microTrigger.trend.direction === "DOWN")
          ? "BREAKOUT"
          : "CHOP";

      const microWindowCandles = await client.info.getCandleSnapshot(symbol, "15m", now - 900_000 * (lookbackCandles + 30), now);
      const microCloses = microWindowCandles
        .map((candle) => Number(candle.c))
        .filter((value) => Number.isFinite(value) && value > 0);
      const ema20 = calculateLatestEma(microCloses, MICRO_TREND_EMA_PERIOD) ?? close;
      const microTrendLongOk = Number.isFinite(close) && Number.isFinite(ema20) && close > ema20;
      const microTrendShortOk = Number.isFinite(close) && Number.isFinite(ema20) && close < ema20;

      let filteredSignal = signal;
      if (signal === "STRONG LONG" || signal === "CONTINUATION LONG") {
        if (!structureLongOk) {
          filteredSignal = "NO SIGNAL";
        }
      } else if (signal === "STRONG SHORT" || signal === "CONTINUATION SHORT") {
        if (!structureShortOk) {
          filteredSignal = "NO SIGNAL";
        }
      }

      if (filteredSignal === "STRONG LONG" || filteredSignal === "CONTINUATION LONG") {
        if (!microTrendLongOk) {
          filteredSignal = "NO SIGNAL";
        }
      } else if (filteredSignal === "STRONG SHORT" || filteredSignal === "CONTINUATION SHORT") {
        if (!microTrendShortOk) {
          filteredSignal = "NO SIGNAL";
        }
      }

      const originalDirectional = signal.endsWith("LONG") || signal.endsWith("SHORT");
      const passedStructure = !originalDirectional
        ? true
        : signal.endsWith("LONG")
          ? structureLongOk
          : structureShortOk;
      const passedMicroTrend = !originalDirectional
        ? true
        : signal.endsWith("LONG")
          ? microTrendLongOk
          : microTrendShortOk;

        const guarded = applySupportFloorGuard(
          filteredSignal,
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
          passedLiquidity,
          passedOrderBook: orderBookGate.passedOrderBook,
          orderBookSpreadPct: orderBookGate.orderBookSpreadPct,
          orderBookCombinedDepthUsd: orderBookGate.orderBookCombinedDepthUsd,
          orderBookImbalance: orderBookGate.orderBookImbalance,
          orderBookReferenceNotionalUsd: orderBookGate.orderBookReferenceNotionalUsd,
          orderBookDepthBps: orderBookGate.orderBookDepthBps,
          passedStructure,
          passedMicroTrend,
          ema20,
          higherTimeframeTrend: oneHourTrendDirection,
          structureState
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
      averageMarketVolume,
      volatilityPct: item.volatilityPct
    })
  }));

  return {
    analyzedAt: new Date().toISOString(),
    params,
    results: scoredResults.slice(0, params.limitTokens),
    skipped
  };
}
