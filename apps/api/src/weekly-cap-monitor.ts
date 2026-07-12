/**
 * Weekly Capitulation Monitor
 *
 * Polls every 15 minutes (in batches to avoid hammering Bitunix) for each
 * token in the capitulation universe.  Checks price change, volume, order
 * book depth, and funding rate.  Persists the state and raises alert levels:
 *
 *   NORMAL  – baseline, no movement
 *   WATCH   – price up >2% in the last 15m
 *   ALERT   – price up >2% AND 15m volume ≥$1M AND bid depth looks healthy
 */
import "./env.js";
import { fetchRecentCandles, fetchOrderBookExecutionRead, fetchAllFundingRates } from "./bitunix-service.js";
import { prisma } from "./prisma-client.js";

// ── Config ────────────────────────────────────────────────────────────────────

const MONITOR_INTERVAL_MS    = 15 * 60 * 1000;   // 15 minutes
const BATCH_SIZE             = 8;
const BATCH_PAUSE_MS         = 2_000;
const WATCH_CHANGE_PCT       = 2;                 // >2% → WATCH
const ALERT_VOLUME_USD       = 1_000_000;         // ≥$1M 15m volume → ALERT
const ALERT_BID_DEPTH_MIN    = 5_000;             // minimum bid depth USD for ALERT

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toUsdtInstId(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (upper.endsWith("-PERP")) return `${upper.slice(0, -5)}USDT`;
  if (upper.endsWith("USDT"))  return upper;
  return `${upper}USDT`;
}

// ── Per-symbol check ──────────────────────────────────────────────────────────

type MonitorCheckResult = {
  symbol: string;
  price: number;
  pricePrev15m: number | null;
  changePct15m: number | null;
  volume15mUsd: number | null;
  bidDepthUsd: number | null;
  askDepthUsd: number | null;
  fundingRate: number | null;
  alertLevel: "NORMAL" | "WATCH" | "ALERT";
  alertReason: string | null;
};

async function checkSymbol(
  symbol: string,
  fundingRates: Map<string, number>,
): Promise<MonitorCheckResult | null> {
  try {
    const instId = toUsdtInstId(symbol);

    // Fetch last 3 × 15m candles — enough to compare current vs prev close
    const [candles15m] = await Promise.all([
      fetchRecentCandles(symbol, "15m", 3),
    ]);

    const closes = candles15m.map((c) => Number(c.close)).filter(Number.isFinite);
    const volumes = candles15m.map((c) => Number(c.volume)).filter(Number.isFinite);
    if (closes.length < 2) return null;

    const price      = closes[closes.length - 1];
    const prevPrice  = closes[closes.length - 2];
    const vol15m     = volumes[volumes.length - 1] ?? null;

    // Volume is in base token units from Bitunix — convert to USD
    const volume15mUsd = vol15m != null && price > 0 ? vol15m * price : null;

    const changePct15m = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : null;

    // Order book depth only when price is moving (avoid unnecessary calls)
    let bidDepthUsd: number | null = null;
    let askDepthUsd: number | null = null;
    if (changePct15m != null && changePct15m >= WATCH_CHANGE_PCT) {
      const ob = await fetchOrderBookExecutionRead(instId);
      if (ob) {
        bidDepthUsd = ob.bidDepthUsd;
        askDepthUsd = ob.askDepthUsd;
      }
    }

    // Funding rate from pre-fetched map
    const baseSymbol = symbol.replace(/-PERP$/i, "").toUpperCase();
    const fundingRate = fundingRates.get(baseSymbol + "USDT") ?? fundingRates.get(symbol) ?? null;

    // Fetch timeframe confluence count
    const tokenData = await prisma.weeklyCapToken.findUnique({ where: { symbol } });
    const timeframeCrossCount = tokenData?.timeframeCrossCount ?? 0;

    // Classify alert level
    let alertLevel: "NORMAL" | "WATCH" | "ALERT" = "NORMAL";
    let alertReason: string | null = null;

    if (changePct15m != null && changePct15m >= WATCH_CHANGE_PCT) {
      alertLevel  = "WATCH";
      alertReason = `+${changePct15m.toFixed(2)}% in 15m`;

      if (
        volume15mUsd != null &&
        volume15mUsd >= ALERT_VOLUME_USD &&
        (bidDepthUsd == null || bidDepthUsd >= ALERT_BID_DEPTH_MIN) &&
        timeframeCrossCount >= 3  // Require at least 3 timeframes crossing for ALERT
      ) {
        alertLevel  = "ALERT";
        alertReason = `+${changePct15m.toFixed(2)}% | vol $${(volume15mUsd / 1_000).toFixed(0)}K | ${timeframeCrossCount} timeframes crossing`;
      }
    }

    return {
      symbol,
      price,
      pricePrev15m: prevPrice,
      changePct15m: changePct15m != null ? Number(changePct15m.toFixed(3)) : null,
      volume15mUsd: volume15mUsd != null ? Number(volume15mUsd.toFixed(0)) : null,
      bidDepthUsd:  bidDepthUsd  != null ? Number(bidDepthUsd.toFixed(0))  : null,
      askDepthUsd:  askDepthUsd  != null ? Number(askDepthUsd.toFixed(0))  : null,
      fundingRate,
      alertLevel,
      alertReason,
    };
  } catch {
    return null;
  }
}

// ── Persist ───────────────────────────────────────────────────────────────────

async function persistResult(result: MonitorCheckResult): Promise<void> {
  const now        = new Date();
  const prevState  = await prisma.weeklyCapMonitor.findUnique({ where: { symbol: result.symbol } });
  const wasAlert   = prevState?.alertLevel === "ALERT";
  const isNewAlert = !wasAlert && result.alertLevel === "ALERT";

  await prisma.weeklyCapMonitor.upsert({
    where:  { symbol: result.symbol },
    create: {
      symbol:           result.symbol,
      snapshotAt:       now,
      price:            result.price,
      pricePrev15m:     result.pricePrev15m,
      changePct15m:     result.changePct15m,
      volume15mUsd:     result.volume15mUsd,
      bidDepthUsd:      result.bidDepthUsd,
      askDepthUsd:      result.askDepthUsd,
      fundingRate:      result.fundingRate,
      alertLevel:       result.alertLevel,
      alertTriggeredAt: isNewAlert ? now : null,
      alertReason:      result.alertReason,
    },
    update: {
      snapshotAt:       now,
      price:            result.price,
      pricePrev15m:     result.pricePrev15m,
      changePct15m:     result.changePct15m,
      volume15mUsd:     result.volume15mUsd,
      bidDepthUsd:      result.bidDepthUsd != null ? result.bidDepthUsd : undefined,
      askDepthUsd:      result.askDepthUsd != null ? result.askDepthUsd : undefined,
      fundingRate:      result.fundingRate  != null ? result.fundingRate  : undefined,
      alertLevel:       result.alertLevel,
      alertTriggeredAt: isNewAlert ? now : (prevState?.alertTriggeredAt ?? null),
      alertReason:      result.alertReason,
    },
  });
}

// ── One monitor cycle ─────────────────────────────────────────────────────────

export async function runMonitorCycle(): Promise<{
  checked: number;
  watch: number;
  alerts: number;
}> {
  const tokens = await prisma.weeklyCapToken.findMany({
    where: { inCapitulation: true },
    select: { symbol: true },
    orderBy: { distanceFromAtlPct: "asc" },
  });

  if (tokens.length === 0) {
    return { checked: 0, watch: 0, alerts: 0 };
  }

  const fundingRates = await fetchAllFundingRates();
  const symbols      = tokens.map((t) => t.symbol);

  let checked = 0;
  let watch   = 0;
  let alerts  = 0;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch   = symbols.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((sym) => checkSymbol(sym, fundingRates)),
    );

    for (const r of results) {
      if (r.status !== "fulfilled" || r.value == null) continue;
      const result = r.value;
      await persistResult(result);
      checked += 1;
      if (result.alertLevel === "WATCH")  watch  += 1;
      if (result.alertLevel === "ALERT")  alerts += 1;
    }

    if (i + BATCH_SIZE < symbols.length) {
      await sleep(BATCH_PAUSE_MS);
    }
  }

  return { checked, watch, alerts };
}

// ── Continuous service ────────────────────────────────────────────────────────

export async function startWeeklyCapMonitorService(): Promise<never> {
  console.log(`[weekly-cap:monitor] Starting — interval ${MONITOR_INTERVAL_MS / 1000}s, batch ${BATCH_SIZE}`);

  while (true) {
    const start = Date.now();
    try {
      const summary = await runMonitorCycle();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `[weekly-cap:monitor] ${new Date().toISOString()} checked=${summary.checked} watch=${summary.watch} alerts=${summary.alerts} (${elapsed}s)`,
      );
    } catch (err) {
      console.error("[weekly-cap:monitor] Cycle error:", err instanceof Error ? err.message : err);
    }

    const elapsed = Date.now() - start;
    const wait    = Math.max(0, MONITOR_INTERVAL_MS - elapsed);
    await sleep(wait);
  }
}

// ── Report data ───────────────────────────────────────────────────────────────

export type MonitorReportRow = {
  symbol: string;
  marketCapM: number;
  weeklyRsi: number | null;
  distanceFromAtlPct: number | null;
  weeklyStochCrossUp: boolean;
  dailyStochCrossUp: boolean;
  timeframeCrossCount: number;
  price: number | null;
  changePct15m: number | null;
  volume15mUsd: number | null;
  bidDepthUsd: number | null;
  askDepthUsd: number | null;
  fundingRate: number | null;
  alertLevel: string;
  alertReason: string | null;
  alertTriggeredAt: Date | null;
  snapshotAt: Date | null;
};

export async function getMonitorReport(): Promise<MonitorReportRow[]> {
  const rows = await prisma.weeklyCapToken.findMany({
    where: { inCapitulation: true },
    orderBy: [{ distanceFromAtlPct: "asc" }],
    include: { monitor: true },
  });

  return rows.map((r) => ({
    symbol: r.symbol,
    marketCapM: Number((r.marketCapUsd / 1_000_000).toFixed(1)),
    weeklyRsi: r.weeklyRsi,
    distanceFromAtlPct: r.distanceFromAtlPct,
    weeklyStochCrossUp: r.weeklyStochCrossUp,
    dailyStochCrossUp: r.dailyStochCrossUp,
    timeframeCrossCount: r.timeframeCrossCount,
    price: r.monitor?.price ?? null,
    changePct15m: r.monitor?.changePct15m ?? null,
    volume15mUsd: r.monitor?.volume15mUsd ?? null,
    bidDepthUsd: r.monitor?.bidDepthUsd ?? null,
    askDepthUsd: r.monitor?.askDepthUsd ?? null,
    fundingRate: r.monitor?.fundingRate ?? null,
    alertLevel: r.monitor?.alertLevel ?? "NORMAL",
    alertReason: r.monitor?.alertReason ?? null,
    alertTriggeredAt: r.monitor?.alertTriggeredAt ?? null,
    snapshotAt: r.monitor?.snapshotAt ?? null,
  }));
}
