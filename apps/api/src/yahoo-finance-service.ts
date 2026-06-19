/**
 * Yahoo Finance stock data service
 * Free API, no authentication required
 */

const YAHOO_FINANCE_API = "https://query1.finance.yahoo.com/v8/finance/chart";

export type YahooCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type YahooChartResponse = {
  chart: {
    result: Array<{
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: number[];
          high: number[];
          low: number[];
          close: number[];
          volume: number[];
        }>;
      };
    }>;
    error: null | { code: string; description: string };
  };
};

const intervalMap: Record<string, string> = {
  "15m": "15m",
  "1h": "1h",
  "4h": "1h",   // Yahoo doesn't support 4h, use 1h
  "12h": "1d",  // Yahoo doesn't support 12h, use 1d
  "1d": "1d"
};

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchYahooChart(
  symbol: string,
  interval: string,
  startTimestamp: number,
  endTimestamp: number,
  maxRetries = 5
): Promise<YahooCandle[]> {
  const yahooInterval = intervalMap[interval] || "1d";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = new URL(`${YAHOO_FINANCE_API}/${symbol}`);
      url.searchParams.set("interval", yahooInterval);
      url.searchParams.set("period1", Math.floor(startTimestamp / 1000).toString());
      url.searchParams.set("period2", Math.floor(endTimestamp / 1000).toString());

      const response = await fetch(url.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; HypeTrading/1.0)"
        }
      });

      if (!response.ok) {
        throw new Error(`Yahoo Finance API returned ${response.status}`);
      }

      const data = (await response.json()) as YahooChartResponse;

      if (data.chart.error) {
        throw new Error(`Yahoo Finance error: ${data.chart.error.description}`);
      }

      if (!data.chart.result || data.chart.result.length === 0) {
        return [];
      }

      const result = data.chart.result[0];
      if (!result.timestamp || !result.indicators?.quote?.[0]) {
        return [];
      }

      const quote = result.indicators.quote[0];
      const candles: YahooCandle[] = [];

      for (let i = 0; i < result.timestamp.length; i++) {
        const timestamp = result.timestamp[i] * 1000; // Convert to milliseconds

        // Skip if values are missing
        if (
          quote.open?.[i] == null ||
          quote.high?.[i] == null ||
          quote.low?.[i] == null ||
          quote.close?.[i] == null
        ) {
          continue;
        }

        candles.push({
          timestamp,
          open: quote.open[i],
          high: quote.high[i],
          low: quote.low[i],
          close: quote.close[i],
          volume: quote.volume?.[i] ?? 0
        });
      }

      return candles;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Rate limiting - retry with backoff
      if (errorMsg.includes("429") && attempt < maxRetries) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.log(`[${symbol}] Rate limited, retry ${attempt}/${maxRetries} after ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }

      // Transient errors - retry
      if ((errorMsg.includes("timeout") || errorMsg.includes("ECONNREFUSED")) && attempt < maxRetries) {
        const delayMs = 500 * attempt;
        console.log(`[${symbol}] Transient error, retry ${attempt}/${maxRetries} after ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }

      console.error(
        `[${symbol}] Error fetching ${interval} from Yahoo Finance (attempt ${attempt}/${maxRetries}):`,
        errorMsg
      );

      if (attempt === maxRetries) {
        throw new Error(`Failed to fetch ${symbol} ${interval} after ${maxRetries} attempts: ${errorMsg}`);
      }
    }
  }

  return [];
}

/**
 * Fetch stock candles from Yahoo Finance
 * Note: Yahoo Finance has limited interval support:
 * - 15m, 1h are supported
 * - 4h/12h will be fetched as 1h/1d and aggregated in caller
 */
export async function fetchStockCandles(
  symbol: string,
  interval: "15m" | "1h" | "4h" | "12h" | "1d",
  fromTimestamp: number,
  toTimestamp: number
): Promise<YahooCandle[]> {
  const normalizedSymbol = String(symbol).trim().toUpperCase();
  
  if (!normalizedSymbol.match(/^[A-Z0-9\-]{1,10}$/)) {
    throw new Error(`Invalid stock symbol: ${symbol}`);
  }

  return fetchYahooChart(normalizedSymbol, interval, fromTimestamp, toTimestamp);
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

/**
 * Validate if a symbol is a valid stock ticker
 */
export function isValidStockSymbol(symbol: string): boolean {
  return /^[A-Z]{1,5}$/.test(symbol.toUpperCase());
}
