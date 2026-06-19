import "./env.js";

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";

const CRYPTO_SYMBOL_BLOCKLIST = new Set([
  "BTC", "ETH", "SOL", "XRP", "DOGE", "AVAX", "LINK", "DOT", "MATIC", "ADA", "LTC", "UNI",
  "AAVE", "ATOM", "FIL", "NEAR", "ALGO", "XLM", "ETC", "ARB", "OP", "INJ", "APT", "SUI",
  "BNB", "TRX", "TON", "BCH", "HBAR", "SHIB", "PEPE", "MANA", "AIXBT", "OM", "MANTA"
]);

export type FinnhubStockQuote = {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  timestamp: number;
};

function getFinnhubApiKey(): string {
  const key = String(process.env.FINNHUB_API_KEY ?? "").trim();
  if (!key) {
    throw new Error("FINNHUB_API_KEY is missing");
  }
  return key;
}

export function normalizeStockSymbol(input: string): string {
  const symbol = String(input).trim().toUpperCase();
  if (!symbol) {
    throw new Error("Stock symbol is required");
  }

  if (!/^[A-Z0-9.-]{1,15}$/.test(symbol)) {
    throw new Error(`Invalid stock symbol format: ${symbol}`);
  }

  if (CRYPTO_SYMBOL_BLOCKLIST.has(symbol)) {
    throw new Error(`Blocked crypto symbol for stock endpoint: ${symbol}`);
  }

  return symbol;
}

export async function fetchFinnhubStockQuote(rawSymbol: string): Promise<FinnhubStockQuote> {
  const symbol = normalizeStockSymbol(rawSymbol);
  const token = getFinnhubApiKey();

  const url = new URL(`${FINNHUB_BASE_URL}/quote`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("token", token);

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Finnhub quote request failed (${response.status}): ${body}`.trim());
  }

  const payload = await response.json() as {
    c?: number;
    d?: number;
    dp?: number;
    h?: number;
    l?: number;
    o?: number;
    pc?: number;
    t?: number;
  };

  const price = Number(payload.c ?? 0);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Finnhub returned empty/invalid quote for ${symbol}`);
  }

  return {
    symbol,
    price,
    change: Number(payload.d ?? 0),
    changePercent: Number(payload.dp ?? 0),
    high: Number(payload.h ?? 0),
    low: Number(payload.l ?? 0),
    open: Number(payload.o ?? 0),
    previousClose: Number(payload.pc ?? 0),
    timestamp: Number(payload.t ?? 0),
  };
}

export async function fetchFinnhubStockQuotes(rawSymbols: string[]): Promise<FinnhubStockQuote[]> {
  const symbols = Array.from(
    new Set(rawSymbols.map((s) => normalizeStockSymbol(s)).filter(Boolean))
  );

  const quotes = await Promise.all(symbols.map((symbol) => fetchFinnhubStockQuote(symbol)));
  return quotes;
}

export type FinnhubCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type FinnhubCandleResponse = {
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
  t?: number[];
  s?: string; // status: "ok" or "no_data"
};

const resolutionMap: Record<string, string> = {
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "12h": "720",
  "1d": "D"
};

/**
 * Fetch historical candle data for a stock
 */
export async function fetchStockCandles(
  rawSymbol: string,
  interval: "15m" | "1h" | "4h" | "12h" | "1d",
  fromTimestamp: number,
  toTimestamp: number,
  maxRetries = 5
): Promise<FinnhubCandle[]> {
  const symbol = normalizeStockSymbol(rawSymbol);
  const token = getFinnhubApiKey();
  const resolution = resolutionMap[interval];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = new URL(`${FINNHUB_BASE_URL}/stock/candle`);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("resolution", resolution);
      url.searchParams.set("from", Math.floor(fromTimestamp / 1000).toString());
      url.searchParams.set("to", Math.floor(toTimestamp / 1000).toString());
      url.searchParams.set("token", token);

      const response = await fetch(url.toString(), {
        headers: { Accept: "application/json" }
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const status = response.status;
        
        // Rate limit - retry with exponential backoff
        if (status === 429 && attempt < maxRetries) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          console.log(`[${symbol}] Rate limited, retry ${attempt}/${maxRetries} after ${delayMs}ms`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }

        throw new Error(`Finnhub candle request failed (${status}): ${body}`.trim());
      }

      const data = (await response.json()) as FinnhubCandleResponse;

      // Check for API errors or no data
      if (!data.o || !data.h || !data.l || !data.c || !data.t || data.s !== "ok") {
        console.log(`[${symbol}] No candle data from Finnhub for ${interval}`);
        return [];
      }

      // Convert arrays to candle objects
      const candles: FinnhubCandle[] = data.t!.map((ts, idx) => ({
        timestamp: ts * 1000, // Convert to milliseconds
        open: data.o![idx] ?? 0,
        high: data.h![idx] ?? 0,
        low: data.l![idx] ?? 0,
        close: data.c![idx] ?? 0,
        volume: data.v?.[idx] ?? 0
      }));

      return candles;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Transient errors - retry
      if (errorMsg.includes("fetch") && attempt < maxRetries) {
        const delayMs = 500 * attempt;
        console.log(`[${symbol}] Transient error, retry ${attempt}/${maxRetries} after ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }

      // Log and give up
      console.error(
        `[${symbol}] Error fetching ${interval} candles from Finnhub (attempt ${attempt}/${maxRetries}):`,
        errorMsg
      );

      if (attempt === maxRetries) {
        throw new Error(`Failed to fetch ${symbol} ${interval} candles after ${maxRetries} attempts: ${errorMsg}`);
      }
    }
  }

  return [];
}

/**
 * Get list of popular US stock symbols
 */
export function getPopularStockSymbols(): string[] {
  return [
    // Mega cap tech
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA",
    // Large cap financial
    "JPM", "BAC", "WFC", "GS", "MS",
    // Energy
    "XOM", "CVX", "COP",
    // Consumer discretionary
    "WMT", "KO", "MCD", "NKE", "SBUX",
    // Healthcare
    "JNJ", "UNH", "PFE", "ABBV",
    // Industrials
    "BA", "CAT", "GE",
    // Other large caps
    "IBM", "CSCO", "INTC", "AMD", "GILD"
  ];
}