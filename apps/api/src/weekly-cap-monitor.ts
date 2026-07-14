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
import { fetchRecentCandles, fetchOrderBookExecutionRead, fetchAllFundingRates, fetchPerpTickerSnapshots } from "./bitunix-service.js";
import { prisma } from "./prisma-client.js";

// ── Config ────────────────────────────────────────────────────────────────────

const MONITOR_INTERVAL_MS         = 15 * 60 * 1000;   // 15 minutes
const BATCH_SIZE                  = 8;
const BATCH_PAUSE_MS              = 2_000;
const WATCH_CHANGE_PCT            = 1.5;               // >1.5% → WATCH (low-cap tokens move in smaller steps)
const ALERT_VOLUME_USD            = 50_000;            // ≥$50K 15m volume → ALERT (realistic for $5-50M cap tokens)
const ALERT_BID_DEPTH_MIN         = 2_000;             // minimum bid depth USD for ALERT
const ALERT_MIN_CROSS_COUNT       = 2;                 // require at least 2 timeframes crossing for ALERT
const ALERT_MIN_ATR_PCT           = 3;                 // require ≥3% daily ATR to filter out dead/slow tokens
const MIN_24H_VOLUME_USD_M        = 1;                 // require ≥$1M 24h volume to avoid illiquid traps
const IMBALANCE_ACCELERATION_PCTS = 50;                // >50% jump in imbalance = immediate ALERT signal

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

/**
 * Fetch the most recent history record for a symbol.
 * Used to calculate imbalance acceleration.
 */
async function getPreviousHistoryRecord(symbol: string) {
  return await prisma.weeklyCapMonitorHistory.findFirst({
    where: { symbol },
    orderBy: { snapshotAt: "desc" },
    take: 1,
  });
}

/**
 * Calculate imbalance acceleration percentage.
 * Returns null if previous value unavailable, otherwise % change.
 */
function calculateImbalanceAcceleration(
  currentImbalance: number | null,
  prevImbalance: number | null,
): number | null {
  if (currentImbalance == null || prevImbalance == null || prevImbalance === 0) {
    return null;
  }
  const accel = ((currentImbalance - prevImbalance) / prevImbalance) * 100;
  return Number(accel.toFixed(1));
}

// ── Pre-fire signal computation ───────────────────────────────────────────────

/**
 * Computes a 0-4 pre-fire score based on order book + funding indicators.
 * Higher score = stronger pre-activation signal before price move.
 * 
 * Signals:
 * - Bid/ask imbalance >1.5 (strong buy pressure accumulation)
 * - Funding rate positive (longs piling in, liquidation risk = spark)
 * - Bid-ask spread < 0.5% (tight market, ready to move)
 * - Bid depth concentration (bids dominate vs asks)
 */
function computePreFireScore(
  bidAskImbalance: number | null,
  fundingRate: number | null,
  spreadPct: number | null,
): { score: number; fundingLevel: string } {
  let score = 0;
  let fundingLevel = "NEUTRAL";

  // 1. Bid/ask imbalance: >1.5 = strong buy pressure (1 pt)
  if (bidAskImbalance != null && bidAskImbalance > 1.5) {
    score += 1;
  }

  // 2. Funding rate:  >0.01% = POSITIVE, >0.05% = VERY_POSITIVE (1 pt)
  if (fundingRate != null) {
    if (fundingRate > 0.0005) { // 0.05% per interval
      score += 1;
      fundingLevel = fundingRate > 0.001 ? "VERY_POSITIVE" : "POSITIVE";
    } else if (fundingRate > 0.0001) {
      fundingLevel = "POSITIVE";
    } else if (fundingRate < -0.0001) {
      fundingLevel = "NEGATIVE";
    }
  }

  // 3. Spread tight: <0.3% = market ready (1 pt)
  if (spreadPct != null && spreadPct < 0.003) {
    score += 1;
  }

  // 4. Bonus: very tight spread (<0.2%) + positive funding = maximum setup (1 pt)
  if (spreadPct != null && spreadPct < 0.002 && fundingLevel !== "NEUTRAL") {
    score += 1;
  }

  return { score: Math.min(4, score), fundingLevel };
}

// ── Per-symbol check ──────────────────────────────────────────────────────────

type MonitorCheckResult = {
  symbol: string;
  price: number;
  pricePrev15m: number | null;
  changePct15m: number | null;
  volume15mUsd: number | null;
  volume24hUsdM: number | null;
  bidDepthUsd: number | null;
  askDepthUsd: number | null;
  fundingRate: number | null;
  bidAskImbalance: number | null;
  imbalanceAccelPct: number | null;
  spreadPct: number | null;
  preFireScore: number;
  fundingRateLevel: string;
  alertLevel: "NORMAL" | "CAUTION" | "WATCH" | "ALERT";
  alertReason: string | null;
};

async function checkSymbol(
  symbol: string,
  fundingRates: Map<string, number>,
  volume24hBySymbol: Map<string, number>,
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
    const volume24hUsdM = volume24hBySymbol.get(symbol) ?? null;
    const hasMin24hLiquidity = volume24hUsdM != null && volume24hUsdM >= MIN_24H_VOLUME_USD_M;

    // Order book depth and imbalance analysis
    let bidDepthUsd: number | null = null;
    let askDepthUsd: number | null = null;
    let spreadPct: number | null = null;
    let bidAskImbalance: number | null = null;
    let imbalanceAccelPct: number | null = null;
    let preFireScore = 0;
    let fundingRateLevel = "NEUTRAL";

    // Fetch order book on every check (pre-fire signals are key, not just on price moves)
    const ob = await fetchOrderBookExecutionRead(instId);
    if (ob) {
      bidDepthUsd = ob.bidDepthUsd;
      askDepthUsd = ob.askDepthUsd;
      spreadPct = ob.spreadPct;
      
      // Compute bid/ask imbalance (bid depth / ask depth)
      if (bidDepthUsd != null && askDepthUsd != null && askDepthUsd > 0) {
        bidAskImbalance = Number((bidDepthUsd / askDepthUsd).toFixed(2));
      }
    }

    // Calculate imbalance acceleration by comparing to previous history record
    const prevHistory = await getPreviousHistoryRecord(symbol);
    if (prevHistory && bidAskImbalance != null) {
      imbalanceAccelPct = calculateImbalanceAcceleration(bidAskImbalance, prevHistory.bidAskImbalance);
    }

    // Funding rate from pre-fetched map
    const baseSymbol = symbol.replace(/-PERP$/i, "").toUpperCase();
    const fundingRate = fundingRates.get(baseSymbol + "USDT") ?? fundingRates.get(symbol) ?? null;

    // Compute pre-fire score based on order book + funding
    const preFireAnalysis = computePreFireScore(bidAskImbalance, fundingRate, spreadPct);
    preFireScore = preFireAnalysis.score;
    fundingRateLevel = preFireAnalysis.fundingLevel;

    // Fetch timeframe confluence count
    const tokenData = await prisma.weeklyCapToken.findUnique({ where: { symbol } });
    const timeframeCrossCount = tokenData?.timeframeCrossCount ?? 0;
    const weeklyRsi = tokenData?.weeklyRsi ?? null;
    const distanceFromAtlPct = tokenData?.distanceFromAtlPct ?? null;
    const macdHistRising = tokenData?.macdHistRising ?? false;
    const priceAbovePrevClose = tokenData?.priceAbovePrevClose ?? false;
    const volVsAvg14d = tokenData?.volVsAvg14d ?? null;

    // Calculate activation score (0-3)
    const actScore = (macdHistRising ? 1 : 0) + (priceAbovePrevClose ? 1 : 0) + ((volVsAvg14d ?? 0) >= 1.2 ? 1 : 0);

    // Classify alert level
    let alertLevel: "NORMAL" | "CAUTION" | "WATCH" | "ALERT" = "NORMAL";
    let alertReason: string | null = null;

    // ALERT (Acceleration spike): Imbalance jumped >50% = immediate activation signal
    if (
      hasMin24hLiquidity &&
      imbalanceAccelPct != null &&
      imbalanceAccelPct >= IMBALANCE_ACCELERATION_PCTS &&
      (tokenData?.atrPct == null || tokenData.atrPct >= ALERT_MIN_ATR_PCT)
    ) {
      alertLevel  = "ALERT";
      alertReason = `🔥 Imbalance spike +${imbalanceAccelPct.toFixed(1)}% (acceleration detected) | 24h vol $${volume24hUsdM?.toFixed(2)}M`;
    }
    // ALERT: Activation confirmed (Act 1+/3 OR Fire 2+/4) with structural setup (2+ crosses)
    else if (
      hasMin24hLiquidity &&
      (actScore >= 1 || preFireScore >= 2) &&
      timeframeCrossCount >= ALERT_MIN_CROSS_COUNT &&
      (tokenData?.atrPct == null || tokenData.atrPct >= ALERT_MIN_ATR_PCT)
    ) {
      alertLevel  = "ALERT";
      const triggers = [];
      if (actScore >= 1) triggers.push(`Act ${actScore}/3`);
      if (preFireScore >= 2) triggers.push(`Fire ${preFireScore}/4`);
      alertReason = `${triggers.join(" + ")} | ${timeframeCrossCount} timeframes crossing | 24h vol $${volume24hUsdM?.toFixed(2)}M`;
    }
    // CAUTION: Structural setup ready (wRSI <30, 2+ crosses, near ATL) but awaiting activation
    else if (
      hasMin24hLiquidity &&
      weeklyRsi != null && weeklyRsi < 30 &&
      timeframeCrossCount >= ALERT_MIN_CROSS_COUNT &&
      distanceFromAtlPct != null && distanceFromAtlPct <= 3 &&
      actScore === 0 &&
      preFireScore < 2 &&
      (tokenData?.atrPct == null || tokenData.atrPct >= ALERT_MIN_ATR_PCT)  // Volatility gate: must have movement potential
    ) {
      alertLevel  = "CAUTION";
      alertReason = `Setup ready: wRSI ${weeklyRsi.toFixed(1)} + ${timeframeCrossCount} crosses + ${distanceFromAtlPct.toFixed(1)}% from ATL + ATR ${tokenData?.atrPct?.toFixed(1)}% + 24h vol $${volume24hUsdM?.toFixed(2)}M — waiting for Act 1+/3 or Fire 2+/4`;
    }
    // WATCH: Price moving significantly (>1.5% in 15m)
    else if (changePct15m != null && changePct15m >= WATCH_CHANGE_PCT) {
      alertLevel  = "WATCH";
      alertReason = `+${changePct15m.toFixed(2)}% in 15m`;

      if (
        hasMin24hLiquidity &&
        volume15mUsd != null &&
        volume15mUsd >= ALERT_VOLUME_USD &&
        (bidDepthUsd == null || bidDepthUsd >= ALERT_BID_DEPTH_MIN) &&
        timeframeCrossCount >= ALERT_MIN_CROSS_COUNT &&
        (tokenData?.atrPct == null || tokenData.atrPct >= ALERT_MIN_ATR_PCT)
      ) {
        alertLevel  = "ALERT";
        alertReason = `+${changePct15m.toFixed(2)}% | vol $${(volume15mUsd / 1_000).toFixed(0)}K | 24h vol $${volume24hUsdM?.toFixed(2)}M | ${timeframeCrossCount} timeframes crossing`;
      }
    }

    return {
      symbol,
      price,
      pricePrev15m: prevPrice,
      changePct15m: changePct15m != null ? Number(changePct15m.toFixed(3)) : null,
      volume15mUsd: volume15mUsd != null ? Number(volume15mUsd.toFixed(0)) : null,
      volume24hUsdM,
      bidDepthUsd:  bidDepthUsd  != null ? Number(bidDepthUsd.toFixed(0))  : null,
      askDepthUsd:  askDepthUsd  != null ? Number(askDepthUsd.toFixed(0))  : null,
      fundingRate,
      bidAskImbalance: bidAskImbalance ?? null,
      imbalanceAccelPct,
      spreadPct: spreadPct != null ? Number(spreadPct.toFixed(4)) : null,
      preFireScore,
      fundingRateLevel,
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
      symbol:              result.symbol,
      snapshotAt:          now,
      price:               result.price,
      pricePrev15m:        result.pricePrev15m,
      changePct15m:        result.changePct15m,
      volume15mUsd:        result.volume15mUsd,
      bidDepthUsd:         result.bidDepthUsd,
      askDepthUsd:         result.askDepthUsd,
      fundingRate:         result.fundingRate,
      bidAskImbalance:     result.bidAskImbalance,
      spreadPct:           result.spreadPct,
      preFireScore:        result.preFireScore,
      alertLevel:          result.alertLevel,
      alertTriggeredAt:    isNewAlert ? now : null,
      alertReason:         result.alertReason,
    },
    update: {
      snapshotAt:          now,
      price:               result.price,
      pricePrev15m:        result.pricePrev15m,
      changePct15m:        result.changePct15m,
      volume15mUsd:        result.volume15mUsd,
      bidDepthUsd:         result.bidDepthUsd         != null ? result.bidDepthUsd         : undefined,
      askDepthUsd:         result.askDepthUsd         != null ? result.askDepthUsd         : undefined,
      fundingRate:         result.fundingRate         != null ? result.fundingRate         : undefined,
      bidAskImbalance:     result.bidAskImbalance     != null ? result.bidAskImbalance     : undefined,
      spreadPct:           result.spreadPct           != null ? result.spreadPct           : undefined,
      preFireScore:        result.preFireScore,
      alertLevel:          result.alertLevel,
      alertTriggeredAt:    isNewAlert ? now : (prevState?.alertTriggeredAt ?? null),
      alertReason:         result.alertReason,
    },
  });

  // Store full time-series to history table for acceleration tracking
  await prisma.weeklyCapMonitorHistory.create({
    data: {
      symbol:             result.symbol,
      snapshotAt:         now,
      price:              result.price,
      bidAskImbalance:    result.bidAskImbalance,
      imbalanceAccelPct:  result.imbalanceAccelPct,
      preFireScore:       result.preFireScore,
      fundingRate:        result.fundingRate,
      spreadPct:          result.spreadPct,
      alertLevel:         result.alertLevel,
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
  const tickerSnapshots = await fetchPerpTickerSnapshots();
  const volume24hBySymbol = new Map(tickerSnapshots.map((s) => [s.symbol, s.volume24hUsd]));
  const symbols      = tokens.map((t) => t.symbol);

  let checked = 0;
  let watch   = 0;
  let alerts  = 0;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch   = symbols.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((sym) => checkSymbol(sym, fundingRates, volume24hBySymbol)),
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
  stoch4hCrossUp: boolean;
  stoch1hCrossUp: boolean;
  stoch15mCrossUp: boolean;
  timeframeCrossCount: number;
  atrPct: number | null;
  macdHistRising: boolean;
  priceAbovePrevClose: boolean;
  volVsAvg14d: number | null;
  price: number | null;
  changePct15m: number | null;
  volume15mUsd: number | null;
  bidDepthUsd: number | null;
  askDepthUsd: number | null;
  bidAskImbalance: number | null;
  spreadPct: number | null;
  preFireScore: number;
  fundingRate: number | null;
  fundingRateLevel: string;
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
    stoch4hCrossUp: r.stoch4hCrossUp,
    stoch1hCrossUp: r.stoch1hCrossUp,
    stoch15mCrossUp: r.stoch15mCrossUp,
    timeframeCrossCount: r.timeframeCrossCount,
    atrPct: r.atrPct,
    macdHistRising: r.macdHistRising,
    priceAbovePrevClose: r.priceAbovePrevClose,
    volVsAvg14d: r.volVsAvg14d,
    price: r.monitor?.price ?? null,
    changePct15m: r.monitor?.changePct15m ?? null,
    volume15mUsd: r.monitor?.volume15mUsd ?? null,
    bidDepthUsd: r.monitor?.bidDepthUsd ?? null,
    askDepthUsd: r.monitor?.askDepthUsd ?? null,
    bidAskImbalance: r.monitor?.bidAskImbalance ?? null,
    spreadPct: r.monitor?.spreadPct ?? null,
    preFireScore: r.monitor?.preFireScore ?? 0,
    fundingRate: r.monitor?.fundingRate ?? null,
    fundingRateLevel: r.monitor?.fundingRate != null 
      ? (r.monitor.fundingRate > 0.0005 ? (r.monitor.fundingRate > 0.001 ? "VERY_POSITIVE" : "POSITIVE") 
      : (r.monitor.fundingRate < -0.0001 ? "NEGATIVE" : "NEUTRAL"))
      : "NEUTRAL",
    alertLevel: r.monitor?.alertLevel ?? "NORMAL",
    alertReason: r.monitor?.alertReason ?? null,
    alertTriggeredAt: r.monitor?.alertTriggeredAt ?? null,
    snapshotAt: r.monitor?.snapshotAt ?? null,
  }));
}
