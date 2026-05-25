import "./env.js";
import { writeFileSync } from "node:fs";
import { PrismaClient, CandleInterval } from "@prisma/client";

type Interval = "15m" | "1h" | "4h" | "12h" | "1d";

type ExportCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
};

type ExportPayload = Record<string, Record<Interval, ExportCandle[]>>;

const prisma = new PrismaClient();

const intervalMap: Record<CandleInterval, Interval> = {
  M15: "15m",
  H1: "1h",
  H4: "4h",
  H12: "12h",
  D1: "1d"
};

function resolveLookbackDays(): number {
  const raw = process.env.EXPORT_LOOKBACK_DAYS;
  if (!raw) {
    return 90;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("EXPORT_LOOKBACK_DAYS must be a positive number when provided");
  }

  return Math.floor(parsed);
}

function resolveJsonPath(): string {
  const raw = process.env.EXPORT_JSON_PATH;
  return raw && raw.trim().length > 0 ? raw.trim() : "hl-candles-db-universe.json";
}

function resolveIncludeSymbols(): Set<string> {
  const raw = process.env.EXPORT_INCLUDE_SYMBOLS;
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toUpperCase().replace(/-PERP$/i, ""))
      .filter((item) => item.length > 0)
  );
}

async function main(): Promise<void> {
  const lookbackDays = resolveLookbackDays();
  const jsonPath = resolveJsonPath();
  const includeSymbols = resolveIncludeSymbols();
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const counts = await prisma.marketCandle.groupBy({
    by: ["symbol", "interval"],
    where: {
      timestamp: { gte: cutoff }
    },
    _count: {
      _all: true
    }
  });

  const bySymbolCounts = new Map<string, Partial<Record<CandleInterval, number>>>();
  for (const row of counts) {
    const symbol = String(row.symbol).toUpperCase();
    if (includeSymbols.size > 0 && !includeSymbols.has(symbol)) {
      continue;
    }

    const existing = bySymbolCounts.get(symbol) ?? {};
    existing[row.interval] = row._count._all;
    bySymbolCounts.set(symbol, existing);
  }

  const completeSymbols = Array.from(bySymbolCounts.entries())
    .filter(([, intervals]) => (
      (intervals.M15 ?? 0) > 1000 &&
      (intervals.H1 ?? 0) > 500 &&
      (intervals.H4 ?? 0) > 100 &&
      (intervals.H12 ?? 0) > 50 &&
      (intervals.D1 ?? 0) > 30
    ))
    .map(([symbol]) => symbol);

  const rows = await prisma.marketCandle.findMany({
    where: {
      symbol: { in: completeSymbols },
      timestamp: { gte: cutoff }
    },
    orderBy: [
      { symbol: "asc" },
      { interval: "asc" },
      { timestamp: "asc" }
    ]
  });

  const payload: ExportPayload = {};
  for (const row of rows) {
    const symbol = String(row.symbol).toUpperCase();
    const interval = intervalMap[row.interval];
    payload[symbol] ??= {
      "15m": [],
      "1h": [],
      "4h": [],
      "12h": [],
      "1d": []
    };

    payload[symbol][interval].push({
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      timestamp: row.timestamp.getTime()
    });
  }

  writeFileSync(jsonPath, JSON.stringify(payload), "utf8");
  console.log(`[export:candles] lookback days: ${lookbackDays}`);
  console.log(`[export:candles] symbols exported: ${completeSymbols.length}`);
  console.log(`[export:candles] wrote ${jsonPath}`);
}

main().catch(async (error: unknown) => {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
