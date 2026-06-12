import "./env.js";
import { CandleInterval, PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";

type Candle = {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type FeatureRow = {
  symbol: string;
  timestamp: Date;
  labelPump: boolean;
  futureReturnPct: number;
  volumeRatio7: number;
  volumeRatio14: number;
  volatility20Pct: number;
  rangePct: number;
  sma20GapPct: number;
  sma50GapPct: number;
  sma20Slope5Pct: number;
  rsi14: number;
};

type QuantileSummary = {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
};

type FeatureKey = keyof Omit<FeatureRow, "symbol" | "timestamp" | "labelPump" | "futureReturnPct">;
type FeatureSpec = {
  key: FeatureKey;
  direction: "high" | "low";
};

type ThresholdStats = {
  threshold: number;
  thresholdPercentile: number;
  precision: number;
  recall: number;
  f1: number;
  lift: number;
  predicted: number;
};

export type PrePumpAnalysisOptions = {
  interval: CandleInterval;
  minFutureReturnPct: number;
  lookaheadBars: number;
  minCandlesPerSymbol: number;
  maxSymbols: number;
  topPercentileCut: number;
};

export type PrePumpFeatureReport = {
  feature: FeatureKey;
  direction: "high" | "low";
  positiveQuantiles: QuantileSummary;
  negativeQuantiles: QuantileSummary;
  bestThreshold: ThresholdStats;
  topPercentileCut: number;
  topPercentilePrecision: number;
  topPercentileLift: number;
  topPercentileSample: number;
};

export type SuggestedRuntimeSetting = {
  key: string;
  value: string;
  rationale: string;
};

export type PrePumpAnalysisReport = {
  options: PrePumpAnalysisOptions;
  dataset: {
    rows: number;
    positivePumpRows: number;
    baseRate: number;
  };
  features: PrePumpFeatureReport[];
  composite: {
    topBucketRatio: number;
    precision: number;
    recall: number;
    lift: number;
    sample: number;
  };
  topExamples: Array<{
    symbol: string;
    timestamp: string;
    futureReturnPct: number;
  }>;
  suggestedRuntimeSettings: SuggestedRuntimeSetting[];
};

const prisma = new PrismaClient();

const FEATURE_SPECS: FeatureSpec[] = [
  { key: "volumeRatio7", direction: "high" },
  { key: "volumeRatio14", direction: "high" },
  { key: "volatility20Pct", direction: "high" },
  { key: "rangePct", direction: "high" },
  { key: "sma20GapPct", direction: "high" },
  { key: "sma50GapPct", direction: "high" },
  { key: "sma20Slope5Pct", direction: "high" },
  { key: "rsi14", direction: "high" }
];

const DEFAULT_OPTIONS: PrePumpAnalysisOptions = {
  interval: parseInterval((process.env.PRE_PUMP_ANALYSIS_INTERVAL ?? "D1").toUpperCase()),
  minFutureReturnPct: asNumber(process.env.PRE_PUMP_ANALYSIS_MIN_FUTURE_RETURN_PCT, 120),
  lookaheadBars: Math.max(3, Math.trunc(asNumber(process.env.PRE_PUMP_ANALYSIS_LOOKAHEAD_BARS, 21))),
  minCandlesPerSymbol: Math.max(80, Math.trunc(asNumber(process.env.PRE_PUMP_ANALYSIS_MIN_CANDLES_PER_SYMBOL, 140))),
  maxSymbols: Math.max(10, Math.trunc(asNumber(process.env.PRE_PUMP_ANALYSIS_MAX_SYMBOLS, 2000))),
  topPercentileCut: clamp(asNumber(process.env.PRE_PUMP_ANALYSIS_TOP_PERCENTILE, 90), 50, 99.5)
};

export async function analyzePrePumpPatterns(raw?: Partial<PrePumpAnalysisOptions>): Promise<PrePumpAnalysisReport> {
  const options = resolveOptions(raw);
  const grouped = await loadCandles(options);
  const rows = buildFeatureRows(grouped, options);

  if (rows.length === 0) {
    throw new Error("No analyzable rows. Check candle coverage and analysis parameters.");
  }

  const positives = rows.filter((row) => row.labelPump);
  const negatives = rows.filter((row) => !row.labelPump);

  if (positives.length === 0) {
    throw new Error(
      "No pump events found under current thresholds. Lower PRE_PUMP_ANALYSIS_MIN_FUTURE_RETURN_PCT or widen lookahead."
    );
  }

  const baseRate = positives.length / rows.length;
  const featureReports: PrePumpFeatureReport[] = [];

  for (const spec of FEATURE_SPECS) {
    const positiveValues = positives.map((row) => row[spec.key]);
    const negativeValues = negatives.map((row) => row[spec.key]);
    const allValues = sortedFinite(rows.map((row) => row[spec.key]));

    const positiveQuantiles = quantiles(positiveValues);
    const negativeQuantiles = quantiles(negativeValues);
    const thresholdStats = findBestThreshold(rows, spec, baseRate, allValues);

    if (!positiveQuantiles || !negativeQuantiles || !thresholdStats) {
      continue;
    }

    const topCut = percentile(allValues, options.topPercentileCut);
    const isSelectedTop = (value: number): boolean => {
      if (!Number.isFinite(topCut)) {
        return false;
      }
      return spec.direction === "high" ? value >= topCut : value <= topCut;
    };

    const topRows = rows.filter((row) => isSelectedTop(row[spec.key]));
    const topPrecision = topRows.length > 0 ? topRows.filter((row) => row.labelPump).length / topRows.length : 0;
    const topLift = baseRate > 0 ? topPrecision / baseRate : 0;

    featureReports.push({
      feature: spec.key,
      direction: spec.direction,
      positiveQuantiles,
      negativeQuantiles,
      bestThreshold: thresholdStats,
      topPercentileCut: options.topPercentileCut,
      topPercentilePrecision: topPrecision,
      topPercentileLift: topLift,
      topPercentileSample: topRows.length
    });
  }

  const ranked = rankComposite(rows);
  const topBucketRatio = 0.1;
  const topK = Math.max(1, Math.round(ranked.length * topBucketRatio));
  const topRows = ranked.slice(0, topK);
  const topPrecision = topRows.filter((row) => row.labelPump).length / topRows.length;
  const topRecall = topRows.filter((row) => row.labelPump).length / positives.length;
  const topLift = baseRate > 0 ? topPrecision / baseRate : 0;

  const topExamples = topRows
    .filter((row) => row.labelPump)
    .slice(0, 15)
    .map((row) => ({
      symbol: row.symbol,
      timestamp: row.timestamp.toISOString(),
      futureReturnPct: row.futureReturnPct
    }));

  const report: PrePumpAnalysisReport = {
    options,
    dataset: {
      rows: rows.length,
      positivePumpRows: positives.length,
      baseRate
    },
    features: featureReports,
    composite: {
      topBucketRatio,
      precision: topPrecision,
      recall: topRecall,
      lift: topLift,
      sample: topRows.length
    },
    topExamples,
    suggestedRuntimeSettings: []
  };

  report.suggestedRuntimeSettings = deriveSuggestedRuntimeSettings(report);
  return report;
}

function deriveSuggestedRuntimeSettings(report: PrePumpAnalysisReport): SuggestedRuntimeSetting[] {
  const byFeature = new Map(report.features.map((item) => [item.feature, item]));
  const suggestions: SuggestedRuntimeSetting[] = [];

  const volume14 = byFeature.get("volumeRatio14");
  if (volume14) {
    const balanced = clamp((volume14.positiveQuantiles.p50 + volume14.bestThreshold.threshold) / 2, 1.1, 8);
    suggestions.push({
      key: "PRE_PUMP_WATCH_MIN_VOLUME_RATIO",
      value: toRuntimeNumber(balanced, 3),
      rationale: `balanced from volumeRatio14 median ${fmt(volume14.positiveQuantiles.p50)} and best threshold ${fmt(
        volume14.bestThreshold.threshold
      )}`
    });
  }

  const rsi = byFeature.get("rsi14");
  if (rsi) {
    suggestions.push({
      key: "PRE_PUMP_WATCH_MIN_INTERMEDIARY_RSI",
      value: toRuntimeNumber(clamp(rsi.positiveQuantiles.p25, 35, 75), 2),
      rationale: `pump-side RSI q25 ${fmt(rsi.positiveQuantiles.p25)}`
    });
    suggestions.push({
      key: "PRE_PUMP_WATCH_MAX_INTERMEDIARY_RSI",
      value: toRuntimeNumber(clamp(rsi.positiveQuantiles.p90, 45, 92), 2),
      rationale: `pump-side RSI p90 ${fmt(rsi.positiveQuantiles.p90)}`
    });
  }

  const emaSlope = byFeature.get("sma20Slope5Pct");
  if (emaSlope) {
    suggestions.push({
      key: "PRE_PUMP_WATCH_MIN_EMA_SLOPE",
      value: toRuntimeNumber(clamp(emaSlope.positiveQuantiles.p25, 0, 10), 4),
      rationale: `proxy from SMA20 slope q25 ${fmt(emaSlope.positiveQuantiles.p25)}`
    });
  }

  const volatility = byFeature.get("volatility20Pct");
  if (volatility) {
    const percentileProxy = clamp(Math.round(volatility.bestThreshold.thresholdPercentile), 55, 97);
    suggestions.push({
      key: "PRE_PUMP_WATCH_MIN_VOLATILITY_PERCENTILE",
      value: String(percentileProxy),
      rationale: `mapped from volatility threshold percentile ${fmt(volatility.bestThreshold.thresholdPercentile)}`
    });
  }

  return suggestions;
}

function resolveOptions(raw?: Partial<PrePumpAnalysisOptions>): PrePumpAnalysisOptions {
  return {
    interval: raw?.interval ?? DEFAULT_OPTIONS.interval,
    minFutureReturnPct: raw?.minFutureReturnPct ?? DEFAULT_OPTIONS.minFutureReturnPct,
    lookaheadBars: Math.max(3, Math.trunc(raw?.lookaheadBars ?? DEFAULT_OPTIONS.lookaheadBars)),
    minCandlesPerSymbol: Math.max(80, Math.trunc(raw?.minCandlesPerSymbol ?? DEFAULT_OPTIONS.minCandlesPerSymbol)),
    maxSymbols: Math.max(10, Math.trunc(raw?.maxSymbols ?? DEFAULT_OPTIONS.maxSymbols)),
    topPercentileCut: clamp(raw?.topPercentileCut ?? DEFAULT_OPTIONS.topPercentileCut, 50, 99.5)
  };
}

function parseInterval(input: string): CandleInterval {
  const allowed: CandleInterval[] = ["M15", "H1", "H4", "H12", "D1"];
  if ((allowed as string[]).includes(input)) {
    return input as CandleInterval;
  }
  throw new Error(`Unsupported PRE_PUMP_ANALYSIS_INTERVAL=${input}. Use one of ${allowed.join(", ")}`);
}

async function loadCandles(options: PrePumpAnalysisOptions): Promise<Map<string, Candle[]>> {
  const symbols = await prisma.marketCandle.findMany({
    where: { interval: options.interval },
    select: { symbol: true },
    distinct: ["symbol"],
    orderBy: { symbol: "asc" },
    take: options.maxSymbols
  });

  const grouped = new Map<string, Candle[]>();

  for (const { symbol } of symbols) {
    const candles = await prisma.marketCandle.findMany({
      where: { interval: options.interval, symbol },
      orderBy: { timestamp: "asc" },
      select: {
        timestamp: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true
      }
    });

    if (candles.length < options.minCandlesPerSymbol) {
      continue;
    }

    grouped.set(symbol, candles);
  }

  return grouped;
}

function buildFeatureRows(grouped: Map<string, Candle[]>, options: PrePumpAnalysisOptions): FeatureRow[] {
  const rows: FeatureRow[] = [];

  for (const [symbol, candles] of grouped.entries()) {
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const volumes = candles.map((c) => c.volume);
    const rsiSeries = computeRsi(closes, 14);

    for (let i = 55; i < candles.length - options.lookaheadBars; i += 1) {
      const close = closes[i];
      if (!Number.isFinite(close) || close <= 0) {
        continue;
      }

      const futureMaxHigh = maxInRange(highs, i + 1, i + options.lookaheadBars);
      if (!Number.isFinite(futureMaxHigh) || futureMaxHigh <= 0) {
        continue;
      }

      const futureReturnPct = ((futureMaxHigh - close) / close) * 100;
      const sma20 = smaAt(closes, i, 20);
      const sma50 = smaAt(closes, i, 50);
      const sma20Prev5 = smaAt(closes, i - 5, 20);
      const avgVol7 = meanInRange(volumes, i - 7, i - 1);
      const avgVol14 = meanInRange(volumes, i - 14, i - 1);
      const vol20 = stdDevPct(closes, i, 20);
      const rangePct = ((candles[i].high - candles[i].low) / close) * 100;
      const rsi14 = rsiSeries[i];

      if (
        !Number.isFinite(sma20) ||
        !Number.isFinite(sma50) ||
        !Number.isFinite(sma20Prev5) ||
        !Number.isFinite(avgVol7) ||
        !Number.isFinite(avgVol14) ||
        !Number.isFinite(vol20) ||
        !Number.isFinite(rangePct) ||
        !Number.isFinite(rsi14)
      ) {
        continue;
      }

      rows.push({
        symbol,
        timestamp: candles[i].timestamp,
        labelPump: futureReturnPct >= options.minFutureReturnPct,
        futureReturnPct,
        volumeRatio7: safeDivide(candles[i].volume, Math.max(1, avgVol7)),
        volumeRatio14: safeDivide(candles[i].volume, Math.max(1, avgVol14)),
        volatility20Pct: vol20,
        rangePct,
        sma20GapPct: ((close - sma20) / sma20) * 100,
        sma50GapPct: ((close - sma50) / sma50) * 100,
        sma20Slope5Pct: ((sma20 - sma20Prev5) / sma20Prev5) * 100,
        rsi14
      });
    }
  }

  return rows;
}

function rankComposite(rows: FeatureRow[]): FeatureRow[] {
  const rankedSets: Record<string, number[]> = {
    volumeRatio14: sortedFinite(rows.map((row) => row.volumeRatio14)),
    volatility20Pct: sortedFinite(rows.map((row) => row.volatility20Pct)),
    sma20Slope5Pct: sortedFinite(rows.map((row) => row.sma20Slope5Pct)),
    sma20GapPct: sortedFinite(rows.map((row) => row.sma20GapPct)),
    rangePct: sortedFinite(rows.map((row) => row.rangePct)),
    rsi14: sortedFinite(rows.map((row) => row.rsi14))
  };

  return rows
    .map((row) => {
      const score =
        0.28 * percentileRankSorted(rankedSets.volumeRatio14, row.volumeRatio14) +
        0.22 * percentileRankSorted(rankedSets.volatility20Pct, row.volatility20Pct) +
        0.18 * percentileRankSorted(rankedSets.sma20Slope5Pct, row.sma20Slope5Pct) +
        0.12 * percentileRankSorted(rankedSets.sma20GapPct, row.sma20GapPct) +
        0.12 * percentileRankSorted(rankedSets.rangePct, row.rangePct) +
        0.08 * rsiMidBandScore(row.rsi14);
      return { row, score };
    })
    .sort((left, right) => right.score - left.score)
    .map((item) => item.row);
}

function findBestThreshold(
  rows: FeatureRow[],
  spec: FeatureSpec,
  baseRate: number,
  sortedAllValues: number[]
): ThresholdStats | null {
  if (sortedAllValues.length < 20) {
    return null;
  }

  const candidates = new Set<number>();
  for (let p = 5; p <= 95; p += 5) {
    const value = percentile(sortedAllValues, p);
    if (Number.isFinite(value)) {
      candidates.add(value);
    }
  }

  const positives = rows.filter((row) => row.labelPump).length;
  let best: ThresholdStats | null = null;

  for (const threshold of candidates) {
    const selected = rows.filter((row) => {
      const value = row[spec.key];
      return spec.direction === "high" ? value >= threshold : value <= threshold;
    });

    if (selected.length === 0) {
      continue;
    }

    const tp = selected.filter((row) => row.labelPump).length;
    const fp = selected.length - tp;
    const fn = positives - tp;
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const lift = baseRate > 0 ? precision / baseRate : 0;
    const thresholdPercentile = percentileRankSorted(sortedAllValues, threshold) * 100;

    if (!best || f1 > best.f1) {
      best = {
        threshold,
        thresholdPercentile,
        precision,
        recall,
        f1,
        lift,
        predicted: selected.length
      };
    }
  }

  return best;
}

function meanInRange(values: number[], start: number, end: number): number {
  if (start < 0 || end >= values.length || start > end) {
    return Number.NaN;
  }
  let sum = 0;
  for (let i = start; i <= end; i += 1) {
    sum += values[i];
  }
  return sum / (end - start + 1);
}

function maxInRange(values: number[], start: number, end: number): number {
  if (start < 0 || end >= values.length || start > end) {
    return Number.NaN;
  }
  let current = -Infinity;
  for (let i = start; i <= end; i += 1) {
    if (values[i] > current) {
      current = values[i];
    }
  }
  return current;
}

function smaAt(values: number[], index: number, period: number): number {
  const start = index - period + 1;
  if (start < 0 || index >= values.length) {
    return Number.NaN;
  }
  return meanInRange(values, start, index);
}

function stdDevPct(values: number[], index: number, period: number): number {
  const start = index - period + 1;
  if (start < 1 || index >= values.length) {
    return Number.NaN;
  }
  const returns: number[] = [];
  for (let i = start; i <= index; i += 1) {
    const prev = values[i - 1];
    const curr = values[i];
    if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(curr) || curr <= 0) {
      return Number.NaN;
    }
    returns.push(Math.log(curr / prev));
  }
  const mean = returns.reduce((acc, item) => acc + item, 0) / returns.length;
  const variance = returns.reduce((acc, item) => acc + (item - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

function computeRsi(closes: number[], period: number): number[] {
  const result = new Array<number>(closes.length).fill(Number.NaN);
  if (closes.length <= period) {
    return result;
  }

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) {
      gains += delta;
    } else {
      losses += Math.abs(delta);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    result[i] = rsiFromAverages(avgGain, avgLoss);
  }

  return result;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) {
    return 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function quantiles(values: number[]): QuantileSummary | null {
  const cleaned = sortedFinite(values);
  if (cleaned.length === 0) {
    return null;
  }
  return {
    p10: percentile(cleaned, 10),
    p25: percentile(cleaned, 25),
    p50: percentile(cleaned, 50),
    p75: percentile(cleaned, 75),
    p90: percentile(cleaned, 90)
  };
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) {
    return Number.NaN;
  }
  const clamped = clamp(p, 0, 100);
  const rank = (clamped / 100) * (sortedValues.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) {
    return sortedValues[low];
  }
  const weight = rank - low;
  return sortedValues[low] * (1 - weight) + sortedValues[high] * weight;
}

function sortedFinite(values: number[]): number[] {
  return values.filter((item) => Number.isFinite(item)).sort((a, b) => a - b);
}

function percentileRankSorted(sortedValues: number[], value: number): number {
  if (sortedValues.length === 0 || !Number.isFinite(value)) {
    return 0;
  }
  let lo = 0;
  let hi = sortedValues.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sortedValues[mid] <= value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo / sortedValues.length;
}

function rsiMidBandScore(rsi: number): number {
  if (!Number.isFinite(rsi)) {
    return 0;
  }
  const center = 62;
  const distance = Math.abs(rsi - center);
  return clamp(1 - distance / 35, 0, 1);
}

function safeDivide(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return Number.NaN;
  }
  return numerator / denominator;
}

function asNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) {
    return "nan";
  }
  return value.toFixed(4);
}

function toPct(value: number): string {
  if (!Number.isFinite(value)) {
    return "nan";
  }
  return `${(value * 100).toFixed(2)}%`;
}

function toRuntimeNumber(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function formatPrePumpAnalysisReport(report: PrePumpAnalysisReport): string {
  const lines: string[] = [];
  lines.push("PRE-PUMP PATTERN REPORT");
  lines.push(
    `interval=${report.options.interval} lookaheadBars=${report.options.lookaheadBars} minFutureReturnPct=${report.options.minFutureReturnPct}`
  );
  lines.push(
    `rows=${report.dataset.rows} positivePumpRows=${report.dataset.positivePumpRows} baseRate=${toPct(report.dataset.baseRate)}`
  );
  lines.push("");

  for (const feature of report.features) {
    lines.push(`feature=${feature.feature}`);
    lines.push(
      `  positive q25/q50/q75=${fmt(feature.positiveQuantiles.p25)}/${fmt(feature.positiveQuantiles.p50)}/${fmt(feature.positiveQuantiles.p75)}`
    );
    lines.push(
      `  negative q25/q50/q75=${fmt(feature.negativeQuantiles.p25)}/${fmt(feature.negativeQuantiles.p50)}/${fmt(feature.negativeQuantiles.p75)}`
    );
    lines.push(
      `  best threshold (${feature.direction})=${fmt(feature.bestThreshold.threshold)} percentile=${fmt(feature.bestThreshold.thresholdPercentile)} precision=${toPct(feature.bestThreshold.precision)} recall=${toPct(feature.bestThreshold.recall)} f1=${fmt(feature.bestThreshold.f1)} lift=${fmt(feature.bestThreshold.lift)} predicted=${feature.bestThreshold.predicted}`
    );
    lines.push(
      `  top ${fmt(feature.topPercentileCut)}th percentile precision=${toPct(feature.topPercentilePrecision)} lift=${fmt(
        feature.topPercentileLift
      )} sample=${feature.topPercentileSample}`
    );
    lines.push("");
  }

  lines.push("COMPOSITE SCORE (volume+volatility+SMA+RSI)");
  lines.push(
    `  top${Math.round(report.composite.topBucketRatio * 100)} precision=${toPct(report.composite.precision)} recall=${toPct(
      report.composite.recall
    )} lift=${fmt(report.composite.lift)} sample=${report.composite.sample}`
  );
  lines.push("");

  if (report.suggestedRuntimeSettings.length > 0) {
    lines.push("SUGGESTED PRE_PUMP_WATCH SETTINGS");
    for (const item of report.suggestedRuntimeSettings) {
      lines.push(`  ${item.key}=${item.value} (${item.rationale})`);
    }
    lines.push("");
  }

  if (report.topExamples.length > 0) {
    lines.push("TOP PRE-PUMP EXAMPLES");
    for (const row of report.topExamples) {
      lines.push(`  ${row.symbol} @ ${row.timestamp} future=${fmt(row.futureReturnPct)}%`);
    }
  }

  return lines.join("\n");
}

async function runCli(): Promise<void> {
  const report = await analyzePrePumpPatterns();
  console.log(formatPrePumpAnalysisReport(report));
}

const isEntrypoint = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  runCli()
    .catch((error) => {
      console.error("Pre-pump pattern analysis failed", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
