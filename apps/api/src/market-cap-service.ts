import "./env.js";

type CoinPaprikaTicker = {
  symbol?: string;
  rank?: number;
  quotes?: {
    USD?: {
      market_cap?: number | null;
    };
  };
};

const MARKET_CAP_CACHE_TTL_MS = Math.max(60_000, Number(process.env.SCAN_MARKET_CAP_CACHE_TTL_MS ?? 15 * 60 * 1000));
const MARKET_CAP_FETCH_TIMEOUT_MS = Math.max(3_000, Number(process.env.SCAN_MARKET_CAP_FETCH_TIMEOUT_MS ?? 20_000));
const MARKET_CAP_MAX_RANK = Math.max(100, Number(process.env.SCAN_MARKET_CAP_MAX_RANK ?? 1500));

let cacheAtMs = 0;
let cache: Map<string, number> | null = null;

async function fetchCoinPaprikaTickers(): Promise<CoinPaprikaTicker[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MARKET_CAP_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.coinpaprika.com/v1/tickers", {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`coinpaprika tickers fetch failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as CoinPaprikaTicker[];
    if (!Array.isArray(payload)) {
      throw new Error("coinpaprika tickers response is not an array");
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchMarketCapBySymbolUsd(): Promise<Map<string, number>> {
  const now = Date.now();
  if (cache && now - cacheAtMs < MARKET_CAP_CACHE_TTL_MS) {
    return new Map(cache);
  }

  const tickers = await fetchCoinPaprikaTickers();
  const next = new Map<string, number>();

  for (const ticker of tickers) {
    const symbol = String(ticker.symbol ?? "").trim().toUpperCase();
    if (!symbol) {
      continue;
    }

    const rank = Number(ticker.rank ?? Number.POSITIVE_INFINITY);
    if (!Number.isFinite(rank) || rank <= 0 || rank > MARKET_CAP_MAX_RANK) {
      continue;
    }

    const marketCap = Number(ticker.quotes?.USD?.market_cap ?? 0);
    if (!Number.isFinite(marketCap) || marketCap <= 0) {
      continue;
    }

    const current = next.get(symbol);
    if (current == null || marketCap > current) {
      next.set(symbol, marketCap);
    }
  }

  cache = next;
  cacheAtMs = now;
  return new Map(next);
}
