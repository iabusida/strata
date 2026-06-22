import "./env.js";
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
import { detectRegime } from "./regime-engine.js";
import { evaluateStructure } from "./structure-engine.js";
import { evaluateMicroTrend } from "./ema-engine.js";
import { evaluateSupportResistance } from "./sr-engine.js";
import { detectDescendingTrendlineBreakout, detectAscendingTrendlineBreakdown } from "./trendline-engine.js";
import { classifyEntryTiming, type EntryTiming } from "./entry-timing.js";
import type { LatestOhlc, OrderBookExecutionRead, PerpAssetContext, ScanResult } from "./market-data-service.js";

type OkxInstrumentRow = {
  instId?: string;
  instType?: string;
  ctType?: string;
  ctVal?: string;
  ctValCcy?: string;
  settleCcy?: string;
  state?: string;
};

type OkxTickerRow = {
  instId?: string;
  last?: string;
  askPx?: string;
  bidPx?: string;
  vol24h?: string;
  volCcy24h?: string;
};

type OkxOpenInterestRow = {
  instId?: string;
  oi?: string;
  oiCcy?: string;
  oiUsd?: string;
};

type OkxFundingRow = {
  fundingRate?: string;
};

type OkxMarkPriceRow = {
  instId?: string;
  markPx?: string;
};

type OkxBookRow = {
  asks?: string[][];
  bids?: string[][];
};

type OkxInstrumentMeta = {
  externalSymbol: string;
  instId: string;
  ctVal: number;
};

type NormalizedCandle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

const OKX_API_BASE_URL = String(process.env.OKX_API_BASE_URL ?? "https://www.okx.com").trim().replace(/\/$/, "");

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
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("timeout") ||
    message.includes("fetch")
  );
}

async function withRetry<T>(operation: () => Promise<T>, context: string, maxAttempts: number, baseDelayMs: number): Promise<T> {
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
      console.warn(`[scan:rsi:okx] retry ${attempt}/${maxAttempts - 1} for ${context} in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  throw new Error(`${context}: ${extractErrorMessage(lastError)}`);
}

async function okxGet<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const url = new URL(path, OKX_API_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`OKX request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as { code?: string; msg?: string; data?: T };
  if (payload.code !== "0") {
    throw new Error(`OKX payload error: ${payload.msg ?? "unknown error"}`);
  }

  return (payload.data ?? []) as T;
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
const SCAN_SYMBOL_CONCURRENCY = Math.max(1, Math.trunc(resolveNumberEnv("OKX_SCAN_SYMBOL_CONCURRENCY", 1)));
const SCAN_CHUNK_DELAY_MS = Math.max(0, Math.trunc(resolveNumberEnv("SCAN_CHUNK_DELAY_MS", 120)));
const VOLUME_CACHE_TTL_MS = Math.max(5_000, Math.trunc(resolveNumberEnv("VOLUME_CACHE_TTL_MS", 60_000)));
const ASSET_LIST_CACHE_TTL_MS = Math.max(10_000, Math.trunc(resolveNumberEnv("ASSET_LIST_CACHE_TTL_MS", 300_000)));
const FUNDING_CACHE_TTL_MS = Math.max(10_000, Math.trunc(resolveNumberEnv("OKX_FUNDING_CACHE_TTL_MS", 60_000)));
const INSTRUMENT_CACHE_TTL_MS = Math.max(60_000, Math.trunc(resolveNumberEnv("OKX_INSTRUMENT_CACHE_TTL_MS", 300_000)));

let _volumeCache: Map<string, number> | null = null;
let _volumeCacheAt = 0;
let _assetListCache: { perp: string[]; spot: string[] } | null = null;
let _assetListCacheAt = 0;
let _perpInstrumentCache: Map<string, OkxInstrumentMeta> | null = null;
let _perpInstrumentByInstId: Map<string, OkxInstrumentMeta> | null = null;
let _perpInstrumentCacheAt = 0;
let _fundingCache = new Map<string, { rate: number; at: number }>();
let _perpCtxCache: Map<string, PerpAssetContext> | null = null;
let _perpCtxCacheAt = 0;

const PERP_CTX_CACHE_TTL_MS = 4_000;
const OKX_BAR_MAP: Record<string, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "12h": "12H",
  "1d": "1D"
};

function normalizePerpSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (!upper) {
    return upper;
  }

  if (upper.endsWith("-USDT-SWAP")) {
    return `${upper.slice(0, -10)}-PERP`;
  }

  return upper.endsWith("-PERP") ? upper : `${upper}-PERP`;
}

function getBaseSymbol(symbol: string): string {
  const normalized = normalizePerpSymbol(symbol);
  return normalized.endsWith("-PERP") ? normalized.slice(0, -5) : normalized;
}

function toOkxPerpInstId(symbol: string): string {
  return `${getBaseSymbol(symbol)}-USDT-SWAP`;
}

function toExternalPerpSymbol(instId: string): string {
  const upper = instId.trim().toUpperCase();
  if (upper.endsWith("-USDT-SWAP")) {
    return `${upper.slice(0, -10)}-PERP`;
  }

  return upper;
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

function parseNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isOkxMissingInstrumentError(error: unknown): boolean {
  const message = extractErrorMessage(error).toLowerCase();
  return message.includes("instrument id") && message.includes("doesn't exist");
}

function parseCandleRow(row: unknown): NormalizedCandle | null {
  if (!Array.isArray(row) || row.length < 6) {
    return null;
  }

  const t = parseNumber(row[0]);
  const o = parseNumber(row[1]);
  const h = parseNumber(row[2]);
  const l = parseNumber(row[3]);
  const c = parseNumber(row[4]);
  const v = parseNumber(row[7] ?? row[6] ?? row[5]);
  if (![t, o, h, l, c].every((item) => Number.isFinite(item) && item > 0)) {
    return null;
  }

  return { t, o, h, l, c, v: Number.isFinite(v) && v >= 0 ? v : 0 };
}

async function getPerpInstruments(): Promise<{ bySymbol: Map<string, OkxInstrumentMeta>; byInstId: Map<string, OkxInstrumentMeta> }> {
  const now = Date.now();
  if (_perpInstrumentCache && _perpInstrumentByInstId && now - _perpInstrumentCacheAt < INSTRUMENT_CACHE_TTL_MS) {
    return { bySymbol: _perpInstrumentCache, byInstId: _perpInstrumentByInstId };
  }

  const rows = await withRetry(
    () => okxGet<OkxInstrumentRow[]>("/api/v5/public/instruments", { instType: "SWAP" }),
    "fetch OKX swap instruments",
    SCAN_FETCH_MAX_ATTEMPTS,
    SCAN_FETCH_BACKOFF_MS
  );

  const bySymbol = new Map<string, OkxInstrumentMeta>();
  const byInstId = new Map<string, OkxInstrumentMeta>();
  for (const row of rows) {
    const instId = String(row.instId ?? "").trim().toUpperCase();
    if (!instId.endsWith("-USDT-SWAP")) {
      continue;
    }
    if (String(row.state ?? "").toLowerCase() !== "live") {
      continue;
    }
    if (String(row.ctType ?? "").toLowerCase() !== "linear") {
      continue;
    }

    const meta: OkxInstrumentMeta = {
      externalSymbol: toExternalPerpSymbol(instId),
      instId,
      ctVal: Math.max(0, parseNumber(row.ctVal))
    };
    bySymbol.set(meta.externalSymbol, meta);
    byInstId.set(instId, meta);
  }

  _perpInstrumentCache = bySymbol;
  _perpInstrumentByInstId = byInstId;
  _perpInstrumentCacheAt = Date.now();
  return { bySymbol, byInstId };
}

async function fetchSpotSymbols(): Promise<string[]> {
  const rows = await withRetry(
    () => okxGet<OkxInstrumentRow[]>("/api/v5/public/instruments", { instType: "SPOT" }),
    "fetch OKX spot instruments",
    SCAN_FETCH_MAX_ATTEMPTS,
    SCAN_FETCH_BACKOFF_MS
  );

  return rows
    .map((row) => String(row.instId ?? "").trim().toUpperCase())
    .filter((instId) => instId.endsWith("-USDT"));
}

async function fetchCandlesByInstId(instId: string, interval: keyof typeof OKX_BAR_MAP, count: number): Promise<NormalizedCandle[]> {
  const bar = OKX_BAR_MAP[interval];
  const dedup = new Map<number, NormalizedCandle>();
  let cursor: string | undefined;

  while (dedup.size < count) {
    const limit = String(Math.min(100, Math.max(10, count - dedup.size + 5)));
    const rows = await withRetry(
      () => okxGet<unknown[]>("/api/v5/market/history-candles", {
        instId,
        bar,
        limit,
        after: cursor
      }),
      `${instId} ${interval} candles`,
      SCAN_FETCH_MAX_ATTEMPTS,
      SCAN_FETCH_BACKOFF_MS
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      break;
    }

    const parsed = rows
      .map((row) => parseCandleRow(row))
      .filter((row): row is NormalizedCandle => row != null)
      .sort((left, right) => left.t - right.t);

    if (parsed.length === 0) {
      break;
    }

    for (const candle of parsed) {
      dedup.set(candle.t, candle);
    }

    const oldestTs = parsed[0]?.t;
    if (!Number.isFinite(oldestTs) || String(oldestTs) === cursor) {
      break;
    }

    cursor = String(oldestTs);
    if (rows.length < Number(limit)) {
      break;
    }
  }

  return Array.from(dedup.values()).sort((left, right) => left.t - right.t).slice(-count);
}

async function fetchPerpFundingRate(instId: string): Promise<number> {
  const cached = _fundingCache.get(instId);
  if (cached && Date.now() - cached.at < FUNDING_CACHE_TTL_MS) {
    return cached.rate;
  }

  const rows = await withRetry(
    () => okxGet<OkxFundingRow[]>("/api/v5/public/funding-rate", { instId }),
    `${instId} funding rate`,
    SCAN_FETCH_MAX_ATTEMPTS,
    SCAN_FETCH_BACKOFF_MS
  );

  const rate = parseNumber(rows[0]?.fundingRate);
  _fundingCache.set(instId, { rate, at: Date.now() });
  return rate;
}

function calculateVolumeUsdFromTicker(ticker: OkxTickerRow, instrument: OkxInstrumentMeta | undefined): number {
  const last = parseNumber(ticker.last);
  const volCcy24h = parseNumber(ticker.volCcy24h);
  const vol24h = parseNumber(ticker.vol24h);

  if (volCcy24h > 0 && last > 0) {
    return Number((volCcy24h * last).toFixed(2));
  }

  const ctVal = instrument?.ctVal ?? 0;
  if (vol24h > 0 && ctVal > 0 && last > 0) {
    return Number((vol24h * ctVal * last).toFixed(2));
  }

  return 0;
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

export async function fetchLatestOhlc(symbol: string, interval: "1m" | "5m" | "15m" | "1h" | "4h" = "5m"): Promise<LatestOhlc | null> {
  let candles: NormalizedCandle[];
  try {
    candles = await fetchCandlesByInstId(toOkxPerpInstId(symbol), interval, 4);
  } catch (error) {
    if (isOkxMissingInstrumentError(error)) {
      return null;
    }

    throw error;
  }
  const latest = candles.at(-1);
  if (!latest) {
    return null;
  }

  return {
    open: latest.o,
    high: latest.h,
    low: latest.l,
    close: latest.c,
    time: latest.t
  };
}

export async function fetchPerpContexts(symbols: string[]): Promise<Map<string, PerpAssetContext>> {
  const normalizedSymbols = symbols.map((symbol) => normalizePerpSymbol(symbol)).filter((symbol) => symbol.length > 0);
  const wanted = new Set(normalizedSymbols);
  if (wanted.size === 0) {
    return new Map();
  }

  const now = Date.now();
  if (_perpCtxCache && now - _perpCtxCacheAt < PERP_CTX_CACHE_TTL_MS) {
    const cached = new Map<string, PerpAssetContext>();
    for (const symbol of wanted) {
      const entry = _perpCtxCache.get(symbol);
      if (entry) {
        cached.set(symbol, entry);
      }
    }
    return cached;
  }

  const [{ byInstId, bySymbol }, tickers, openInterests, marks] = await Promise.all([
    getPerpInstruments(),
    withRetry(
      () => okxGet<OkxTickerRow[]>("/api/v5/market/tickers", { instType: "SWAP" }),
      "fetch OKX swap tickers",
      SCAN_FETCH_MAX_ATTEMPTS,
      SCAN_FETCH_BACKOFF_MS
    ),
    withRetry(
      () => okxGet<OkxOpenInterestRow[]>("/api/v5/public/open-interest", { instType: "SWAP" }),
      "fetch OKX open interest",
      SCAN_FETCH_MAX_ATTEMPTS,
      SCAN_FETCH_BACKOFF_MS
    ),
    withRetry(
      () => okxGet<OkxMarkPriceRow[]>("/api/v5/public/mark-price", { instType: "SWAP" }),
      "fetch OKX mark prices",
      SCAN_FETCH_MAX_ATTEMPTS,
      SCAN_FETCH_BACKOFF_MS
    )
  ]);

  const tickerMap = new Map(tickers.map((row) => [String(row.instId ?? "").trim().toUpperCase(), row]));
  const oiMap = new Map(openInterests.map((row) => [String(row.instId ?? "").trim().toUpperCase(), row]));
  const markMap = new Map(marks.map((row) => [String(row.instId ?? "").trim().toUpperCase(), row]));

  const fundingEntries = await Promise.all(
    Array.from(wanted).map(async (symbol) => {
      const instrument = bySymbol.get(symbol);
      if (!instrument) {
        return [symbol, 0] as const;
      }
      try {
        return [symbol, await fetchPerpFundingRate(instrument.instId)] as const;
      } catch {
        return [symbol, 0] as const;
      }
    })
  );
  const fundingMap = new Map(fundingEntries);

  const fullCache = new Map<string, PerpAssetContext>();
  for (const [instId, instrument] of byInstId.entries()) {
    const ticker = tickerMap.get(instId);
    if (!ticker) {
      continue;
    }

    const oi = oiMap.get(instId);
    const mark = markMap.get(instId);
    const bid = parseNumber(ticker.bidPx);
    const ask = parseNumber(ticker.askPx);
    const midPrice = bid > 0 && ask > 0 ? Number((((bid + ask) / 2)).toFixed(6)) : parseNumber(ticker.last);
    const markPrice = parseNumber(mark?.markPx) || midPrice || parseNumber(ticker.last);
    const openInterest = parseNumber(oi?.oiCcy) || parseNumber(oi?.oi) * Math.max(0, instrument.ctVal);
    const openInterestUsd = parseNumber(oi?.oiUsd) || Number((openInterest * markPrice).toFixed(2));
    const dayNtlVolume = calculateVolumeUsdFromTicker(ticker, instrument);

    fullCache.set(instrument.externalSymbol, {
      symbol: instrument.externalSymbol,
      fundingRate: fundingMap.get(instrument.externalSymbol) ?? 0,
      markPrice,
      oraclePrice: markPrice,
      midPrice,
      openInterest,
      openInterestUsd,
      dayNtlVolume
    });
  }

  _perpCtxCache = fullCache;
  _perpCtxCacheAt = Date.now();

  const result = new Map<string, PerpAssetContext>();
  for (const symbol of wanted) {
    const entry = fullCache.get(symbol);
    if (entry) {
      result.set(symbol, entry);
    }
  }

  return result;
}

function sumDepthUsdWithinBps(levels: string[][] | undefined, markPrice: number, bps: number, contractValue: number): number {
  if (!levels || levels.length === 0 || !Number.isFinite(markPrice) || markPrice <= 0) {
    return 0;
  }

  const limitPct = bps / 10_000;
  let total = 0;
  for (const level of levels) {
    const px = parseNumber(level?.[0]);
    const sz = parseNumber(level?.[1]);
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(sz) || sz <= 0) {
      continue;
    }
    const distancePct = Math.abs(px - markPrice) / markPrice;
    if (distancePct <= limitPct) {
      total += contractValue > 0 ? px * sz * contractValue : px * sz;
    }
  }

  return Number(total.toFixed(2));
}

export async function fetchOrderBookExecutionRead(symbol: string): Promise<OrderBookExecutionRead | null> {
  const normalized = normalizePerpSymbol(symbol);
  if (!normalized) {
    return null;
  }

  const { bySymbol } = await getPerpInstruments();
  const instrument = bySymbol.get(normalized);
  if (!instrument) {
    return null;
  }

  const rows = await withRetry(
    () => okxGet<OkxBookRow[]>("/api/v5/market/books", { instId: instrument.instId, sz: "400" }),
    `${instrument.instId} order book`,
    SCAN_FETCH_MAX_ATTEMPTS,
    SCAN_FETCH_BACKOFF_MS
  );

  const book = rows[0];
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const bestBid = parseNumber(bids[0]?.[0]);
  const bestAsk = parseNumber(asks[0]?.[0]);
  if (!Number.isFinite(bestBid) || bestBid <= 0 || !Number.isFinite(bestAsk) || bestAsk <= 0 || bestAsk < bestBid) {
    return null;
  }

  const markPrice = Number((((bestBid + bestAsk) / 2)).toFixed(6));
  const spreadPct = Number((((bestAsk - bestBid) / markPrice) * 100).toFixed(5));
  const bidDepthUsd = sumDepthUsdWithinBps(bids, markPrice, ORDERBOOK_DEPTH_BPS, instrument.ctVal);
  const askDepthUsd = sumDepthUsdWithinBps(asks, markPrice, ORDERBOOK_DEPTH_BPS, instrument.ctVal);
  const combinedDepthUsd = Number((bidDepthUsd + askDepthUsd).toFixed(2));
  const imbalance = combinedDepthUsd > 0
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

export async function searchTokens(query: string | undefined, market: MarketType): Promise<string[]> {
  const now = Date.now();
  if (_assetListCache && now - _assetListCacheAt < ASSET_LIST_CACHE_TTL_MS) {
    const list = market === "perp" ? _assetListCache.perp : _assetListCache.spot;
    if (!query) {
      return list;
    }

    const q = query.trim().toUpperCase();
    return list.filter((symbol) => symbol.toUpperCase().includes(q));
  }

  const [{ bySymbol }, spot] = await Promise.all([getPerpInstruments(), fetchSpotSymbols()]);
  _assetListCache = {
    perp: [...bySymbol.keys()].sort(),
    spot: [...spot].sort()
  };
  _assetListCacheAt = Date.now();

  const list = market === "perp" ? _assetListCache.perp : _assetListCache.spot;
  if (!query) {
    return list;
  }

  const q = query.trim().toUpperCase();
  return list.filter((symbol) => symbol.toUpperCase().includes(q));
}

async function fetchAndCalculateTimeframeRsi(symbol: string, interval: "1d" | "12h" | "4h" | "1h" | "15m", lookbackCandles: number): Promise<TimeframeRsi | null> {
  const candles = await fetchCandlesByInstId(toOkxPerpInstId(symbol), interval, lookbackCandles + 30);
  const closes = candles.map((candle) => candle.c).filter((value) => Number.isFinite(value));
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

async function fetchAllVolumes24h(market: MarketType): Promise<Map<string, number>> {
  const now = Date.now();
  if (_volumeCache && now - _volumeCacheAt < VOLUME_CACHE_TTL_MS) {
    return new Map(_volumeCache);
  }

  const volumeMap = new Map<string, number>();

  if (market === "perp") {
    const [{ byInstId }, tickers] = await Promise.all([
      getPerpInstruments(),
      withRetry(
        () => okxGet<OkxTickerRow[]>("/api/v5/market/tickers", { instType: "SWAP" }),
        "fetch OKX swap tickers for volume",
        SCAN_FETCH_MAX_ATTEMPTS,
        SCAN_FETCH_BACKOFF_MS
      )
    ]);

    for (const ticker of tickers) {
      const instId = String(ticker.instId ?? "").trim().toUpperCase();
      const instrument = byInstId.get(instId);
      if (!instrument) {
        continue;
      }
      const volumeUsd = calculateVolumeUsdFromTicker(ticker, instrument);
      if (volumeUsd > 0) {
        volumeMap.set(instrument.externalSymbol, volumeUsd);
      }
    }
  } else {
    const tickers = await withRetry(
      () => okxGet<OkxTickerRow[]>("/api/v5/market/tickers", { instType: "SPOT" }),
      "fetch OKX spot tickers for volume",
      SCAN_FETCH_MAX_ATTEMPTS,
      SCAN_FETCH_BACKOFF_MS
    );

    for (const ticker of tickers) {
      const instId = String(ticker.instId ?? "").trim().toUpperCase();
      if (!instId.endsWith("-USDT")) {
        continue;
      }
      const last = parseNumber(ticker.last);
      const vol24h = parseNumber(ticker.vol24h);
      const volumeUsd = last > 0 && vol24h > 0 ? Number((last * vol24h).toFixed(2)) : 0;
      if (volumeUsd > 0) {
        volumeMap.set(instId, volumeUsd);
      }
    }
  }

  _volumeCache = new Map(volumeMap);
  _volumeCacheAt = Date.now();
  return volumeMap;
}

function calculateVolatilityPctFromCandles(candles: NormalizedCandle[], lookbackCandles: number): number {
  const window = candles.slice(-lookbackCandles);
  if (window.length === 0) {
    return 0;
  }

  let highestHigh = Number.NEGATIVE_INFINITY;
  let lowestLow = Number.POSITIVE_INFINITY;
  for (const candle of window) {
    if (candle.h > highestHigh) highestHigh = candle.h;
    if (candle.l < lowestLow) lowestLow = candle.l;
  }

  if (!Number.isFinite(highestHigh) || !Number.isFinite(lowestLow) || lowestLow <= 0) {
    return 0;
  }

  return Number((((highestHigh - lowestLow) / lowestLow) * 100).toFixed(3));
}

function calculateAtrFromCandles(candles: NormalizedCandle[], period: number = 14): number {
  const atr = calculateLatestAtr(
    candles.map((candle) => candle.h),
    candles.map((candle) => candle.l),
    candles.map((candle) => candle.c),
    period
  );
  return atr != null && Number.isFinite(atr) && atr > 0 ? atr : 0;
}

function calculateTrendPersistenceFromCandles(candles: NormalizedCandle[], lookback: number = 6): number {
  const closes = candles.map((candle) => candle.c);
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

export async function scanRsi(params: ScanParams): Promise<ScanResult> {
  const explicitSymbols = Array.isArray(params.symbols)
    ? params.symbols.map((symbol) => symbol.trim()).filter((symbol) => symbol.length > 0)
    : [];
  const matching = explicitSymbols.length > 0
    ? Array.from(new Set(explicitSymbols.map((symbol) => params.market === "perp" ? normalizePerpSymbol(symbol) : symbol.toUpperCase())))
    : await searchTokens(params.query, params.market);
  const skipped: SkippedToken[] = [];

  const allVolumes = await fetchAllVolumes24h(params.market);
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
        .map((symbol) => params.market === "perp" ? normalizePerpSymbol(symbol) : symbol.toUpperCase())
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
    .sort((left, right) => (volumeBySymbol.get(right) ?? 0) - (volumeBySymbol.get(left) ?? 0))
    .slice(0, params.limitTokens);

  const symbolsToScan = explicitSymbols.length > 0 ? matching.filter((symbol) => volumeBySymbol.has(symbol)) : [...topByVolume];
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
        try {
          const lookbackCandles = 200;
          const volume24h = volumeBySymbol.get(symbol);
          if (volume24h == null) {
            throw new Error("Missing ranked volume for symbol");
          }

          const daily = await fetchAndCalculateTimeframeRsi(symbol, "1d", lookbackCandles);
          const twelveh = await fetchAndCalculateTimeframeRsi(symbol, "12h", lookbackCandles);
          const macro = await fetchAndCalculateTimeframeRsi(symbol, "4h", lookbackCandles);
          const intermediary = await fetchAndCalculateTimeframeRsi(symbol, "1h", lookbackCandles);
          const microTrigger = await fetchAndCalculateTimeframeRsi(symbol, "15m", lookbackCandles);
          const fourHourCandles = await fetchCandlesByInstId(toOkxPerpInstId(symbol), "4h", 230);
          const supportWindowCandles = await fetchCandlesByInstId(toOkxPerpInstId(symbol), "1h", 56);
          const microWindowCandles = await fetchCandlesByInstId(toOkxPerpInstId(symbol), "15m", lookbackCandles + 30);

          if (!macro || !intermediary || !microTrigger) {
            return {
              skipped: {
                symbol,
                reason: "INSUFFICIENT_CANDLES" as const,
                details: `Could not fetch all three key timeframes (macro: ${macro ? "ok" : "fail"}, intermediary: ${intermediary ? "ok" : "fail"}, micro: ${microTrigger ? "ok" : "fail"})`
              }
            };
          }

          const baseSignal = determineSignal(macro, intermediary, microTrigger, {
            daily: daily ?? null,
            twelveh: twelveh ?? null
          });
          const dailyReversalBias = evaluateDailyReversalBias(daily ?? null);
          const close = fourHourCandles.length > 0 ? fourHourCandles.at(-1)?.c ?? 0 : 0;
          const levelsCalc = calculateSupportResistance(supportWindowCandles.slice(-48).map((candle) => ({ h: candle.h, l: candle.l })));
          const volatilityPct = calculateVolatilityPctFromCandles(supportWindowCandles, VOLATILITY_LOOKBACK_CANDLES);
          const passedVolatility = volatilityPct >= MIN_VOLATILITY_PCT;
          const minVolumeUsd = getMinVolumeUsdForSymbol(symbol);
          const passedLiquidity = volume24h >= minVolumeUsd;
          const latestOneHour = supportWindowCandles.at(-1);
          const previousOneHour = supportWindowCandles.at(-2);
          const latestHigh = Number(latestOneHour?.h ?? NaN);
          const latestLow = Number(latestOneHour?.l ?? NaN);
          const previousHigh = Number(previousOneHour?.h ?? NaN);
          const previousLow = Number(previousOneHour?.l ?? NaN);

        const highs1h = supportWindowCandles.slice(-12).map((candle) => candle.h);
        const lows1h = supportWindowCandles.slice(-12).map((candle) => candle.l);
        const trendlineHighs = supportWindowCandles.slice(-40).map((candle) => candle.h);
        const trendlineLows = supportWindowCandles.slice(-40).map((candle) => candle.l);
        const trendlineBreakoutResult = detectDescendingTrendlineBreakout(trendlineHighs, close);
        const trendlineBreakdownResult = detectAscendingTrendlineBreakdown(trendlineLows, close);
        const trendlineBreakout = trendlineBreakoutResult.detected;
        const trendlineBreakdown = trendlineBreakdownResult.detected;
        const lowerHighOn1h = Number.isFinite(latestHigh) && Number.isFinite(previousHigh) && latestHigh < previousHigh;
        const higherLowOn1h = Number.isFinite(latestLow) && Number.isFinite(previousLow) && latestLow > previousLow;
        const structureBreakShort = Number.isFinite(latestLow) && Number.isFinite(previousLow) && latestLow < previousLow;
        const structureBreakLong = Number.isFinite(latestHigh) && Number.isFinite(previousHigh) && latestHigh > previousHigh;

        const oneHourTrendDirection: "BULLISH" | "BEARISH" | "NEUTRAL" = macro.trend.direction === "UP" && intermediary.trend.direction === "UP"
          ? "BULLISH"
          : macro.trend.direction === "DOWN" && intermediary.trend.direction === "DOWN"
            ? "BEARISH"
            : "NEUTRAL";
        const alignLongCount = [macro.trend.direction, intermediary.trend.direction, microTrigger.trend.direction].filter((item) => item === "UP").length;
        const alignShortCount = [macro.trend.direction, intermediary.trend.direction, microTrigger.trend.direction].filter((item) => item === "DOWN").length;
        const structureState: TokenRsiResult["tradeContext"]["structureState"] = Math.max(alignLongCount, alignShortCount) >= 2
          ? "TRENDING"
          : (microTrigger.trend.direction === "UP" || microTrigger.trend.direction === "DOWN")
            ? "BREAKOUT"
            : "CHOP";

        const microCloses = microWindowCandles.map((candle) => candle.c).filter((value) => Number.isFinite(value) && value > 0);
        const ema20Current = calculateLatestEma(microCloses, MICRO_TREND_EMA_PERIOD) ?? close;
        const ema20Previous = calculateLatestEma(microCloses.slice(0, -1), MICRO_TREND_EMA_PERIOD) ?? ema20Current;
        const emaSlope = Number((ema20Current - ema20Previous).toFixed(8));
        const atr1h = calculateAtrFromCandles(supportWindowCandles, 14);
        const atr4h = calculateAtrFromCandles(fourHourCandles, 14);
        const trendPersistence4h = calculateTrendPersistenceFromCandles(fourHourCandles, 6);
        const recentHigh1h = supportWindowCandles.slice(-12).reduce((max, candle) => Math.max(max, candle.h), 0);
        const recentLow1hRaw = supportWindowCandles.slice(-12).reduce((min, candle) => Math.min(min, candle.l), Number.POSITIVE_INFINITY);
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
          if (strong4hTrend && !structureBreakShort && !trendlineBreakdown) signal = "NO SIGNAL";
          if (signal === "REVERSAL SHORT" && !lowerHighOn1h && !trendlineBreakdown) signal = "NO SIGNAL";
        }
        if (signal === "REVERSAL LONG") {
          const strong4hTrend = macro.trend.direction === "DOWN" && trendPersistence4h >= 3;
          if (strong4hTrend && !structureBreakLong && !trendlineBreakout) signal = "NO SIGNAL";
          if (signal === "REVERSAL LONG" && !higherLowOn1h && !trendlineBreakout) signal = "NO SIGNAL";
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
        const passedStructure = !originalDirectional ? true : structureOk;
        const passedMicroTrend = !originalDirectional ? true : emaOk;
        const effectiveStructureState: TokenRsiResult["tradeContext"]["structureState"] = filteredSignal.startsWith("REVERSAL") ? "REVERSAL" : structureState;
        const guarded = applySupportFloorGuard(filteredSignal, close, levelsCalc.localSupport, levelsCalc.localResistance, 0.003);
        const adjustedSignalBadge = getSignalBadge(guarded.adjustedSignal);
        const signalCategory = getSignalCategory(guarded.adjustedSignal);

        const commonTradeContext: TokenRsiResult["tradeContext"] = {
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
        };

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
            tradeContext: commonTradeContext
          }),
          rsi: intermediary.rsi,
          close,
          volume24h,
          volatilityPct,
          tradeContext: commonTradeContext,
          confluence: {
            score: 0,
            bias: direction,
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
        } catch (error) {
          if (isOkxMissingInstrumentError(error)) {
            return {
              skipped: {
                symbol,
                reason: "FETCH_ERROR" as const,
                details: `OKX instrument unavailable or delisted: ${extractErrorMessage(error)}`
              }
            };
          }

          throw error;
        }
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

  const averageMarketVolume = results.length > 0 ? results.reduce((sum, item) => sum + item.volume24h, 0) / results.length : 0;
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
      adjustedSignal = item.confluence.bias === "LONG" ? "REVERSAL LONG" : "REVERSAL SHORT";
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
