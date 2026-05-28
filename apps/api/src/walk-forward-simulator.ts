import "./env.js";
import { readFile } from "node:fs/promises";

import {
  analyzeResults,
  getLastSimulationDiagnostics,
  runLeveragedBalanceBacktest,
  runSimulation,
  type Candle,
  type CandleDataBySymbol
} from "./trade-simulator.js";

type TimeframeKey = "15m" | "1h" | "4h" | "12h" | "1d";

type WindowSummary = {
  window: number;
  start: string;
  end: string;
  symbols: number;
  totalTrades: number;
  targetTrades: number;
  targetReached: boolean;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  expectedValue: number;
  maxDrawdown: number;
  avgDurationCandles: number;
  avgDurationHours: number;
  distribution: {
    WIN: number;
    LOSS: number;
    TIME_EXIT: number;
  };
  leveragedBacktest: {
    finalBalance: number;
    totalReturnPct: number;
    totalFeesCharged: number;
  };
  diagnostics: ReturnType<typeof getLastSimulationDiagnostics>;
};

const WINDOW_COUNT = Math.max(2, Math.trunc(Number(process.env.SIM_WALK_FORWARD_WINDOWS ?? "3")));
const BACKTEST_STARTING_BALANCE = Number(process.env.SIM_BACKTEST_STARTING_BALANCE ?? 500);
const BACKTEST_LEVERAGE = Number(process.env.SIM_BACKTEST_LEVERAGE ?? 5);
const BACKTEST_FEE_OPEN_USD = Number(process.env.SIM_BACKTEST_FEE_OPEN_USD ?? 3);
const BACKTEST_FEE_CLOSE_USD = Number(process.env.SIM_BACKTEST_FEE_CLOSE_USD ?? 3);

function isMultiTimeframeCandles(value: Candle[] | Record<TimeframeKey, Candle[]>): value is Record<TimeframeKey, Candle[]> {
  return !Array.isArray(value);
}

function filterCandles(candles: Candle[], startMs: number, endMs: number): Candle[] {
  return candles.filter((candle) => candle.timestamp >= startMs && candle.timestamp < endMs);
}

function filterDatasetWindow(data: CandleDataBySymbol, startMs: number, endMs: number): CandleDataBySymbol {
  const filtered: CandleDataBySymbol = {};

  for (const [symbol, payload] of Object.entries(data)) {
    if (Array.isArray(payload)) {
      const candles = filterCandles(payload, startMs, endMs);
      if (candles.length > 0) {
        filtered[symbol] = candles;
      }
      continue;
    }

    if (!isMultiTimeframeCandles(payload)) {
      continue;
    }

    const sliced = {
      "15m": filterCandles(payload["15m"], startMs, endMs),
      "1h": filterCandles(payload["1h"], startMs, endMs),
      "4h": filterCandles(payload["4h"], startMs, endMs),
      "12h": filterCandles(payload["12h"], startMs, endMs),
      "1d": filterCandles(payload["1d"], startMs, endMs)
    };

    if (sliced["15m"].length > 0) {
      filtered[symbol] = sliced;
    }
  }

  return filtered;
}

function collectRange(data: CandleDataBySymbol): { startMs: number; endMs: number } {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;

  for (const payload of Object.values(data)) {
    const candles15m = Array.isArray(payload) ? payload : payload["15m"];
    if (candles15m.length === 0) {
      continue;
    }

    startMs = Math.min(startMs, candles15m[0].timestamp);
    endMs = Math.max(endMs, candles15m[candles15m.length - 1].timestamp);
  }

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error("Unable to determine candle timestamp range for walk-forward run");
  }

  return { startMs, endMs };
}

async function runCli(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error("Usage: tsx src/walk-forward-simulator.ts <path-to-candle-json>");
  }

  const raw = await readFile(filePath, "utf8");
  const candleData = JSON.parse(raw) as CandleDataBySymbol;
  const { startMs, endMs } = collectRange(candleData);
  const totalRangeMs = Math.max(1, (endMs - startMs) + 1);
  const windowSizeMs = Math.ceil(totalRangeMs / WINDOW_COUNT);
  const summaries: WindowSummary[] = [];

  console.log(`[walk-forward] dataset ${new Date(startMs).toISOString()} -> ${new Date(endMs).toISOString()} | windows=${WINDOW_COUNT}`);

  for (let index = 0; index < WINDOW_COUNT; index += 1) {
    const windowStartMs = startMs + (index * windowSizeMs);
    const windowEndMs = index === WINDOW_COUNT - 1 ? endMs + 1 : Math.min(endMs + 1, windowStartMs + windowSizeMs);
    const windowData = filterDatasetWindow(candleData, windowStartMs, windowEndMs);
    const symbols = Object.keys(windowData).length;

    console.log(`\n[walk-forward] window ${index + 1}/${WINDOW_COUNT} | ${new Date(windowStartMs).toISOString()} -> ${new Date(windowEndMs - 1).toISOString()} | symbols=${symbols}`);

    const trades = await runSimulation(windowData);
    const summary = analyzeResults(trades);
    const diagnostics = getLastSimulationDiagnostics();
    const backtest = runLeveragedBalanceBacktest(
      trades,
      BACKTEST_STARTING_BALANCE,
      BACKTEST_LEVERAGE,
      10,
      10,
      BACKTEST_FEE_OPEN_USD,
      BACKTEST_FEE_CLOSE_USD
    );

    summaries.push({
      window: index + 1,
      start: new Date(windowStartMs).toISOString(),
      end: new Date(windowEndMs - 1).toISOString(),
      symbols,
      totalTrades: trades.length,
      targetTrades: diagnostics.targetTrades,
      targetReached: trades.length >= diagnostics.targetTrades,
      winRate: summary.winRate,
      avgWin: summary.avgWinPct,
      avgLoss: summary.avgLossPct,
      expectedValue: summary.expectedValue,
      maxDrawdown: summary.maxDrawdown,
      avgDurationCandles: summary.avgDuration,
      avgDurationHours: Number(((summary.avgDuration * 15) / 60).toFixed(2)),
      distribution: summary.distribution,
      leveragedBacktest: {
        finalBalance: backtest.finalBalance,
        totalReturnPct: backtest.totalReturnPct,
        totalFeesCharged: backtest.totalFeesCharged
      },
      diagnostics
    });
  }

  console.log("\n" + JSON.stringify({
    filePath,
    windows: WINDOW_COUNT,
    summaries
  }, null, 2));
}

runCli().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});