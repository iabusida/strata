import "./env.js";
import { writeFileSync } from "node:fs";
import { PrismaClient, CandleInterval } from "@prisma/client";
import {
  markBackfillStarted,
  markBackfillSuccess,
  markBackfillFailed,
  markBackfillNoData,
  initializeOrUpdateStatus
} from "./backfill-token-tracking.js";

type Interval = "15m" | "1h" | "4h" | "12h" | "1d";

type OkxInstrumentRow = {
  instId?: string;
  state?: string;
  ctType?: string;
};

type BitunixTradingPairRow = {
  symbol?: string;
  symbolStatus?: string;
};

type SimulatorCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
};

const INTERVALS: Interval[] = ["15m", "1h", "4h", "12h", "1d"];
const OKX_API_BASE_URL = String(process.env.OKX_API_BASE_URL ?? "https://www.okx.com").trim().replace(/\/$/, "");
const BITUNIX_API_BASE_URL = String(process.env.BITUNIX_API_BASE_URL ?? "https://fapi.bitunix.com").trim().replace(/\/$/, "");
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 800;
const INTERVAL_PAUSE_MS = 120;
const SYMBOL_PAUSE_MS = 60;
const INSERT_BATCH_SIZE = 1000;
const CANDLE_LIMIT_PER_REQUEST = 100;

type BackfillProvider = "OKX" | "BITUNIX";
type BackfillProviderMode = BackfillProvider | "AUTO";

const intervalMap: Record<Interval, CandleInterval> = {
  "15m": CandleInterval.M15,
  "1h": CandleInterval.H1,
  "4h": CandleInterval.H4,
  "12h": CandleInterval.H12,
  "1d": CandleInterval.D1
};

const okxBarMap: Record<Interval, string> = {
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "12h": "12H",
  "1d": "1D"
};

const bitunixBarMap: Record<Interval, string> = {
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "12h": "12h",
  "1d": "1d"
};

function toBaseCoin(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (upper.endsWith("-USDT-SWAP")) {
    return upper.slice(0, -10);
  }
  if (upper.endsWith("-PERP")) {
    return upper.slice(0, -5);
  }
  return upper;
}

function toOkxInstId(symbol: string): string {
  return `${toBaseCoin(symbol)}-USDT-SWAP`;
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

function resolveBackfillProviderMode(): BackfillProviderMode {
  const raw = String(process.env.BACKFILL_PROVIDER ?? "AUTO").trim().toUpperCase();
  if (raw === "OKX" || raw === "BITUNIX" || raw === "AUTO") {
    return raw;
  }

  throw new Error("BACKFILL_PROVIDER must be one of: AUTO, OKX, BITUNIX");
}

function resolveProviderPreference(): BackfillProvider {
  const marketDataProvider = String(process.env.MARKET_DATA_PROVIDER ?? "").trim().toUpperCase();
  return marketDataProvider === "BITUNIX" ? "BITUNIX" : "OKX";
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

function parseNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
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

  const payload = await response.json() as { code?: string; msg?: string; data?: T };
  if (payload.code !== "0") {
    throw new Error(`OKX payload error: ${payload.msg ?? "unknown error"}`);
  }

  if (payload.data == null) {
    throw new Error("OKX payload missing data field");
  }

  return payload.data;
}

async function bitunixGet<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(path, BITUNIX_API_BASE_URL);
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
    throw new Error(`Bitunix request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as { code?: number | string; msg?: string; data?: T };
  const normalizedCode = String(payload.code ?? "");
  if (normalizedCode !== "0") {
    throw new Error(`Bitunix payload error: ${payload.msg ?? "unknown error"}`);
  }

  if (payload.data == null) {
    throw new Error("Bitunix payload missing data field");
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

      const delayMs = RETRY_BASE_MS * (2 ** (attempt - 1));
      console.warn(`[backfill:candles] retrying ${context} in ${delayMs}ms (${attempt}/${MAX_RETRIES})`);
      await sleep(delayMs);
    }
  }

  throw new Error(`${context}: ${extractErrorMessage(lastError)}`);
}

async function fetchCandles(symbol: string, interval: Interval, startTime: number, endTime: number): Promise<SimulatorCandle[]> {
  const instId = toOkxInstId(symbol);
  const dedup = new Map<number, SimulatorCandle>();
  let cursor: string | undefined;

  while (true) {
    const rows = await fetchWithRetry(
      () => okxGet<unknown[]>("/api/v5/market/history-candles", {
        instId,
        bar: okxBarMap[interval],
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
    if (!Number.isFinite(oldestTimestamp)) {
      break;
    }

    if (oldestTimestamp <= startTime) {
      break;
    }

    const nextCursor = String(oldestTimestamp);
    if (nextCursor === cursor || rows.length < CANDLE_LIMIT_PER_REQUEST) {
      break;
    }

    cursor = nextCursor;
    await sleep(40);
  }

  return Array.from(dedup.values()).sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchCandlesBitunix(symbol: string, interval: Interval, startTime: number, endTime: number): Promise<SimulatorCandle[]> {
  const instId = `${toBaseCoin(symbol)}USDT`;
  const bar = bitunixBarMap[interval];
  const dedup = new Map<number, SimulatorCandle>();
  let cursor: string | undefined = String(endTime);

  while (true) {
    const rows = await fetchWithRetry(
      () => bitunixGet<Array<{ open?: number; high?: number; low?: number; close?: number; time?: number; quoteVol?: string; baseVol?: string }>>(
        "/api/v1/futures/market/kline",
        {
          symbol: instId,
          interval: bar,
          limit: String(CANDLE_LIMIT_PER_REQUEST),
          endTime: cursor
        }
      ),
      `${instId} ${interval} candles (Bitunix)`
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      break;
    }

    const parsed = rows
      .map((row) => {
        const timestamp = parseNumber(row.time);
        const open = parseNumber(row.open);
        const high = parseNumber(row.high);
        const low = parseNumber(row.low);
        const close = parseNumber(row.close);
        const volume = parseNumber(row.quoteVol ?? row.baseVol);
        if (
          !Number.isFinite(timestamp) ||
          !Number.isFinite(open) ||
          !Number.isFinite(high) ||
          !Number.isFinite(low) ||
          !Number.isFinite(close)
        ) {
          return null;
        }

        return {
          open,
          high,
          low,
          close,
          volume: Number.isFinite(volume) ? volume : 0,
          timestamp
        } satisfies SimulatorCandle;
      })
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
    if (!Number.isFinite(oldestTimestamp)) {
      break;
    }

    if (oldestTimestamp <= startTime) {
      break;
    }

    const nextCursor = String(Math.max(0, Math.floor(oldestTimestamp - 1)));
    if (nextCursor === cursor || rows.length < CANDLE_LIMIT_PER_REQUEST) {
      break;
    }

    cursor = nextCursor;
    await sleep(40);
  }

  return Array.from(dedup.values()).sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchCandlesForProvider(
  provider: BackfillProvider,
  symbol: string,
  interval: Interval,
  startTime: number,
  endTime: number
): Promise<SimulatorCandle[]> {
  if (provider === "OKX") {
    return fetchCandles(symbol, interval, startTime, endTime);
  }

  return fetchCandlesBitunix(symbol, interval, startTime, endTime);
}

async function getAllOkxPerpSymbols(): Promise<string[]> {
  const rows = await fetchWithRetry(
    () => okxGet<OkxInstrumentRow[]>("/api/v5/public/instruments", { instType: "SWAP" }),
    "fetch OKX swap universe"
  );

  const symbols = rows
    .map((row) => ({
      instId: String(row.instId ?? "").trim().toUpperCase(),
      state: String(row.state ?? "").trim().toLowerCase(),
      ctType: String(row.ctType ?? "").trim().toLowerCase()
    }))
    .filter((row) => row.instId.endsWith("-USDT-SWAP"))
    .filter((row) => row.state === "live")
    .filter((row) => row.ctType === "linear")
    .map((row) => toBaseCoin(row.instId))
    .filter((symbol) => symbol.length > 0);

  const uniqueSymbols = Array.from(new Set(symbols));
  if (uniqueSymbols.length === 0) {
    throw new Error("OKX swap universe returned zero symbols");
  }

  return uniqueSymbols;
}

async function getAllBitunixPerpSymbols(): Promise<string[]> {
  const rows = await fetchWithRetry(
    () => bitunixGet<BitunixTradingPairRow[]>("/api/v1/futures/market/trading_pairs", {}),
    "fetch Bitunix trading pair universe"
  );

  const symbols = rows
    .map((row) => ({
      symbol: String(row.symbol ?? "").trim().toUpperCase(),
      status: String(row.symbolStatus ?? "").trim().toUpperCase()
    }))
    .filter((row) => row.symbol.endsWith("USDT"))
    .filter((row) => row.status === "OPEN")
    .map((row) => row.symbol.slice(0, -4))
    .filter((symbol) => symbol.length > 0);

  const uniqueSymbols = Array.from(new Set(symbols));
  if (uniqueSymbols.length === 0) {
    throw new Error("Bitunix trading pair universe returned zero symbols");
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
  const providerMode = resolveBackfillProviderMode();
  const providerPreference = resolveProviderPreference();
  const failOnErrors = resolveFailOnErrors();
  const jsonPath = resolveJsonPath();

  const endTime = Date.now();
  const startTime = endTime - (lookbackDays * 24 * 60 * 60 * 1000);

  console.log(`[backfill:candles] provider mode: ${providerMode}`);
  console.log(`[backfill:candles] provider preference: ${providerPreference}`);
  console.log(`[backfill:candles] lookback days: ${lookbackDays}`);

  const okxSymbols = providerMode === "BITUNIX" ? [] : await getAllOkxPerpSymbols();
  const bitunixSymbols = providerMode === "OKX" ? [] : await getAllBitunixPerpSymbols();

  const okxSet = new Set(okxSymbols);
  const bitunixSet = new Set(bitunixSymbols);

  const symbols = providerMode === "OKX"
    ? okxSymbols
    : providerMode === "BITUNIX"
      ? bitunixSymbols
      : Array.from(new Set([...okxSymbols, ...bitunixSymbols])).sort((left, right) => left.localeCompare(right));

  const selectedSymbolsPreFilter = symbolLimit
    ? symbols.slice(symbolOffset, symbolOffset + symbolLimit)
    : symbols.slice(symbolOffset);
  const selectedSymbols = includeSymbols.size > 0
    ? selectedSymbolsPreFilter.filter((symbol) => includeSymbols.has(toBaseCoin(symbol)))
    : selectedSymbolsPreFilter;
  console.log(
    `[backfill:candles] symbols in universe: ${symbols.length}, offset: ${symbolOffset}, selected: ${selectedSymbols.length}, includeFilter: ${includeSymbols.size}`
  );
  if (providerMode === "AUTO") {
    console.log(`[backfill:candles] OKX symbols: ${okxSymbols.length}, Bitunix symbols: ${bitunixSymbols.length}`);
  }

  const simulatorData: Record<string, Record<Interval, SimulatorCandle[]>> = {};
  const failures: Array<{ symbol: string; interval: Interval; error: string }> = [];
  let totalRowsFetched = 0;

  try {
    for (const symbol of selectedSymbols) {
      const baseCoin = toBaseCoin(symbol);

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
      const symbolFailures: string[] = [];

      for (const interval of INTERVALS) {
        try {
          const providerOrder: BackfillProvider[] = providerMode === "OKX"
            ? ["OKX"]
            : providerMode === "BITUNIX"
              ? ["BITUNIX"]
              : providerPreference === "BITUNIX"
                ? ["BITUNIX", "OKX"]
                : ["OKX", "BITUNIX"];

          const candidateProviders = providerOrder.filter((provider) => (
            provider === "OKX" ? okxSet.has(baseCoin) : bitunixSet.has(baseCoin)
          ));

          if (candidateProviders.length === 0) {
            throw new Error("symbol is unavailable in selected provider universe");
          }

          let candles: SimulatorCandle[] | null = null;
          let usedProvider: BackfillProvider | null = null;
          let hadSuccessfulFetch = false;
          const providerErrors: string[] = [];

          for (const provider of candidateProviders) {
            try {
              const fetched = await fetchCandlesForProvider(provider, baseCoin, interval, startTime, endTime);
              hadSuccessfulFetch = true;
              if (fetched.length > 0) {
                candles = fetched;
                usedProvider = provider;
                break;
              }

              usedProvider = provider;
            } catch (error) {
              providerErrors.push(`${provider}: ${extractErrorMessage(error)}`);
            }
          }

          if (!hadSuccessfulFetch && candles == null) {
            throw new Error(providerErrors.join(" | "));
          }

          const resolvedCandles = candles ?? [];
          await persistCandles(prisma, baseCoin, interval, resolvedCandles);
          perInterval[interval] = resolvedCandles;
          totalRowsFetched += resolvedCandles.length;
          symbolTotalCandles += resolvedCandles.length;
          if (resolvedCandles.length > 0) {
            symbolHasData = true;
          }
          console.log(`[backfill:candles] ${baseCoin} ${interval}: ${resolvedCandles.length} candles${usedProvider ? ` (${usedProvider})` : ""}`);
        } catch (error) {
          const message = extractErrorMessage(error);
          symbolFailures.push(`${interval}: ${message}`);
          failures.push({ symbol: baseCoin, interval, error: message });
          console.error(`[backfill:candles] FAILED ${baseCoin} ${interval}: ${message}`);
        }

        await sleep(INTERVAL_PAUSE_MS);
      }

      simulatorData[baseCoin] = perInterval;

      if (!symbolHasData && symbolFailures.length > 0) {
        await markBackfillFailed(prisma, baseCoin, symbolFailures.join(" | "));
        console.log(`[backfill:candles] ${baseCoin} marked as PENDING due to fetch failures`);
      } else if (!symbolHasData) {
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
