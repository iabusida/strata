/**
 * Coinbase Spot Weekly Capitulation Universe
 *
 * Fetches all Coinbase spot USD pairs, gates by market cap (≤$50M),
 * then computes weekly/daily/6h/1h/15m RSI + stochastic indicators.
 *
 * Candle source: Coinbase Exchange public REST API (no auth required).
 * Granularities: 86400s (1d), 21600s (6h), 3600s (1h), 900s (15m).
 *
 * Weekly RSI is built from daily closes grouped into 7-day bars.
 * ATL proxy: lowest close in the available ~300-day daily window.
 */
import "./env.js";
import { fetchMarketCapBySymbolUsd } from "./market-cap-service.js";
import { calculateLatestRsi, calculateStochasticRsi, calculateLatestAtr } from "./rsi.js";
import { MACD } from "technicalindicators";
import { prisma } from "./prisma-client.js";

// ── Config ────────────────────────────────────────────────────────────────────

const COINBASE_API_URL      = "https://api.exchange.coinbase.com";
const MAX_MARKET_CAP_USD    = 200_000_000;   // $200M — Coinbase lists larger-cap tokens than Bitunix perps
const CAP_RSI_THRESHOLD     = 38;
const CAP_ATL_DISTANCE_MAX  = 30;      // ≤30% from 300d low (Coinbase tokens are more established)
const UNIVERSE_STALE_HOURS  = 12;
const CANDLE_CONCURRENCY    = 4;       // conservative for public rate limits
const CANDLE_CHUNK_DELAY_MS = 600;

// Unsupported product cache (avoid repeated 404 spam)
const unsupportedCache = new Map<string, number>();
const UNSUPPORTED_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Candle fetching ───────────────────────────────────────────────────────────

type RawCandle = { t: number; o: number; h: number; l: number; c: number; v: number };

async function fetchCoinbaseCandles(
  productId: string,
  granularitySec: number,
  count: number,
  endSec?: number,
): Promise<RawCandle[]> {
  const skip = unsupportedCache.get(productId) ?? 0;
  if (skip > Date.now()) return [];

  const end = endSec ?? Math.floor(Date.now() / 1000);
  const start = end - granularitySec * count;

  const url =
    `${COINBASE_API_URL}/products/${encodeURIComponent(productId)}/candles` +
    `?granularity=${granularitySec}` +
    `&start=${new Date(start * 1000).toISOString()}` +
    `&end=${new Date(end * 1000).toISOString()}`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 404 && body.includes("NotFound")) {
      unsupportedCache.set(productId, Date.now() + UNSUPPORTED_TTL_MS);
      return [];
    }
    throw new Error(`Coinbase candles ${res.status} for ${productId}: ${body.slice(0, 120)}`);
  }

  const raw = await res.json() as unknown;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const parsed: RawCandle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, l, h, o, c, v] = row.map(Number);
    if ([t, o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) {
      parsed.push({ t: t * 1000, o, h, l, c, v: Number.isFinite(v) && v >= 0 ? v : 0 });
    }
  }

  return parsed.sort((a, b) => a.t - b.t).slice(-count);
}

/**
 * Fetch daily candles with pagination to get up to ~600 days.
 * Coinbase returns max 300 candles per request so we make two calls.
 */
async function fetchDailyCandles(productId: string): Promise<RawCandle[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const DAY = 86400;

  const [recent, older] = await Promise.all([
    fetchCoinbaseCandles(productId, DAY, 300, nowSec),
    fetchCoinbaseCandles(productId, DAY, 300, nowSec - 300 * DAY),
  ]);

  // Merge, deduplicate by timestamp, sort ascending
  const byTs = new Map<number, RawCandle>();
  for (const c of [...older, ...recent]) byTs.set(c.t, c);
  return Array.from(byTs.values()).sort((a, b) => a.t - b.t);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildWeeklyCloses(daily: number[]): number[] {
  const weekly: number[] = [];
  const start = daily.length % 7;
  for (let i = start; i + 7 <= daily.length; i += 7) weekly.push(daily[i + 6]);
  return weekly;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Public types ──────────────────────────────────────────────────────────────

export type CoinbaseCapTokenRow = {
  symbol: string;
  baseSymbol: string;
  marketCapUsd: number;
  close: number | null;
  atl300: number | null;
  distanceFromAtlPct: number | null;
  weeklyRsi: number | null;
  weeklyStochK: number | null;
  weeklyStochD: number | null;
  weeklyStochCrossUp: boolean;
  dailyRsi: number | null;
  dailyStochK: number | null;
  dailyStochD: number | null;
  dailyStochCrossUp: boolean;
  stoch6hK: number | null;
  stoch6hD: number | null;
  stoch6hCrossUp: boolean;
  stoch1hK: number | null;
  stoch1hD: number | null;
  stoch1hCrossUp: boolean;
  stoch15mK: number | null;
  stoch15mD: number | null;
  stoch15mCrossUp: boolean;
  timeframeCrossCount: number;
  atrPct: number | null;
  macdHistRising: boolean;
  priceAbovePrevClose: boolean;
  volVsAvg14d: number | null;
  inCapitulation: boolean;
};

// ── Core indicator computation ────────────────────────────────────────────────

async function computeIndicators(
  productId: string,
): Promise<Omit<CoinbaseCapTokenRow, "symbol" | "baseSymbol" | "marketCapUsd"> & { indicatorError?: string }> {
  const EMPTY = {
    close: null, atl300: null, distanceFromAtlPct: null,
    weeklyRsi: null, weeklyStochK: null, weeklyStochD: null, weeklyStochCrossUp: false,
    dailyRsi: null, dailyStochK: null, dailyStochD: null, dailyStochCrossUp: false,
    stoch6hK: null, stoch6hD: null, stoch6hCrossUp: false,
    stoch1hK: null, stoch1hD: null, stoch1hCrossUp: false,
    stoch15mK: null, stoch15mD: null, stoch15mCrossUp: false,
    timeframeCrossCount: 0, atrPct: null,
    macdHistRising: false, priceAbovePrevClose: false, volVsAvg14d: null,
    inCapitulation: false,
  };

  try {
    // Fetch all timeframes concurrently
    const [dailyCandles, candles6h, candles1h, candles15m] = await Promise.all([
      fetchDailyCandles(productId),
      fetchCoinbaseCandles(productId, 21600, 200),   // 6h
      fetchCoinbaseCandles(productId, 3600,  200),   // 1h
      fetchCoinbaseCandles(productId, 900,   200),   // 15m
    ]);

    const dc   = dailyCandles.map((c) => c.c).filter(Number.isFinite);
    const c6h  = candles6h.map((c) => c.c).filter(Number.isFinite);
    const c1h  = candles1h.map((c) => c.c).filter(Number.isFinite);
    const c15m = candles15m.map((c) => c.c).filter(Number.isFinite);

    if (dc.length < 40) return { ...EMPTY, indicatorError: "insufficient_daily_data" };

    // ATL proxy (lowest close in available data)
    const atl300 = Math.min(...dc);
    const close  = dc[dc.length - 1];
    const distanceFromAtlPct = ((close - atl300) / atl300) * 100;

    // Weekly (derived from daily)
    const wc = buildWeeklyCloses(dc);
    const weeklyRsi   = wc.length >= 8 ? calculateLatestRsi(wc, Math.min(14, wc.length - 1)) : null;
    const weeklyStoch = wc.length >= 8 ? calculateStochasticRsi(wc, Math.min(14, wc.length - 1), Math.min(14, wc.length - 1), 3, 3) : null;
    const weeklyStochCrossUp = weeklyStoch
      ? weeklyStoch.prevK <= weeklyStoch.prevD && weeklyStoch.k > weeklyStoch.d
      : false;

    // Daily
    const dailyRsi   = calculateLatestRsi(dc, 14);
    const dailyStoch = dc.length >= 30 ? calculateStochasticRsi(dc, 14, 14, 3, 3) : null;
    const dailyStochCrossUp = dailyStoch
      ? dailyStoch.prevK <= dailyStoch.prevD && dailyStoch.k > dailyStoch.d
      : false;

    // 6h
    const stoch6h = c6h.length >= 30 ? calculateStochasticRsi(c6h, 14, 14, 3, 3) : null;
    const stoch6hCrossUp = stoch6h
      ? stoch6h.prevK <= stoch6h.prevD && stoch6h.k > stoch6h.d
      : false;

    // 1h
    const stoch1h = c1h.length >= 30 ? calculateStochasticRsi(c1h, 14, 14, 3, 3) : null;
    const stoch1hCrossUp = stoch1h
      ? stoch1h.prevK <= stoch1h.prevD && stoch1h.k > stoch1h.d
      : false;

    // 15m
    const stoch15m = c15m.length >= 30 ? calculateStochasticRsi(c15m, 14, 14, 3, 3) : null;
    const stoch15mCrossUp = stoch15m
      ? stoch15m.prevK <= stoch15m.prevD && stoch15m.k > stoch15m.d
      : false;

    // Confluence count
    const timeframeCrossCount = [
      stoch15mCrossUp, stoch1hCrossUp, stoch6hCrossUp, dailyStochCrossUp, weeklyStochCrossUp
    ].filter(Boolean).length;

    // ATR%
    let atrPct: number | null = null;
    if (dailyCandles.length >= 15) {
      const highs  = dailyCandles.map((c) => c.h).filter(Number.isFinite);
      const lows   = dailyCandles.map((c) => c.l).filter(Number.isFinite);
      const closes = dailyCandles.map((c) => c.c).filter(Number.isFinite);
      const atr = calculateLatestAtr(highs, lows, closes, 14);
      if (atr != null && close > 0) atrPct = (atr / close) * 100;
    }

    // MACD
    let macdHistRising = false;
    if (dc.length >= 35) {
      const macdResult = MACD.calculate({ values: dc, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
      if (macdResult.length >= 2) {
        const cur  = macdResult[macdResult.length - 1].histogram ?? 0;
        const prev = macdResult[macdResult.length - 2].histogram ?? 0;
        macdHistRising = cur > prev;
      }
    }

    // Price vs prev close
    const priceAbovePrevClose = dc.length >= 2 && dc[dc.length - 1] > dc[dc.length - 2];

    // Volume vs 14d average
    let volVsAvg14d: number | null = null;
    if (dailyCandles.length >= 15) {
      const vols = dailyCandles.map((c) => c.v).filter((v) => Number.isFinite(v) && v > 0);
      if (vols.length >= 15) {
        const avg14 = vols.slice(-15, -1).reduce((s, v) => s + v, 0) / 14;
        const curVol = vols[vols.length - 1];
        if (avg14 > 0) volVsAvg14d = curVol / avg14;
      }
    }

    const inCapitulation =
      weeklyRsi != null &&
      weeklyRsi < CAP_RSI_THRESHOLD;
      // Note: ATL distance not gated here — Coinbase tokens are established coins
      // whose true ATLs predate our 300d candle window. Weekly RSI <38 is the signal.

    return {
      close, atl300, distanceFromAtlPct,
      weeklyRsi:         weeklyRsi != null ? Number(weeklyRsi.toFixed(2)) : null,
      weeklyStochK:      weeklyStoch ? Number(weeklyStoch.k.toFixed(2)) : null,
      weeklyStochD:      weeklyStoch ? Number(weeklyStoch.d.toFixed(2)) : null,
      weeklyStochCrossUp,
      dailyRsi:          dailyRsi != null ? Number(dailyRsi.toFixed(2)) : null,
      dailyStochK:       dailyStoch ? Number(dailyStoch.k.toFixed(2)) : null,
      dailyStochD:       dailyStoch ? Number(dailyStoch.d.toFixed(2)) : null,
      dailyStochCrossUp,
      stoch6hK:          stoch6h ? Number(stoch6h.k.toFixed(2)) : null,
      stoch6hD:          stoch6h ? Number(stoch6h.d.toFixed(2)) : null,
      stoch6hCrossUp,
      stoch1hK:          stoch1h ? Number(stoch1h.k.toFixed(2)) : null,
      stoch1hD:          stoch1h ? Number(stoch1h.d.toFixed(2)) : null,
      stoch1hCrossUp,
      stoch15mK:         stoch15m ? Number(stoch15m.k.toFixed(2)) : null,
      stoch15mD:         stoch15m ? Number(stoch15m.d.toFixed(2)) : null,
      stoch15mCrossUp,
      timeframeCrossCount,
      atrPct:            atrPct != null ? Number(atrPct.toFixed(2)) : null,
      macdHistRising,
      priceAbovePrevClose,
      volVsAvg14d:       volVsAvg14d != null ? Number(volVsAvg14d.toFixed(2)) : null,
      inCapitulation,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...EMPTY, indicatorError: msg.slice(0, 200) };
  }
}

// ── Universe builder ──────────────────────────────────────────────────────────

export type BuildResult = {
  refreshed: boolean;
  total: number;
  inCapitulation: number;
};

/**
 * Fetch all Coinbase USD spot pairs.
 */
async function fetchCoinbaseUsdPairs(): Promise<string[]> {
  const res = await fetch(`${COINBASE_API_URL}/products`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Coinbase /products error: ${res.status}`);
  const data = await res.json() as Array<{ id: string; base_currency: string; quote_currency: string; status: string }>;
  return data
    .filter((p) => p.quote_currency === "USD" && p.status === "online")
    .map((p) => p.id);
}

export async function buildCoinbaseCapUniverse(
  opts: { forceRefresh?: boolean } = {},
): Promise<BuildResult> {
  // Check freshness
  if (!opts.forceRefresh) {
    const newest = await prisma.coinbaseCapToken.findFirst({ orderBy: { refreshedAt: "desc" } });
    if (newest) {
      const ageHours = (Date.now() - newest.refreshedAt.getTime()) / 3_600_000;
      if (ageHours < UNIVERSE_STALE_HOURS) {
        const total = await prisma.coinbaseCapToken.count();
        const inCap = await prisma.coinbaseCapToken.count({ where: { inCapitulation: true } });
        return { refreshed: false, total, inCapitulation: inCap };
      }
    }
  }

  console.log("[coinbase-cap] Fetching Coinbase USD pairs and market caps…");
  const [usdPairs, caps] = await Promise.all([
    fetchCoinbaseUsdPairs(),
    fetchMarketCapBySymbolUsd(),
  ]);

  // Gate by market cap
  type EligiblePair = { productId: string; baseSymbol: string; marketCapUsd: number };
  const eligible: EligiblePair[] = [];
  let noCapMatch = 0;
  let tooLargeCap = 0;
  for (const productId of usdPairs) {
    const base = productId.replace(/-USD$/, "");
    const cap = caps.get(base) ?? caps.get(base.toUpperCase()) ?? caps.get(base.toLowerCase());
    if (cap == null) { noCapMatch++; continue; }
    if (cap > MAX_MARKET_CAP_USD) { tooLargeCap++; continue; }
    if (cap > 0) eligible.push({ productId, baseSymbol: base, marketCapUsd: cap });
  }
  console.log(`[coinbase-cap] ${usdPairs.length} USD pairs → ${eligible.length} eligible (${noCapMatch} no-cap-match, ${tooLargeCap} too-large >$${MAX_MARKET_CAP_USD/1_000_000}M)`);

  console.log(`[coinbase-cap] ${eligible.length} eligible tokens (≤$50M cap). Computing indicators…`);

  let processed = 0;
  let inCapCount = 0;

  for (let i = 0; i < eligible.length; i += CANDLE_CONCURRENCY) {
    const chunk = eligible.slice(i, i + CANDLE_CONCURRENCY);
    await Promise.all(chunk.map(async (entry) => {
      const ind = await computeIndicators(entry.productId);
      await prisma.coinbaseCapToken.upsert({
        where: { symbol: entry.productId },
        create: {
          symbol: entry.productId,
          baseSymbol: entry.baseSymbol,
          marketCapUsd: entry.marketCapUsd,
          refreshedAt: new Date(),
          ...ind,
        },
        update: {
          baseSymbol: entry.baseSymbol,
          marketCapUsd: entry.marketCapUsd,
          refreshedAt: new Date(),
          ...ind,
        },
      });
      processed++;
      if (ind.inCapitulation) inCapCount++;
    }));

    if (processed % 30 === 0) {
      console.log(`[coinbase-cap]   ${processed}/${eligible.length} processed, ${inCapCount} in capitulation…`);
    }
    if (i + CANDLE_CONCURRENCY < eligible.length) await sleep(CANDLE_CHUNK_DELAY_MS);
  }

  console.log(`[coinbase-cap] Universe built: ${eligible.length} tokens, ${inCapCount} in capitulation.`);
  return { refreshed: true, total: eligible.length, inCapitulation: inCapCount };
}

export async function getCapitulationTokens(): Promise<CoinbaseCapTokenRow[]> {
  const rows = await prisma.coinbaseCapToken.findMany({
    where: { inCapitulation: true },
    orderBy: { distanceFromAtlPct: "asc" },
  });
  return rows.map((r) => ({
    symbol:              r.symbol,
    baseSymbol:          r.baseSymbol,
    marketCapUsd:        r.marketCapUsd,
    close:               r.close,
    atl300:              r.atl300,
    distanceFromAtlPct:  r.distanceFromAtlPct,
    weeklyRsi:           r.weeklyRsi,
    weeklyStochK:        r.weeklyStochK,
    weeklyStochD:        r.weeklyStochD,
    weeklyStochCrossUp:  r.weeklyStochCrossUp,
    dailyRsi:            r.dailyRsi,
    dailyStochK:         r.dailyStochK,
    dailyStochD:         r.dailyStochD,
    dailyStochCrossUp:   r.dailyStochCrossUp,
    stoch6hK:            r.stoch6hK,
    stoch6hD:            r.stoch6hD,
    stoch6hCrossUp:      r.stoch6hCrossUp,
    stoch1hK:            r.stoch1hK,
    stoch1hD:            r.stoch1hD,
    stoch1hCrossUp:      r.stoch1hCrossUp,
    stoch15mK:           r.stoch15mK,
    stoch15mD:           r.stoch15mD,
    stoch15mCrossUp:     r.stoch15mCrossUp,
    timeframeCrossCount: r.timeframeCrossCount,
    atrPct:              r.atrPct,
    macdHistRising:      r.macdHistRising,
    priceAbovePrevClose: r.priceAbovePrevClose,
    volVsAvg14d:         r.volVsAvg14d,
    inCapitulation:      r.inCapitulation,
  }));
}
