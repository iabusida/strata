import "./env.js";
import { writeFileSync } from "node:fs";

type Interval = "15m" | "1h" | "4h" | "12h" | "1d";

type SimulatorCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
};

type MultiTimeframeCandles = Record<Interval, SimulatorCandle[]>;

type OkxPayload<T> = {
  code?: string;
  msg?: string;
  data?: T;
};

const SYMBOLS = ["AVAX", "NEAR", "HYPE", "SUI", "LINK", "AAVE", "UNI", "ARB", "OP", "INJ"] as const;
const INTERVALS: Interval[] = ["15m", "1h", "4h", "12h", "1d"];
const LOOKBACK_DAYS = 90;
const LOOKBACK_MS = LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
const OKX_API_BASE_URL = String(process.env.OKX_API_BASE_URL ?? "https://www.okx.com").trim().replace(/\/$/, "");
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 800;
const INTERVAL_PAUSE_MS = 120;
const CANDLE_LIMIT_PER_REQUEST = 100;

const OKX_BAR_MAP: Record<Interval, string> = {
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "12h": "12H",
  "1d": "1D"
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function toOkxInstId(symbol: string): string {
  return `${symbol.trim().toUpperCase()}-USDT-SWAP`;
}

function parseOkxCandleRow(row: unknown): SimulatorCandle | null {
  if (!Array.isArray(row) || row.length < 6) {
    return null;
  }

  const timestamp = parseNumber(row[0]);
  const open = parseNumber(row[1]);
  const high = parseNumber(row[2]);
  const low = parseNumber(row[3]);
  const close = parseNumber(row[4]);
  const volume = parseNumber(row[7] ?? row[6] ?? row[5]);

  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    !Number.isFinite(volume)
  ) {
    return null;
  }

  return {
    open,
    high,
    low,
    close,
    volume,
    timestamp
  };
}

async function okxGet<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(path, OKX_API_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`OKX request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as OkxPayload<T>;
  if (payload.code !== "0") {
    throw new Error(`OKX payload error: ${payload.msg ?? "unknown error"}`);
  }

  if (payload.data == null) {
    throw new Error("OKX payload missing data field");
  }

  return payload.data;
}

async function fetchWithRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_RETRIES) {
        break;
      }

      const backoffMs = RETRY_BASE_MS * (2 ** (attempt - 1));
      console.warn(`[fetch:data] retrying ${context} in ${backoffMs}ms (${attempt}/${MAX_RETRIES})`);
      await sleep(backoffMs);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${context}: ${message}`);
}

async function fetchCandles(symbol: string, interval: Interval, startTime: number, endTime: number): Promise<SimulatorCandle[]> {
  const instId = toOkxInstId(symbol);
  const dedup = new Map<number, SimulatorCandle>();
  let cursor: string | undefined;

  while (true) {
    const rows = await fetchWithRetry(
      () => okxGet<unknown[]>("/api/v5/market/history-candles", {
        instId,
        bar: OKX_BAR_MAP[interval],
        limit: String(CANDLE_LIMIT_PER_REQUEST),
        after: cursor
      }),
      `${instId} ${interval} candles`
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      break;
    }

    const parsed = rows
      .map((row) => parseOkxCandleRow(row))
      .filter((item): item is SimulatorCandle => item != null)
      .sort((left, right) => left.timestamp - right.timestamp);

    if (parsed.length === 0) {
      break;
    }

    for (const candle of parsed) {
      if (candle.timestamp >= startTime && candle.timestamp <= endTime) {
        dedup.set(candle.timestamp, candle);
      }
    }

    const oldestTimestamp = parsed[0]?.timestamp;
    if (!Number.isFinite(oldestTimestamp) || oldestTimestamp <= startTime) {
      break;
    }

    const nextCursor = String(oldestTimestamp);
    if (nextCursor === cursor || rows.length < CANDLE_LIMIT_PER_REQUEST) {
      break;
    }

    cursor = nextCursor;
    await sleep(40);
  }

  return Array.from(dedup.values()).sort((left, right) => left.timestamp - right.timestamp);
}

async function fetchAll(): Promise<Record<string, MultiTimeframeCandles>> {
  const endTime = Date.now();
  const startTime = endTime - LOOKBACK_MS;

  const data: Record<string, MultiTimeframeCandles> = {};
  console.log(`[fetch:data] provider: OKX`);
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
