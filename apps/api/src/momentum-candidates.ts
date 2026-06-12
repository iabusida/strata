import { CandleInterval, PrismaClient } from "@prisma/client";

export type MomentumCandidate = {
  symbol: string;
  score: number;
  move24hPct: number;
  move48hPct: number;
  vol24hVsPrev24h: number;
  dailyVolVs20dAvg: number;
  dailyRsi14: number | null;
  dailyStochRsiK: number | null;
  dailyStochRsiD: number | null;
  weeklyStochRsiK: number | null;
  weeklyStochRsiD: number | null;
  distanceFrom20dHighPct: number | null;
  broke20dHigh: boolean;
};

export type MomentumCandidatesSnapshot = {
  asOf: string;
  universeSize: number;
  candidatesStrict: number;
  candidatesNear: number;
  strictTop: MomentumCandidate[];
  nearTop: MomentumCandidate[];
  dataFreshness: {
    latestH1: string | null;
    latestD1: string | null;
  };
};

type Candle = {
  ts: number;
  close: number;
  high: number;
  low: number;
  volume: number;
};

type CacheState = {
  payload: MomentumCandidatesSnapshot;
  computedAtMs: number;
};

const CACHE_TTL_MS = 120_000;
const D1_LOOKBACK_DAYS = 220;
const H1_LOOKBACK_HOURS = 84;

let prismaClient: PrismaClient | null = null;
let cacheState: CacheState | null = null;

function getPrismaClient(): PrismaClient {
  if (prismaClient) {
    return prismaClient;
  }

  prismaClient = new PrismaClient();
  return prismaClient;
}

function toNum(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pct(from: number, to: number): number {
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) {
    return 0;
  }

  return ((to - from) / from) * 100;
}

function rsi(values: number[], period: number = 14): number[] {
  if (values.length < period + 1) {
    return [];
  }

  const out: number[] = [];
  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) {
      gain += delta;
    } else {
      loss -= delta;
    }
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;
  out.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss))));

  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const stepGain = delta > 0 ? delta : 0;
    const stepLoss = delta < 0 ? -delta : 0;
    avgGain = ((avgGain * (period - 1)) + stepGain) / period;
    avgLoss = ((avgLoss * (period - 1)) + stepLoss) / period;
    out.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss))));
  }

  return out;
}

function stochRsi(rsiValues: number[], period: number = 14, smoothK: number = 3, smoothD: number = 3): {
  k: number[];
  d: number[];
} {
  if (rsiValues.length < period) {
    return { k: [], d: [] };
  }

  const stoch: number[] = [];
  for (let i = period - 1; i < rsiValues.length; i += 1) {
    const window = rsiValues.slice(i - period + 1, i + 1);
    const lowest = Math.min(...window);
    const highest = Math.max(...window);
    const value = highest === lowest ? 0 : ((rsiValues[i] - lowest) / (highest - lowest)) * 100;
    stoch.push(value);
  }

  const k: number[] = [];
  for (let i = 0; i < stoch.length; i += 1) {
    const window = stoch.slice(Math.max(0, i - smoothK + 1), i + 1);
    k.push(window.reduce((sum, item) => sum + item, 0) / window.length);
  }

  const d: number[] = [];
  for (let i = 0; i < k.length; i += 1) {
    const window = k.slice(Math.max(0, i - smoothD + 1), i + 1);
    d.push(window.reduce((sum, item) => sum + item, 0) / window.length);
  }

  return { k, d };
}

function toWeeklyCandles(daily: Candle[]): Candle[] {
  const weekly: Candle[] = [];

  for (let i = 0; i < daily.length; i += 7) {
    const chunk = daily.slice(i, i + 7);
    if (chunk.length === 0) {
      continue;
    }

    weekly.push({
      ts: chunk[chunk.length - 1].ts,
      close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map((item) => item.high)),
      low: Math.min(...chunk.map((item) => item.low)),
      volume: chunk.reduce((sum, item) => sum + item.volume, 0)
    });
  }

  return weekly;
}

function buildCandidate(input: {
  symbol: string;
  move24: number;
  move48: number;
  vol24Ratio: number;
  volDailyRatio: number;
  dailyRsiNow: number | null;
  dailyRsiPrev: number | null;
  dK: number | null;
  dD: number | null;
  dKPrev: number | null;
  dDPrev: number | null;
  wK: number | null;
  wD: number | null;
  distHighPct: number | null;
  brokeHigh: boolean;
  strict: boolean;
}): MomentumCandidate | null {
  const {
    symbol,
    move24,
    move48,
    vol24Ratio,
    volDailyRatio,
    dailyRsiNow,
    dailyRsiPrev,
    dK,
    dD,
    dKPrev,
    dDPrev,
    wK,
    wD,
    distHighPct,
    brokeHigh,
    strict
  } = input;

  const crossUp = dKPrev != null && dDPrev != null && dK != null && dD != null ? dKPrev <= dDPrev && dK > dD : false;
  const bullishStack = dK != null && dD != null ? dK > dD && dK >= (strict ? 25 : 20) && dK <= (strict ? 82 : 90) : false;
  const dailyNotOverheated = dK != null && dD != null ? !(dK > (strict ? 88 : 95) && dD > (strict ? 85 : 95)) : true;
  const weeklyHealthy = wK == null || wD == null ? true : (wK < (strict ? 80 : 88) && wD < (strict ? 80 : 88));
  const dailyRsiHealthy = dailyRsiNow != null ? dailyRsiNow >= (strict ? 48 : 45) && dailyRsiNow <= (strict ? 74 : 80) : false;
  const dailyRsiRising = dailyRsiNow != null && dailyRsiPrev != null ? dailyRsiNow > dailyRsiPrev : false;

  const notExploded = move48 < (strict ? 80 : 95);
  const earlyMove = move24 > (strict ? 3 : 1) && move24 < (strict ? 35 : 45);
  const volumeIgnition = vol24Ratio >= (strict ? 1.15 : 1.05) || volDailyRatio >= (strict ? 1.35 : 1.15);
  const nearBreakout = distHighPct != null && distHighPct <= (strict ? 5 : 8);

  if (
    !notExploded
    || !earlyMove
    || !volumeIgnition
    || !dailyNotOverheated
    || !dailyRsiHealthy
    || !dailyRsiRising
    || !weeklyHealthy
    || !(crossUp || bullishStack)
    || !nearBreakout
  ) {
    return null;
  }

  const score = strict
    ? (crossUp ? 20 : 10)
      + Math.min(20, Math.max(0, (vol24Ratio - 1) * 25))
      + Math.min(20, Math.max(0, (volDailyRatio - 1) * 15))
      + Math.min(20, Math.max(0, 6 - (distHighPct ?? 6)) * 3)
      + Math.min(20, Math.max(0, move24))
    : (crossUp ? 18 : 9)
      + Math.min(18, Math.max(0, (vol24Ratio - 1) * 20))
      + Math.min(18, Math.max(0, (volDailyRatio - 1) * 12))
      + Math.min(18, Math.max(0, 8 - (distHighPct ?? 8)) * 2.2)
      + Math.min(18, Math.max(0, move24 * 0.8))
      + Math.min(10, Math.max(0, ((dailyRsiNow ?? 50) - 50) / 3));

  return {
    symbol,
    score: Number(score.toFixed(1)),
    move24hPct: Number(move24.toFixed(2)),
    move48hPct: Number(move48.toFixed(2)),
    vol24hVsPrev24h: Number(vol24Ratio.toFixed(2)),
    dailyVolVs20dAvg: Number(volDailyRatio.toFixed(2)),
    dailyRsi14: dailyRsiNow != null ? Number(dailyRsiNow.toFixed(2)) : null,
    dailyStochRsiK: dK != null ? Number(dK.toFixed(2)) : null,
    dailyStochRsiD: dD != null ? Number(dD.toFixed(2)) : null,
    weeklyStochRsiK: wK != null ? Number(wK.toFixed(2)) : null,
    weeklyStochRsiD: wD != null ? Number(wD.toFixed(2)) : null,
    distanceFrom20dHighPct: distHighPct != null ? Number(distHighPct.toFixed(2)) : null,
    broke20dHigh: brokeHigh
  };
}

async function computeMomentumCandidates(limit: number): Promise<MomentumCandidatesSnapshot> {
  const prisma = getPrismaClient();
  const nowMs = Date.now();
  const d1From = new Date(nowMs - D1_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const h1From = new Date(nowMs - H1_LOOKBACK_HOURS * 60 * 60 * 1000);

  const [d1Rows, h1Rows, freshness] = await Promise.all([
    prisma.marketCandle.findMany({
      where: {
        interval: CandleInterval.D1,
        timestamp: { gte: d1From }
      },
      orderBy: [{ symbol: "asc" }, { timestamp: "asc" }],
      select: {
        symbol: true,
        timestamp: true,
        close: true,
        high: true,
        low: true,
        volume: true
      }
    }),
    prisma.marketCandle.findMany({
      where: {
        interval: CandleInterval.H1,
        timestamp: { gte: h1From }
      },
      orderBy: [{ symbol: "asc" }, { timestamp: "asc" }],
      select: {
        symbol: true,
        timestamp: true,
        close: true,
        high: true,
        low: true,
        volume: true
      }
    }),
    prisma.marketCandle.aggregate({
      _max: { timestamp: true },
      where: {
        interval: CandleInterval.H1
      }
    })
  ]);

  const latestD1 = d1Rows.length > 0 ? d1Rows[d1Rows.length - 1].timestamp.toISOString() : null;
  const latestH1 = freshness._max.timestamp ? freshness._max.timestamp.toISOString() : null;

  const d1BySymbol = new Map<string, Candle[]>();
  for (const row of d1Rows) {
    const list = d1BySymbol.get(row.symbol) ?? [];
    list.push({
      ts: new Date(row.timestamp).getTime(),
      close: toNum(row.close),
      high: toNum(row.high),
      low: toNum(row.low),
      volume: toNum(row.volume)
    });
    d1BySymbol.set(row.symbol, list);
  }

  const h1BySymbol = new Map<string, Candle[]>();
  for (const row of h1Rows) {
    const list = h1BySymbol.get(row.symbol) ?? [];
    list.push({
      ts: new Date(row.timestamp).getTime(),
      close: toNum(row.close),
      high: toNum(row.high),
      low: toNum(row.low),
      volume: toNum(row.volume)
    });
    h1BySymbol.set(row.symbol, list);
  }

  const strictCandidates: MomentumCandidate[] = [];
  const nearCandidates: MomentumCandidate[] = [];

  for (const [symbol, daily] of d1BySymbol.entries()) {
    const h1 = h1BySymbol.get(symbol) ?? [];
    if (daily.length < 40 || h1.length < 49) {
      continue;
    }

    const latestH1Candle = h1[h1.length - 1];
    const c24 = h1.find((item) => item.ts >= latestH1Candle.ts - 24 * 60 * 60 * 1000) ?? h1[0];
    const c48 = h1.find((item) => item.ts >= latestH1Candle.ts - 48 * 60 * 60 * 1000) ?? h1[0];

    const move24 = pct(c24.close, latestH1Candle.close);
    const move48 = pct(c48.close, latestH1Candle.close);

    const vol24 = h1
      .filter((item) => item.ts > latestH1Candle.ts - 24 * 60 * 60 * 1000)
      .reduce((sum, item) => sum + item.volume, 0);
    const volPrev24 = h1
      .filter((item) => item.ts <= latestH1Candle.ts - 24 * 60 * 60 * 1000 && item.ts > latestH1Candle.ts - 48 * 60 * 60 * 1000)
      .reduce((sum, item) => sum + item.volume, 0);
    const vol24Ratio = volPrev24 > 0 ? vol24 / volPrev24 : 0;

    const dayVolumes = daily.slice(-21).map((item) => item.volume);
    const avg20 = dayVolumes.slice(0, 20).reduce((sum, item) => sum + item, 0) / Math.max(1, dayVolumes.slice(0, 20).length);
    const latestDailyVol = dayVolumes[dayVolumes.length - 1] ?? 0;
    const volDailyRatio = avg20 > 0 ? latestDailyVol / avg20 : 0;

    const dCloses = daily.map((item) => item.close);
    const dRsiSeries = rsi(dCloses, 14);
    const dStoch = stochRsi(dRsiSeries, 14, 3, 3);
    const dailyRsiNow = dRsiSeries[dRsiSeries.length - 1] ?? null;
    const dailyRsiPrev = dRsiSeries[dRsiSeries.length - 2] ?? null;
    const dK = dStoch.k[dStoch.k.length - 1] ?? null;
    const dD = dStoch.d[dStoch.d.length - 1] ?? null;
    const dKPrev = dStoch.k[dStoch.k.length - 2] ?? null;
    const dDPrev = dStoch.d[dStoch.d.length - 2] ?? null;

    const weekly = toWeeklyCandles(daily);
    const wCloses = weekly.map((item) => item.close);
    const wRsiSeries = rsi(wCloses, 14);
    const wStoch = stochRsi(wRsiSeries, 14, 3, 3);
    const wK = wStoch.k[wStoch.k.length - 1] ?? null;
    const wD = wStoch.d[wStoch.d.length - 1] ?? null;

    const lookback20 = daily.slice(-20);
    const high20 = Math.max(...lookback20.map((item) => item.high));
    const closeNow = daily[daily.length - 1].close;
    const distHighPct = high20 > 0 ? ((high20 - closeNow) / high20) * 100 : null;
    const brokeHigh = closeNow >= high20 * 0.995;

    const strictCandidate = buildCandidate({
      symbol,
      move24,
      move48,
      vol24Ratio,
      volDailyRatio,
      dailyRsiNow,
      dailyRsiPrev,
      dK,
      dD,
      dKPrev,
      dDPrev,
      wK,
      wD,
      distHighPct,
      brokeHigh,
      strict: true
    });

    if (strictCandidate) {
      strictCandidates.push(strictCandidate);
    }

    const nearCandidate = buildCandidate({
      symbol,
      move24,
      move48,
      vol24Ratio,
      volDailyRatio,
      dailyRsiNow,
      dailyRsiPrev,
      dK,
      dD,
      dKPrev,
      dDPrev,
      wK,
      wD,
      distHighPct,
      brokeHigh,
      strict: false
    });

    if (nearCandidate) {
      nearCandidates.push(nearCandidate);
    }
  }

  strictCandidates.sort((left, right) => right.score - left.score);
  nearCandidates.sort((left, right) => right.score - left.score);

  return {
    asOf: new Date().toISOString(),
    universeSize: d1BySymbol.size,
    candidatesStrict: strictCandidates.length,
    candidatesNear: nearCandidates.length,
    strictTop: strictCandidates.slice(0, limit),
    nearTop: nearCandidates.slice(0, limit),
    dataFreshness: {
      latestH1,
      latestD1
    }
  };
}

export async function getMomentumCandidatesSnapshot(input: {
  limit?: number;
  forceRefresh?: boolean;
} = {}): Promise<MomentumCandidatesSnapshot> {
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(50, Math.trunc(input.limit as number))) : 12;
  const forceRefresh = Boolean(input.forceRefresh);
  const nowMs = Date.now();

  if (!forceRefresh && cacheState && nowMs - cacheState.computedAtMs <= CACHE_TTL_MS) {
    return {
      ...cacheState.payload,
      strictTop: cacheState.payload.strictTop.slice(0, limit),
      nearTop: cacheState.payload.nearTop.slice(0, limit)
    };
  }

  const payload = await computeMomentumCandidates(limit);
  cacheState = {
    payload,
    computedAtMs: nowMs
  };

  return payload;
}
