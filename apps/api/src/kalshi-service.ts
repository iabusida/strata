/**
 * Kalshi prediction market API integration
 * Fetches prediction market data from https://docs.kalshi.com/api-reference
 */

const KALSHI_BASE_URL = "https://external-api.kalshi.com/trade-api/v2";

export interface KalshiMarket {
  ticker: string; // Market ID
  title: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  created_time: string;
  close_time: string;
  expiration_time: string;
  yes_bid_dollars: string | number; // Price reflects probability
  yes_ask_dollars: string | number;
  no_bid_dollars: string | number;
  no_ask_dollars: string | number;
  status: string; // 'active', 'inactive', etc.
  market_type: string; // 'binary'
  event_ticker: string;
  last_price_dollars: string | number;
  volume_fp?: string | number;
  volume_24h_fp?: string | number;
  liquidity_dollars: string | number;
  [key: string]: unknown; // Allow other fields from API
}

export interface BtcHourlyProbability {
  hour: string; // ISO timestamp of the hour
  priceThreshold: number;
  probYes: number; // Probability of price at or above threshold
  probNo: number; // Probability of price below threshold
  marketId: string;
}

export interface ExchangeStatus {
  exchange_active: boolean;
  trading_active: boolean;
  exchange_estimated_resume_time: string | null;
}

/**
 * Check Kalshi exchange status
 */
export async function fetchExchangeStatus(): Promise<ExchangeStatus | null> {
  try {
    const url = `${KALSHI_BASE_URL}/exchange/status`;
    console.log(`[Kalshi] Fetching exchange status from: ${url}`);

    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      console.error(`[Kalshi] Exchange status error: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as ExchangeStatus;
    console.log(
      `[Kalshi] Exchange status: active=${data.exchange_active}, trading=${data.trading_active}`
    );
    return data;
  } catch (error) {
    console.error("[Kalshi] Error fetching exchange status:", error);
    return null;
  }
}

/**
 * List all available markets on Kalshi
 */
export async function fetchAllMarkets(limit: number = 100): Promise<KalshiMarket[]> {
  try {
    const params = new URLSearchParams();
    params.set("limit", Math.min(limit, 100).toString()); // Kalshi max is 100

    const url = `${KALSHI_BASE_URL}/markets?${params.toString()}`;
    console.log(`[Kalshi] Fetching markets from: ${url}`);

    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      console.error(`[Kalshi] API error: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = (await response.json()) as { markets?: KalshiMarket[]; cursor?: string };
    const markets = data.markets || [];
    console.log(
      `[Kalshi] Retrieved ${markets.length} markets (cursor: ${data.cursor || "none"})`
    );
    return markets;
  } catch (error) {
    console.error("[Kalshi] Error fetching all markets:", error);
    return [];
  }
}

/**
 * Search for markets matching a keyword pattern
 */
export async function searchMarkets(keyword: string): Promise<KalshiMarket[]> {
  try {
    const markets = await fetchAllMarkets(200);
    const keywordLower = keyword.toLowerCase();

    return markets.filter((m) => {
      const titleLower = m.title.toLowerCase();
      const subtitleLower = (m.yes_sub_title || "").toLowerCase();
      return titleLower.includes(keywordLower) || subtitleLower.includes(keywordLower);
    });
  } catch (error) {
    console.error("[Kalshi] Error searching markets:", error);
    return [];
  }
}

/**
 * Search for hourly BTC price markets on Kalshi
 * Returns markets matching pattern like "BTC price at Xpm EDT"
 */
export async function fetchBtcHourlyMarkets(): Promise<KalshiMarket[]> {
  try {
    // Try multiple search patterns
    const searchQueries = ["BTC price", "Bitcoin price", "BTC hourly"];
    let allMarkets: KalshiMarket[] = [];

    for (const query of searchQueries) {
      try {
        const results = await searchMarkets(query);
        allMarkets = [...allMarkets, ...results];
      } catch (error) {
        console.warn(`[Kalshi] Error with query "${query}":`, error);
      }
    }

    // Deduplicate and filter for hourly BTC price markets
    const uniqueMarkets = Array.from(
      new Map(allMarkets.map((m) => [m.ticker, m])).values()
    );

    const filtered = uniqueMarkets.filter((m: KalshiMarket) => {
      const titleLower = m.title.toLowerCase();
      return (
        (titleLower.includes("btc") || titleLower.includes("bitcoin")) &&
        titleLower.includes("price") &&
        (m.title.match(/\d{1,2}(am|pm)/i) || m.yes_sub_title?.match(/\d{1,2}(am|pm)/i))
      );
    });

    console.log(
      `[Kalshi] Found ${filtered.length} hourly BTC markets (from ${allMarkets.length} total)`
    );
    return filtered;
  } catch (error) {
    console.error("[Kalshi] Error fetching hourly BTC markets:", error);
    return [];
  }
}

/**
 * Get BTC price probabilities at specific price thresholds
 * Converts market prices to implied probabilities
 * @param hours - Optional: number of hours to look ahead (default: 24)
 * @returns Array of hourly price probabilities
 */
export async function fetchBtcPriceProbabilities(
  hours: number = 24
): Promise<BtcHourlyProbability[]> {
  const markets = await fetchBtcHourlyMarkets();
  const probabilities: BtcHourlyProbability[] = [];

  for (const market of markets) {
    // Extract price threshold from title or subtitle
    const thresholdMatch = market.title.match(/\$?([\d,]+)/) ||
      market.yes_sub_title?.match(/\$?([\d,]+)/);
    const priceThreshold = thresholdMatch
      ? parseInt(thresholdMatch[1].replace(/,/g, ""), 10)
      : null;

    if (!priceThreshold) continue;

    // Extract hour from title (e.g., "10pm EDT")
    const hourMatch = market.title.match(/(\d{1,2}(?:am|pm))/i);
    const hour = hourMatch ? hourMatch[1] : market.yes_sub_title || "unknown";

    // Convert market prices to implied probabilities
    // Market price represents probability: $0.30 = 30% probability
    const yesBid = Number(market.yes_bid_dollars) || 0;
    const yesAsk = Number(market.yes_ask_dollars) || 0;
    const midPrice = yesBid && yesAsk ? (yesBid + yesAsk) / 2 : yesAsk || yesBid || 0;

    probabilities.push({
      hour,
      priceThreshold,
      probYes: Math.round(midPrice * 100), // Convert to percentage
      probNo: Math.round((1 - midPrice) * 100),
      marketId: market.ticker,
    });
  }

  return probabilities.sort((a, b) => parseInt(a.hour) - parseInt(b.hour));
}

/**
 * Get current market details for a specific Kalshi market
 */
export async function fetchMarketDetails(marketId: string): Promise<KalshiMarket | null> {
  try {
    const response = await fetch(`${KALSHI_BASE_URL}/markets/${marketId}`);
    if (!response.ok) {
      throw new Error(`Kalshi API error: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as { market: KalshiMarket };
    return data.market || null;
  } catch (error) {
    console.error(`[Kalshi] Error fetching market ${marketId}:`, error);
    return null;
  }
}

/**
 * Stream real-time updates for BTC hourly prediction markets
 * Returns an async generator of updated probabilities
 */
export async function* streamBtcProbabilities() {
  let lastFetch = 0;
  const POLL_INTERVAL = 30000; // Poll every 30 seconds

  while (true) {
    const now = Date.now();
    if (now - lastFetch >= POLL_INTERVAL) {
      const probs = await fetchBtcPriceProbabilities();
      if (probs.length > 0) {
        yield {
          timestamp: new Date().toISOString(),
          probabilities: probs,
        };
        lastFetch = now;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
