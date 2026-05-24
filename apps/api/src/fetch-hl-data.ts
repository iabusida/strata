import "./env.js";
import { writeFileSync } from "node:fs";

type RawHLCandle = {
  t: number;
  o: number | string;
  h: number | string;
  l: number | string;
  c: number | string;
  v: number | string;
};

type SimulatorCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
};

type CandleRequestBody = {
  type: "candleSnapshot";
  req: {
    coin: string;
    interval: Interval;
    startTime: number;
    endTime: number;
  };
};

type Interval = "15m" | "1h" | "4h" | "12h" | "1d";
type MultiTimeframeCandles = Record<Interval, SimulatorCandle[]>;

const SYMBOLS = ["AVAX", "NEAR", "HYPE", "SUI", "LINK", "AAVE", "UNI", "ARB", "OP", "INJ"] as const;
const INTERVALS: Interval[] = ["15m", "1h", "4h", "12h", "1d"];
const LOOKBACK_DAYS = 90;
const LOOKBACK_MS = LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 800;
const INTERVAL_PAUSE_MS = 120;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toSimulatorCandle(raw: RawHLCandle): SimulatorCandle {
  const open = Number(raw.o);
  const high = Number(raw.h);
  const low = Number(raw.l);
  const close = Number(raw.c);
  const volume = Number(raw.v);
  const timestamp = Number(raw.t);

  if (
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    !Number.isFinite(volume) ||
    !Number.isFinite(timestamp)
  ) {
    throw new Error("Received invalid candle values from Hyperliquid API");
  }

  return { open, high, low, close, volume, timestamp };
}

async function fetchCandles(symbol: string, interval: Interval, startTime: number, endTime: number): Promise<SimulatorCandle[]> {
  const body: CandleRequestBody = {
    type: "candleSnapshot",
    req: {
      coin: symbol,
      interval,
      startTime,
      endTime
    }
  };

  let payload: unknown;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (response.ok) {
      payload = (await response.json()) as unknown;
      lastError = null;
      break;
    }

    const message = `Hyperliquid API request failed for ${symbol}: ${response.status} ${response.statusText} (attempt ${attempt}/${MAX_RETRIES})`;
    lastError = message;

    if (response.status !== 429 || attempt === MAX_RETRIES) {
      throw new Error(message);
    }

    const backoffMs = RETRY_BASE_MS * (2 ** (attempt - 1));
    console.warn(`[fetch:data] rate-limited for ${symbol}; retrying in ${backoffMs}ms`);
    await sleep(backoffMs);
  }

  if (lastError != null || payload == null) {
    throw new Error(lastError ?? `Failed to fetch payload for ${symbol}`);
  }

  if (!Array.isArray(payload)) {
    throw new Error(`Unexpected response shape for ${symbol}. Expected array.`);
  }

  const candles = payload.map((item) => {
    if (typeof item !== "object" || item == null) {
      throw new Error(`Invalid candle payload item for ${symbol}`);
    }

    const candle = item as Partial<RawHLCandle>;
    if (
      typeof candle.t !== "number" ||
      (typeof candle.o !== "string" && typeof candle.o !== "number") ||
      (typeof candle.h !== "string" && typeof candle.h !== "number") ||
      (typeof candle.l !== "string" && typeof candle.l !== "number") ||
      (typeof candle.c !== "string" && typeof candle.c !== "number") ||
      (typeof candle.v !== "string" && typeof candle.v !== "number")
    ) {
      throw new Error(`Missing required candle fields for ${symbol}`);
    }

    return toSimulatorCandle(candle as RawHLCandle);
  });

  candles.sort((left, right) => left.timestamp - right.timestamp);
  return candles;
}

async function fetchAll(): Promise<Record<string, MultiTimeframeCandles>> {
  const endTime = Date.now();
  const startTime = endTime - LOOKBACK_MS;

  const data: Record<string, MultiTimeframeCandles> = {};
  console.log(`[fetch:data] lookback days: ${LOOKBACK_DAYS}`);
  for (const symbol of SYMBOLS) {
    const byInterval = {} as MultiTimeframeCandles;
    for (const interval of INTERVALS) {
      const candles = await fetchCandles(symbol, interval, startTime, endTime);
      byInterval[interval] = candles;
      console.log(`[fetch:data] ${symbol} ${interval}: ${candles.length} candles`);
      await sleep(INTERVAL_PAUSE_MS);
    }
    data[symbol] = byInterval;
  }

  return data;
}

async function main(): Promise<void> {
  const data = await fetchAll();
  writeFileSync("hl-candles.json", JSON.stringify(data, null, 2), "utf8");
  console.log("[fetch:data] wrote hl-candles.json");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
