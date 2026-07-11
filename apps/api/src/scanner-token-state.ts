import { prisma } from "./prisma-client.js";
import { fetchRecentCandles } from "./bitunix-service.js";
import { calculateLatestMacdHistogram, calculateStochasticRsi, type MarketType } from "./rsi.js";
import type { ScanResult } from "./market-data-service.js";

type ResultRow = ScanResult["results"][number];

type BearishChecks = {
  h1: boolean;
  h4: boolean;
  h6: boolean;
  h12: boolean;
  d1: boolean;
  missing: string[];
};

type SetupClassification = {
  setupDirection: "LONG" | "SHORT" | "NEUTRAL";
  setupLabel: string;
  nearZone: boolean;
  burstReady: boolean;
};

type PersistOptions = {
  rows: ResultRow[];
  market: MarketType;
  checkedAtIso: string;
  checkIntervalMs: number;
};

export type PersistScannerTokenStatesSummary = {
  processed: number;
  inserted: number;
  updated: number;
  errored: number;
};

const DEFAULT_SCANNER_TOKEN_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const SCANNER_BEARISH_6H_CANDLE_COUNT = 220;

function resolveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env ${name}: ${raw}`);
  }
  return parsed;
}

export function resolveScannerCheckIntervalMs(): number {
  return Math.max(
    60_000,
    Math.trunc(resolveNumberEnv("SCANNER_TOKEN_CHECK_INTERVAL_MS", DEFAULT_SCANNER_TOKEN_CHECK_INTERVAL_MS))
  );
}

function normalizeSymbol(symbol: string, market: MarketType): string {
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

function isBearishTimeframe(tf: ResultRow["timeframes"]["daily"] | ResultRow["timeframes"]["macro"] | ResultRow["timeframes"]["intermediary"]): boolean {
  if (!tf) {
    return false;
  }
  return tf.trend.direction === "DOWN" && tf.macdHist < 0 && tf.stochK <= tf.stochD;
}

async function computeBearish6h(symbol: string, market: MarketType): Promise<boolean | null> {
  if (market !== "perp") {
    return null;
  }

  try {
    const candles = await fetchRecentCandles(symbol, "1h", SCANNER_BEARISH_6H_CANDLE_COUNT);
    const closes = candles.map((candle) => Number(candle.close)).filter((value) => Number.isFinite(value));
    if (closes.length < 100) {
      return null;
    }

    const sixHourCloses: number[] = [];
    const start = closes.length % 6;
    for (let i = start; i + 6 <= closes.length; i += 6) {
      sixHourCloses.push(closes[i + 5]);
    }

    if (sixHourCloses.length < 40) {
      return null;
    }

    const macdHist = calculateLatestMacdHistogram(sixHourCloses);
    const stoch = calculateStochasticRsi(sixHourCloses);
    if (macdHist == null || stoch == null) {
      return null;
    }

    return macdHist < 0 && stoch.k <= stoch.d;
  } catch {
    return null;
  }
}

function classifySetup(row: ResultRow, bearishCount: number): SetupClassification {
  const signalType = row.signal.type;
  const isLongSignal = signalType.includes("LONG");
  const isShortSignal = signalType.includes("SHORT");
  const confluenceBias = row.confluence.bias;
  const nearZone = row.levels.nearSupportFloor || row.levels.nearResistance;
  const burstReady =
    signalType.startsWith("STRONG") ||
    (signalType.startsWith("CONTINUATION") && row.confluence.score >= 7) ||
    (signalType.startsWith("REVERSAL") && row.confluence.score >= 8);

  if (isShortSignal && bearishCount >= 3 && row.levels.nearResistance) {
    return {
      setupDirection: "SHORT",
      setupLabel: burstReady ? "BURST_SHORT_READY" : "NEAR_RESISTANCE_SHORT",
      nearZone,
      burstReady
    };
  }

  if (isLongSignal && bearishCount <= 1 && row.levels.nearSupportFloor) {
    return {
      setupDirection: "LONG",
      setupLabel: burstReady ? "BURST_LONG_READY" : "NEAR_SUPPORT_LONG",
      nearZone,
      burstReady
    };
  }

  if (isShortSignal && bearishCount >= 3) {
    return {
      setupDirection: "SHORT",
      setupLabel: burstReady ? "SHORT_MOMENTUM" : "SHORT_WATCH",
      nearZone,
      burstReady
    };
  }

  if (isLongSignal && bearishCount <= 1) {
    return {
      setupDirection: "LONG",
      setupLabel: burstReady ? "LONG_MOMENTUM" : "LONG_WATCH",
      nearZone,
      burstReady
    };
  }

  // Fallback when explicit LONG/SHORT signal is absent: use confluence bias
  // to keep the scanner state actionable instead of all-neutral.
  if (confluenceBias === "SHORT" && bearishCount >= 2) {
    return {
      setupDirection: "SHORT",
      setupLabel: row.levels.nearResistance ? "NEAR_RESISTANCE_SHORT_BIAS" : "SHORT_BIAS_WATCH",
      nearZone,
      burstReady: burstReady || row.confluence.score >= 7
    };
  }

  if (confluenceBias === "LONG" && bearishCount <= 2) {
    return {
      setupDirection: "LONG",
      setupLabel: row.levels.nearSupportFloor ? "NEAR_SUPPORT_LONG_BIAS" : "LONG_BIAS_WATCH",
      nearZone,
      burstReady: burstReady || row.confluence.score >= 7
    };
  }

  return {
    setupDirection: "NEUTRAL",
    setupLabel: "MONITOR",
    nearZone,
    burstReady
  };
}

function buildBearishChecks(row: ResultRow, bearish6h: boolean | null): BearishChecks {
  const h1Known = row.timeframes.intermediary != null;
  const h4Known = row.timeframes.macro != null;
  const h12Known = row.timeframes.twelveh != null;
  const d1Known = row.timeframes.daily != null;

  const checks: BearishChecks = {
    h1: isBearishTimeframe(row.timeframes.intermediary),
    h4: isBearishTimeframe(row.timeframes.macro),
    h6: bearish6h === true,
    h12: isBearishTimeframe(row.timeframes.twelveh),
    d1: isBearishTimeframe(row.timeframes.daily),
    missing: []
  };

  if (!h1Known) checks.missing.push("1h");
  if (!h4Known) checks.missing.push("4h");
  if (bearish6h == null) checks.missing.push("6h");
  if (!h12Known) checks.missing.push("12h");
  if (!d1Known) checks.missing.push("1d");

  return checks;
}

export async function resolveDueScannerSymbols(
  symbols: string[],
  market: MarketType,
  now: Date
): Promise<string[]> {
  if (symbols.length === 0) {
    return [];
  }

  const normalized = Array.from(new Set(symbols.map((symbol) => normalizeSymbol(symbol, market))));
  const existing = await prisma.scannerTokenState.findMany({
    where: {
      market,
      symbol: {
        in: normalized
      }
    },
    select: {
      symbol: true,
      nextCheckAt: true
    }
  });

  const existingMap = new Map(existing.map((row) => [row.symbol, row.nextCheckAt.getTime()]));
  const nowMs = now.getTime();

  return normalized.filter((symbol) => {
    const nextCheckAtMs = existingMap.get(symbol);
    if (nextCheckAtMs == null) {
      return true;
    }
    return nextCheckAtMs <= nowMs;
  });
}

export async function persistScannerTokenStates(options: PersistOptions): Promise<PersistScannerTokenStatesSummary> {
  if (options.rows.length === 0) {
    return {
      processed: 0,
      inserted: 0,
      updated: 0,
      errored: 0
    };
  }

  const checkedAt = new Date(options.checkedAtIso);
  const nextCheckAt = new Date(checkedAt.getTime() + Math.max(60_000, options.checkIntervalMs));
  const normalizedSymbols = Array.from(new Set(options.rows.map((row) => normalizeSymbol(row.symbol, options.market))));
  const existing = await prisma.scannerTokenState.findMany({
    where: {
      market: options.market,
      symbol: {
        in: normalizedSymbols
      }
    },
    select: {
      symbol: true
    }
  });
  const existingSet = new Set(existing.map((row) => row.symbol));

  const summary: PersistScannerTokenStatesSummary = {
    processed: options.rows.length,
    inserted: 0,
    updated: 0,
    errored: 0
  };

  for (const row of options.rows) {
    const normalizedSymbol = normalizeSymbol(row.symbol, options.market);
    const existedBefore = existingSet.has(normalizedSymbol);

    try {
      const bearish6h = await computeBearish6h(normalizedSymbol, options.market);
      const bearish = buildBearishChecks(row, bearish6h);
      const bearishCount = Number(bearish.h1) + Number(bearish.h4) + Number(bearish.h6) + Number(bearish.h12) + Number(bearish.d1);
      const setup = classifySetup(row, bearishCount);

      await prisma.scannerTokenState.upsert({
        where: {
          symbol_market: {
            symbol: normalizedSymbol,
            market: options.market
          }
        },
        create: {
          symbol: normalizedSymbol,
          market: options.market,
          setupDirection: setup.setupDirection,
          setupLabel: setup.setupLabel,
          signalType: row.signal.type,
          nearZone: setup.nearZone,
          burstReady: setup.burstReady,
          bearish1h: bearish.h1,
          bearish4h: bearish.h4,
          bearish6h: bearish.h6,
          bearish12h: bearish.h12,
          bearish1d: bearish.d1,
          bearishCount,
          score: Number(row.confluence.score),
          confidence: Number((row.confluence.score / Math.max(1, row.confluence.maxScore)) * 100),
          details: {
            market: options.market,
            price: row.close,
            status: row.status,
            signalCategory: row.signalCategory,
            missingBearishChecks: bearish.missing,
            supportDistancePct: row.levels.supportDistancePct,
            resistanceDistancePct: row.levels.resistanceDistancePct
          },
          lastCheckedAt: checkedAt,
          nextCheckAt,
          lastError: null
        },
        update: {
          setupDirection: setup.setupDirection,
          setupLabel: setup.setupLabel,
          signalType: row.signal.type,
          nearZone: setup.nearZone,
          burstReady: setup.burstReady,
          bearish1h: bearish.h1,
          bearish4h: bearish.h4,
          bearish6h: bearish.h6,
          bearish12h: bearish.h12,
          bearish1d: bearish.d1,
          bearishCount,
          score: Number(row.confluence.score),
          confidence: Number((row.confluence.score / Math.max(1, row.confluence.maxScore)) * 100),
          details: {
            market: options.market,
            price: row.close,
            status: row.status,
            signalCategory: row.signalCategory,
            missingBearishChecks: bearish.missing,
            supportDistancePct: row.levels.supportDistancePct,
            resistanceDistancePct: row.levels.resistanceDistancePct
          },
          lastCheckedAt: checkedAt,
          nextCheckAt,
          lastError: null
        }
      });

      if (existedBefore) {
        summary.updated += 1;
      } else {
        summary.inserted += 1;
        existingSet.add(normalizedSymbol);
      }
    } catch (error) {
      summary.errored += 1;
      await prisma.scannerTokenState.upsert({
        where: {
          symbol_market: {
            symbol: normalizedSymbol,
            market: options.market
          }
        },
        create: {
          symbol: normalizedSymbol,
          market: options.market,
          setupDirection: "NEUTRAL",
          setupLabel: "ERROR",
          signalType: "NO SIGNAL",
          nearZone: false,
          burstReady: false,
          bearish1h: false,
          bearish4h: false,
          bearish6h: false,
          bearish12h: false,
          bearish1d: false,
          bearishCount: 0,
          score: 0,
          confidence: 0,
          details: {
            market: options.market,
            error: "SCANNER_STATE_PERSIST_FAILED"
          },
          lastCheckedAt: checkedAt,
          nextCheckAt,
          lastError: error instanceof Error ? error.message : String(error)
        },
        update: {
          lastCheckedAt: checkedAt,
          nextCheckAt,
          lastError: error instanceof Error ? error.message : String(error)
        }
      });

      if (existedBefore) {
        summary.updated += 1;
      } else {
        summary.inserted += 1;
        existingSet.add(normalizedSymbol);
      }
    }
  }

  return summary;
}
