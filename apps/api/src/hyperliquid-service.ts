import "./env.js";
import { Hyperliquid } from "hyperliquid";
import {
  applySupportFloorGuard,
  calculateLatestAtr,
  calculateLatestEma,
  calculateLatestMacdHistogram,
  calculateLatestRsi,
  calculateSupportResistance,
  calculateStochasticRsiSeries,
  calculateStochasticRsi,
  classifyRsi,
  computeConfluenceScore,
  determineSignal,
  evaluateDailyReversalBias,
  getSignalCategory,
  getSignalBadge,
  translateTimeframeTrend,
  type MarketType,
  type ScanParams,
  type SkippedToken,
  type TimeframeRsi,
  type TokenRsiResult
} from "./rsi.js";
import { detectRegime, type MarketRegime } from "./regime-engine.js";
import { evaluateStructure } from "./structure-engine.js";
import { evaluateMicroTrend } from "./ema-engine.js";
import { evaluateSupportResistance } from "./sr-engine.js";
import { detectDescendingTrendlineBreakout, detectAscendingTrendlineBreakdown } from "./trendline-engine.js";
import { classifyEntryTiming, type EntryTiming } from "./entry-timing.js";

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

function resolveSymbolSetEnv(name: string, defaultValue: string): Set<string> {
  const raw = process.env[name] ?? defaultValue;
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter((item) => item.length > 0)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isRetryableFetchError(error: unknown): boolean {
  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("500") ||
    message.includes("internal server error") ||
    message.includes("no response") ||
    message.includes("unknown error")
  );
}

async function withRetry<T>(
  operation: () => Promise<T>,
  context: string,
  maxAttempts: number,
  baseDelayMs: number
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableFetchError(error) || attempt >= maxAttempts) {
        break;
      }

      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      console.warn(`[scan:rsi] retry ${attempt}/${maxAttempts - 1} for ${context} in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  throw new Error(`${context}: ${extractErrorMessage(lastError)}`);
}

const VOLATILITY_LOOKBACK_CANDLES = Math.max(10, Math.trunc(resolveNumberEnv("VOLATILITY_LOOKBACK_CANDLES", 14)));
const MIN_VOLATILITY_PCT = resolveNumberEnv("MIN_VOLATILITY_PCT", 1.5);
const MIN_VOLUME_USD = resolveNumberEnv("MIN_VOLUME_USD", 7_000_000);
const MIN_VOLUME_USD_MAJOR_ALT = resolveNumberEnv("MIN_VOLUME_USD_MAJOR_ALT", 3_000_000);
const MAJOR_ALT_SYMBOLS = resolveSymbolSetEnv(
  "MAJOR_ALT_SYMBOLS",
  "SOL,BNB,XRP,DOGE,ADA,TON,AVAX,LINK,DOT,LTC,TRX,BCH,APT,ARB,OP,INJ,ONDO,SUI,NEAR"
);
const MICRO_TREND_EMA_PERIOD = 20;
const ORDERBOOK_DEPTH_BPS = Math.max(1, Math.trunc(resolveNumberEnv("ORDERBOOK_DEPTH_BPS", 10)));
const ORDERBOOK_REFERENCE_NOTIONAL_USD = Math.max(100, resolveNumberEnv("ORDERBOOK_REFERENCE_NOTIONAL_USD", 2000));
const ORDERBOOK_MIN_DEPTH_MULTIPLIER = Math.max(1, resolveNumberEnv("ORDERBOOK_MIN_DEPTH_MULTIPLIER", 2));
const ORDERBOOK_MAX_SPREAD_PCT_LARGE = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_LARGE", 0.03));
const ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT", 0.08));
const ORDERBOOK_MAX_SPREAD_PCT_ALT = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_ALT", 0.06));
const ORDERBOOK_MAX_AGAINST_IMBALANCE = Math.max(0, Math.min(1, resolveNumberEnv("ORDERBOOK_MAX_AGAINST_IMBALANCE", 0.25)));
const ORDERBOOK_MAX_AGAINST_IMBALANCE_MAJOR_ALT = Math.max(
  0,
  Math.min(1, resolveNumberEnv("ORDERBOOK_MAX_AGAINST_IMBALANCE_MAJOR_ALT", 0.35))
);
const SCAN_FETCH_MAX_ATTEMPTS = Math.max(1, Math.trunc(resolveNumberEnv("SCAN_FETCH_MAX_ATTEMPTS", 4)));
const SCAN_FETCH_BACKOFF_MS = Math.max(50, Math.trunc(resolveNumberEnv("SCAN_FETCH_BACKOFF_MS", 250)));
const SCAN_SYMBOL_CONCURRENCY = Math.max(1, Math.trunc(resolveNumberEnv("SCAN_SYMBOL_CONCURRENCY", 5)));
const SCAN_CHUNK_DELAY_MS = Math.max(0, Math.trunc(resolveNumberEnv("SCAN_CHUNK_DELAY_MS", 120)));
const VOLUME_CACHE_TTL_MS = Math.max(5_000, Math.trunc(resolveNumberEnv("VOLUME_CACHE_TTL_MS", 60_000)));
const ASSET_LIST_CACHE_TTL_MS = Math.max(10_000, Math.trunc(resolveNumberEnv("ASSET_LIST_CACHE_TTL_MS", 300_000)));

let _volumeCache: Map<string, number> | null = null;
let _volumeCacheAt = 0;
let _assetListCache: { perp: string[]; spot: string[] } | null = null;
let _assetListCacheAt = 0;

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

function getBaseSymbol(symbol: string): string {
  const normalized = normalizePerpSymbol(symbol);
  return normalized.endsWith("-PERP") ? normalized.slice(0, -5) : normalized;
}

function isLargeCapSymbol(symbol: string): boolean {
  const base = getBaseSymbol(symbol);
  return base === "BTC" || base === "ETH";
}

function isMajorAltSymbol(symbol: string): boolean {
  const base = getBaseSymbol(symbol);
  return MAJOR_ALT_SYMBOLS.has(base);
}

function getMinVolumeUsdForSymbol(symbol: string): number {
  if (isLargeCapSymbol(symbol)) {
    return MIN_VOLUME_USD;
  }

  if (isMajorAltSymbol(symbol)) {
    return MIN_VOLUME_USD_MAJOR_ALT;
  }

  return MIN_VOLUME_USD;
}

function getOrderBookSpreadLimitPct(symbol: string): number {
  if (isLargeCapSymbol(symbol)) {
    return ORDERBOOK_MAX_SPREAD_PCT_LARGE;
  }

  if (isMajorAltSymbol(symbol)) {
    return ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT;
  }

  return ORDERBOOK_MAX_SPREAD_PCT_ALT;
}

function getOrderBookMaxAgainstImbalance(symbol: string): number {
  if (isMajorAltSymbol(symbol) && !isLargeCapSymbol(symbol)) {
    return ORDERBOOK_MAX_AGAINST_IMBALANCE_MAJOR_ALT;
  }

  return ORDERBOOK_MAX_AGAINST_IMBALANCE;
}

function signalToDirection(signalType: string): "LONG" | "SHORT" | null {
  if (signalType.includes("LONG")) {
    return "LONG";
  }

  if (signalType.includes("SHORT")) {
    return "SHORT";
  }

  return null;
}

function resolveEntryTiming(signalType: string, item: Pick<TokenRsiResult, "close" | "levels" | "tradeContext">): EntryTiming | null {
  const direction = signalToDirection(signalType);
  if (!direction) {
    return null;
  }

  return classifyEntryTiming({
    direction,
    price: item.close,
    atr: item.tradeContext.atr,
    supportDistancePct: item.levels.supportDistancePct,
    resistanceDistancePct: item.levels.resistanceDistancePct,
    ema20: item.tradeContext.ema20
  });
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

// Shared perp-context cache — all callers within the same 4-second window share one
// network request, and a 429 from the upstream API triggers a 30-second backoff so we
// never hammer the rate limit.
let _perpCtxCache: Map<string, PerpAssetContext> | null = null;
let _perpCtxCacheAt = 0;
let _perpCtxInFlight: Promise<[unknown, unknown]> | null = null;
let _perpCtxBackoffUntil = 0;
const PERP_CTX_CACHE_TTL_MS = 4_000;
const PERP_CTX_BACKOFF_MS = 30_000;

async function getRawPerpContexts(): Promise<[unknown, unknown]> {
  const now = Date.now();

  if (now < _perpCtxBackoffUntil) {
    if (_perpCtxCache) {
      // Return an empty sentinel — callers will use the cached result map.
      return [null, null];
    }
    throw new Error("Hyperliquid API rate limited; backoff active");
  }

  if (_perpCtxInFlight) {
    return _perpCtxInFlight;
  }

  const client = await getClient();
  _perpCtxInFlight = client.info.perpetuals.getMetaAndAssetCtxs().catch((err: unknown) => {
    _perpCtxInFlight = null;
    const code = (err as { code?: number })?.code ?? 0;
    if (code === 429) {
      _perpCtxBackoffUntil = Date.now() + PERP_CTX_BACKOFF_MS;
      console.warn(
        `[hyperliquid-service] Rate limited (429) — backing off for ${PERP_CTX_BACKOFF_MS / 1000}s`
      );
    }
    throw err;
  }) as Promise<[unknown, unknown]>;

  const result = await _perpCtxInFlight;
  _perpCtxInFlight = null;
  return result;
}

export async function fetchPerpContexts(symbols: string[]): Promise<Map<string, PerpAssetContext>> {
  const normalizedSymbols = symbols
    .map((symbol) => normalizePerpSymbol(symbol))
    .filter((symbol) => symbol.length > 0);
  const wanted = new Set(normalizedSymbols);
  if (wanted.size === 0) {
    return new Map();
  }

  const now = Date.now();

  // Return cached result if it is fresh enough.
  if (_perpCtxCache && now - _perpCtxCacheAt < PERP_CTX_CACHE_TTL_MS) {
    const cached = new Map<string, PerpAssetContext>();
    for (const sym of wanted) {
      const entry = _perpCtxCache.get(sym);
      if (entry) cached.set(sym, entry);
    }
    return cached;
  }

  let meta: unknown;
  let ctxs: unknown;
  try {
    [meta, ctxs] = await getRawPerpContexts();
  } catch (_err) {
    // On failure, serve stale cache if available so callers keep their last-known prices.
    if (_perpCtxCache) {
      const stale = new Map<string, PerpAssetContext>();
      for (const sym of wanted) {
        const entry = _perpCtxCache.get(sym);
        if (entry) stale.set(sym, entry);
      }
      return stale;
    }
    throw _err;
  }

  // Sentinel returned during backoff — reuse existing cache.
  if (meta === null) {
    const fallback = new Map<string, PerpAssetContext>();
    if (_perpCtxCache) {
      for (const sym of wanted) {
        const entry = _perpCtxCache.get(sym);
        if (entry) fallback.set(sym, entry);
      }
    }
    return fallback;
  }
  // Build the full universe cache so any symbol can be served without a new request.
  const fullCache = new Map<string, PerpAssetContext>();
  const universe: Array<{ name: string }> = (meta as any).universe;

  for (let i = 0; i < universe.length; i += 1) {
    const symbol = normalizePerpSymbol(universe[i]?.name ?? "");
    if (!symbol) continue;

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

    fullCache.set(symbol, {
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

  // Persist as the new cache before returning.
  _perpCtxCache = fullCache;
  _perpCtxCacheAt = Date.now();

  const result = new Map<string, PerpAssetContext>();
  for (const sym of wanted) {
    const entry = fullCache.get(sym);
    if (entry) result.set(sym, entry);
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

  const maxSpreadPct = getOrderBookSpreadLimitPct(symbol);
  const maxAgainstImbalance = getOrderBookMaxAgainstImbalance(symbol);
  const minDepthUsd = ORDERBOOK_REFERENCE_NOTIONAL_USD * ORDERBOOK_MIN_DEPTH_MULTIPLIER;

  const spreadPass = read.spreadPct <= maxSpreadPct;
  const depthPass = read.combinedDepthUsd >= minDepthUsd;
  const imbalancePass =
    direction === "LONG"
      ? read.imbalance >= -maxAgainstImbalance
      : read.imbalance <= maxAgainstImbalance;

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
  const now = Date.now();
  if (_assetListCache && now - _assetListCacheAt < ASSET_LIST_CACHE_TTL_MS) {
    const list = market === "perp" ? _assetListCache.perp : _assetListCache.spot;
    if (!query) {
      return list;
    }

    const q = query.trim().toUpperCase();
    return list.filter((symbol) => symbol.toUpperCase().includes(q));
  }

  let assets: { perp: string[]; spot: string[] };
  try {
    assets = await withRetry(
      () => client.info.getAllAssets(),
      "fetch asset list",
      SCAN_FETCH_MAX_ATTEMPTS,
      SCAN_FETCH_BACKOFF_MS
    ) as { perp: string[]; spot: string[] };
    _assetListCache = {
      perp: [...(assets.perp ?? [])],
      spot: [...(assets.spot ?? [])]
    };
    _assetListCacheAt = Date.now();
  } catch (error) {
    if (_assetListCache) {
      console.warn("[scan:rsi] using stale asset list cache due to fetch failure");
      assets = _assetListCache;
    } else {
      throw error;
    }
  }

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
  interval: "1d" | "12h" | "4h" | "1h" | "15m",
  lookbackCandles: number
): Promise<TimeframeRsi | null> {
  const intervalsMs: Record<string, number> = {
    "1d": 86_400_000,
    "12h": 43_200_000,
    "4h": 14_400_000,
    "1h": 3_600_000,
    "15m": 900_000
  };

  const intervalMs = intervalsMs[interval];
  const now = Date.now();
  const start = now - intervalMs * (lookbackCandles + 30);

  const candles = await withRetry(
    () => client.info.getCandleSnapshot(symbol, interval, start, now),
    `${symbol} ${interval} candles`,
    SCAN_FETCH_MAX_ATTEMPTS,
    SCAN_FETCH_BACKOFF_MS
  );
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

  const stochRsi = calculateStochasticRsi(closes, 14, 14, 3, 3);
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
  const now = Date.now();
  if (_volumeCache && now - _volumeCacheAt < VOLUME_CACHE_TTL_MS) {
    return new Map(_volumeCache);
  }

  let meta: unknown;
  let ctxs: unknown;
  try {
    [meta, ctxs] = await withRetry(
      () => client.info.perpetuals.getMetaAndAssetCtxs(),
      "fetch 24h volumes",
      SCAN_FETCH_MAX_ATTEMPTS,
      SCAN_FETCH_BACKOFF_MS
    );
  } catch (error) {
    if (_volumeCache && _volumeCache.size > 0) {
      console.warn("[scan:rsi] using stale volume cache due to fetch failure");
      return new Map(_volumeCache);
    }

    throw error;
  }

  const volumeMap = new Map<string, number>();
  const universe: Array<{ name: string }> = (meta as any).universe;
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name;
    const symbol = market === "perp" ? normalizePerpSymbol(name) : name;
    const dayNtlVlm = Number((ctxs as any)[i]?.dayNtlVlm ?? 0);
    if (Number.isFinite(dayNtlVlm) && dayNtlVlm > 0) {
      volumeMap.set(symbol, dayNtlVlm);
      if (market === "perp") {
        volumeMap.set(name, dayNtlVlm);
      }
    }
  }

  _volumeCache = new Map(volumeMap);
  _volumeCacheAt = Date.now();

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

function calculateAtrFromCandles(candles: any[], period: number = 14): number {
  const highs = candles
    .map((candle) => Number(candle?.h ?? NaN))
    .filter((value) => Number.isFinite(value) && value > 0);
  const lows = candles
    .map((candle) => Number(candle?.l ?? NaN))
    .filter((value) => Number.isFinite(value) && value > 0);
  const closes = candles
    .map((candle) => Number(candle?.c ?? NaN))
    .filter((value) => Number.isFinite(value) && value > 0);

  const atr = calculateLatestAtr(highs, lows, closes, period);
  return atr != null && Number.isFinite(atr) && atr > 0 ? atr : 0;
}

function calculateTrendPersistenceFromCandles(candles: any[], lookback: number = 6): number {
  const closes = candles
    .map((candle) => Number(candle?.c ?? NaN))
    .filter((value) => Number.isFinite(value) && value > 0);
  const stochSeries = calculateStochasticRsiSeries(closes);
  if (stochSeries.length === 0) {
    return 0;
  }

  const window = stochSeries.slice(-Math.max(lookback, 3));
  let upCount = 0;
  let downCount = 0;
  for (const point of window) {
    if (point.k > point.d) upCount += 1;
    if (point.k < point.d) downCount += 1;
  }

  return Math.max(upCount, downCount);
}

function percentileRank(value: number, samples: number[]): number {
  if (!Number.isFinite(value) || samples.length === 0) {
    return 0;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  let belowOrEqual = 0;
  for (const sample of sorted) {
    if (sample <= value) {
      belowOrEqual += 1;
    }
  }

  return Number(((belowOrEqual / sorted.length) * 100).toFixed(2));
}

export type ScanResult = {
  analyzedAt: string;
  params: ScanParams;
  results: TokenRsiResult[];
  skipped: SkippedToken[];
};

export async function scanRsi(params: ScanParams): Promise<ScanResult> {
  const client = await getClient();
  const explicitSymbols = Array.isArray(params.symbols)
    ? params.symbols
        .map((symbol) => symbol.trim())
        .filter((symbol) => symbol.length > 0)
    : [];
  const matching = explicitSymbols.length > 0
    ? Array.from(new Set(explicitSymbols))
    : await searchTokens(params.query, params.market);
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

  const includeSymbols = Array.isArray(params.includeSymbols)
    ? params.includeSymbols
        .map((symbol) => symbol.trim())
        .filter((symbol) => symbol.length > 0)
    : [];

  for (const symbol of includeSymbols) {
    if (volumeBySymbol.has(symbol)) {
      continue;
    }

    const vol = allVolumes.get(symbol);
    if (vol != null) {
      volumeBySymbol.set(symbol, vol);
      continue;
    }

    skipped.push({
      symbol,
      reason: "FETCH_ERROR",
      details: "Included symbol has no 24h volume data available"
    });
  }

  const topByVolume = matching
    .filter((symbol) => volumeBySymbol.has(symbol))
    .sort((left, right) => {
      const leftVolume = volumeBySymbol.get(left) ?? 0;
      const rightVolume = volumeBySymbol.get(right) ?? 0;
      return rightVolume - leftVolume;
    })
    .slice(0, params.limitTokens);

  const symbolsToScan = explicitSymbols.length > 0
    ? matching.filter((symbol) => volumeBySymbol.has(symbol))
    : [...topByVolume];
  for (const symbol of includeSymbols) {
    if (!symbolsToScan.includes(symbol) && volumeBySymbol.has(symbol)) {
      symbolsToScan.push(symbol);
    }
  }

  const settled: Array<PromiseSettledResult<{ result?: TokenRsiResult; skipped?: SkippedToken }>> = [];

  for (let startIndex = 0; startIndex < symbolsToScan.length; startIndex += SCAN_SYMBOL_CONCURRENCY) {
    const chunk = symbolsToScan.slice(startIndex, startIndex + SCAN_SYMBOL_CONCURRENCY);
    const chunkSettled = await Promise.allSettled(
      chunk.map(async (symbol) => {
      const lookbackCandles = 200;
      const now = Date.now();
      const oneDayMs = 86_400_000;
      const tweleveHourMs = 43_200_000;
      const fourHourMs = 14_400_000;
      const oneHourMs = 3_600_000;
      const volume24h = volumeBySymbol.get(symbol);
      if (volume24h == null) {
        throw new Error("Missing ranked volume for symbol");
      }

      const [daily, twelveh, macro, intermediary, microTrigger, fourHourCandles, supportWindowCandles] = await Promise.all([
        fetchAndCalculateTimeframeRsi(client, symbol, "1d", lookbackCandles),
        fetchAndCalculateTimeframeRsi(client, symbol, "12h", lookbackCandles),
        fetchAndCalculateTimeframeRsi(client, symbol, "4h", lookbackCandles),
        fetchAndCalculateTimeframeRsi(client, symbol, "1h", lookbackCandles),
        fetchAndCalculateTimeframeRsi(client, symbol, "15m", lookbackCandles),
        withRetry(
          () => client.info.getCandleSnapshot(symbol, "4h", now - fourHourMs * (200 + 30), now),
          `${symbol} 4h support window`,
          SCAN_FETCH_MAX_ATTEMPTS,
          SCAN_FETCH_BACKOFF_MS
        ),
        withRetry(
          () => client.info.getCandleSnapshot(symbol, "1h", now - oneHourMs * (48 + 8), now),
          `${symbol} 1h support window`,
          SCAN_FETCH_MAX_ATTEMPTS,
          SCAN_FETCH_BACKOFF_MS
        )
      ]);

      if (!macro || !intermediary || !microTrigger) {
        return {
          skipped: {
            symbol,
            reason: "INSUFFICIENT_CANDLES" as const,
            details: `Could not fetch all three key timeframes (macro: ${macro ? "ok" : "fail"}, intermediary: ${intermediary ? "ok" : "fail"}, micro: ${microTrigger ? "ok" : "fail"})`
          } as SkippedToken
        };
      }

      const baseSignal = determineSignal(macro, intermediary, microTrigger, {
        daily: daily ?? null,
        twelveh: twelveh ?? null
      });
      const dailyReversalBias = evaluateDailyReversalBias(daily ?? null);
      const close = fourHourCandles.length > 0 ? Number(fourHourCandles.at(-1)?.c ?? 0) : 0;
      const levelsCalc = calculateSupportResistance(supportWindowCandles.slice(-48));
      const volatilityPct = calculateVolatilityPctFromCandles(supportWindowCandles, VOLATILITY_LOOKBACK_CANDLES);
      const passedVolatility = volatilityPct >= MIN_VOLATILITY_PCT;
      const minVolumeUsd = getMinVolumeUsdForSymbol(symbol);
      const passedLiquidity = volume24h >= minVolumeUsd;
      const oneHourWindow = supportWindowCandles.slice(-2);
      const latestOneHour = oneHourWindow.at(-1);
      const previousOneHour = oneHourWindow.at(-2);
      const latestHigh = Number(latestOneHour?.h ?? NaN);
      const latestLow = Number(latestOneHour?.l ?? NaN);
      const latestOpen = Number(latestOneHour?.o ?? NaN);
      const latestCloseOneHour = Number(latestOneHour?.c ?? NaN);
      const previousHigh = Number(previousOneHour?.h ?? NaN);
      const previousLow = Number(previousOneHour?.l ?? NaN);
      const previousClose = Number(previousOneHour?.c ?? NaN);

      const highs1h = supportWindowCandles.slice(-12).map((candle) => Number(candle?.h ?? NaN));
      const lows1h = supportWindowCandles.slice(-12).map((candle) => Number(candle?.l ?? NaN));

      // Trendline pattern detection uses a wider 1h window for reliable pivot finding.
      const trendlineHighs = supportWindowCandles.slice(-40).map((candle) => Number(candle?.h ?? NaN));
      const trendlineLows = supportWindowCandles.slice(-40).map((candle) => Number(candle?.l ?? NaN));
      const trendlineBreakoutResult = detectDescendingTrendlineBreakout(trendlineHighs, close);
      const trendlineBreakdownResult = detectAscendingTrendlineBreakdown(trendlineLows, close);
      const trendlineBreakout = trendlineBreakoutResult.detected;
      const trendlineBreakdown = trendlineBreakdownResult.detected;
      const lowerHighOn1h =
        Number.isFinite(latestHigh) && Number.isFinite(previousHigh) && latestHigh < previousHigh;
      const higherLowOn1h =
        Number.isFinite(latestLow) && Number.isFinite(previousLow) && latestLow > previousLow;
      const structureBreakShort =
        Number.isFinite(latestLow) && Number.isFinite(previousLow) && latestLow < previousLow;
      const structureBreakLong =
        Number.isFinite(latestHigh) && Number.isFinite(previousHigh) && latestHigh > previousHigh;

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
      
      // Check actual price structure for breakout vs breakdown
      const highs1h = supportWindowCandles.map((c) => c.h).filter((h) => Number.isFinite(h));
      const lows1h = supportWindowCandles.map((c) => c.l).filter((l) => Number.isFinite(l));
      const isBreakingUp = microTrigger.trend.direction === "UP" && highs1h.length >= 3 && highs1h[highs1h.length - 1] > Math.max(...highs1h.slice(0, -1));
      const isBreakingDown = microTrigger.trend.direction === "DOWN" && lows1h.length >= 3 && lows1h[lows1h.length - 1] < Math.min(...lows1h.slice(0, -1));
      
      const structureState = Math.max(alignLongCount, alignShortCount) >= 2
        ? "TRENDING"
        : isBreakingUp
          ? "BREAKOUT"
          : isBreakingDown
            ? "BREAKDOWN"
            : "CHOP";

      const microWindowCandles = await withRetry(
        () => client.info.getCandleSnapshot(symbol, "15m", now - 900_000 * (lookbackCandles + 30), now),
        `${symbol} 15m micro window`,
        SCAN_FETCH_MAX_ATTEMPTS,
        SCAN_FETCH_BACKOFF_MS
      );
      const microCloses = microWindowCandles
        .map((candle) => Number(candle.c))
        .filter((value) => Number.isFinite(value) && value > 0);
      const ema20Current = calculateLatestEma(microCloses, MICRO_TREND_EMA_PERIOD) ?? close;
      const ema20Previous = calculateLatestEma(microCloses.slice(0, -1), MICRO_TREND_EMA_PERIOD) ?? ema20Current;
      const emaSlope = Number((ema20Current - ema20Previous).toFixed(8));
      const microTrendLongOk = evaluateMicroTrend(
        { price: close, ema20: ema20Current, prevEma20: ema20Previous },
        "STRONG LONG"
      );
      const microTrendShortOk = evaluateMicroTrend(
        { price: close, ema20: ema20Current, prevEma20: ema20Previous },
        "STRONG SHORT"
      );

      const atr1h = calculateAtrFromCandles(supportWindowCandles, 14);
      const atr4h = calculateAtrFromCandles(fourHourCandles, 14);
      const trendPersistence4h = calculateTrendPersistenceFromCandles(fourHourCandles, 6);
      const recentHigh1h = supportWindowCandles
        .slice(-12)
        .reduce((max, candle) => Math.max(max, Number(candle?.h ?? 0)), 0);
      const recentLow1hRaw = supportWindowCandles
        .slice(-12)
        .reduce((min, candle) => Math.min(min, Number(candle?.l ?? Number.POSITIVE_INFINITY)), Number.POSITIVE_INFINITY);
      const recentLow1h = Number.isFinite(recentLow1hRaw) ? recentLow1hRaw : 0;
      const regimeInfo = detectRegime({
        price: close,
        atr1h,
        atr4h,
        recentHigh1h,
        recentLow1h,
        volatilityPct,
        trendPersistence: trendPersistence4h
      });

      let signal = baseSignal;

      if (signal === "REVERSAL SHORT") {
        const strong4hTrend = macro.trend.direction === "UP" && trendPersistence4h >= 3;
        if (strong4hTrend && !structureBreakShort && !trendlineBreakdown) {
          signal = "NO SIGNAL";
        }
        if (signal === "REVERSAL SHORT" && !lowerHighOn1h && !trendlineBreakdown) {
          signal = "NO SIGNAL";
        }
      }

      if (signal === "REVERSAL LONG") {
        const strong4hTrend = macro.trend.direction === "DOWN" && trendPersistence4h >= 3;
        if (strong4hTrend && !structureBreakLong && !trendlineBreakout) {
          signal = "NO SIGNAL";
        }
        if (signal === "REVERSAL LONG" && !higherLowOn1h && !trendlineBreakout) {
          signal = "NO SIGNAL";
        }
      }

      let filteredSignal = signal;
      const structureOk = filteredSignal === "NO SIGNAL"
        ? true
        : evaluateStructure({ highs1h, lows1h }, filteredSignal)
          || (filteredSignal.includes("LONG") ? trendlineBreakout : false)
          || (filteredSignal.includes("SHORT") ? trendlineBreakdown : false);
      const emaOk = filteredSignal === "NO SIGNAL"
        ? true
        : evaluateMicroTrend({ price: close, ema20: ema20Current, prevEma20: ema20Previous }, filteredSignal);
      const srOk = filteredSignal === "NO SIGNAL"
        ? true
        : evaluateSupportResistance(
            {
              price: close,
              high1h: Number.isFinite(latestHigh) ? latestHigh : close,
              low1h: Number.isFinite(latestLow) ? latestLow : close
            },
            filteredSignal
          );

      const directionalSignal = filteredSignal.endsWith("LONG") || filteredSignal.endsWith("SHORT");
      const trendlineAligned =
        (filteredSignal.includes("LONG") && trendlineBreakout) ||
        (filteredSignal.includes("SHORT") && trendlineBreakdown);

      if (directionalSignal) {
        const failCount = Number(!structureOk) + Number(!emaOk) + Number(!srOk);
        const continuationSignal = filteredSignal.startsWith("CONTINUATION");
        const weakStructureMomentum = !structureOk && !emaOk;
        const strictSrMiss = !srOk && !trendlineAligned;

        if (weakStructureMomentum || failCount >= 3 || (continuationSignal && strictSrMiss)) {
          filteredSignal = "NO SIGNAL";
        }
      }

      // If 1D shows extreme reversal opposite to the final direction, neutralize it.
      let direction: "LONG" | "SHORT" | null = filteredSignal.includes("LONG")
        ? "LONG"
        : filteredSignal.includes("SHORT")
          ? "SHORT"
          : null;
      if (dailyReversalBias === "SHORT" && direction === "LONG") {
        direction = null;
      } else if (dailyReversalBias === "LONG" && direction === "SHORT") {
        direction = null;
      }

      const originalDirectional = filteredSignal.endsWith("LONG") || filteredSignal.endsWith("SHORT");
      const passedStructure = !originalDirectional
        ? true
        : structureOk;
      const passedMicroTrend = !originalDirectional
        ? true
        : emaOk;
      const effectiveStructureState = filteredSignal.startsWith("REVERSAL") ? "REVERSAL" : structureState;

        const guarded = applySupportFloorGuard(
          filteredSignal,
          close,
          levelsCalc.localSupport,
          levelsCalc.localResistance,
          0.003
        );
      const adjustedSignalBadge = getSignalBadge(guarded.adjustedSignal);
        const signalCategory = getSignalCategory(guarded.adjustedSignal);

      const result: TokenRsiResult = {
        symbol,
        market: params.market,
        entryTiming: resolveEntryTiming(guarded.adjustedSignal, {
          close,
          levels: {
            localSupport: levelsCalc.localSupport,
            localResistance: levelsCalc.localResistance,
            nearSupportFloor: guarded.nearSupportFloor,
            nearResistance: guarded.nearResistance,
            supportDistancePct: guarded.supportDistancePct,
            resistanceDistancePct: guarded.resistanceDistancePct
          },
          tradeContext: {
            volatilityPct,
            volume24h,
            passedVolatility,
            passedLiquidity,
            passedOrderBook: true,
            orderBookSpreadPct: 0,
            orderBookCombinedDepthUsd: 0,
            orderBookImbalance: 0,
            orderBookReferenceNotionalUsd: 0,
            orderBookDepthBps: 0,
            passedStructure,
            passedMicroTrend,
            ema20: ema20Current,
            emaSlope,
            atr1h,
            atr4h,
            atr: atr1h,
            trendPersistence4h,
            regime: regimeInfo.regime,
            atrExpansion: regimeInfo.atrExpansion,
            rangeCompression: regimeInfo.rangeCompression,
            volatilityPercentile: 0,
            liquidityPercentile: 0,
            higherTimeframeTrend: oneHourTrendDirection,
            structureState: effectiveStructureState,
            trendlineBreakout,
            trendlineBreakdown
          }
        }),
        rsi: intermediary.rsi,
        close,
        volume24h,
        volatilityPct,
        tradeContext: {
          volatilityPct,
          volume24h,
          passedVolatility,
          passedLiquidity,
          passedOrderBook: true,
          orderBookSpreadPct: 0,
          orderBookCombinedDepthUsd: 0,
          orderBookImbalance: 0,
          orderBookReferenceNotionalUsd: 0,
          orderBookDepthBps: 0,
          passedStructure,
          passedMicroTrend,
          ema20: ema20Current,
          emaSlope,
          atr1h,
          atr4h,
          atr: atr1h,
          trendPersistence4h,
          regime: regimeInfo.regime,
          atrExpansion: regimeInfo.atrExpansion,
          rangeCompression: regimeInfo.rangeCompression,
          volatilityPercentile: 0,
          liquidityPercentile: 0,
          higherTimeframeTrend: oneHourTrendDirection,
          structureState: effectiveStructureState,
          trendlineBreakout,
          trendlineBreakdown
        },
        confluence: {
          score: 0,
          bias: null,
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
          daily: daily ?? null,
          twelveh: twelveh ?? null,
          macro,
          intermediary,
          microTrigger
        }
      };

      return { result };
    })
    );

    settled.push(...chunkSettled);

    if (SCAN_CHUNK_DELAY_MS > 0 && startIndex + SCAN_SYMBOL_CONCURRENCY < symbolsToScan.length) {
      await sleep(SCAN_CHUNK_DELAY_MS);
    }
  }

  const results: TokenRsiResult[] = [];

  for (let i = 0; i < settled.length; i += 1) {
    const item = settled[i];
    const symbol = symbolsToScan[i];

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

    if (item.value.skipped) {
      skipped.push(item.value.skipped);
    }
  }

  const averageMarketVolume =
    results.length > 0 ? results.reduce((sum, item) => sum + item.volume24h, 0) / results.length : 0;

  const volatilitySamples = results.map((item) => item.volatilityPct).filter((value) => Number.isFinite(value) && value >= 0);
  const liquiditySamples = results.map((item) => item.volume24h).filter((value) => Number.isFinite(value) && value >= 0);

  const scoredResults = results.map((item) => ({
    ...item,
    tradeContext: {
      ...item.tradeContext,
      volatilityPercentile: percentileRank(item.volatilityPct, volatilitySamples),
      liquidityPercentile: percentileRank(item.volume24h, liquiditySamples)
    },
    confluence: computeConfluenceScore({
      daily: item.timeframes.daily,
      twelveh: item.timeframes.twelveh,
      macro: item.timeframes.macro,
      intermediary: item.timeframes.intermediary,
      microTrigger: item.timeframes.microTrigger,
      signalType: item.signal.type,
      volume24h: item.volume24h,
      averageMarketVolume,
      volatilityPct: item.volatilityPct,
      trendlineBreakout: item.tradeContext.trendlineBreakout,
      trendlineBreakdown: item.tradeContext.trendlineBreakdown
    })
  })).map((item) => {
    const passedVolatility = item.volatilityPct >= MIN_VOLATILITY_PCT;
    const passedLiquidity = item.volume24h >= getMinVolumeUsdForSymbol(item.symbol);

    const tradeContext = {
      ...item.tradeContext,
      passedVolatility,
      passedLiquidity
    };

    let adjustedSignal = item.signal.type;
    if (
      adjustedSignal.startsWith("NO SIGNAL") &&
      item.confluence.bias &&
      item.confluence.score >= 4 &&
      passedVolatility &&
      passedLiquidity
    ) {
      adjustedSignal = item.confluence.bias === "LONG"
        ? "REVERSAL LONG"
        : "REVERSAL SHORT";
    }

    return {
      ...item,
      tradeContext,
      signal: getSignalBadge(adjustedSignal),
      signalCategory: getSignalCategory(adjustedSignal),
      entryTiming: resolveEntryTiming(adjustedSignal, {
        close: item.close,
        levels: item.levels,
        tradeContext
      })
    };
  });

  return {
    analyzedAt: new Date().toISOString(),
    params,
    results: scoredResults,
    skipped
  };
}
