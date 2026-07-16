/**
 * Coinbase Spot Weekly Capitulation Monitor
 *
 * Polls Coinbase spot prices every 15 minutes for capitulation tokens.
 * No funding rates (spot only). Alerts based on:
 *   WATCH  – price up >1.5% in 15m window
 *   ALERT  – WATCH conditions + volume surge + ATR% gate + ≥2 TF crosses
 */
import "./env.js";
import { prisma } from "./prisma-client.js";
import { buildCoinbaseCapUniverse } from "./coinbase-cap-universe.js";

// ── Config ────────────────────────────────────────────────────────────────────

const COINBASE_API_URL     = "https://api.exchange.coinbase.com";
const MONITOR_INTERVAL_MS  = 15 * 60 * 1000;
const BATCH_SIZE           = 6;
const BATCH_PAUSE_MS       = 1_500;

const WATCH_CHANGE_PCT     = 1.5;     // >1.5% in 15m → WATCH
const ALERT_VOLUME_USD     = 50_000;  // ≥$50K 15m volume for ALERT
const ALERT_MIN_CROSS_COUNT = 2;      // ≥2 TF crosses for ALERT
const ALERT_MIN_ATR_PCT    = 3;       // ≥3% ATR to exclude dead tokens

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchSpotPrice(productId: string): Promise<{ price: number; volume15mUsd: number | null } | null> {
  try {
    const [tickerRes, candleRes] = await Promise.all([
      fetch(`${COINBASE_API_URL}/products/${encodeURIComponent(productId)}/ticker`, { headers: { Accept: "application/json" } }),
      fetch(
        `${COINBASE_API_URL}/products/${encodeURIComponent(productId)}/candles` +
        `?granularity=900` +
        `&start=${new Date(Date.now() - 1800_000).toISOString()}` +
        `&end=${new Date().toISOString()}`,
        { headers: { Accept: "application/json" } },
      ),
    ]);

    if (!tickerRes.ok) return null;
    const ticker = await tickerRes.json() as { price?: string };
    const price = Number(ticker.price);
    if (!Number.isFinite(price) || price <= 0) return null;

    let volume15mUsd: number | null = null;
    if (candleRes.ok) {
      const candles = await candleRes.json() as unknown;
      if (Array.isArray(candles) && candles.length > 0) {
        // Most recent candle: [timestamp, low, high, open, close, volume]
        const latest = candles.sort((a: unknown[], b: unknown[]) => Number(b[0]) - Number(a[0]))[0];
        const vol = Number(latest[5]);
        if (Number.isFinite(vol) && vol > 0) {
          volume15mUsd = vol * price;
        }
      }
    }

    return { price, volume15mUsd };
  } catch {
    return null;
  }
}

// ── Monitor cycle ─────────────────────────────────────────────────────────────

export type MonitorSummary = {
  checked: number;
  watch: number;
  alerts: number;
};

async function checkSymbol(symbol: string): Promise<void> {
  const tokenData = await prisma.coinbaseCapToken.findUnique({ where: { symbol } });
  if (!tokenData) return;

  const spot = await fetchSpotPrice(symbol);
  if (!spot) return;

  const { price, volume15mUsd } = spot;

  // Previous snapshot for 15m change
  const prev = await prisma.coinbaseCapMonitor.findUnique({ where: { symbol } });
  const pricePrev15m = prev?.price ?? null;
  const changePct15m = pricePrev15m != null && pricePrev15m > 0
    ? ((price - pricePrev15m) / pricePrev15m) * 100
    : null;

  let alertLevel = "NORMAL";
  let alertReason: string | null = null;
  let alertTriggeredAt: Date | null = prev?.alertTriggeredAt ?? null;

  if (changePct15m != null && changePct15m >= WATCH_CHANGE_PCT) {
    alertLevel = "WATCH";

    const timeframeCrossCount = tokenData.timeframeCrossCount ?? 0;
    const atrPct = tokenData.atrPct ?? 0;

    if (
      volume15mUsd != null &&
      volume15mUsd >= ALERT_VOLUME_USD &&
      timeframeCrossCount >= ALERT_MIN_CROSS_COUNT &&
      atrPct >= ALERT_MIN_ATR_PCT
    ) {
      alertLevel = "ALERT";
      alertReason = `+${changePct15m.toFixed(2)}% | vol $${(volume15mUsd / 1000).toFixed(0)}K | ${timeframeCrossCount} crosses`;
      if (!alertTriggeredAt) alertTriggeredAt = new Date();
    }
  } else if (alertLevel === "NORMAL") {
    alertTriggeredAt = null;
  }

  await prisma.coinbaseCapMonitor.upsert({
    where: { symbol },
    create: {
      symbol,
      snapshotAt: new Date(),
      price,
      pricePrev15m,
      changePct15m,
      volume15mUsd,
      alertLevel,
      alertReason,
      alertTriggeredAt,
    },
    update: {
      snapshotAt: new Date(),
      price,
      pricePrev15m,
      changePct15m,
      volume15mUsd,
      alertLevel,
      alertReason,
      alertTriggeredAt,
    },
  });
}

export async function runMonitorCycle(): Promise<MonitorSummary> {
  const tokens = await prisma.coinbaseCapToken.findMany({
    where: { inCapitulation: true },
    select: { symbol: true },
  });

  let watch = 0;
  let alerts = 0;

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((t) => checkSymbol(t.symbol)));
    if (i + BATCH_SIZE < tokens.length) await sleep(BATCH_PAUSE_MS);
  }

  const monitors = await prisma.coinbaseCapMonitor.findMany({
    where: { symbol: { in: tokens.map((t) => t.symbol) } },
    select: { alertLevel: true },
  });
  for (const m of monitors) {
    if (m.alertLevel === "ALERT") alerts++;
    else if (m.alertLevel === "WATCH") watch++;
  }

  return { checked: tokens.length, watch, alerts };
}

// ── Report ────────────────────────────────────────────────────────────────────

export type MonitorReportRow = {
  symbol: string;
  marketCapM: number;
  weeklyRsi: number | null;
  distanceFromAtlPct: number | null;
  stoch15mCrossUp: boolean;
  stoch1hCrossUp: boolean;
  stoch6hCrossUp: boolean;
  dailyStochCrossUp: boolean;
  weeklyStochCrossUp: boolean;
  timeframeCrossCount: number;
  atrPct: number | null;
  price: number | null;
  changePct15m: number | null;
  volume15mUsd: number | null;
  alertLevel: string;
  alertReason: string | null;
  snapshotAt: Date | null;
};

export async function getMonitorReport(): Promise<MonitorReportRow[]> {
  const tokens = await prisma.coinbaseCapToken.findMany({
    where: { inCapitulation: true },
    include: { monitor: true },
    orderBy: { distanceFromAtlPct: "asc" },
  });

  return tokens.map((t) => ({
    symbol:              t.symbol,
    marketCapM:          t.marketCapUsd / 1_000_000,
    weeklyRsi:           t.weeklyRsi,
    distanceFromAtlPct:  t.distanceFromAtlPct,
    stoch15mCrossUp:     t.stoch15mCrossUp,
    stoch1hCrossUp:      t.stoch1hCrossUp,
    stoch6hCrossUp:      t.stoch6hCrossUp,
    dailyStochCrossUp:   t.dailyStochCrossUp,
    weeklyStochCrossUp:  t.weeklyStochCrossUp,
    timeframeCrossCount: t.timeframeCrossCount,
    atrPct:              t.atrPct,
    price:               t.monitor?.price ?? null,
    changePct15m:        t.monitor?.changePct15m ?? null,
    volume15mUsd:        t.monitor?.volume15mUsd ?? null,
    alertLevel:          t.monitor?.alertLevel ?? "NORMAL",
    alertReason:         t.monitor?.alertReason ?? null,
    snapshotAt:          t.monitor?.snapshotAt ?? null,
  }));
}

// ── Continuous service ────────────────────────────────────────────────────────

export async function startCoinbaseCapMonitorService(): Promise<void> {
  console.log("[coinbase-cap-monitor] Starting continuous 15m polling service…");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await buildCoinbaseCapUniverse();
      const summary = await runMonitorCycle();
      console.log(`[coinbase-cap-monitor] cycle done — checked=${summary.checked} watch=${summary.watch} alerts=${summary.alerts}`);
    } catch (err) {
      console.error("[coinbase-cap-monitor] cycle error:", err instanceof Error ? err.message : err);
    }
    await sleep(MONITOR_INTERVAL_MS);
  }
}
