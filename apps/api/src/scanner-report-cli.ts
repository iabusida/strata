#!/usr/bin/env node
import "./env.js";
import { prisma } from "./prisma-client.js";
import { scanRsi } from "./market-data-service.js";
import type { MarketType } from "./rsi.js";
import { persistScannerTokenStates, resolveScannerCheckIntervalMs } from "./scanner-token-state.js";

function parseArgs(argv: string[]): { flags: Record<string, string> } {
  const flags: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
    flags[key] = value;

    if (value !== "true") {
      i += 1;
    }
  }

  return { flags };
}

function resolveMarket(raw: string | undefined): "perp" | "spot" {
  return raw === "spot" ? "spot" : "perp";
}

function resolveLimit(raw: string | undefined): number | null {
  if (!raw || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.trunc(parsed));
}

function resolveBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === "") {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function resolveBatchSize(raw: string | undefined): number {
  const fallback = 20;
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.trunc(parsed));
}

function resolveNumber(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function normalizeReportSymbol(symbol: string, market: MarketType): string {
  const upper = symbol.trim().toUpperCase();
  if (market === "spot") {
    return upper;
  }
  if (upper.endsWith("-PERP")) {
    return upper;
  }
  if (upper.endsWith("USDT")) {
    return `${upper.slice(0, -4)}-PERP`;
  }
  return `${upper}-PERP`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toYesNo(value: boolean): "Y" | "N" {
  return value ? "Y" : "N";
}

async function runLiveRefresh(opts: {
  market: MarketType;
  symbols: string[];
  batchSize: number;
  pauseMs: number;
}): Promise<void> {
  if (opts.symbols.length === 0) {
    return;
  }

  const symbolBatches = chunk(opts.symbols, opts.batchSize);
  const collectedRows: Awaited<ReturnType<typeof scanRsi>>["results"] = [];

  console.info("[scanner-report] live refresh start", {
    market: opts.market,
    symbols: opts.symbols.length,
    batches: symbolBatches.length,
    batchSize: opts.batchSize,
    pauseMs: opts.pauseMs
  });

  for (let i = 0; i < symbolBatches.length; i += 1) {
    const batch = symbolBatches[i];
    const startedAt = Date.now();

    const scan = await scanRsi({
      market: opts.market,
      symbols: batch,
      limitTokens: batch.length
    });

    collectedRows.push(...scan.results);

    console.info("[scanner-report] live batch complete", {
      batch: i + 1,
      totalBatches: symbolBatches.length,
      requested: batch.length,
      returned: scan.results.length,
      durationMs: Date.now() - startedAt
    });

    if (i < symbolBatches.length - 1 && opts.pauseMs > 0) {
      await sleep(opts.pauseMs);
    }
  }

  const persistSummary = await persistScannerTokenStates({
    rows: collectedRows,
    market: opts.market,
    checkedAtIso: new Date().toISOString(),
    checkIntervalMs: resolveScannerCheckIntervalMs()
  });

  console.info("[scanner-report] live refresh persisted", {
    market: opts.market,
    rowsScanned: collectedRows.length,
    ...persistSummary
  });
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const market = resolveMarket(flags.market);
  const limit = resolveLimit(flags.limit);
  const live = resolveBoolean(flags.live, true);
  const batchSize = resolveBatchSize(flags.batchSize ?? process.env.SCANNER_REPORT_LIVE_BATCH_SIZE);
  const pauseMs = Math.max(0, resolveNumber(flags.pauseMs ?? process.env.SCANNER_REPORT_LIVE_PAUSE_MS, 300));

  const existingRows = await prisma.scannerTokenState.findMany({
    where: { market },
    orderBy: [
      { symbol: "asc" }
    ]
  });

  if (existingRows.length === 0) {
    console.log(`No scanner token states found for market=${market}`);
    return;
  }

  if (live) {
    const symbols = Array.from(
      new Set(existingRows.map((row) => normalizeReportSymbol(row.symbol, market)))
    );
    await runLiveRefresh({
      market,
      symbols,
      batchSize,
      pauseMs
    });
  }

  const rows = await prisma.scannerTokenState.findMany({
    where: { market },
    orderBy: [
      { symbol: "asc" }
    ],
    take: limit ?? undefined
  });

  console.log(`Scanner setup report | market=${market} | rows=${rows.length} | live=${live ? "Y" : "N"}`);

  console.log("\n=== TOKEN STATE TABLE ===");
  console.table(
    rows.map((row) => ({
      id: row.id.toString(),
      symbol: row.symbol,
      market: row.market,
      setupDirection: row.setupDirection,
      setupLabel: row.setupLabel,
      signalType: row.signalType,
      nearZone: toYesNo(row.nearZone),
      burstReady: toYesNo(row.burstReady),
      bearish1h: toYesNo(row.bearish1h),
      bearish4h: toYesNo(row.bearish4h),
      bearish6h: toYesNo(row.bearish6h),
      bearish12h: toYesNo(row.bearish12h),
      bearish1d: toYesNo(row.bearish1d),
      bearishCount: row.bearishCount,
      score: row.score.toFixed(2),
      confidence: `${row.confidence.toFixed(1)}%`,
      details: JSON.stringify(row.details),
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? "N/A",
      nextCheckAt: row.nextCheckAt.toISOString(),
      lastError: row.lastError ?? "",
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    }))
  );

  const dueNow = rows.filter((row) => row.nextCheckAt.getTime() <= Date.now()).length;
  const errored = rows.filter((row) => row.lastError != null && row.lastError.trim() !== "").length;
  console.log("\n=== STATE SUMMARY ===");
  console.table([
    {
      market,
      total: rows.length,
      shorts: rows.filter((row) => row.setupDirection === "SHORT").length,
      longs: rows.filter((row) => row.setupDirection === "LONG").length,
      neutral: rows.filter((row) => row.setupDirection === "NEUTRAL").length,
      burstReady: rows.filter((row) => row.burstReady).length,
      nearZone: rows.filter((row) => row.nearZone).length,
      dueNow,
      errored
    }
  ]);
}

main()
  .catch((error) => {
    console.error("scanner-report-cli failed", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
