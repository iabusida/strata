import "./env.js";
import { CandleInterval, PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";

/**
 * Pre-pump COILING scanner (true early / accumulation phase).
 *
 * Philosophy: a real "pre-pump" token is QUIET, not already moving. The earlier
 * extension-based version rewarded high volume / RSI / SMA-gap, which only fire
 * AFTER a breakout — so it surfaced names like JTO/WLD that had already run.
 *
 * This version flips the signature. It looks for the accumulation / volatility-
 * squeeze base that PRECEDES a breakout:
 *   - volatility compression (current vol low vs its own recent baseline)
 *   - flat / coiling price (no big trailing run-up)
 *   - price sitting in the lower-mid of its range, coiled below resistance
 *   - quiet volume base-building (gentle uptick, not a vertical spike)
 *   - neutral RSI (not overbought)
 *
 * Hard disqualifiers GUARANTEE no "already moved" names survive: anything with a
 * meaningful trailing run-up, extension above its SMAs, overbought RSI, or that
 * is sitting near its range highs is excluded outright.
 *
 * Everything is deterministic and auditable — no AI required. A future AI layer
 * could add shadow commentary over `candidates` without changing the picks.
 */

const prisma = new PrismaClient();

const COINBASE_API_BASE_URL = String(
  process.env.COINBASE_API_BASE_URL ?? "https://api.exchange.coinbase.com"
).trim().replace(/\/$/, "");

const LOOKAHEAD_BARS = 21;
const BASE_RATE_PUMP_PCT = 60; // future move that counts as a "pump" for context base-rate

type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type PrePumpFeatureVector = {
  compressionRatio: number;     // vol20 / volBaseline  (<1 = contracting / squeeze)
  volatility20Pct: number;      // current 20-bar volatility
  trailingReturn10Pct: number;  // run-up over last 10 bars (run-up gate)
  trailingReturn20Pct: number;  // run-up over last 20 bars
  sma20GapPct: number;          // extension above 20d SMA
  sma50GapPct: number;          // extension above 50d SMA
  rangePosition60: number;      // 0..1 position within 60-bar range (0 = lows)
  distFromHigh60Pct: number;    // % below the 60-bar high
  volumeTrendRatio: number;     // avgVol7 / avgVol14 (gentle accumulation)
  rsi14: number;
};

type ScoreKey =
  | "squeeze"
  | "accumulation"
  | "basePosition"
  | "flatness"
  | "coilBelowResistance"
  | "rsiNeutral";

export type PrePumpTier = "TIER_1" | "TIER_2" | "TIER_3";

export type PrePumpCandidate = {
  rank: number;
  symbol: string;
  score: number;            // 0..100 coiling readiness
  firedCount: number;
  fired: ScoreKey[];
  tier: PrePumpTier;
  tierLabel: string;
  tierReason: string;
  avgDollarVol14: number;
  features: PrePumpFeatureVector;
  latestBar: string;
  candleCount: number;
};

export type PrePumpRuleInfo = {
  name: string;
  detail: string;
};

export type PrePumpScanResult = {
  generatedAt: string;
  datasetRows: number;   // historical quiet-base setups evaluated
  pumpRows: number;      // quiet-base setups that then pumped >= BASE_RATE_PUMP_PCT
  baseRatePct: number;   // pumpRows / datasetRows
  rules: PrePumpRuleInfo[];
  universeSize: number;
  scanned: number;
  skipped: number;
  disqualified: number;
  candidates: PrePumpCandidate[];
};

export type PrePumpScanOptions = {
  /** Max candidates returned (ranked). Default 25. */
  topN?: number;
  /** Minimum daily candles required to score a symbol. Default 80. */
  minCandles?: number;
  /** Avg 14d USD volume below this → disqualified (illiquid). Default 1_000_000. */
  minLiquidityUsd?: number;
  /** volatility20Pct above this → disqualified (data noise / already wild). Default 18. */
  maxTrustVolatilityPct?: number;
  /** volatility20Pct below this → disqualified (stablecoin / dead / pegged). Default 0.8. */
  minVolatilityPct?: number;
  /** trailing 10-bar run-up at/above this → disqualified ("already moved"). Default 40. */
  maxTrailingRunupPct?: number;
  /** sma20GapPct at/above this → disqualified (extended). Default 20. */
  maxSma20GapPct?: number;
  /** sma50GapPct at/above this → disqualified (extended). Default 35. */
  maxSma50GapPct?: number;
  /** rsi14 at/above this → disqualified (overbought). Default 68. */
  maxRsi14?: number;
  /** rangePosition60 at/above this → disqualified (already at highs). Default 0.85. */
  maxRangePosition60?: number;
  /** Minimum coiling score to be listed as a candidate. Default 35. */
  minScore?: number;
};

const SCORE_WEIGHTS: Record<ScoreKey, number> = {
  squeeze: 0.28,
  accumulation: 0.20,
  basePosition: 0.14,
  flatness: 0.14,
  coilBelowResistance: 0.12,
  rsiNeutral: 0.12
};

const SCORE_SHORT: Record<ScoreKey, string> = {
  squeeze: "sqz",
  accumulation: "acc",
  basePosition: "base",
  flatness: "flat",
  coilBelowResistance: "coil",
  rsiNeutral: "rsi"
};

const TIER_LABEL: Record<PrePumpTier, string> = {
  TIER_1: "Prime coil",
  TIER_2: "Forming base",
  TIER_3: "Early / weak coil"
};

// ─── Math helpers ──────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Triangular membership: 0 at lo/hi, 1 at peak. */
function bump(value: number, lo: number, peak: number, hi: number): number {
  if (!Number.isFinite(value) || value <= lo || value >= hi) return 0;
  if (value === peak) return 1;
  return value < peak ? (value - lo) / (peak - lo) : (hi - value) / (hi - peak);
}

function meanInRange(values: number[], start: number, end: number): number {
  if (start < 0 || end >= values.length || start > end) return Number.NaN;
  let sum = 0;
  for (let i = start; i <= end; i += 1) sum += values[i];
  return sum / (end - start + 1);
}

function maxInRange(values: number[], start: number, end: number): number {
  if (start < 0 || end >= values.length || start > end) return Number.NaN;
  let m = -Infinity;
  for (let i = start; i <= end; i += 1) if (values[i] > m) m = values[i];
  return m;
}

function minInRange(values: number[], start: number, end: number): number {
  if (start < 0 || end >= values.length || start > end) return Number.NaN;
  let m = Infinity;
  for (let i = start; i <= end; i += 1) if (values[i] < m) m = values[i];
  return m;
}

function smaAt(values: number[], index: number, period: number): number {
  const start = index - period + 1;
  if (start < 0 || index >= values.length) return Number.NaN;
  return meanInRange(values, start, index);
}

/** Annualization-free per-bar volatility (% std-dev of log returns) over `period` ending at index. */
function stdDevPct(values: number[], index: number, period: number): number {
  const start = index - period + 1;
  if (start < 1 || index >= values.length) return Number.NaN;
  const returns: number[] = [];
  for (let i = start; i <= index; i += 1) {
    const prev = values[i - 1];
    const curr = values[i];
    if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(curr) || curr <= 0) return Number.NaN;
    returns.push(Math.log(curr / prev));
  }
  const mean = returns.reduce((acc, item) => acc + item, 0) / returns.length;
  const variance = returns.reduce((acc, item) => acc + (item - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

/** Wilder RSI series aligned to `closes` (NaN until warmed up). */
function computeRsiSeries(closes: number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(Number.NaN);
  if (closes.length <= period) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ─── Feature computation (coiling signature) ───────────────────────────────────

type Computed = {
  features: PrePumpFeatureVector;
  avgDollarVol14: number;
};

/**
 * Coiling feature vector at bar `i`. Requires ~70 bars of history so the 60-bar
 * range and the volatility baseline window are well-formed.
 */
function computeCoilingFeatures(
  candles: Candle[],
  closes: number[],
  highs: number[],
  lows: number[],
  volumes: number[],
  rsiSeries: number[],
  i: number
): Computed | null {
  if (i < 60 || i >= candles.length) return null;
  const close = closes[i];
  if (!Number.isFinite(close) || close <= 0) return null;

  const sma20 = smaAt(closes, i, 20);
  const sma50 = smaAt(closes, i, 50);
  const vol20 = stdDevPct(closes, i, 20);
  const volBaseline = stdDevPct(closes, i - 20, 40); // 40-bar vol ending 20 bars ago
  const avgVol7 = meanInRange(volumes, i - 6, i);
  const avgVol14 = meanInRange(volumes, i - 13, i);
  const close10 = closes[i - 10];
  const close20 = closes[i - 20];
  const max60 = maxInRange(highs, i - 59, i);
  const min60 = minInRange(lows, i - 59, i);
  const rsi14 = rsiSeries[i];

  if (
    !Number.isFinite(sma20) || !Number.isFinite(sma50) ||
    !Number.isFinite(vol20) || !Number.isFinite(volBaseline) || volBaseline <= 0 ||
    !Number.isFinite(avgVol7) || !Number.isFinite(avgVol14) || avgVol14 <= 0 ||
    !Number.isFinite(close10) || close10 <= 0 || !Number.isFinite(close20) || close20 <= 0 ||
    !Number.isFinite(max60) || !Number.isFinite(min60) || max60 <= min60 ||
    !Number.isFinite(rsi14)
  ) {
    return null;
  }

  return {
    avgDollarVol14: avgVol14 * close,
    features: {
      compressionRatio: vol20 / volBaseline,
      volatility20Pct: vol20,
      trailingReturn10Pct: ((close - close10) / close10) * 100,
      trailingReturn20Pct: ((close - close20) / close20) * 100,
      sma20GapPct: ((close - sma20) / sma20) * 100,
      sma50GapPct: ((close - sma50) / sma50) * 100,
      rangePosition60: (close - min60) / (max60 - min60),
      distFromHigh60Pct: ((max60 - close) / max60) * 100,
      volumeTrendRatio: avgVol7 / avgVol14,
      rsi14
    }
  };
}

function isDisqualified(
  f: PrePumpFeatureVector,
  avgDollarVol14: number,
  opts: Required<PrePumpScanOptions>
): string | null {
  if (avgDollarVol14 < opts.minLiquidityUsd) {
    return `illiquid (~$${Math.round(avgDollarVol14).toLocaleString()}/day)`;
  }
  if (f.volatility20Pct > opts.maxTrustVolatilityPct) {
    return `too volatile (${f.volatility20Pct.toFixed(1)}%)`;
  }
  if (f.volatility20Pct < opts.minVolatilityPct) {
    return `dead / pegged (${f.volatility20Pct.toFixed(2)}% volatility)`;
  }
  if (f.trailingReturn10Pct >= opts.maxTrailingRunupPct) {
    return `already moved (+${f.trailingReturn10Pct.toFixed(0)}% in 10d)`;
  }
  if (f.sma20GapPct >= opts.maxSma20GapPct) {
    return `extended above 20d SMA (+${f.sma20GapPct.toFixed(0)}%)`;
  }
  if (f.sma50GapPct >= opts.maxSma50GapPct) {
    return `extended above 50d SMA (+${f.sma50GapPct.toFixed(0)}%)`;
  }
  if (f.rsi14 >= opts.maxRsi14) {
    return `overbought (rsi ${f.rsi14.toFixed(0)})`;
  }
  if (f.rangePosition60 >= opts.maxRangePosition60) {
    return `at range highs (${(f.rangePosition60 * 100).toFixed(0)}% of 60d range)`;
  }
  return null;
}

function scoreComponents(f: PrePumpFeatureVector): Record<ScoreKey, number> {
  // squeeze: lower compressionRatio = tighter coil. 1.0 → 0, 0.45 → 1.
  const squeeze = clamp01((1.0 - f.compressionRatio) / (1.0 - 0.45));
  // accumulation: gentle volume uptick, not a spike.
  const accumulation = bump(f.volumeTrendRatio, 0.9, 1.25, 1.9);
  // basePosition: coiled in the lower-mid of its 60d range (room to run).
  const basePosition = bump(f.rangePosition60, 0.05, 0.35, 0.7);
  // flatness: price barely moved over 20 bars (true base).
  const flatness = clamp01(1 - Math.abs(f.trailingReturn20Pct) / 30);
  // coilBelowResistance: sitting a modest distance below the 60d high.
  const coilBelowResistance = bump(f.distFromHigh60Pct, 3, 14, 35);
  // rsiNeutral: not weak, not overbought.
  const rsiNeutral = bump(f.rsi14, 40, 52, 64);
  return { squeeze, accumulation, basePosition, flatness, coilBelowResistance, rsiNeutral };
}

function classifyTier(
  score: number,
  comps: Record<ScoreKey, number>,
  f: PrePumpFeatureVector
): { tier: PrePumpTier; reason: string } {
  if (score >= 58 && comps.squeeze >= 0.5 && comps.accumulation >= 0.4) {
    return {
      tier: "TIER_1",
      reason: `tight squeeze (ratio ${f.compressionRatio.toFixed(2)}), quiet volume build, flat base`
    };
  }
  if (score >= 45) {
    return {
      tier: "TIER_2",
      reason: `forming base (ratio ${f.compressionRatio.toFixed(2)}, range ${(f.rangePosition60 * 100).toFixed(0)}%)`
    };
  }
  return {
    tier: "TIER_3",
    reason: `early coil — partial signals (ratio ${f.compressionRatio.toFixed(2)})`
  };
}

// ─── Coinbase universe ─────────────────────────────────────────────────────────

async function getCoinbaseSpotSymbols(): Promise<Set<string>> {
  const response = await fetch(`${COINBASE_API_BASE_URL}/products`, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`Coinbase products request failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Coinbase products payload is not an array");
  }
  const symbols = (payload as Array<{ id?: string; quote_currency?: string; status?: string; trading_disabled?: boolean }>)
    .filter((p) => String(p.quote_currency ?? "").toUpperCase() === "USD")
    .filter((p) => String(p.status ?? "").toLowerCase() === "online")
    .filter((p) => p.trading_disabled !== true)
    .map((p) => String(p.id ?? "").toUpperCase())
    .filter((id) => id.endsWith("-USD"))
    .map((id) => id.slice(0, -4))
    .filter((s) => s.length > 0);
  return new Set(symbols);
}

// ─── Main scan ─────────────────────────────────────────────────────────────────

function resolveOptions(raw?: PrePumpScanOptions): Required<PrePumpScanOptions> {
  return {
    topN: Math.max(1, Math.trunc(raw?.topN ?? 25)),
    minCandles: Math.max(70, Math.trunc(raw?.minCandles ?? 80)),
    minLiquidityUsd: Math.max(0, raw?.minLiquidityUsd ?? 1_000_000),
    maxTrustVolatilityPct: Math.max(0, raw?.maxTrustVolatilityPct ?? 18),
    minVolatilityPct: Math.max(0, raw?.minVolatilityPct ?? 0.8),
    maxTrailingRunupPct: Math.max(0, raw?.maxTrailingRunupPct ?? 40),
    maxSma20GapPct: raw?.maxSma20GapPct ?? 20,
    maxSma50GapPct: raw?.maxSma50GapPct ?? 35,
    maxRsi14: raw?.maxRsi14 ?? 68,
    maxRangePosition60: raw?.maxRangePosition60 ?? 0.85,
    minScore: raw?.minScore ?? 35
  };
}

function buildRulesInfo(opts: Required<PrePumpScanOptions>): PrePumpRuleInfo[] {
  return [
    { name: "Run-up gate", detail: `exclude if up ≥ ${opts.maxTrailingRunupPct}% over last 10 bars` },
    { name: "Extension gate", detail: `exclude if > +${opts.maxSma20GapPct}% vs 20d SMA or +${opts.maxSma50GapPct}% vs 50d SMA` },
    { name: "Overbought gate", detail: `exclude if RSI ≥ ${opts.maxRsi14}` },
    { name: "Range gate", detail: `exclude if ≥ ${(opts.maxRangePosition60 * 100).toFixed(0)}% up its 60d range` },
    { name: "Liquidity gate", detail: `exclude if < $${opts.minLiquidityUsd.toLocaleString()}/day` },
    { name: "Volatility gate", detail: `exclude if 20d volatility > ${opts.maxTrustVolatilityPct}%` }
  ];
}

export async function runPrePumpScan(raw?: PrePumpScanOptions): Promise<PrePumpScanResult> {
  const opts = resolveOptions(raw);
  const coinbaseSymbols = await getCoinbaseSpotSymbols();

  const dbSymbols = await prisma.marketCandle.findMany({
    where: { interval: CandleInterval.D1 },
    select: { symbol: true },
    distinct: ["symbol"]
  });
  const scanSymbols = dbSymbols.map((r) => r.symbol).filter((s) => coinbaseSymbols.has(s));

  type Scored = Omit<PrePumpCandidate, "rank">;
  const scored: Scored[] = [];
  let skipped = 0;
  let disqualified = 0;

  // Historical context: of quiet coiling bases, how many then pumped?
  let baseSetups = 0;
  let basePumps = 0;

  for (const symbol of scanSymbols) {
    const candles = await prisma.marketCandle.findMany({
      where: { interval: CandleInterval.D1, symbol },
      orderBy: { timestamp: "asc" },
      select: { open: true, high: true, low: true, close: true, volume: true, timestamp: true }
    });

    if (candles.length < opts.minCandles) {
      skipped += 1;
      continue;
    }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);
    const rsiSeries = computeRsiSeries(closes, 14);

    // Historical base-rate pass (context only).
    for (let j = 60; j < candles.length - LOOKAHEAD_BARS; j += 1) {
      const c = computeCoilingFeatures(candles, closes, highs, lows, volumes, rsiSeries, j);
      if (!c) continue;
      const quietBase =
        Math.abs(c.features.trailingReturn10Pct) <= 25 &&
        c.features.compressionRatio < 1 &&
        c.features.volatility20Pct >= opts.minVolatilityPct &&
        c.features.sma20GapPct < opts.maxSma20GapPct &&
        c.features.rangePosition60 < opts.maxRangePosition60;
      if (!quietBase) continue;
      baseSetups += 1;
      const futureMaxHigh = maxInRange(highs, j + 1, j + LOOKAHEAD_BARS);
      if (Number.isFinite(futureMaxHigh) && closes[j] > 0) {
        const fwd = ((futureMaxHigh - closes[j]) / closes[j]) * 100;
        if (fwd >= BASE_RATE_PUMP_PCT) basePumps += 1;
      }
    }

    // Latest-bar scoring.
    const i = candles.length - 1;
    const computed = computeCoilingFeatures(candles, closes, highs, lows, volumes, rsiSeries, i);
    if (!computed) {
      skipped += 1;
      continue;
    }
    const { features, avgDollarVol14 } = computed;

    if (isDisqualified(features, avgDollarVol14, opts) != null) {
      disqualified += 1;
      continue;
    }

    const comps = scoreComponents(features);
    let score = 0;
    const fired: ScoreKey[] = [];
    for (const key of Object.keys(SCORE_WEIGHTS) as ScoreKey[]) {
      score += SCORE_WEIGHTS[key] * comps[key];
      if (comps[key] >= 0.5) fired.push(key);
    }
    const score100 = score * 100;

    // Must show at least some compression to be a coil candidate.
    if (score100 < opts.minScore || comps.squeeze < 0.35) {
      continue;
    }

    const { tier, reason } = classifyTier(score100, comps, features);

    scored.push({
      symbol,
      score: Number(score100.toFixed(2)),
      firedCount: fired.length,
      fired,
      tier,
      tierLabel: TIER_LABEL[tier],
      tierReason: reason,
      avgDollarVol14: Math.round(avgDollarVol14),
      features,
      latestBar: candles[i].timestamp.toISOString(),
      candleCount: candles.length
    });
  }

  scored.sort((a, b) => (b.score - a.score) || (b.firedCount - a.firedCount));

  const candidates: PrePumpCandidate[] = scored
    .slice(0, opts.topN)
    .map((c, idx) => ({ rank: idx + 1, ...c }));

  return {
    generatedAt: new Date().toISOString(),
    datasetRows: baseSetups,
    pumpRows: basePumps,
    baseRatePct: baseSetups > 0 ? Number(((basePumps / baseSetups) * 100).toFixed(2)) : 0,
    rules: buildRulesInfo(opts),
    universeSize: coinbaseSymbols.size,
    scanned: scanSymbols.length,
    skipped,
    disqualified,
    candidates
  };
}

/** Compact Telegram (HTML) summary of a scan result. */
export function formatPrePumpScanTelegram(result: PrePumpScanResult, maxRows = 20): string {
  const lines: string[] = [];
  lines.push("🧭 <b>Pre-Pump Coils</b> (early / accumulation, daily)");
  lines.push(
    `quiet bases historically pumped ${result.baseRatePct}% of the time ` +
    `(${result.pumpRows.toLocaleString()}/${result.datasetRows.toLocaleString()})`
  );
  lines.push(
    `scanned ${result.scanned} Coinbase tokens · ${result.disqualified} excluded (already moved/extended)`
  );
  lines.push(new Date(result.generatedAt).toUTCString());
  lines.push("");

  if (result.candidates.length === 0) {
    lines.push("No tokens are in a clean pre-breakout coil right now.");
    return lines.join("\n");
  }

  const tierEmoji: Record<PrePumpTier, string> = { TIER_1: "🟢", TIER_2: "🟡", TIER_3: "🔴" };

  for (const c of result.candidates.slice(0, maxRows)) {
    const signals = c.fired.map((k) => SCORE_SHORT[k]).join(",");
    lines.push(
      `${tierEmoji[c.tier]} <b>${c.symbol}</b> · score ${c.score.toFixed(0)} · ` +
      `squeeze ${c.features.compressionRatio.toFixed(2)} · ` +
      `10d ${c.features.trailingReturn10Pct >= 0 ? "+" : ""}${c.features.trailingReturn10Pct.toFixed(0)}% · ` +
      `${c.features.distFromHigh60Pct.toFixed(0)}% below high`
    );
    lines.push(`   ${c.tierLabel} — ${c.tierReason} [${signals}]`);
  }

  lines.push("");
  lines.push("🟢 prime coil · 🟡 forming base · 🔴 early/weak — already-moved names are excluded");
  return lines.join("\n");
}

// ─── Per-symbol assessment (for trade-engine entry gating) ─────────────────────

export type CoilBreakout = {
  /** Highest high of the coil ceiling (pivot window, excluding the latest bar). */
  pivotHigh: number;
  /** % the latest close is above the coil pivot high. */
  breakoutPct: number;
  /** Latest bar volume relative to the average coil volume (surge confirmation). */
  volumeSurgeRatio: number;
  /** True when price has cleared the coil ceiling with a volume surge and is not extended. */
  ready: boolean;
};

export type CoilingAssessment = {
  symbol: string;
  qualified: boolean;
  tier: PrePumpTier | null;
  score: number;
  reason: string;
  disqualifiedReason: string | null;
  features: PrePumpFeatureVector | null;
  avgDollarVol14: number;
  latestBar: string | null;
  /** Breakout-from-base readiness for momentum (breakout) entries. */
  breakout: CoilBreakout | null;
  /** Convenience: qualified AND breakout.ready. */
  breakoutReady: boolean;
};

const coilAssessmentCache = new Map<string, { latestBar: string; assessment: CoilingAssessment }>();

/**
 * Assess a single symbol's pre-pump coiling quality from its stored daily candles.
 *
 * Used by the trade engine to gate entries: a token only "qualifies" if it is a
 * genuine accumulation/squeeze coil that passes ALL disqualifiers — including the
 * dollar-volume liquidity gate (so illiquid penny tokens like FORT are rejected),
 * the already-moved / extension gates, and a minimum coiling score + tier.
 *
 * Results are cached per symbol and only recomputed when a new daily bar appears
 * (daily candles change once per day), so this is cheap to call every scan cycle.
 */
export async function assessCoilingForSymbol(
  symbol: string,
  raw?: PrePumpScanOptions & {
    allowTier3?: boolean;
    breakoutPivotBars?: number;
    breakoutBufferPct?: number;
    breakoutMaxChasePct?: number;
    breakoutMinVolSurge?: number;
  }
): Promise<CoilingAssessment> {
  const opts = resolveOptions(raw);
  const allowTier3 = raw?.allowTier3 === true;
  const breakoutPivotBars = Math.max(5, Math.trunc(raw?.breakoutPivotBars ?? 20));
  const breakoutBufferPct = Math.max(0, raw?.breakoutBufferPct ?? 0.5);
  const breakoutMaxChasePct = Math.max(breakoutBufferPct, raw?.breakoutMaxChasePct ?? 12);
  const breakoutMinVolSurge = Math.max(1, raw?.breakoutMinVolSurge ?? 1.5);
  const base = symbol.toUpperCase().replace(/[-_/](USD[TC]?|PERP)$/i, "").replace(/(USD[TC]?|PERP)$/i, "");

  const notQualified = (
    reason: string,
    extra?: Partial<CoilingAssessment>
  ): CoilingAssessment => ({
    symbol: base,
    qualified: false,
    tier: null,
    score: 0,
    reason,
    disqualifiedReason: null,
    features: null,
    avgDollarVol14: 0,
    latestBar: null,
    breakout: null,
    breakoutReady: false,
    ...extra
  });

  const candles = await prisma.marketCandle.findMany({
    where: { interval: CandleInterval.D1, symbol: base },
    orderBy: { timestamp: "asc" },
    select: { open: true, high: true, low: true, close: true, volume: true, timestamp: true }
  });

  if (candles.length < opts.minCandles) {
    return notQualified("insufficient_history");
  }

  const latestBar = candles[candles.length - 1].timestamp.toISOString();
  const cached = coilAssessmentCache.get(base);
  if (cached && cached.latestBar === latestBar) {
    return cached.assessment;
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const rsiSeries = computeRsiSeries(closes, 14);

  const computed = computeCoilingFeatures(candles, closes, highs, lows, volumes, rsiSeries, candles.length - 1);
  if (!computed) {
    const a = notQualified("feature_computation_failed", { latestBar });
    coilAssessmentCache.set(base, { latestBar, assessment: a });
    return a;
  }

  const { features, avgDollarVol14 } = computed;
  const disq = isDisqualified(features, avgDollarVol14, opts);
  if (disq != null) {
    const a: CoilingAssessment = {
      symbol: base,
      qualified: false,
      tier: null,
      score: 0,
      reason: `disqualified: ${disq}`,
      disqualifiedReason: disq,
      features,
      avgDollarVol14: Math.round(avgDollarVol14),
      latestBar,
      breakout: null,
      breakoutReady: false
    };
    coilAssessmentCache.set(base, { latestBar, assessment: a });
    return a;
  }

  // Breakout-from-base detection: the latest close clears the coil ceiling
  // (highest high over the pivot window, excluding the latest bar) by a small
  // buffer, on a volume surge, and is not yet extended (avoids chasing).
  const last = candles.length - 1;
  const pivotStart = Math.max(0, last - breakoutPivotBars);
  const pivotHigh = maxInRange(highs, pivotStart, last - 1);
  const coilAvgVol = meanInRange(volumes, pivotStart, last - 1);
  const latestClose = closes[last];
  const latestVol = volumes[last];
  let breakout: CoilBreakout | null = null;
  if (Number.isFinite(pivotHigh) && pivotHigh > 0 && Number.isFinite(coilAvgVol) && coilAvgVol > 0) {
    const breakoutPct = ((latestClose - pivotHigh) / pivotHigh) * 100;
    const volumeSurgeRatio = latestVol / coilAvgVol;
    const ready =
      breakoutPct >= breakoutBufferPct &&
      breakoutPct <= breakoutMaxChasePct &&
      volumeSurgeRatio >= breakoutMinVolSurge;
    breakout = {
      pivotHigh: Number(pivotHigh.toFixed(6)),
      breakoutPct: Number(breakoutPct.toFixed(3)),
      volumeSurgeRatio: Number(volumeSurgeRatio.toFixed(2)),
      ready
    };
  }

  const comps = scoreComponents(features);
  let score = 0;
  for (const key of Object.keys(SCORE_WEIGHTS) as ScoreKey[]) {
    score += SCORE_WEIGHTS[key] * comps[key];
  }
  const score100 = score * 100;
  const { tier, reason } = classifyTier(score100, comps, features);

  const meetsScore = score100 >= opts.minScore && comps.squeeze >= 0.35;
  const meetsTier = allowTier3 ? true : tier !== "TIER_3";
  const qualified = meetsScore && meetsTier;

  const assessment: CoilingAssessment = {
    symbol: base,
    qualified,
    tier,
    score: Number(score100.toFixed(2)),
    reason: qualified ? `${TIER_LABEL[tier]} — ${reason}` : (meetsScore ? `tier ${tier} below entry minimum` : "coil score below minimum"),
    disqualifiedReason: null,
    features,
    avgDollarVol14: Math.round(avgDollarVol14),
    latestBar,
    breakout,
    breakoutReady: qualified && breakout?.ready === true
  };
  coilAssessmentCache.set(base, { latestBar, assessment });
  return assessment;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function cli(): Promise<void> {
  const topN = Math.max(1, Math.trunc(num(process.env.PRE_PUMP_SCAN_TOP, 25)));
  console.log("[pre-pump-scan] scanning for early coiling / accumulation bases...");
  const result = await runPrePumpScan({ topN });

  console.log(
    `[pre-pump-scan] historical context: ${result.pumpRows}/${result.datasetRows} quiet bases ` +
    `pumped >= ${BASE_RATE_PUMP_PCT}% (base rate ${result.baseRatePct}%)`
  );
  console.log(`[pre-pump-scan] Coinbase spot universe: ${result.universeSize} symbols`);
  console.log(
    `[pre-pump-scan] scanned ${result.scanned}, ${result.skipped} skipped (insufficient data), ` +
    `${result.disqualified} disqualified (already moved/extended)`
  );
  console.log("");
  console.log(`[pre-pump-scan] TOP ${result.candidates.length} COILING CANDIDATES (latest daily bar):`);
  console.log("");
  console.log(
    "rank  symbol      tier  score  fired  sqzRatio vol20% run10% run20% g20%  g50%  rngPos dHigh%  vTrend rsi   signals"
  );
  console.log("─".repeat(132));

  const tierTag: Record<PrePumpTier, string> = { TIER_1: "🟢T1", TIER_2: "🟡T2", TIER_3: "🔴T3" };

  for (const c of result.candidates) {
    const f = c.features;
    const signals = c.fired.map((k) => SCORE_SHORT[k]).join(",");
    console.log(
      `${String(c.rank).padStart(3)}.  ${c.symbol.padEnd(10)} ${tierTag[c.tier]}  ` +
      `${c.score.toFixed(1).padStart(6)} ${String(c.firedCount).padStart(5)}  ` +
      `${f.compressionRatio.toFixed(2).padStart(7)} ${f.volatility20Pct.toFixed(1).padStart(6)} ` +
      `${f.trailingReturn10Pct.toFixed(1).padStart(6)} ${f.trailingReturn20Pct.toFixed(1).padStart(6)} ` +
      `${f.sma20GapPct.toFixed(1).padStart(5)} ${f.sma50GapPct.toFixed(1).padStart(5)} ` +
      `${(f.rangePosition60 * 100).toFixed(0).padStart(6)} ${f.distFromHigh60Pct.toFixed(1).padStart(6)} ` +
      `${f.volumeTrendRatio.toFixed(2).padStart(6)} ${f.rsi14.toFixed(0).padStart(4)}   ${signals}`
    );
  }

  console.log("");
  console.log("tiers: 🟢T1 prime coil · 🟡T2 forming base · 🔴T3 early/weak — already-moved names excluded");
  console.log(
    "legend: sqzRatio<1=volatility squeeze, run10/20=trailing run-up, g20/g50=SMA gap, " +
    "rngPos=position in 60d range, dHigh=% below 60d high, vTrend=volume uptick"
  );
}

const isDirectRun = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  cli()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
