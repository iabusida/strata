/**
 * Weekly Capitulation Universe
 *
 * Builds and persists a low-cap (≤$50M) universe then annotates each token
 * with weekly and daily RSI/stoch indicators plus distance-from-ATL.
 *
 * The universe is loaded once and cached in the DB.  Re-computation only
 * happens when `forceRefresh: true` is passed or when the data is older
 * than UNIVERSE_STALE_HOURS.
 */
import "./env.js";
import { fetchPerpTickerSnapshots } from "./bitunix-service.js";
import { fetchMarketCapBySymbolUsd } from "./market-cap-service.js";
import { fetchRecentCandles } from "./bitunix-service.js";
import { calculateLatestRsi, calculateStochasticRsi } from "./rsi.js";
import { prisma } from "./prisma-client.js";

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_MARKET_CAP_USD = 50_000_000;          // $50M hard cap
const ATL_WINDOW_DAYS    = 365;
const CAPITULATION_WEEKLY_RSI_THRESHOLD  = 38;
const CAPITULATION_ATL_DISTANCE_MAX_PCT  = 10;  // must be ≤10% from ATL
const UNIVERSE_STALE_HOURS = 12;                // re-compute if older than this
const CANDLE_CONCURRENCY   = 6;

// ── Helpers ───────────────────────────────────────────────────────────────────

function toBaseSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (upper.endsWith("-PERP")) return upper.slice(0, -5);
  if (upper.endsWith("USDT"))  return upper.slice(0, -4);
  return upper;
}

function buildWeeklyCloses(dailyCloses: number[]): number[] {
  const weekly: number[] = [];
  const start = dailyCloses.length % 7;
  for (let i = start; i + 7 <= dailyCloses.length; i += 7) {
    weekly.push(dailyCloses[i + 6]);
  }
  return weekly;
}

// ── Public types ──────────────────────────────────────────────────────────────

export type WeeklyCapTokenRow = {
  symbol: string;
  baseSymbol: string;
  marketCapUsd: number;
  close: number | null;
  atl365: number | null;
  distanceFromAtlPct: number | null;
  weeklyRsi: number | null;
  weeklyStochK: number | null;
  weeklyStochD: number | null;
  weeklyStochCrossUp: boolean;
  dailyRsi: number | null;
  dailyStochK: number | null;
  dailyStochD: number | null;
  dailyStochCrossUp: boolean;
  stoch4hK: number | null;
  stoch4hD: number | null;
  stoch4hCrossUp: boolean;
  stoch1hK: number | null;
  stoch1hD: number | null;
  stoch1hCrossUp: boolean;
  stoch15mK: number | null;
  stoch15mD: number | null;
  stoch15mCrossUp: boolean;
  timeframeCrossCount: number;
  inCapitulation: boolean;
};

// ── Core computation ──────────────────────────────────────────────────────────

async function computeIndicators(symbol: string): Promise<Omit<WeeklyCapTokenRow, "symbol" | "baseSymbol" | "marketCapUsd"> & { indicatorError?: string }> {
  try {
    const daily4h = await fetchRecentCandles(symbol, "4h", 60);
    const daily1h = await fetchRecentCandles(symbol, "1h", 120);
    const daily15m = await fetchRecentCandles(symbol, "15m", 120);
    const daily1d = await fetchRecentCandles(symbol, "1d", ATL_WINDOW_DAYS + 50);

    const dc = daily1d.map((c) => Number(c.close)).filter(Number.isFinite);
    const c4h = daily4h.map((c) => Number(c.close)).filter(Number.isFinite);
    const c1h = daily1h.map((c) => Number(c.close)).filter(Number.isFinite);
    const c15m = daily15m.map((c) => Number(c.close)).filter(Number.isFinite);

    if (dc.length < 60) {
      return {
        close: null, atl365: null, distanceFromAtlPct: null,
        weeklyRsi: null, weeklyStochK: null, weeklyStochD: null, weeklyStochCrossUp: false,
        dailyRsi: null, dailyStochK: null, dailyStochD: null, dailyStochCrossUp: false,
        stoch4hK: null, stoch4hD: null, stoch4hCrossUp: false,
        stoch1hK: null, stoch1hD: null, stoch1hCrossUp: false,
        stoch15mK: null, stoch15mD: null, stoch15mCrossUp: false,
        timeframeCrossCount: 0,
        inCapitulation: false,
        indicatorError: `insufficient daily candles: ${dc.length}`,
      };
    }

    const wc = buildWeeklyCloses(dc);
    const close = dc[dc.length - 1];
    const atl365 = Math.min(...dc.slice(-ATL_WINDOW_DAYS));
    const distanceFromAtlPct = atl365 > 0 ? ((close - atl365) / atl365) * 100 : null;

    const weeklyRsi   = wc.length >= 20 ? calculateLatestRsi(wc, 14)                  : null;
    const weeklyStoch = wc.length >= 20 ? calculateStochasticRsi(wc, 14, 14, 3, 3)   : null;
    const dailyRsi    = calculateLatestRsi(dc, 14);
    const dailyStoch  = calculateStochasticRsi(dc, 14, 14, 3, 3);
    const stoch4h     = c4h.length >= 20 ? calculateStochasticRsi(c4h, 14, 14, 3, 3) : null;
    const stoch1h     = c1h.length >= 20 ? calculateStochasticRsi(c1h, 14, 14, 3, 3) : null;
    const stoch15m    = c15m.length >= 20 ? calculateStochasticRsi(c15m, 14, 14, 3, 3) : null;

    // A cross is active ONLY if:
    // 1. Previous K was at or below D (was in bearish/oversold state)
    // 2. Current K is strictly above D (just crossed into bullish state)
    // 3. This ensures the flag is true only in the cycle the cross happens, not for stale crosses
    const weeklyStochCrossUp = weeklyStoch
      ? weeklyStoch.prevK <= weeklyStoch.prevD && weeklyStoch.k > weeklyStoch.d
      : false;
    const dailyStochCrossUp = dailyStoch
      ? dailyStoch.prevK <= dailyStoch.prevD && dailyStoch.k > dailyStoch.d
      : false;
    const stoch4hCrossUp = stoch4h
      ? stoch4h.prevK <= stoch4h.prevD && stoch4h.k > stoch4h.d
      : false;
    const stoch1hCrossUp = stoch1h
      ? stoch1h.prevK <= stoch1h.prevD && stoch1h.k > stoch1h.d
      : false;
    const stoch15mCrossUp = stoch15m
      ? stoch15m.prevK <= stoch15m.prevD && stoch15m.k > stoch15m.d
      : false;

    // Count how many timeframes are crossing for confluence score
    const timeframeCrossCount = [weeklyStochCrossUp, dailyStochCrossUp, stoch4hCrossUp, stoch1hCrossUp, stoch15mCrossUp].filter(Boolean).length;

    const inCapitulation =
      weeklyRsi != null &&
      weeklyRsi < CAPITULATION_WEEKLY_RSI_THRESHOLD &&
      distanceFromAtlPct != null &&
      distanceFromAtlPct <= CAPITULATION_ATL_DISTANCE_MAX_PCT;

    return {
      close,
      atl365,
      distanceFromAtlPct: distanceFromAtlPct != null ? Number(distanceFromAtlPct.toFixed(2)) : null,
      weeklyRsi:   weeklyRsi   != null ? Number(weeklyRsi.toFixed(2))       : null,
      weeklyStochK: weeklyStoch ? Number(weeklyStoch.k.toFixed(2))           : null,
      weeklyStochD: weeklyStoch ? Number(weeklyStoch.d.toFixed(2))           : null,
      weeklyStochCrossUp,
      dailyRsi:   dailyRsi   != null ? Number(dailyRsi.toFixed(2))           : null,
      dailyStochK: dailyStoch ? Number(dailyStoch.k.toFixed(2))              : null,
      dailyStochD: dailyStoch ? Number(dailyStoch.d.toFixed(2))              : null,
      dailyStochCrossUp,
      stoch4hK: stoch4h ? Number(stoch4h.k.toFixed(2)) : null,
      stoch4hD: stoch4h ? Number(stoch4h.d.toFixed(2)) : null,
      stoch4hCrossUp,
      stoch1hK: stoch1h ? Number(stoch1h.k.toFixed(2)) : null,
      stoch1hD: stoch1h ? Number(stoch1h.d.toFixed(2)) : null,
      stoch1hCrossUp,
      stoch15mK: stoch15m ? Number(stoch15m.k.toFixed(2)) : null,
      stoch15mD: stoch15m ? Number(stoch15m.d.toFixed(2)) : null,
      stoch15mCrossUp,
      timeframeCrossCount,
      inCapitulation,
    };
  } catch (err) {
    return {
      close: null, atl365: null, distanceFromAtlPct: null,
      weeklyRsi: null, weeklyStochK: null, weeklyStochD: null, weeklyStochCrossUp: false,
      dailyRsi: null, dailyStochK: null, dailyStochD: null, dailyStochCrossUp: false,
      stoch4hK: null, stoch4hD: null, stoch4hCrossUp: false,
      stoch1hK: null, stoch1hD: null, stoch1hCrossUp: false,
      stoch15mK: null, stoch15mD: null, stoch15mCrossUp: false,
      timeframeCrossCount: 0,
      inCapitulation: false,
      indicatorError: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function buildWeeklyCapUniverse(options: { forceRefresh?: boolean } = {}): Promise<{
  total: number;
  inCapitulation: number;
  refreshed: boolean;
}> {
  // Check staleness
  if (!options.forceRefresh) {
    const newest = await prisma.weeklyCapToken.findFirst({ orderBy: { refreshedAt: "desc" } });
    if (newest) {
      const ageMs = Date.now() - newest.refreshedAt.getTime();
      if (ageMs < UNIVERSE_STALE_HOURS * 60 * 60 * 1000) {
        const total = await prisma.weeklyCapToken.count();
        const inCap = await prisma.weeklyCapToken.count({ where: { inCapitulation: true } });
        return { total, inCapitulation: inCap, refreshed: false };
      }
    }
  }

  console.log("[weekly-cap] Fetching ticker snapshots and market caps…");
  const [tickers, caps] = await Promise.all([
    fetchPerpTickerSnapshots(),
    fetchMarketCapBySymbolUsd(),
  ]);

  const eligible: Array<{ symbol: string; baseSymbol: string; marketCapUsd: number }> = [];
  for (const ticker of tickers) {
    const base = toBaseSymbol(ticker.symbol);
    const cap  = caps.get(base);
    if (cap == null || cap <= 0 || cap > MAX_MARKET_CAP_USD) continue;
    eligible.push({ symbol: ticker.symbol, baseSymbol: base, marketCapUsd: cap });
  }

  console.log(`[weekly-cap] ${eligible.length} eligible tokens (≤$${MAX_MARKET_CAP_USD / 1_000_000}M cap). Computing indicators…`);

  let processed = 0;
  let capCount  = 0;

  for (let i = 0; i < eligible.length; i += CANDLE_CONCURRENCY) {
    const chunk = eligible.slice(i, i + CANDLE_CONCURRENCY);
    await Promise.all(chunk.map(async (entry) => {
      const ind = await computeIndicators(entry.symbol);
      await prisma.weeklyCapToken.upsert({
        where: { symbol: entry.symbol },
        create: {
          symbol: entry.symbol,
          baseSymbol: entry.baseSymbol,
          marketCapUsd: entry.marketCapUsd,
          ...ind,
          addedAt: new Date(),
          refreshedAt: new Date(),
        },
        update: {
          baseSymbol: entry.baseSymbol,
          marketCapUsd: entry.marketCapUsd,
          ...ind,
          refreshedAt: new Date(),
        },
      });
      processed += 1;
      if (ind.inCapitulation) capCount += 1;
    }));

    if ((i / CANDLE_CONCURRENCY) % 5 === 0) {
      console.log(`[weekly-cap]   ${processed}/${eligible.length} processed, ${capCount} in capitulation…`);
    }
  }

  console.log(`[weekly-cap] Universe built: ${processed} tokens, ${capCount} in capitulation.`);
  return { total: processed, inCapitulation: capCount, refreshed: true };
}

export async function getCapitulationTokens(): Promise<WeeklyCapTokenRow[]> {
  const rows = await prisma.weeklyCapToken.findMany({
    where: { inCapitulation: true },
    orderBy: [{ distanceFromAtlPct: "asc" }, { weeklyRsi: "asc" }],
  });
  return rows.map((r) => ({
    symbol: r.symbol,
    baseSymbol: r.baseSymbol,
    marketCapUsd: r.marketCapUsd,
    close: r.close,
    atl365: r.atl365,
    distanceFromAtlPct: r.distanceFromAtlPct,
    weeklyRsi: r.weeklyRsi,
    weeklyStochK: r.weeklyStochK,
    weeklyStochD: r.weeklyStochD,
    weeklyStochCrossUp: r.weeklyStochCrossUp,
    dailyRsi: r.dailyRsi,
    dailyStochK: r.dailyStochK,
    dailyStochD: r.dailyStochD,
    dailyStochCrossUp: r.dailyStochCrossUp,
    inCapitulation: r.inCapitulation,
  }));
}

export async function getAllUniverseTokens(): Promise<WeeklyCapTokenRow[]> {
  const rows = await prisma.weeklyCapToken.findMany({
    orderBy: [{ inCapitulation: "desc" }, { distanceFromAtlPct: "asc" }],
  });
  return rows.map((r) => ({
    symbol: r.symbol,
    baseSymbol: r.baseSymbol,
    marketCapUsd: r.marketCapUsd,
    close: r.close,
    atl365: r.atl365,
    distanceFromAtlPct: r.distanceFromAtlPct,
    weeklyRsi: r.weeklyRsi,
    weeklyStochK: r.weeklyStochK,
    weeklyStochD: r.weeklyStochD,
    weeklyStochCrossUp: r.weeklyStochCrossUp,
    dailyRsi: r.dailyRsi,
    dailyStochK: r.dailyStochK,
    dailyStochD: r.dailyStochD,
    dailyStochCrossUp: r.dailyStochCrossUp,
    inCapitulation: r.inCapitulation,
  }));
}
