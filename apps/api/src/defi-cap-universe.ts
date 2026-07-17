/**
 * DeFi Spot Capitulation Universe
 *
 * Spot-only scanner for Solana and Ethereum pools discovered from GeckoTerminal.
 * Uses pool OHLCV history to compute daily RSI / stoch RSI and an adaptive weekly
 * RSI / stoch RSI signal for spot reversals.
 */
import "./env.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { RSI } from "technicalindicators";
import { aggregateClosesByBucket, calculateLatestAtr, calculateLatestRsi, calculateStochasticRsi } from "./rsi.js";

const GECKO_API_BASE = "https://api.geckoterminal.com/api/v2";
const NETWORKS = ["solana", "eth"] as const;
const CACHE_FILE = path.resolve(process.cwd(), "data", "defi-cap-state.json");

const MAX_MARKET_CAP_USD = Math.max(10_000_000, Number(process.env.DEFI_CAP_MAX_MARKET_CAP_USD ?? 200_000_000));
const MIN_LIQUIDITY_USD = Math.max(25_000, Number(process.env.DEFI_CAP_MIN_LIQUIDITY_USD ?? 150_000));
const MIN_VOLUME_24H_USD = Math.max(0, Number(process.env.DEFI_CAP_MIN_VOLUME_24H_USD ?? 10_000));
const MIN_POOL_AGE_DAYS = Math.max(30, Number(process.env.DEFI_CAP_MIN_POOL_AGE_DAYS ?? 60));
const DISCOVERY_LIMIT_PER_NETWORK = Math.max(3, Number(process.env.DEFI_CAP_DISCOVERY_LIMIT ?? 5));
const DAILY_HISTORY_LIMIT = Math.max(60, Number(process.env.DEFI_CAP_DAILY_HISTORY_LIMIT ?? 180));
const UNIVERSE_TTL_MS = Math.max(15 * 60 * 1000, Number(process.env.DEFI_CAP_TTL_MS ?? 60 * 60 * 1000));
const WEEKLY_RSI_PERIOD = Math.max(5, Number(process.env.DEFI_CAP_WEEKLY_RSI_PERIOD ?? 7));
const WEEKLY_STOCH_PERIOD = Math.max(5, Number(process.env.DEFI_CAP_WEEKLY_STOCH_PERIOD ?? 7));

const supportedQuotes: Record<(typeof NETWORKS)[number], Set<string>> = {
  solana: new Set(["SOL", "USDC", "USDT"]),
  eth: new Set(["ETH", "WETH", "USDC", "USDT"])
};

type GeckoPool = {
  id: string;
  type: string;
  attributes?: {
    address?: string;
    name?: string;
    pool_created_at?: string;
    fdv_usd?: string;
    market_cap_usd?: string;
    reserve_in_usd?: string;
    price_change_percentage?: {
      h24?: string;
      h6?: string;
      h1?: string;
    };
    volume_usd?: {
      h24?: string;
    };
  };
  relationships?: {
    dex?: { data?: { id?: string } };
  };
};

type GeckoPoolsResponse = {
  data?: GeckoPool[];
};

type GeckoOhlcvResponse = {
  data?: {
    attributes?: {
      ohlcv_list?: Array<[number, number, number, number, number, number]>;
    };
  };
};

type NormalizedPool = {
  network: (typeof NETWORKS)[number];
  poolId: string;
  poolAddress: string;
  pairName: string;
  baseSymbol: string;
  quoteSymbol: string;
  dex: string | null;
  marketCapUsd: number;
  fdvUsd: number | null;
  liquidityUsd: number;
  volume24hUsd: number;
  priceChange24hPct: number | null;
  ageDays: number;
};

export type DefiCapSetupStatus = "REVERSAL_READY" | "REVERSAL_WATCH" | "NO_SETUP";

export type DefiCapTokenRow = {
  network: (typeof NETWORKS)[number];
  poolId: string;
  poolAddress: string;
  pairName: string;
  baseSymbol: string;
  quoteSymbol: string;
  dex: string | null;
  marketCapUsd: number;
  fdvUsd: number | null;
  liquidityUsd: number;
  volume24hUsd: number;
  priceChange24hPct: number | null;
  ageDays: number;
  close: number;
  weeklyRsi: number | null;
  weeklyStochK: number | null;
  weeklyStochD: number | null;
  weeklyStochCrossUp: boolean;
  dailyRsi: number | null;
  dailyStochK: number | null;
  dailyStochD: number | null;
  dailyStochCrossUp: boolean;
  dailyAtrPct: number | null;
  distanceFromAtlPct: number | null;
  candleCount: number;
  inCapitulation: boolean;
  status: DefiCapSetupStatus;
  refreshedAt: string;
};

export type DefiCapState = {
  refreshedAt: string;
  total: number;
  inCapitulation: number;
  rows: DefiCapTokenRow[];
};

type WeeklyStochResult = {
  k: number;
  d: number;
  prevK: number;
  prevD: number;
} | null;

function toNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAgeDays(createdAt: string | undefined): number | null {
  if (!createdAt) return null;
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return null;
  return Math.floor((Date.now() - createdMs) / 86_400_000);
}

function extractBaseSymbol(pairName: string | undefined): string {
  if (!pairName) return "";
  return pairName.split("/")[0].trim().toUpperCase();
}

function extractQuoteSymbol(pairName: string | undefined): string {
  if (!pairName) return "";
  return pairName.split("/")[1]?.trim().toUpperCase() ?? "";
}

function pairSupported(network: (typeof NETWORKS)[number], quoteSymbol: string): boolean {
  return supportedQuotes[network].has(quoteSymbol);
}

async function fetchJson<T>(url: string): Promise<T> {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (res.ok) {
        return await res.json() as T;
      }

      const body = await res.text().catch(() => "");
      if (res.status === 429 && attempt < maxAttempts) {
        const retryAfterSec = Number(res.headers.get("retry-after") ?? "0");
        const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : 5000 * attempt;
        await sleep(delayMs);
        continue;
      }

      throw new Error(`fetch failed ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`fetch failed after ${maxAttempts} attempts: ${url}`);
}

async function fetchPoolsForNetwork(network: (typeof NETWORKS)[number], endpoint: string): Promise<GeckoPool[]> {
  const url = `${GECKO_API_BASE}/networks/${network}/${endpoint}`;
  const payload = await fetchJson<GeckoPoolsResponse>(url);
  return payload.data ?? [];
}

async function fetchOhlcvDay(network: (typeof NETWORKS)[number], poolAddress: string): Promise<Array<[number, number, number, number, number, number]>> {
  const url = `${GECKO_API_BASE}/networks/${network}/pools/${poolAddress}/ohlcv/day?aggregate=1&limit=${DAILY_HISTORY_LIMIT}`;
  const payload = await fetchJson<GeckoOhlcvResponse>(url);
  const list = payload.data?.attributes?.ohlcv_list ?? [];
  return list
    .filter((row): row is [number, number, number, number, number, number] => Array.isArray(row) && row.length >= 6)
    .sort((a, b) => a[0] - b[0]);
}

function buildAdaptiveWeeklyStoch(closes: number[], rsiPeriod: number, stochPeriod: number, kPeriod = 3, dPeriod = 3): WeeklyStochResult {
  if (closes.length < rsiPeriod + stochPeriod + kPeriod + dPeriod) {
    return null;
  }

  const rsiSeries = RSI.calculate({ period: rsiPeriod, values: closes });
  if (rsiSeries.length < stochPeriod + kPeriod + dPeriod) {
    return null;
  }

  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i += 1) {
    const window = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const min = Math.min(...window);
    const max = Math.max(...window);
    rawK.push(max === min ? 0 : ((rsiSeries[i] - min) / (max - min)) * 100);
  }

  if (rawK.length < kPeriod + dPeriod) {
    return null;
  }

  const smoothK: number[] = [];
  for (let i = kPeriod - 1; i < rawK.length; i += 1) {
    const slice = rawK.slice(i - kPeriod + 1, i + 1);
    smoothK.push(slice.reduce((a, b) => a + b, 0) / kPeriod);
  }

  if (smoothK.length < dPeriod + 1) {
    return null;
  }

  const smoothD: number[] = [];
  for (let i = dPeriod - 1; i < smoothK.length; i += 1) {
    const slice = smoothK.slice(i - dPeriod + 1, i + 1);
    smoothD.push(slice.reduce((a, b) => a + b, 0) / dPeriod);
  }

  return {
    k: Number(smoothK.at(-1)!.toFixed(2)),
    d: Number(smoothD.at(-1)!.toFixed(2)),
    prevK: Number(smoothK.at(-2)!.toFixed(2)),
    prevD: Number(smoothD.at(-2)!.toFixed(2))
  };
}

function buildWeeklyCloses(dailyCloses: number[]): number[] {
  return aggregateClosesByBucket(dailyCloses, 7);
}

function getPoolScore(pool: GeckoPool): number {
  const attrs = pool.attributes ?? {};
  const priceChange24h = toNumber(attrs.price_change_percentage?.h24);
  const marketCap = toNumber(attrs.market_cap_usd);
  const liquidity = toNumber(attrs.reserve_in_usd);

  const changeScore = priceChange24h ?? 0;
  const capScore = marketCap ?? Number.POSITIVE_INFINITY;
  const liquidityScore = liquidity ?? 0;

  return changeScore * 1_000_000 + capScore - liquidityScore;
}

function normalizePool(network: (typeof NETWORKS)[number], pool: GeckoPool): NormalizedPool | null {
  const attrs = pool.attributes ?? {};
  const pairName = (attrs.name ?? "").trim().toUpperCase();
  const baseSymbol = extractBaseSymbol(pairName);
  const quoteSymbol = extractQuoteSymbol(pairName);
  const poolAddress = (attrs.address ?? "").trim();
  const dex = pool.relationships?.dex?.data?.id?.trim() ?? null;
  const ageDays = parseAgeDays(attrs.pool_created_at);
  const marketCapUsd = toNumber(attrs.market_cap_usd);
  const fdvUsd = toNumber(attrs.fdv_usd);
  const liquidityUsd = toNumber(attrs.reserve_in_usd);
  const volume24hUsd = toNumber(attrs.volume_usd?.h24);
  const priceChange24hPct = toNumber(attrs.price_change_percentage?.h24);

  if (!pairName || !poolAddress || !baseSymbol || !quoteSymbol || ageDays == null) {
    return null;
  }

  if (!pairSupported(network, quoteSymbol)) {
    return null;
  }

  if (marketCapUsd == null || marketCapUsd <= 0 || marketCapUsd > MAX_MARKET_CAP_USD) {
    return null;
  }

  if (liquidityUsd == null || liquidityUsd < MIN_LIQUIDITY_USD) {
    return null;
  }

  if (volume24hUsd == null || volume24hUsd < MIN_VOLUME_24H_USD) {
    return null;
  }

  if (ageDays < MIN_POOL_AGE_DAYS) {
    return null;
  }

  return {
    network,
    poolId: pool.id,
    poolAddress,
    pairName,
    baseSymbol,
    quoteSymbol,
    dex,
    marketCapUsd,
    fdvUsd,
    liquidityUsd,
    volume24hUsd,
    priceChange24hPct,
    ageDays
  };
}

async function discoverPools(): Promise<NormalizedPool[]> {
  const seen = new Set<string>();
  const discovered: NormalizedPool[] = [];

  for (const network of NETWORKS) {
    const endpoints = ["trending_pools", "pools?page=1"];
    const rawPools: GeckoPool[] = [];

    for (const endpoint of endpoints) {
      const pools = await fetchPoolsForNetwork(network, endpoint);
      rawPools.push(...pools.slice(0, DISCOVERY_LIMIT_PER_NETWORK));
      await sleep(300);
    }

    for (const pool of rawPools) {
      const normalized = normalizePool(network, pool);
      if (!normalized) continue;
      if (seen.has(normalized.poolId)) continue;
      seen.add(normalized.poolId);
      discovered.push(normalized);
    }
  }

  discovered.sort((a, b) => {
    if (!a || !b) return 0;
    const aChange = a.priceChange24hPct ?? 0;
    const bChange = b.priceChange24hPct ?? 0;
    if (aChange !== bChange) return aChange - bChange;
    if (a.marketCapUsd !== b.marketCapUsd) return a.marketCapUsd - b.marketCapUsd;
    return b.liquidityUsd - a.liquidityUsd;
  });

  return discovered;
}

function isCrossUp(currentK: number, currentD: number, previousK: number, previousD: number): boolean {
  return previousK <= previousD && currentK > currentD;
}

export async function buildDefiCapUniverse(forceRefresh = false): Promise<DefiCapState> {
  const cached = await readDefiCapState();
  if (!forceRefresh && cached && Date.now() - Date.parse(cached.refreshedAt) < UNIVERSE_TTL_MS) {
    return cached;
  }

  const discovered = await discoverPools();
  const rows: DefiCapTokenRow[] = [];

  for (const pool of discovered) {
    const candles = await fetchOhlcvDay(pool.network, pool.poolAddress);
    if (candles.length < 35) {
      continue;
    }

    const closes = candles.map((row) => row[4]);
    const highs = candles.map((row) => row[2]);
    const lows = candles.map((row) => row[3]);
    const latestClose = closes.at(-1) ?? NaN;
    if (!Number.isFinite(latestClose) || latestClose <= 0) {
      continue;
    }

    const dailyRsi = calculateLatestRsi(closes, 14);
    const dailyStoch = calculateStochasticRsi(closes, 14, 14, 3, 3);
    const dailyAtr = calculateLatestAtr(highs, lows, closes, 14);

    const weeklyCloses = buildWeeklyCloses(closes);
    const weeklyRsiSeries = weeklyCloses.length >= WEEKLY_RSI_PERIOD + 1
      ? RSI.calculate({ period: WEEKLY_RSI_PERIOD, values: weeklyCloses })
      : [];
    const weeklyRsi = weeklyRsiSeries.at(-1) ?? null;
    const weeklyRsiPrev = weeklyRsiSeries.at(-2) ?? null;
    const weeklyStoch = weeklyCloses.length >= WEEKLY_RSI_PERIOD + WEEKLY_STOCH_PERIOD + 6
      ? buildAdaptiveWeeklyStoch(weeklyCloses, WEEKLY_RSI_PERIOD, WEEKLY_STOCH_PERIOD)
      : null;

    const dailyStochCrossUp = dailyStoch
      ? isCrossUp(dailyStoch.k, dailyStoch.d, dailyStoch.prevK, dailyStoch.prevD)
      : false;
    const weeklyStochCrossUp = weeklyStoch
      ? isCrossUp(weeklyStoch.k, weeklyStoch.d, weeklyStoch.prevK, weeklyStoch.prevD)
      : false;
    const weeklyRsiMomentumUp = weeklyRsi != null && weeklyRsiPrev != null && weeklyRsi > weeklyRsiPrev;

    const atl = Math.min(...closes);
    const distanceFromAtlPct = atl > 0 ? ((latestClose - atl) / atl) * 100 : null;
    const atrPct = dailyAtr != null ? (dailyAtr / latestClose) * 100 : null;
    const inCapitulation = weeklyRsi != null && weeklyRsi < 38;
    const status: DefiCapSetupStatus = inCapitulation
      ? ((weeklyStochCrossUp || weeklyRsiMomentumUp) && dailyStochCrossUp ? "REVERSAL_READY" : "REVERSAL_WATCH")
      : "NO_SETUP";

    rows.push({
      network: pool.network,
      poolId: pool.poolId,
      poolAddress: pool.poolAddress,
      pairName: pool.pairName,
      baseSymbol: pool.baseSymbol,
      quoteSymbol: pool.quoteSymbol,
      dex: pool.dex,
      marketCapUsd: pool.marketCapUsd,
      fdvUsd: pool.fdvUsd,
      liquidityUsd: pool.liquidityUsd,
      volume24hUsd: pool.volume24hUsd,
      priceChange24hPct: pool.priceChange24hPct,
      ageDays: pool.ageDays,
      close: latestClose,
      weeklyRsi,
      weeklyStochK: weeklyStoch?.k ?? null,
      weeklyStochD: weeklyStoch?.d ?? null,
      weeklyStochCrossUp,
      dailyRsi,
      dailyStochK: dailyStoch?.k ?? null,
      dailyStochD: dailyStoch?.d ?? null,
      dailyStochCrossUp,
      dailyAtrPct: atrPct,
      distanceFromAtlPct,
      candleCount: candles.length,
      inCapitulation,
      status,
      refreshedAt: new Date().toISOString()
    });
  }

  rows.sort((a, b) => {
    if (a.status !== b.status) {
      if (a.status === "REVERSAL_READY") return -1;
      if (b.status === "REVERSAL_READY") return 1;
      if (a.status === "REVERSAL_WATCH") return -1;
      if (b.status === "REVERSAL_WATCH") return 1;
    }

    const aChange = a.priceChange24hPct ?? 0;
    const bChange = b.priceChange24hPct ?? 0;
    if (aChange !== bChange) return aChange - bChange;
    return a.marketCapUsd - b.marketCapUsd;
  });

  const state: DefiCapState = {
    refreshedAt: new Date().toISOString(),
    total: rows.length,
    inCapitulation: rows.filter((row) => row.inCapitulation).length,
    rows
  };

  await writeDefiCapState(state);
  return state;
}

export async function readDefiCapState(): Promise<DefiCapState | null> {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as DefiCapState;
    if (!parsed || !Array.isArray(parsed.rows)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeDefiCapState(state: DefiCapState): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function getDefiCapRows(): Promise<DefiCapTokenRow[]> {
  const state = await readDefiCapState();
  return state?.rows ?? [];
}

export async function getDefiCapCapitulationRows(): Promise<DefiCapTokenRow[]> {
  const rows = await getDefiCapRows();
  return rows.filter((row) => row.inCapitulation);
}

export async function runDefiCapMonitorCycle(): Promise<{ checked: number; watch: number; alerts: number }> {
  const state = await buildDefiCapUniverse(true);
  const watch = state.rows.filter((row) => row.status === "REVERSAL_WATCH").length;
  const alerts = state.rows.filter((row) => row.status === "REVERSAL_READY").length;
  return { checked: state.rows.length, watch, alerts };
}

export async function startDefiCapMonitorService(): Promise<void> {
  const intervalMinutes = Math.max(5, Number(process.env.DEFI_CAP_MONITOR_INTERVAL_MINUTES ?? 15));
  const intervalMs = intervalMinutes * 60_000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const summary = await runDefiCapMonitorCycle();
    console.log(`[defi-cap] cycle complete: checked=${summary.checked} watch=${summary.watch} alerts=${summary.alerts}`);
    await sleep(intervalMs);
  }
}
