import "./env.js";
import { writeFileSync } from "node:fs";
import { PrismaClient, CandleInterval } from "@prisma/client";
import { Hyperliquid } from "hyperliquid";
import {
  markBackfillStarted,
  markBackfillSuccess,
  markBackfillFailed,
  markBackfillNoData,
  initializeOrUpdateStatus
} from "./backfill-token-tracking.js";

type Interval = "15m" | "1h" | "4h" | "12h" | "1d";

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

const INTERVALS: Interval[] = ["15m", "1h", "4h", "12h", "1d"];
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 800;
const META_FETCH_MAX_ATTEMPTS = Math.max(1, Math.trunc(resolveNumberEnv("BACKFILL_META_MAX_ATTEMPTS", 6)));
const META_FETCH_BACKOFF_MS = Math.max(100, Math.trunc(resolveNumberEnv("BACKFILL_META_BACKOFF_MS", 1000)));
const INTERVAL_PAUSE_MS = 120;
const SYMBOL_PAUSE_MS = 60;
const INSERT_BATCH_SIZE = 1000;

const intervalMap: Record<Interval, CandleInterval> = {
  "15m": CandleInterval.M15,
  "1h": CandleInterval.H1,
  "4h": CandleInterval.H4,
  "12h": CandleInterval.H12,
  "1d": CandleInterval.D1
};

function toBaseCoin(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  return upper.endsWith("-PERP") ? upper.slice(0, -5) : upper;
}

function resolveLookbackDays(): number {
  const raw = process.env.BACKFILL_LOOKBACK_DAYS ?? process.env.BACKFILL_LOOK_DAYS;
  if (!raw) {
    return 90;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("BACKFILL_LOOKBACK_DAYS must be a positive number when provided");
  }

  return Math.floor(parsed);
}

function resolveNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env ${name}: ${raw}`);
  }

  return parsed;
}

function resolveSymbolLimit(): number | null {
  const raw = process.env.BACKFILL_SYMBOL_LIMIT;
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("BACKFILL_SYMBOL_LIMIT must be a positive number when provided");
  }

  return Math.floor(parsed);
}

function resolveSymbolOffset(): number {
  const raw = process.env.BACKFILL_SYMBOL_OFFSET;
  if (!raw) {
    return 0;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("BACKFILL_SYMBOL_OFFSET must be a non-negative number when provided");
  }

  return Math.floor(parsed);
}

function resolveIncludeSymbols(): Set<string> {
  const raw = process.env.BACKFILL_INCLUDE_SYMBOLS;
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((item) => toBaseCoin(item))
      .filter((item) => item.length > 0)
  );
}

function resolveFailOnErrors(): boolean {
  const raw = process.env.BACKFILL_FAIL_ON_ERRORS;
  if (!raw) {
    return false;
  }

  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function resolveJsonPath(): string {
  const raw = process.env.BACKFILL_JSON_PATH;
  return raw && raw.trim().length > 0 ? raw.trim() : "hl-candles-90d-all.json";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isRetryableMetaError(error: unknown): boolean {
  const message = extractErrorMessage(error).toLowerCase();
  const code = String((error as { code?: unknown })?.code ?? "").toLowerCase();

  return (
    code === "429" ||
    code === "500" ||
    code === "502" ||
    code === "503" ||
    code === "504" ||
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("fetch") ||
    message.includes("unknown error") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("eai_again")
  );
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

async function fetchCandleWindow(symbol: string, interval: Interval, startTime: number, endTime: number): Promise<SimulatorCandle[]> {
  const body: CandleRequestBody = {
    type: "candleSnapshot",
    req: {
      coin: toBaseCoin(symbol),
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

    const message = `Hyperliquid API request failed for ${symbol} ${interval}: ${response.status} ${response.statusText} (attempt ${attempt}/${MAX_RETRIES})`;
    lastError = message;

    if (response.status !== 429 || attempt === MAX_RETRIES) {
      throw new Error(message);
    }

    const backoffMs = RETRY_BASE_MS * (2 ** (attempt - 1));
    console.warn(`[backfill:candles] rate-limited for ${symbol} ${interval}; retrying in ${backoffMs}ms`);
    await sleep(backoffMs);
  }

  if (lastError != null || payload == null) {
    throw new Error(lastError ?? `Failed to fetch payload for ${symbol} ${interval}`);
  }

  if (!Array.isArray(payload)) {
    throw new Error(`Unexpected response shape for ${symbol} ${interval}. Expected array.`);
  }

  const candles = payload.map((item) => {
    if (typeof item !== "object" || item == null) {
      throw new Error(`Invalid candle payload item for ${symbol} ${interval}`);
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
      throw new Error(`Missing required candle fields for ${symbol} ${interval}`);
    }

    return toSimulatorCandle(candle as RawHLCandle);
  });

  candles.sort((left, right) => left.timestamp - right.timestamp);
  return candles;
}

async function fetchCandles(symbol: string, interval: Interval, startTime: number, endTime: number): Promise<SimulatorCandle[]> {
  let cursorEnd = endTime;
  const dedup = new Map<number, SimulatorCandle>();

  // Hyperliquid snapshot responses are capped; paginate backwards using cursorEnd.
  while (cursorEnd > startTime) {
    const windowCandles = await fetchCandleWindow(symbol, interval, startTime, cursorEnd);
    if (windowCandles.length === 0) {
      break;
    }

    for (const candle of windowCandles) {
      if (candle.timestamp >= startTime && candle.timestamp <= endTime) {
        dedup.set(candle.timestamp, candle);
      }
    }

    const oldest = windowCandles[0]?.timestamp ?? 0;
    if (!Number.isFinite(oldest) || oldest <= startTime) {
      break;
    }

    if (windowCandles.length < 100) {
      break;
    }

    cursorEnd = oldest - 1;
    await sleep(40);
  }

  return Array.from(dedup.values()).sort((a, b) => a.timestamp - b.timestamp);
}

async function getAllPerpSymbols(): Promise<string[]> {
  const sdk = new Hyperliquid({ enableWs: false });
  await sdk.connect();

  let meta: unknown = null;
  let lastError: unknown;

  for (let attempt = 1; attempt <= META_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      [meta] = await sdk.info.perpetuals.getMetaAndAssetCtxs();
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableMetaError(error);
      const message = extractErrorMessage(error);

      if (!retryable || attempt >= META_FETCH_MAX_ATTEMPTS) {
        break;
      }

      const delayMs = META_FETCH_BACKOFF_MS * (2 ** (attempt - 1));
      console.warn(
        `[backfill:candles] universe fetch failed (attempt ${attempt}/${META_FETCH_MAX_ATTEMPTS}) - ${message}; retrying in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }

  if (lastError !== undefined) {
    throw new Error(
      `Failed to fetch perpetual universe after ${META_FETCH_MAX_ATTEMPTS} attempts: ${extractErrorMessage(lastError)}`
    );
  }

  const universe = (meta as { universe?: Array<{ name?: string }> }).universe;
  if (!Array.isArray(universe)) {
    throw new Error("Unexpected perpetual universe payload from Hyperliquid");
  }

  const symbols = universe
    .map((item) => String(item?.name ?? "").trim().toUpperCase())
    .map((symbol) => toBaseCoin(symbol))
    .filter((symbol) => symbol.length > 0);
  const uniqueSymbols = Array.from(new Set(symbols));

  if (uniqueSymbols.length === 0) {
    throw new Error("Perpetual universe returned zero symbols");
  }

  return uniqueSymbols;
}

async function persistCandles(
  prisma: PrismaClient,
  symbol: string,
  interval: Interval,
  candles: SimulatorCandle[]
): Promise<void> {
  if (candles.length === 0) {
    return;
  }

  const dbInterval = intervalMap[interval];
  for (let i = 0; i < candles.length; i += INSERT_BATCH_SIZE) {
    const chunk = candles.slice(i, i + INSERT_BATCH_SIZE);
    await prisma.marketCandle.createMany({
      data: chunk.map((c) => ({
        symbol,
        interval: dbInterval,
        timestamp: new Date(c.timestamp),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      })),
      skipDuplicates: true
    });
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const lookbackDays = resolveLookbackDays();
  const symbolLimit = resolveSymbolLimit();
  const symbolOffset = resolveSymbolOffset();
  const includeSymbols = resolveIncludeSymbols();
  const failOnErrors = resolveFailOnErrors();
  const jsonPath = resolveJsonPath();

  const endTime = Date.now();
  const startTime = endTime - (lookbackDays * 24 * 60 * 60 * 1000);

  console.log(`[backfill:candles] lookback days: ${lookbackDays}`);
  const symbols = await getAllPerpSymbols();
  const selectedSymbolsPreFilter = symbolLimit
    ? symbols.slice(symbolOffset, symbolOffset + symbolLimit)
    : symbols.slice(symbolOffset);
  const selectedSymbols = includeSymbols.size > 0
    ? selectedSymbolsPreFilter.filter((symbol) => includeSymbols.has(toBaseCoin(symbol)))
    : selectedSymbolsPreFilter;
  console.log(
    `[backfill:candles] symbols in universe: ${symbols.length}, offset: ${symbolOffset}, selected: ${selectedSymbols.length}, includeFilter: ${includeSymbols.size}`
  );

  const simulatorData: Record<string, Record<Interval, SimulatorCandle[]>> = {};
  const failures: Array<{ symbol: string; interval: Interval; error: string }> = [];
  let totalRowsFetched = 0;

  try {
    for (const symbol of selectedSymbols) {
      const baseCoin = toBaseCoin(symbol);

      // Initialize or update status to IN_PROGRESS
      await initializeOrUpdateStatus(prisma, baseCoin, "PENDING");
      await markBackfillStarted(prisma, baseCoin);

      const perInterval: Record<Interval, SimulatorCandle[]> = {
        "15m": [],
        "1h": [],
        "4h": [],
        "12h": [],
        "1d": []
      };

      let symbolTotalCandles = 0;
      let symbolHasData = false;

      for (const interval of INTERVALS) {
        try {
          const candles = await fetchCandles(symbol, interval, startTime, endTime);
          await persistCandles(prisma, symbol, interval, candles);
          perInterval[interval] = candles;
          totalRowsFetched += candles.length;
          symbolTotalCandles += candles.length;
          if (candles.length > 0) {
            symbolHasData = true;
          }
          console.log(`[backfill:candles] ${symbol} ${interval}: ${candles.length} candles`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ symbol, interval, error: message });
          console.error(`[backfill:candles] FAILED ${symbol} ${interval}: ${message}`);
        }

        await sleep(INTERVAL_PAUSE_MS);
      }

      simulatorData[symbol] = perInterval;

      // Mark backfill completion/failure for this symbol
      if (!symbolHasData) {
        await markBackfillNoData(prisma, baseCoin);
        console.log(`[backfill:candles] ${baseCoin} marked as NO_DATA (no candles available)`);
      } else {
        await markBackfillSuccess(prisma, baseCoin, symbolTotalCandles, new Date(startTime));
        console.log(`[backfill:candles] ${baseCoin} marked as COMPLETED (${symbolTotalCandles} candles)`);
      }

      await sleep(SYMBOL_PAUSE_MS);
    }

    writeFileSync(jsonPath, JSON.stringify(simulatorData), "utf8");
    console.log(`[backfill:candles] wrote ${jsonPath}`);
    console.log(`[backfill:candles] total rows fetched: ${totalRowsFetched}`);

    if (failures.length > 0) {
      console.warn(`[backfill:candles] completed with ${failures.length} failures`);
      const sample = failures.slice(0, 10).map((f) => `${f.symbol} ${f.interval}: ${f.error}`).join(" | ");
      console.warn(`[backfill:candles] failure sample: ${sample}`);
      if (failOnErrors) {
        throw new Error(`Backfill completed with ${failures.length} failures. Sample: ${sample}`);
      }
    }

    console.log("[backfill:candles] completed successfully");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
