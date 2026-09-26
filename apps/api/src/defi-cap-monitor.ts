/**
 * DeFi Spot Capitulation Monitor
 *
 * Uses 15m OHLCV from GeckoTerminal for pools already in the DB universe.
 * Persists latest state + historical snapshots, and emits Telegram alerts
 * for NEW ALERT transitions (deduped via DefiCapAlertEvent).
 */
import "./env.js";
import { prisma } from "./prisma-client.js";
import { sendTelegramMessage } from "./telegram-service.js";
import { buildDefiCapUniverse } from "./defi-cap-universe.js";

const GECKO_API_BASE = "https://api.geckoterminal.com/api/v2";

const MONITOR_INTERVAL_MS = Math.max(5, Number(process.env.DEFI_CAP_MONITOR_INTERVAL_MINUTES ?? 15)) * 60_000;
const BATCH_SIZE = Math.max(1, Number(process.env.DEFI_CAP_MONITOR_BATCH_SIZE ?? 6));
const BATCH_PAUSE_MS = Math.max(0, Number(process.env.DEFI_CAP_MONITOR_BATCH_PAUSE_MS ?? 1000));

const WATCH_CHANGE_PCT = Math.max(0.5, Number(process.env.DEFI_CAP_WATCH_CHANGE_PCT ?? 1.5));
const ALERT_VOLUME_USD = Math.max(10_000, Number(process.env.DEFI_CAP_ALERT_VOLUME_USD ?? 50_000));
const ALERT_MIN_ATR_PCT = Math.max(1, Number(process.env.DEFI_CAP_ALERT_MIN_ATR_PCT ?? 3));

const TELEGRAM_GLOBAL_ENABLED = ["1", "true", "yes", "on"].includes(String(process.env.TELEGRAM_ALERTS_ENABLED ?? "false").trim().toLowerCase());
const TELEGRAM_DEFI_ENABLED = ["1", "true", "yes", "on"].includes(String(process.env.DEFI_CAP_TELEGRAM_ALERTS_ENABLED ?? "true").trim().toLowerCase());
const TELEGRAM_ENABLED = TELEGRAM_GLOBAL_ENABLED && TELEGRAM_DEFI_ENABLED;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type GeckoOhlcvResponse = {
  data?: {
    attributes?: {
      ohlcv_list?: Array<[number, number, number, number, number, number]>;
    };
  };
};

async function fetchJson<T>(url: string): Promise<T> {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (res.ok) return await res.json() as T;

      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        await sleep(1000 * attempt);
        continue;
      }

      const body = await res.text().catch(() => "");
      throw new Error(`gecko fetch ${res.status}: ${body.slice(0, 180)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`gecko fetch failed after ${maxAttempts} attempts`);
}

async function fetchPool15mOhlcv(network: string, poolAddress: string): Promise<Array<[number, number, number, number, number, number]>> {
  const url = `${GECKO_API_BASE}/networks/${network}/pools/${poolAddress}/ohlcv/minute?aggregate=15&limit=3`;
  const payload = await fetchJson<GeckoOhlcvResponse>(url);
  const list = payload.data?.attributes?.ohlcv_list ?? [];
  return list
    .filter((row): row is [number, number, number, number, number, number] => Array.isArray(row) && row.length >= 6)
    .sort((a, b) => a[0] - b[0]);
}

export type DefiMonitorSummary = {
  checked: number;
  watch: number;
  alerts: number;
};

export type DefiMonitorReportRow = {
  poolId: string;
  network: string;
  pairName: string;
  dex: string | null;
  marketCapM: number;
  liquidityUsd: number;
  weeklyRsi: number | null;
  dailyRsi: number | null;
  dailyStochCrossUp: boolean;
  weeklyStochCrossUp: boolean;
  distanceFromAtlPct: number | null;
  dailyAtrPct: number | null;
  status: string;
  price: number | null;
  changePct15m: number | null;
  volume15mUsd: number | null;
  alertLevel: string;
  alertReason: string | null;
  snapshotAt: Date | null;
};

function buildAlertReason(changePct15m: number | null, volume15mUsd: number | null, pairName: string): string {
  const chg = changePct15m != null ? `${changePct15m >= 0 ? "+" : ""}${changePct15m.toFixed(2)}%` : "n/a";
  const vol = volume15mUsd != null ? `$${(volume15mUsd / 1000).toFixed(0)}K` : "n/a";
  return `${pairName}: ${chg} in 15m, vol=${vol}`;
}

async function maybeSendNewAlert(pool: {
  poolId: string;
  network: string;
  pairName: string;
}, alertReason: string): Promise<void> {
  const dedupeKey = `${pool.poolId}:ALERT:${new Date().toISOString().slice(0, 16)}`;

  const existing = await prisma.defiCapAlertEvent.findUnique({ where: { dedupeKey } });
  if (existing) return;

  await prisma.defiCapAlertEvent.create({
    data: {
      poolId: pool.poolId,
      dedupeKey,
      network: pool.network,
      pairName: pool.pairName,
      alertLevel: "ALERT",
      alertReason,
      sentAt: new Date(),
    },
  });

  if (!TELEGRAM_ENABLED) return;

  const msg = [
    "🚨 DeFi Spot Reversal Alert",
    `Pair: ${pool.pairName}`,
    `Chain: ${pool.network}`,
    alertReason,
    "Source: DeFi cap monitor",
  ].join("\n");

  try {
    await sendTelegramMessage(msg);
  } catch (err) {
    console.error("[defi-cap-monitor] telegram send failed:", err instanceof Error ? err.message : err);
  }
}

async function checkPool(pool: {
  poolId: string;
  network: string;
  poolAddress: string;
  pairName: string;
  dailyAtrPct: number | null;
  dailyStochCrossUp: boolean;
  weeklyStochCrossUp: boolean;
}): Promise<"NORMAL" | "WATCH" | "ALERT" | null> {
  try {
    const candles = await fetchPool15mOhlcv(pool.network, pool.poolAddress);
    if (candles.length < 2) return null;

    const latest = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    const price = Number(latest[4]);
    const prevPrice = Number(prev[4]);
    const volumeBase = Number(latest[5]);

    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(prevPrice) || prevPrice <= 0) return null;

    const changePct15m = ((price - prevPrice) / prevPrice) * 100;
    const volume15mUsd = Number.isFinite(volumeBase) && volumeBase >= 0 ? volumeBase * price : null;

    let alertLevel: "NORMAL" | "WATCH" | "ALERT" = "NORMAL";
    let alertReason: string | null = null;

    if (changePct15m >= WATCH_CHANGE_PCT) {
      alertLevel = "WATCH";

      const hasCrossSignal = pool.dailyStochCrossUp || pool.weeklyStochCrossUp;
      const atrOk = (pool.dailyAtrPct ?? 0) >= ALERT_MIN_ATR_PCT;
      if ((volume15mUsd ?? 0) >= ALERT_VOLUME_USD && hasCrossSignal && atrOk) {
        alertLevel = "ALERT";
        alertReason = buildAlertReason(changePct15m, volume15mUsd, pool.pairName);
      }
    }

    const prevState = await prisma.defiCapMonitor.findUnique({ where: { poolId: pool.poolId } });
    const wasAlert = prevState?.alertLevel === "ALERT";
    const isNewAlert = alertLevel === "ALERT" && !wasAlert;

    await prisma.defiCapMonitor.upsert({
      where: { poolId: pool.poolId },
      create: {
        poolId: pool.poolId,
        snapshotAt: new Date(),
        price,
        pricePrev15m: prevPrice,
        changePct15m: Number(changePct15m.toFixed(3)),
        volume15mUsd: volume15mUsd != null ? Number(volume15mUsd.toFixed(0)) : null,
        alertLevel,
        alertReason,
        alertTriggeredAt: alertLevel === "ALERT" ? new Date() : null,
      },
      update: {
        snapshotAt: new Date(),
        price,
        pricePrev15m: prevPrice,
        changePct15m: Number(changePct15m.toFixed(3)),
        volume15mUsd: volume15mUsd != null ? Number(volume15mUsd.toFixed(0)) : null,
        alertLevel,
        alertReason,
        alertTriggeredAt: alertLevel === "ALERT" ? (prevState?.alertTriggeredAt ?? new Date()) : null,
      },
    });

    await prisma.defiCapMonitorHistory.create({
      data: {
        poolId: pool.poolId,
        snapshotAt: new Date(),
        price,
        changePct15m: Number(changePct15m.toFixed(3)),
        volume15mUsd: volume15mUsd != null ? Number(volume15mUsd.toFixed(0)) : null,
        alertLevel,
      },
    });

    if (isNewAlert && alertReason) {
      await maybeSendNewAlert(pool, alertReason);
    }

    return alertLevel;
  } catch {
    return null;
  }
}

export async function runDefiCapMonitorCycle(): Promise<DefiMonitorSummary> {
  const pools = await prisma.defiCapToken.findMany({
    where: { inCapitulation: true },
    select: {
      poolId: true,
      network: true,
      poolAddress: true,
      pairName: true,
      dailyAtrPct: true,
      dailyStochCrossUp: true,
      weeklyStochCrossUp: true,
    },
  });

  let watch = 0;
  let alerts = 0;

  for (let i = 0; i < pools.length; i += BATCH_SIZE) {
    const batch = pools.slice(i, i + BATCH_SIZE);
    const outcomes = await Promise.all(batch.map((pool) => checkPool(pool)));
    for (const outcome of outcomes) {
      if (outcome === "ALERT") alerts += 1;
      if (outcome === "WATCH") watch += 1;
    }
    if (i + BATCH_SIZE < pools.length && BATCH_PAUSE_MS > 0) {
      await sleep(BATCH_PAUSE_MS);
    }
  }

  return { checked: pools.length, watch, alerts };
}

export async function getDefiMonitorReport(): Promise<DefiMonitorReportRow[]> {
  const rows = await prisma.defiCapToken.findMany({
    where: { inCapitulation: true },
    include: { monitor: true },
    orderBy: [
      { status: "asc" },
      { weeklyRsi: "asc" },
      { marketCapUsd: "asc" },
    ],
  });

  return rows.map((row) => ({
    poolId: row.poolId,
    network: row.network,
    pairName: row.pairName,
    dex: row.dex,
    marketCapM: row.marketCapUsd / 1_000_000,
    liquidityUsd: row.liquidityUsd,
    weeklyRsi: row.weeklyRsi,
    dailyRsi: row.dailyRsi,
    dailyStochCrossUp: row.dailyStochCrossUp,
    weeklyStochCrossUp: row.weeklyStochCrossUp,
    distanceFromAtlPct: row.distanceFromAtlPct,
    dailyAtrPct: row.dailyAtrPct,
    status: row.status,
    price: row.monitor?.price ?? null,
    changePct15m: row.monitor?.changePct15m ?? null,
    volume15mUsd: row.monitor?.volume15mUsd ?? null,
    alertLevel: row.monitor?.alertLevel ?? "NORMAL",
    alertReason: row.monitor?.alertReason ?? null,
    snapshotAt: row.monitor?.snapshotAt ?? null,
  }));
}

export async function startDefiCapMonitorService(): Promise<void> {
  console.log("[defi-cap-monitor] starting 15m monitor service...");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await buildDefiCapUniverse(false);
      const summary = await runDefiCapMonitorCycle();
      console.log(`[defi-cap-monitor] cycle done - checked=${summary.checked} watch=${summary.watch} alerts=${summary.alerts}`);
    } catch (err) {
      console.error("[defi-cap-monitor] cycle error:", err instanceof Error ? err.message : err);
    }
    await sleep(MONITOR_INTERVAL_MS);
  }
}
