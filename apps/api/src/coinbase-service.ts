/**
 * Coinbase API Service
 *
 * Handles:
 * - REST API for market data, orders, account info
 * - WebSocket for real-time price updates
 * - Order execution (LIMIT/MARKET)
 * - Margin account management
 *
 * Environment variables required:
 * - COINBASE_API_KEY
 * - COINBASE_API_SECRET
 * - COINBASE_API_PASSPHRASE
 * - COINBASE_SANDBOX_MODE (optional, for testing)
 */

import crypto from "crypto";

const COINBASE_API_URL =
  process.env.COINBASE_SANDBOX_MODE === "true"
    ? "https://api-sandbox.exchange.coinbase.com"
    : "https://api.exchange.coinbase.com";

const COINBASE_WS_URL =
  process.env.COINBASE_SANDBOX_MODE === "true"
    ? "wss://ws-sandbox.exchange.coinbase.com"
    : "wss://ws.exchange.coinbase.com";

const API_KEY = process.env.COINBASE_API_KEY || "";
const API_SECRET = process.env.COINBASE_API_SECRET || "";
const API_PASSPHRASE = process.env.COINBASE_API_PASSPHRASE || "";

/**
 * Generate HMAC signature for Coinbase API requests
 */
function generateSignature(
  timestamp: string,
  method: string,
  requestPath: string,
  body: string
): string {
  const message = timestamp + method + requestPath + body;
  const key = Buffer.from(API_SECRET, "base64");
  const hmac = crypto.createHmac("sha256", key);
  hmac.update(message);
  return hmac.digest("base64");
}

/**
 * Make authenticated request to Coinbase API
 */
export async function coinbaseRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr = body ? JSON.stringify(body) : "";
  const signature = generateSignature(timestamp, method, path, bodyStr);

  if (!API_KEY) {
    throw new Error(
      "COINBASE_API_KEY not set. Configure credentials when ready for live trading."
    );
  }

  const response = await fetch(COINBASE_API_URL + path, {
    method,
    headers: {
      "CB-ACCESS-KEY": API_KEY,
      "CB-ACCESS-SIGN": signature,
      "CB-ACCESS-TIMESTAMP": timestamp,
      "CB-ACCESS-PASSPHRASE": API_PASSPHRASE,
      "Content-Type": "application/json",
    },
    body: bodyStr || undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Coinbase API error (${response.status}): ${error}`);
  }

  return response.json();
}

/**
 * Fetch OHLC candles for a product
 */
export async function fetchCoinbaseCandles(
  productId: string,
  granularity: number, // 60=1m, 300=5m, 3600=1h, 86400=1d
  limit: number = 300
): Promise<Array<[number, number, number, number, number]>> {
  try {
    const params = new URLSearchParams({
      granularity: granularity.toString(),
      limit: limit.toString(),
    });

    const result = await coinbaseRequest(
      "GET",
      `/products/${productId}/candles?${params}`
    );

    if (!Array.isArray(result)) {
      console.warn(`[coinbase] unexpected candles response for ${productId}`);
      return [];
    }

    // Coinbase returns: [time, low, high, open, close, volume]
    // Rearrange to: [time, open, high, low, close, volume]
    return result.map((candle: number[]) => [
      candle[0],  // time
      candle[3],  // open
      candle[2],  // high
      candle[1],  // low
      candle[4],  // close
    ]);
  } catch (error) {
    console.error(
      `[coinbase] failed to fetch candles for ${productId}:`,
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}

/**
 * Get current account balance
 */
export async function getCoinbaseBalance(): Promise<{
  available: number;
  hold: number;
  margin: number;
}> {
  try {
    const accounts = await coinbaseRequest("GET", "/accounts");

    if (!Array.isArray(accounts)) {
      return { available: 0, hold: 0, margin: 0 };
    }

    let available = 0;
    let hold = 0;

    // Sum USD balances
    for (const account of accounts) {
      if (account.currency === "USD") {
        available += Number(account.available) || 0;
        hold += Number(account.hold) || 0;
      }
    }

    return { available, hold, margin: available };
  } catch (error) {
    console.error(
      "[coinbase] failed to fetch balance:",
      error instanceof Error ? error.message : String(error)
    );
    return { available: 0, hold: 0, margin: 0 };
  }
}

/**
 * Place a limit order
 */
export async function placeCoinbaseOrder(
  productId: string,
  side: "buy" | "sell",
  size: number,
  price: number,
  postOnly: boolean = true
): Promise<{ id: string; status: string }> {
  try {
    const result = await coinbaseRequest("POST", "/orders", {
      product_id: productId,
      side,
      order_type: "limit",
      price: price.toFixed(8),
      size: size.toFixed(8),
      post_only: postOnly,
      time_in_force: "GTC", // Good till cancel
    });

    return {
      id: (result as Record<string, unknown>).id as string,
      status: (result as Record<string, unknown>).status as string,
    };
  } catch (error) {
    console.error(
      `[coinbase] failed to place order for ${productId}:`,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}

/**
 * Cancel an order
 */
export async function cancelCoinbaseOrder(orderId: string): Promise<boolean> {
  try {
    await coinbaseRequest("DELETE", `/orders/${orderId}`);
    return true;
  } catch (error) {
    console.error(
      "[coinbase] failed to cancel order:",
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

/**
 * Get order status
 */
export async function getCoinbaseOrderStatus(
  orderId: string
): Promise<{ status: string; filledSize: number; executedValue: number }> {
  try {
    const result = await coinbaseRequest("GET", `/orders/${orderId}`);
    const order = result as Record<string, unknown>;

    return {
      status: (order.status as string) || "unknown",
      filledSize: Number(order.filled_size) || 0,
      executedValue: Number(order.executed_value) || 0,
    };
  } catch (error) {
    console.error(
      "[coinbase] failed to fetch order status:",
      error instanceof Error ? error.message : String(error)
    );
    return { status: "error", filledSize: 0, executedValue: 0 };
  }
}

/**
 * List all available products (trading pairs)
 */
export async function getCoinbaseProducts(): Promise<string[]> {
  try {
    const result = await coinbaseRequest("GET", "/products");

    if (!Array.isArray(result)) {
      return [];
    }

    // Filter to major USD pairs only
    return result
      .filter(
        (p: Record<string, unknown>) =>
          (p.quote_currency === "USD" || p.quote_currency === "USDT") &&
          (p.id as string).includes("-")
      )
      .map((p: Record<string, unknown>) => (p.id as string).replace("-USD", "").replace("-USDT", ""));
  } catch (error) {
    console.error(
      "[coinbase] failed to fetch products:",
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}

console.info("[coinbase-service] initialized", {
  sandbox: process.env.COINBASE_SANDBOX_MODE === "true",
  apiKeySet: !!API_KEY,
  url: COINBASE_API_URL,
});
