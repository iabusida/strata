/**
 * Coinbase Market Data Provider
 *
 * Implements the ProviderModule interface using Coinbase Exchange public REST API.
 * Covers spot markets only (BTC, ETH, SOL, etc.).
 *
 * Interval mapping note:
 *   Coinbase Exchange supports: 60s, 300s, 900s, 3600s, 21600s, 86400s
 *   4h  → 21600s (6h granularity — closest available)
 *   12h → 21600s (6h granularity — used as proxy)
 *   All other intervals map exactly.
 */

import "./env.js";
import { PrismaClient, CandleInterval } from "@prisma/client";
import { prisma } from "./prisma-client.js";
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

// ─── Constants ────────────────────────────────────────────────────────────────

const COINBASE_API_URL = "https://api.exchange.coinbase.com";

// Coinbase supported granularities (seconds)
const GRANULARITY_MAP: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 21600, // 6h — closest Coinbase granularity to 4h
  "12h": 21600, // 6h — used as proxy
  "1d": 86400
};

// Default Coinbase spot token universe (base symbols, USD pairs)
const DEFAULT_SPOT_TOKENS = (
  process.env.COINBASE_SPOT_TOKENS
    ? process.env.COINBASE_SPOT_TOKENS.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : ["BTC", "ETH", "SOL", "AVAX", "LINK", "DOT", "MATIC", "ADA", "XRP",
       "DOGE", "LTC", "UNI", "AAVE", "ATOM", "FIL", "NEAR", "ALGO", "XLM",
       "ETC", "ARB", "OP", "INJ", "APT", "SUI"]
);

const VOLATILITY_LOOKBACK_CANDLES = 14;
const MIN_VOLATILITY_PCT = 1.5;
const MICRO_TREND_EMA_PERIOD = 20;
const SCAN_CONCURRENCY = 2; // Conservative for public rate limits
const SCAN_CHUNK_DELAY_MS = 500;
const ORDERBOOK_DEPTH_BPS = 200;

// Cache
let _spotTokensCache: string[] | null = null;
let _spotTokensCacheAt = 0;
const SPOT_TOKENS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

let _volumeCache: Map<string, number> | null = null;
let _volumeCacheAt = 0;
const VOLUME_CACHE_TTL_MS = 60 * 1000; // 1 min

// ─── Internal types ────────────────────────────────────────────────────────────

type NormalizedCandle = {
  t: number; // ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toCoinbaseProductId(symbol: string): string {
  const base = symbol.trim().toUpperCase();
  return `${base}-USD`;
}

function signalToDirection(signalType: string): "LONG" | "SHORT" | null {
  if (signalType.includes("LONG")) return "LONG";
  if (signalType.includes("SHORT")) return "SHORT";
  return null;
}

function resolveEntryTiming(
  signalType: string,
  item: Pick<TokenRsiResult, "close" | "levels" | "tradeContext">
): EntryTiming | null {
  const direction = signalToDirection(signalType);
  if (!direction) return null;
  return classifyEntryTiming({
    direction,
    price: item.close,
    atr: item.tradeContext.atr,
    supportDistancePct: item.levels.supportDistancePct,
    resistanceDistancePct: item.levels.resistanceDistancePct,
    ema20: item.tradeContext.ema20
  });
}

function calculateVolatilityPctFromCandles(candles: NormalizedCandle[], lookback: number): number {
  const window = candles.slice(-lookback);
  if (window.length === 0) return 0;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (const c of window) {
    if (c.h > high) high = c.h;
    if (c.l < low) low = c.l;
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || low <= 0) return 0;
  return Number((((high - low) / low) * 100).toFixed(3));
}

function calculateAtrFromCandles(candles: NormalizedCandle[], period = 14): number {
  const atr = calculateLatestAtr(
    candles.map((c) => c.h),
    candles.map((c) => c.l),
    candles.map((c) => c.c),
    period
  );
  return atr != null && Number.isFinite(atr) && atr > 0 ? atr : 0;
}

function calculateTrendPersistenceFromCandles(candles: NormalizedCandle[], lookback = 6): number {
  const closes = candles.map((c) => c.c);
  const stochSeries = calculateStochasticRsiSeries(closes);
  if (stochSeries.length === 0) return 0;
  const window = stochSeries.slice(-Math.max(lookback, 3));
  let up = 0;
  let down = 0;
  for (const pt of window) {
    if (pt.k > pt.d) up++;
    if (pt.k < pt.d) down++;
  }
  return Math.max(up, down);
}

// ─── Coinbase public candle fetch ─────────────────────────────────────────────

async function fetchCoinbasePublicCandles(
  productId: string,
  granularity: number,
  count: number
): Promise<NormalizedCandle[]> {
  // Calculate time window to get ~count candles
  const endSec = Math.floor(Date.now() / 1000);
  const startSec = endSec - granularity * count;
  const start = new Date(startSec * 1000).toISOString();
  const end = new Date(endSec * 1000).toISOString();

  const url =
    `${COINBASE_API_URL}/products/${encodeURIComponent(productId)}/candles` +
    `?granularity=${granularity}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;

  const response = await fetch(url, {
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Coinbase candles error (${response.status}) for ${productId}: ${body}`);
  }

  const raw = await response.json() as unknown;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  // Coinbase returns: [[timestamp_sec, low, high, open, close, volume], ...] newest first
  const parsed: NormalizedCandle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const t = Number(row[0]);
    const l = Number(row[1]);
    const h = Number(row[2]);
    const o = Number(row[3]);
    const c = Number(row[4]);
    const v = Number(row[5]);
    if ([t, o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) {
      parsed.push({ t: t * 1000, o, h, l, c, v: Number.isFinite(v) && v >= 0 ? v : 0 });
    }
  }

  // Sort ascending (oldest first) and take the requested count
  return parsed.sort((a, b) => a.t - b.t).slice(-count);
}

// Interval → CandleInterval enum (matches backfill data)
const DB_INTERVAL_MAP: Record<string, CandleInterval> = {
  "15m": CandleInterval.M15,
  "1h":  CandleInterval.H1,
  "4h":  CandleInterval.H4,
  "12h": CandleInterval.H12,
  "1d":  CandleInterval.D1,
};

async function fetchClosesFromDb(symbol: string, interval: string, limit: number): Promise<number[]> {
  const dbInterval = DB_INTERVAL_MAP[interval];
  if (!dbInterval) return [];
  const base = symbol.trim().toUpperCase().replace(/-USD$/, "");
  try {
    const rows = await prisma.marketCandle.findMany({
      where: { symbol: base, interval: dbInterval },
      orderBy: { timestamp: "desc" },
      take: limit,
      select: { close: true }
    });
    // reverse so oldest-first (required by technical indicator libs)
    return rows.reverse().map((r) => Number(r.close)).filter((v) => Number.isFinite(v) && v > 0);
  } catch {
    return [];
  }
}

async function fetchAndCalculateTimeframeRsi(
  symbol: string,
  interval: "1d" | "12h" | "4h" | "1h" | "15m",
  lookbackCandles: number
): Promise<TimeframeRsi | null> {
  // Prefer DB candles (proper intervals, more history)
  let closes = await fetchClosesFromDb(symbol, interval, lookbackCandles + 30);

  // Fall back to Coinbase live API if DB has insufficient data
  if (closes.length < 60) {
    const granularity = GRANULARITY_MAP[interval];
    if (!granularity) return null;
    const candles = await fetchCoinbasePublicCandles(
      toCoinbaseProductId(symbol),
      granularity,
      lookbackCandles + 30
    );
    closes = candles.map((c) => c.c).filter((v) => Number.isFinite(v));
  }

  if (closes.length < 30) return null;

  const rsi = calculateLatestRsi(closes, 14);
  if (rsi === null) return null;

  const macdHist = calculateLatestMacdHistogram(closes);
  if (macdHist === null) return null;

  const stochRsi = calculateStochasticRsi(closes, 14, 14, 3, 3);
  if (stochRsi === null) return null;

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

// ─── Public interface implementations ─────────────────────────────────────────

export async function fetchLatestOhlc(
  symbol: string,
  _interval: "1m" | "5m" | "15m" | "1h" | "4h" = "5m"
): Promise<LatestOhlc | null> {
  try {
    const candles = await fetchCoinbasePublicCandles(toCoinbaseProductId(symbol), 300, 4);
    const latest = candles.at(-1);
    if (!latest) return null;
    return { open: latest.o, high: latest.h, low: latest.l, close: latest.c, time: latest.t };
  } catch {
    return null;
  }
}

export async function fetchPerpContexts(
  _symbols: string[]
): Promise<Map<string, PerpAssetContext>> {
  // Coinbase is spot-only; perp context is not applicable
  return new Map();
}

export async function fetchOrderBookExecutionRead(
  symbol: string
): Promise<OrderBookExecutionRead | null> {
  try {
    const productId = toCoinbaseProductId(symbol);
    const url = `${COINBASE_API_URL}/products/${encodeURIComponent(productId)}/book?level=2`;
    const response = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!response.ok) return null;

    const data = await response.json() as {
      bids?: [string, string, number][];
      asks?: [string, string, number][];
    };

    const bids = (data.bids ?? []).map(([p, s]) => ({ price: Number(p), size: Number(s) }));
    const asks = (data.asks ?? []).map(([p, s]) => ({ price: Number(p), size: Number(s) }));

    if (bids.length === 0 || asks.length === 0) return null;

    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadPct = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 100 : 0;

    // Sum depth within ORDERBOOK_DEPTH_BPS of mid
    const depthLimit = midPrice * (ORDERBOOK_DEPTH_BPS / 10000);
    let bidDepthUsd = 0;
    for (const { price, size } of bids) {
      if (midPrice - price > depthLimit) break;
      bidDepthUsd += price * size;
    }
    let askDepthUsd = 0;
    for (const { price, size } of asks) {
      if (price - midPrice > depthLimit) break;
      askDepthUsd += price * size;
    }

    const combinedDepthUsd = bidDepthUsd + askDepthUsd;
    const imbalance =
      combinedDepthUsd > 0 ? (bidDepthUsd - askDepthUsd) / combinedDepthUsd : 0;

    return {
      symbol,
      bestBid,
      bestAsk,
      markPrice: midPrice,
      spreadPct: Number(spreadPct.toFixed(4)),
      bidDepthUsd: Number(bidDepthUsd.toFixed(2)),
      askDepthUsd: Number(askDepthUsd.toFixed(2)),
      combinedDepthUsd: Number(combinedDepthUsd.toFixed(2)),
      imbalance: Number(imbalance.toFixed(4)),
      depthBps: ORDERBOOK_DEPTH_BPS
    };
  } catch {
    return null;
  }
}

export async function searchTokens(
  query: string | undefined,
  _market: MarketType
): Promise<string[]> {
  const now = Date.now();

  if (!_spotTokensCache || now - _spotTokensCacheAt > SPOT_TOKENS_CACHE_TTL_MS) {
    try {
      const url = `${COINBASE_API_URL}/products`;
      const response = await fetch(url, { headers: { "Accept": "application/json" } });
      if (response.ok) {
        const products = await response.json() as Array<{
          id?: string;
          quote_currency?: string;
          status?: string;
        }>;
        _spotTokensCache = products
          .filter((p) => p.quote_currency === "USD" && p.status === "online" && p.id?.endsWith("-USD"))
          .map((p) => p.id!.replace(/-USD$/, ""))
          .sort();
        _spotTokensCacheAt = now;
      }
    } catch {
      // Fall back to default list
    }
  }

  const list = _spotTokensCache ?? DEFAULT_SPOT_TOKENS;
  if (!query) return list;
  const q = query.trim().toUpperCase();
  return list.filter((s) => s.includes(q));
}

async function fetchAllVolumes24h(symbols: string[]): Promise<Map<string, number>> {
  const now = Date.now();
  const cacheFresh = _volumeCache != null && now - _volumeCacheAt < VOLUME_CACHE_TTL_MS;

  if (!cacheFresh || !_volumeCache) {
    _volumeCache = new Map();
    _volumeCacheAt = now;
  }

  const fetchTargets = symbols
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0)
    .filter((s) => !_volumeCache!.has(s));

  if (fetchTargets.length > 0) {
    await Promise.allSettled(
      fetchTargets.map(async (symbol) => {
        try {
          const url = `${COINBASE_API_URL}/products/${encodeURIComponent(toCoinbaseProductId(symbol))}/stats`;
          const response = await fetch(url, { headers: { "Accept": "application/json" } });
          if (!response.ok) {
            _volumeCache!.set(symbol, 0);
            return;
          }

          const stats = await response.json() as { last?: string; volume?: string };
          const last = Number(stats.last);
          const vol = Number(stats.volume);
          if (last > 0 && vol > 0) {
            _volumeCache!.set(symbol, Number((last * vol).toFixed(2)));
            return;
          }

          _volumeCache!.set(symbol, 0);
        } catch {
          _volumeCache!.set(symbol, 0);
        }
      })
    );
  }

  const volumeMap = new Map<string, number>();
  for (const symbol of symbols) {
    const normalized = symbol.trim().toUpperCase();
    volumeMap.set(normalized, _volumeCache.get(normalized) ?? 0);
  }

  return volumeMap;
}

export async function scanRsi(params: ScanParams): Promise<ScanResult> {
  const explicitSymbols = Array.isArray(params.symbols)
    ? params.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [];

  const matching =
    explicitSymbols.length > 0
      ? explicitSymbols
      : await searchTokens(params.query, params.market);

  const skipped: SkippedToken[] = [];

  // Get 24h volumes for ranking
  const allVolumes = await fetchAllVolumes24h(matching);
  const volumeBySymbol = new Map<string, number>();
  for (const symbol of matching) {
    const vol = allVolumes.get(symbol);
    if (vol != null) {
      volumeBySymbol.set(symbol, vol);
    } else {
      // Allow symbols not in the volume map but assign minimum volume
      volumeBySymbol.set(symbol, 0);
    }
  }

  const includeSymbols = Array.isArray(params.includeSymbols)
    ? params.includeSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [];
  for (const symbol of includeSymbols) {
    if (!volumeBySymbol.has(symbol)) {
      volumeBySymbol.set(symbol, allVolumes.get(symbol) ?? 0);
    }
  }

  const topByVolume = matching
    .filter((s) => volumeBySymbol.has(s))
    .sort((a, b) => (volumeBySymbol.get(b) ?? 0) - (volumeBySymbol.get(a) ?? 0))
    .slice(0, params.limitTokens);

  const symbolsToScan =
    explicitSymbols.length > 0
      ? matching
      : [...topByVolume, ...includeSymbols.filter((s) => !topByVolume.includes(s))];

  const results: TokenRsiResult[] = [];

  for (let i = 0; i < symbolsToScan.length; i += SCAN_CONCURRENCY) {
    const chunk = symbolsToScan.slice(i, i + SCAN_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(async (symbol) => {
        const lookbackCandles = 200;
        const volume24h = volumeBySymbol.get(symbol) ?? 0;

        const [daily, twelveh, macro, intermediary, microTrigger] = await Promise.all([
          fetchAndCalculateTimeframeRsi(symbol, "1d", lookbackCandles),
          fetchAndCalculateTimeframeRsi(symbol, "12h", lookbackCandles),
          fetchAndCalculateTimeframeRsi(symbol, "4h", lookbackCandles),
          fetchAndCalculateTimeframeRsi(symbol, "1h", lookbackCandles),
          fetchAndCalculateTimeframeRsi(symbol, "15m", lookbackCandles)
        ]);

        if (!macro || !intermediary || !microTrigger) {
          skipped.push({
            symbol,
            reason: "INSUFFICIENT_CANDLES",
            details: `timeframes: macro=${macro ? "ok" : "fail"} intermediary=${intermediary ? "ok" : "fail"} micro=${microTrigger ? "ok" : "fail"}`
          });
          return null;
        }

        const [fourHourCandles, supportWindowCandles, microWindowCandles] = await Promise.all([
          fetchCoinbasePublicCandles(toCoinbaseProductId(symbol), GRANULARITY_MAP["4h"], 230),
          fetchCoinbasePublicCandles(toCoinbaseProductId(symbol), GRANULARITY_MAP["1h"], 56),
          fetchCoinbasePublicCandles(toCoinbaseProductId(symbol), GRANULARITY_MAP["15m"], lookbackCandles + 30)
        ]);

        const close = fourHourCandles.at(-1)?.c ?? 0;
        const levelsCalc = calculateSupportResistance(
          supportWindowCandles.slice(-48).map((c) => ({ h: c.h, l: c.l }))
        );
        const volatilityPct = calculateVolatilityPctFromCandles(supportWindowCandles, VOLATILITY_LOOKBACK_CANDLES);
        const passedVolatility = volatilityPct >= MIN_VOLATILITY_PCT;

        const latestOneHour = supportWindowCandles.at(-1);
        const previousOneHour = supportWindowCandles.at(-2);
        const latestHigh = Number(latestOneHour?.h ?? NaN);
        const latestLow = Number(latestOneHour?.l ?? NaN);
        const previousHigh = Number(previousOneHour?.h ?? NaN);
        const previousLow = Number(previousOneHour?.l ?? NaN);

        const highs1h = supportWindowCandles.slice(-12).map((c) => c.h);
        const lows1h = supportWindowCandles.slice(-12).map((c) => c.l);
        const trendlineHighs = supportWindowCandles.slice(-40).map((c) => c.h);
        const trendlineLows = supportWindowCandles.slice(-40).map((c) => c.l);
        const trendlineBreakout = detectDescendingTrendlineBreakout(trendlineHighs, close).detected;
        const trendlineBreakdown = detectAscendingTrendlineBreakdown(trendlineLows, close).detected;
        const lowerHighOn1h = Number.isFinite(latestHigh) && Number.isFinite(previousHigh) && latestHigh < previousHigh;
        const higherLowOn1h = Number.isFinite(latestLow) && Number.isFinite(previousLow) && latestLow > previousLow;
        const structureBreakShort = Number.isFinite(latestLow) && Number.isFinite(previousLow) && latestLow < previousLow;
        const structureBreakLong = Number.isFinite(latestHigh) && Number.isFinite(previousHigh) && latestHigh > previousHigh;

        const oneHourTrendDirection: "BULLISH" | "BEARISH" | "NEUTRAL" =
          macro.trend.direction === "UP" && intermediary.trend.direction === "UP"
            ? "BULLISH"
            : macro.trend.direction === "DOWN" && intermediary.trend.direction === "DOWN"
              ? "BEARISH"
              : "NEUTRAL";

        const alignLong = [macro.trend.direction, intermediary.trend.direction, microTrigger.trend.direction].filter(
          (d) => d === "UP"
        ).length;
        const alignShort = [macro.trend.direction, intermediary.trend.direction, microTrigger.trend.direction].filter(
          (d) => d === "DOWN"
        ).length;
        const structureState: TokenRsiResult["tradeContext"]["structureState"] =
          Math.max(alignLong, alignShort) >= 2
            ? "TRENDING"
            : microTrigger.trend.direction === "UP" || microTrigger.trend.direction === "DOWN"
              ? "BREAKOUT"
              : "CHOP";

        const microCloses = microWindowCandles
          .map((c) => c.c)
          .filter((v) => Number.isFinite(v) && v > 0);
        const ema20Current = calculateLatestEma(microCloses, MICRO_TREND_EMA_PERIOD) ?? close;
        const ema20Previous =
          calculateLatestEma(microCloses.slice(0, -1), MICRO_TREND_EMA_PERIOD) ?? ema20Current;
        const emaSlope = Number((ema20Current - ema20Previous).toFixed(8));
        const atr1h = calculateAtrFromCandles(supportWindowCandles, 14);
        const atr4h = calculateAtrFromCandles(fourHourCandles, 14);
        const trendPersistence4h = calculateTrendPersistenceFromCandles(fourHourCandles, 6);
        const recentHigh1h = supportWindowCandles.slice(-12).reduce((mx, c) => Math.max(mx, c.h), 0);
        const recentLow1hRaw = supportWindowCandles
          .slice(-12)
          .reduce((mn, c) => Math.min(mn, c.l), Number.POSITIVE_INFINITY);
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

        let baseSignal = determineSignal(macro, intermediary, microTrigger, {
          daily: daily ?? null,
          twelveh: twelveh ?? null
        });
        const dailyReversalBias = evaluateDailyReversalBias(daily ?? null);

        if (baseSignal === "REVERSAL SHORT") {
          const strong4hTrend = macro.trend.direction === "UP" && trendPersistence4h >= 3;
          if (strong4hTrend && !structureBreakShort && !trendlineBreakdown) baseSignal = "NO SIGNAL";
          if (baseSignal === "REVERSAL SHORT" && !lowerHighOn1h && !trendlineBreakdown) baseSignal = "NO SIGNAL";
        }
        if (baseSignal === "REVERSAL LONG") {
          const strong4hTrend = macro.trend.direction === "DOWN" && trendPersistence4h >= 3;
          if (strong4hTrend && !structureBreakLong && !trendlineBreakout) baseSignal = "NO SIGNAL";
          if (baseSignal === "REVERSAL LONG" && !higherLowOn1h && !trendlineBreakout) baseSignal = "NO SIGNAL";
        }

        let filteredSignal = baseSignal;
        const structureOk =
          filteredSignal === "NO SIGNAL"
            ? true
            : evaluateStructure({ highs1h, lows1h }, filteredSignal) ||
              (filteredSignal.includes("LONG") ? trendlineBreakout : false) ||
              (filteredSignal.includes("SHORT") ? trendlineBreakdown : false);
        const emaOk =
          filteredSignal === "NO SIGNAL"
            ? true
            : evaluateMicroTrend(
                { price: close, ema20: ema20Current, prevEma20: ema20Previous },
                filteredSignal
              );
        const srOk =
          filteredSignal === "NO SIGNAL"
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
        if (dailyReversalBias === "SHORT" && direction === "LONG") direction = null;
        else if (dailyReversalBias === "LONG" && direction === "SHORT") direction = null;

        const originalDirectional = filteredSignal.endsWith("LONG") || filteredSignal.endsWith("SHORT");
        const passedStructure = !originalDirectional ? true : structureOk;
        const passedMicroTrend = !originalDirectional ? true : emaOk;
        const effectiveStructureState: TokenRsiResult["tradeContext"]["structureState"] = filteredSignal.startsWith("REVERSAL")
          ? "REVERSAL"
          : structureState;

        const guarded = applySupportFloorGuard(
          filteredSignal,
          close,
          levelsCalc.localSupport,
          levelsCalc.localResistance,
          0.003
        );
        const adjustedSignalBadge = getSignalBadge(guarded.adjustedSignal);
        const signalCategory = getSignalCategory(guarded.adjustedSignal);

        const tradeContext: TokenRsiResult["tradeContext"] = {
          volatilityPct,
          volume24h,
          passedVolatility,
          passedLiquidity: volume24h > 0,
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

        const scoreFromSignalType = (() => {
          if (guarded.adjustedSignal === "STRONG LONG" || guarded.adjustedSignal === "STRONG SHORT") {
            return 6;
          }
          if (guarded.adjustedSignal === "CONTINUATION LONG" || guarded.adjustedSignal === "CONTINUATION SHORT") {
            return 5;
          }
          if (guarded.adjustedSignal === "REVERSAL LONG" || guarded.adjustedSignal === "REVERSAL SHORT") {
            return 4.5;
          }
          return 0;
        })();
        const scoreBoost =
          (passedVolatility ? 0.5 : 0) +
          (volume24h > 0 ? 0.5 : 0) +
          ((passedStructure && passedMicroTrend) ? 0.5 : 0);
        const confluenceScore = Number(Math.min(10, scoreFromSignalType + scoreBoost).toFixed(2));

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
            tradeContext
          }),
          rsi: intermediary.rsi,
          close,
          volume24h,
          volatilityPct,
          tradeContext,
          confluence: {
            score: confluenceScore,
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

        return result;
      })
    );

    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value) {
        results.push(outcome.value);
      } else if (outcome.status === "rejected") {
        console.warn("[coinbase-provider] scan symbol failed:", outcome.reason);
      }
    }

    if (SCAN_CHUNK_DELAY_MS > 0 && i + SCAN_CONCURRENCY < symbolsToScan.length) {
      await new Promise((resolve) => setTimeout(resolve, SCAN_CHUNK_DELAY_MS));
    }
  }

  return {
    analyzedAt: new Date().toISOString(),
    params,
    results,
    skipped
  };
}
