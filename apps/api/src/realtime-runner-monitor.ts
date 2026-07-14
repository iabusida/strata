import "./env.js";

import { fetchOrderBookExecutionRead, fetchPerpContexts, fetchPerpTickerSnapshots } from "./bitunix-service.js";

type TickerSnapshot = {
  symbol: string;
  price: number;
  change24hPct: number;
  volume24hUsdM: number;
};

type SignalSample = {
  ts: number;
  price: number;
  volume24hUsdM: number;
  change24hPct: number;
  bidDepthUsd?: number;
  askDepthUsd?: number;
  spreadPct?: number;
};

type AlertState = {
  symbol: string;
  entryPrice: number;
  entryAt: number;
  lastReportAt: number;
  bestPnlPct: number;
  worstPnlPct: number;
  reason: string;
};

const LOOP_INTERVAL_MS = Math.max(15_000, Number(process.env.REALTIME_RUNNER_LOOP_MS ?? 30_000));
const REPORT_INTERVAL_MS = 15 * 60 * 1000;
const MAX_TRACK_MS = Math.max(60 * 60 * 1000, Number(process.env.REALTIME_RUNNER_TRACK_MS ?? 24 * 60 * 60 * 1000));
const COOLDOWN_MS = Math.max(10 * 60 * 1000, Number(process.env.REALTIME_RUNNER_COOLDOWN_MS ?? 6 * 60 * 60 * 1000));

const MIN_24H_VOL_M = Math.max(0.25, Number(process.env.REALTIME_RUNNER_MIN_24H_VOL_M ?? 1));
const MIN_24H_CHANGE_PCT = Number(process.env.REALTIME_RUNNER_MIN_24H_CHANGE_PCT ?? 0);
const MAX_24H_CHANGE_PCT = Math.max(5, Number(process.env.REALTIME_RUNNER_MAX_24H_CHANGE_PCT ?? 45));
const MIN_BID_DEPTH_USD = Math.max(500, Number(process.env.REALTIME_RUNNER_MIN_BID_DEPTH_USD ?? 5_000));
const MAX_SPREAD_PCT = Math.max(0.0005, Number(process.env.REALTIME_RUNNER_MAX_SPREAD_PCT ?? 0.003));
const MIN_IMBALANCE = Math.max(1, Number(process.env.REALTIME_RUNNER_MIN_IMBALANCE ?? 1.4));
const MIN_RET_1M = Number(process.env.REALTIME_RUNNER_MIN_RET_1M ?? 0.25);
const MIN_RET_3M = Number(process.env.REALTIME_RUNNER_MIN_RET_3M ?? 0.8);
const MIN_RET_5M = Number(process.env.REALTIME_RUNNER_MIN_RET_5M ?? 1.2);

const MAX_SYMBOLS = Math.max(20, Number(process.env.REALTIME_RUNNER_MAX_SYMBOLS ?? 120));
const MAX_OB_CHECKS = Math.max(10, Number(process.env.REALTIME_RUNNER_MAX_OB_CHECKS ?? 40));

const samplesBySymbol = new Map<string, SignalSample[]>();
const alertsBySymbol = new Map<string, AlertState>();
const cooldownBySymbol = new Map<string, number>();

function fmtPct(n: number, decimals: number = 2): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(decimals)}%`;
}

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function keepRecentSamples(symbol: string, maxAgeMs: number): SignalSample[] {
  const rows = samplesBySymbol.get(symbol) ?? [];
  const cutoff = Date.now() - maxAgeMs;
  const next = rows.filter((r) => r.ts >= cutoff);
  samplesBySymbol.set(symbol, next);
  return next;
}

function addSample(symbol: string, sample: SignalSample): void {
  const rows = keepRecentSamples(symbol, 20 * 60 * 1000);
  rows.push(sample);
  samplesBySymbol.set(symbol, rows);
}

function findClosestSample(rows: SignalSample[], targetTs: number): SignalSample | null {
  let best: SignalSample | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const delta = Math.abs(row.ts - targetTs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = row;
    }
  }
  return best;
}

function pctMove(from: number | null, to: number): number {
  if (from == null || !Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) {
    return 0;
  }
  return ((to - from) / from) * 100;
}

function rollingAvg(rows: SignalSample[], key: "bidDepthUsd" | "askDepthUsd", windowMs: number): number | null {
  const cutoff = Date.now() - windowMs;
  const values = rows
    .filter((r) => r.ts >= cutoff)
    .map((r) => r[key])
    .filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  if (values.length === 0) return null;
  const total = values.reduce((sum, v) => sum + v, 0);
  return total / values.length;
}

function scoreSignal(input: {
  symbol: string;
  price: number;
  ret1m: number;
  ret3m: number;
  ret5m: number;
  volume24hUsdM: number;
  change24hPct: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  spreadPct: number;
  bidDepthGrowthPct: number;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (input.ret1m >= MIN_RET_1M) {
    score += 1;
    reasons.push(`1m ${fmtPct(input.ret1m)}`);
  }
  if (input.ret3m >= MIN_RET_3M) {
    score += 1;
    reasons.push(`3m ${fmtPct(input.ret3m)}`);
  }
  if (input.ret5m >= MIN_RET_5M) {
    score += 1;
    reasons.push(`5m ${fmtPct(input.ret5m)}`);
  }

  const imbalance = input.askDepthUsd > 0 ? input.bidDepthUsd / input.askDepthUsd : 0;
  if (imbalance >= MIN_IMBALANCE) {
    score += 1;
    reasons.push(`imbalance ${imbalance.toFixed(2)}x`);
  }

  if (input.bidDepthUsd >= MIN_BID_DEPTH_USD) {
    score += 1;
    reasons.push(`bid ${fmtUsd(input.bidDepthUsd)}`);
  }

  if (input.spreadPct > 0 && input.spreadPct <= MAX_SPREAD_PCT) {
    score += 1;
    reasons.push(`spread ${(input.spreadPct * 100).toFixed(2)}%`);
  }

  if (input.bidDepthGrowthPct >= 35) {
    score += 1;
    reasons.push(`bid growth ${fmtPct(input.bidDepthGrowthPct)}`);
  }

  if (input.volume24hUsdM >= 3) {
    score += 1;
    reasons.push(`24h vol $${input.volume24hUsdM.toFixed(2)}M`);
  }

  return { score, reasons };
}

async function loadTickerSnapshots(): Promise<TickerSnapshot[]> {
  const snapshots = await fetchPerpTickerSnapshots();
  const symbols = snapshots
    .filter((s) => Number.isFinite(s.volume24hUsd) && s.volume24hUsd >= MIN_24H_VOL_M)
    .filter((s) => {
      const chg = s.change24hPct ?? 0;
      return chg >= MIN_24H_CHANGE_PCT && chg <= MAX_24H_CHANGE_PCT;
    })
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
    .slice(0, MAX_SYMBOLS);

  const contexts = await fetchPerpContexts(symbols.map((s) => s.symbol));

  return symbols
    .map((s) => {
      const ctx = contexts.get(s.symbol);
      const price = ctx?.markPrice ?? 0;
      const volume24hUsdM = s.volume24hUsd;
      const change24hPct = s.change24hPct ?? 0;
      if (!Number.isFinite(price) || price <= 0) return null;
      return {
        symbol: s.symbol,
        price,
        change24hPct,
        volume24hUsdM,
      } satisfies TickerSnapshot;
    })
    .filter((s): s is TickerSnapshot => s != null);
}

function computeReturnMetrics(symbol: string, currentPrice: number): { ret1m: number; ret3m: number; ret5m: number } {
  const rows = keepRecentSamples(symbol, 20 * 60 * 1000);
  const now = Date.now();
  const sample1m = findClosestSample(rows, now - 60_000);
  const sample3m = findClosestSample(rows, now - 3 * 60_000);
  const sample5m = findClosestSample(rows, now - 5 * 60_000);

  return {
    ret1m: pctMove(sample1m?.price ?? null, currentPrice),
    ret3m: pctMove(sample3m?.price ?? null, currentPrice),
    ret5m: pctMove(sample5m?.price ?? null, currentPrice),
  };
}

async function runCycle(): Promise<void> {
  const now = Date.now();
  const tickers = await loadTickerSnapshots();

  for (const ticker of tickers) {
    addSample(ticker.symbol, {
      ts: now,
      price: ticker.price,
      volume24hUsdM: ticker.volume24hUsdM,
      change24hPct: ticker.change24hPct,
    });
  }

  const candidates = tickers
    .map((ticker) => {
      const ret = computeReturnMetrics(ticker.symbol, ticker.price);
      return { ticker, ...ret };
    })
    .sort((a, b) => (b.ret3m + b.ret1m) - (a.ret3m + a.ret1m))
    .slice(0, MAX_OB_CHECKS);

  for (const c of candidates) {
    const { ticker, ret1m, ret3m, ret5m } = c;
    const ob = await fetchOrderBookExecutionRead(ticker.symbol);
    if (!ob) continue;

    const rows = keepRecentSamples(ticker.symbol, 20 * 60 * 1000);
    const avgBidDepth5m = rollingAvg(rows, "bidDepthUsd", 5 * 60_000);
    const bidDepthGrowthPct = avgBidDepth5m && avgBidDepth5m > 0
      ? ((ob.bidDepthUsd - avgBidDepth5m) / avgBidDepth5m) * 100
      : 0;

    addSample(ticker.symbol, {
      ts: now,
      price: ticker.price,
      volume24hUsdM: ticker.volume24hUsdM,
      change24hPct: ticker.change24hPct,
      bidDepthUsd: ob.bidDepthUsd,
      askDepthUsd: ob.askDepthUsd,
      spreadPct: ob.spreadPct,
    });

    const { score, reasons } = scoreSignal({
      symbol: ticker.symbol,
      price: ticker.price,
      ret1m,
      ret3m,
      ret5m,
      volume24hUsdM: ticker.volume24hUsdM,
      change24hPct: ticker.change24hPct,
      bidDepthUsd: ob.bidDepthUsd,
      askDepthUsd: ob.askDepthUsd,
      spreadPct: ob.spreadPct,
      bidDepthGrowthPct,
    });

    const isStrongPattern = score >= 5 && ret5m <= 4.5;
    const cooldownUntil = cooldownBySymbol.get(ticker.symbol) ?? 0;
    if (isStrongPattern && !alertsBySymbol.has(ticker.symbol) && now >= cooldownUntil) {
      const reason = reasons.join(" | ");
      const alert: AlertState = {
        symbol: ticker.symbol,
        entryPrice: ticker.price,
        entryAt: now,
        lastReportAt: now,
        bestPnlPct: 0,
        worstPnlPct: 0,
        reason,
      };
      alertsBySymbol.set(ticker.symbol, alert);
      cooldownBySymbol.set(ticker.symbol, now + COOLDOWN_MS);

      console.log(
        `[${nowIso()}] ENTER NOW ${ticker.symbol} @ ${fmtPrice(ticker.price)} ` +
        `| score ${score}/8 | 24h ${fmtPct(ticker.change24hPct)} | reasons: ${reason}`,
      );
    }
  }

  for (const [symbol, alert] of alertsBySymbol.entries()) {
    const ticker = tickers.find((t) => t.symbol === symbol);
    if (!ticker) continue;

    const pnlPct = pctMove(alert.entryPrice, ticker.price);
    alert.bestPnlPct = Math.max(alert.bestPnlPct, pnlPct);
    alert.worstPnlPct = Math.min(alert.worstPnlPct, pnlPct);

    if (now - alert.lastReportAt >= REPORT_INTERVAL_MS) {
      alert.lastReportAt = now;
      console.log(
        `[${nowIso()}] SIM ${symbol} entry ${fmtPrice(alert.entryPrice)} -> now ${fmtPrice(ticker.price)} ` +
        `| PnL ${fmtPct(pnlPct)} | best ${fmtPct(alert.bestPnlPct)} | worst ${fmtPct(alert.worstPnlPct)} ` +
        `| age ${((now - alert.entryAt) / 60000).toFixed(0)}m`,
      );
    }

    if (now - alert.entryAt >= MAX_TRACK_MS) {
      console.log(
        `[${nowIso()}] CLOSE SIM ${symbol} entry ${fmtPrice(alert.entryPrice)} -> now ${fmtPrice(ticker.price)} ` +
        `| final ${fmtPct(pnlPct)} | best ${fmtPct(alert.bestPnlPct)} | worst ${fmtPct(alert.worstPnlPct)}`,
      );
      alertsBySymbol.delete(symbol);
    }
  }
}

async function startService(): Promise<never> {
  console.log(`[realtime-runner] Starting monitor at ${nowIso()}`);
  console.log(
    `[realtime-runner] loop=${LOOP_INTERVAL_MS}ms report=${REPORT_INTERVAL_MS / 60000}m ` +
    `min24hVol=$${MIN_24H_VOL_M.toFixed(2)}M minBid=${fmtUsd(MIN_BID_DEPTH_USD)} maxSpread=${(MAX_SPREAD_PCT * 100).toFixed(2)}%`,
  );

  while (true) {
    const started = Date.now();
    try {
      await runCycle();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${nowIso()}] [realtime-runner] cycle error: ${msg}`);
    }

    const elapsed = Date.now() - started;
    const waitMs = Math.max(0, LOOP_INTERVAL_MS - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

startService().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[${nowIso()}] [realtime-runner] fatal error: ${msg}`);
  process.exit(1);
});
