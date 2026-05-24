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
    interval: "15m";
    startTime: number;
    endTime: number;
  };
};

const SYMBOLS = ["BTC", "ETH", "SOL", "AVAX", "NEAR"] as const;
const INTERVAL = "15m" as const;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

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

async function fetchCandles(symbol: string, startTime: number, endTime: number): Promise<SimulatorCandle[]> {
  const body: CandleRequestBody = {
    type: "candleSnapshot",
    req: {
      coin: symbol,
      interval: INTERVAL,
      startTime,
      endTime
    }
  };

  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid API request failed for ${symbol}: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as unknown;
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

async function fetchAll(): Promise<Record<string, SimulatorCandle[]>> {
  const endTime = Date.now();
  const startTime = endTime - THIRTY_DAYS_MS;

  const data: Record<string, SimulatorCandle[]> = {};
  for (const symbol of SYMBOLS) {
    const candles = await fetchCandles(symbol, startTime, endTime);
    data[symbol] = candles;
    console.log(`[fetch:data] ${symbol}: ${candles.length} candles`);
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
