import "./env.js";
import { fetchPerpTickerSnapshots, type BitunixPerpTickerSnapshot } from "./bitunix-service.js";
import { fetchMarketCapBySymbolUsd } from "./market-cap-service.js";

export type BurstUniverseCandidate = {
  symbol: string;
  baseSymbol: string;
  marketCapUsd: number;
  volume24hUsd: number;
  volume1hUsd: number;
  change24hPct: number | null;
};

const BURST_CACHE_TTL_MS = Math.max(60_000, Number(process.env.SCAN_BURST_UNIVERSE_CACHE_TTL_MS ?? 10 * 60 * 1000));
const BURST_MIN_HOURLY_VOLUME_USD = Math.max(0, Number(process.env.SCAN_BURST_MIN_HOURLY_VOLUME_USD ?? 0));
const BURST_MAX_MARKET_CAP_USD = Math.max(1_000_000, Number(process.env.SCAN_BURST_MAX_MARKET_CAP_USD ?? 150_000_000));
const BURST_UNIVERSE_MAX_SYMBOLS = (() => {
  const raw = process.env.SCAN_BURST_UNIVERSE_MAX_SYMBOLS;
  if (raw == null || raw.trim() === "") {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : Number.POSITIVE_INFINITY;
})();

let cachedAtMs = 0;
let cachedCandidates: BurstUniverseCandidate[] | null = null;

function toBaseSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (upper.endsWith("-PERP")) {
    return upper.slice(0, -5);
  }
  if (upper.endsWith("USDT")) {
    return upper.slice(0, -4);
  }
  return upper;
}

function rankCandidates(rows: BurstUniverseCandidate[]): BurstUniverseCandidate[] {
  return [...rows].sort((a, b) => {
    if (b.volume1hUsd !== a.volume1hUsd) {
      return b.volume1hUsd - a.volume1hUsd;
    }

    const aChange = Math.abs(a.change24hPct ?? 0);
    const bChange = Math.abs(b.change24hPct ?? 0);
    if (bChange !== aChange) {
      return bChange - aChange;
    }

    return a.marketCapUsd - b.marketCapUsd;
  });
}

function toCandidate(snapshot: BitunixPerpTickerSnapshot, marketCapUsd: number): BurstUniverseCandidate {
  return {
    symbol: snapshot.symbol,
    baseSymbol: toBaseSymbol(snapshot.symbol),
    marketCapUsd,
    volume24hUsd: snapshot.volume24hUsd,
    volume1hUsd: snapshot.volume24hUsd / 24,
    change24hPct: snapshot.change24hPct
  };
}

async function computeCandidates(): Promise<BurstUniverseCandidate[]> {
  const [tickerSnapshots, marketCaps] = await Promise.all([
    fetchPerpTickerSnapshots(),
    fetchMarketCapBySymbolUsd()
  ]);

  const lowCapCandidates: BurstUniverseCandidate[] = [];

  for (const snapshot of tickerSnapshots) {
    const baseSymbol = toBaseSymbol(snapshot.symbol);
    const marketCapUsd = marketCaps.get(baseSymbol);
    if (marketCapUsd == null || marketCapUsd <= 0) {
      continue;
    }

    const candidate = toCandidate(snapshot, marketCapUsd);
    if (candidate.marketCapUsd > BURST_MAX_MARKET_CAP_USD) {
      continue;
    }

    lowCapCandidates.push(candidate);
  }

  if (lowCapCandidates.length === 0) {
    return [];
  }

  const candidates: BurstUniverseCandidate[] = [];
  for (const candidate of lowCapCandidates) {

    if (candidate.volume1hUsd < BURST_MIN_HOURLY_VOLUME_USD) {
      continue;
    }

    candidates.push(candidate);
  }

  const ranked = rankCandidates(candidates);
  if (ranked.length > 0) {
    return ranked.slice(0, BURST_UNIVERSE_MAX_SYMBOLS);
  }

  return rankCandidates(lowCapCandidates).slice(0, BURST_UNIVERSE_MAX_SYMBOLS);
}

export async function fetchBurstUniverseCandidates(): Promise<BurstUniverseCandidate[]> {
  const now = Date.now();
  if (cachedCandidates && now - cachedAtMs < BURST_CACHE_TTL_MS) {
    return [...cachedCandidates];
  }

  const candidates = await computeCandidates();
  cachedCandidates = candidates;
  cachedAtMs = now;
  return [...candidates];
}

export async function fetchBurstUniverseSymbols(): Promise<string[]> {
  const candidates = await fetchBurstUniverseCandidates();
  return candidates.map((candidate) => candidate.symbol);
}

export async function inspectBurstUniverseStats(): Promise<{
  snapshots: number;
  withMarketCap: number;
  lowCap: number;
  highHourlyVolume: number;
  finalCandidates: number;
  topByHourlyVolume: Array<{
    symbol: string;
    baseSymbol: string;
    volume1hUsd: number;
    marketCapUsd: number | null;
    change24hPct: number | null;
  }>;
}> {
  const [tickerSnapshots, marketCaps] = await Promise.all([
    fetchPerpTickerSnapshots(),
    fetchMarketCapBySymbolUsd()
  ]);

  let withMarketCap = 0;
  let lowCap = 0;
  let highHourlyVolume = 0;
  let finalCandidates = 0;

  const topByHourlyVolume = [...tickerSnapshots]
    .sort((a, b) => (b.volume24hUsd / 24) - (a.volume24hUsd / 24))
    .slice(0, 20)
    .map((snapshot) => {
      const baseSymbol = toBaseSymbol(snapshot.symbol);
      const marketCapUsd = marketCaps.get(baseSymbol) ?? null;
      return {
        symbol: snapshot.symbol,
        baseSymbol,
        volume1hUsd: snapshot.volume24hUsd / 24,
        marketCapUsd,
        change24hPct: snapshot.change24hPct
      };
    });

  for (const snapshot of tickerSnapshots) {
    const baseSymbol = toBaseSymbol(snapshot.symbol);
    const marketCapUsd = marketCaps.get(baseSymbol);
    if (marketCapUsd == null || marketCapUsd <= 0) {
      continue;
    }
    withMarketCap += 1;

    if (marketCapUsd > BURST_MAX_MARKET_CAP_USD) {
      continue;
    }
    lowCap += 1;
  }

  for (const snapshot of tickerSnapshots) {
    const baseSymbol = toBaseSymbol(snapshot.symbol);
    const marketCapUsd = marketCaps.get(baseSymbol);
    if (marketCapUsd == null || marketCapUsd <= 0 || marketCapUsd > BURST_MAX_MARKET_CAP_USD) {
      continue;
    }

    const volume1hUsd = snapshot.volume24hUsd / 24;
    if (volume1hUsd < BURST_MIN_HOURLY_VOLUME_USD) {
      continue;
    }
    highHourlyVolume += 1;
    finalCandidates += 1;
  }

  return {
    snapshots: tickerSnapshots.length,
    withMarketCap,
    lowCap,
    highHourlyVolume,
    finalCandidates,
    topByHourlyVolume
  };
}
