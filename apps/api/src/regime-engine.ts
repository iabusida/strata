export type MarketRegime = "TRENDING" | "CHOPPY" | "EXPANSION" | "LOW_VOL";

export type DetectRegimeInput = {
  price: number;
  atr1h: number;
  atr4h: number;
  recentHigh1h: number;
  recentLow1h: number;
  volatilityPct: number;
  trendPersistence: number;
};

export type RegimeDetection = {
  regime: MarketRegime;
  atrExpansion: number;
  rangeCompression: number;
  trendPersistence: number;
};

export function detectRegime(input: DetectRegimeInput): RegimeDetection {
  const price = Number.isFinite(input.price) && input.price > 0 ? input.price : 0;
  const atr1h = Number.isFinite(input.atr1h) && input.atr1h > 0 ? input.atr1h : 0;
  const atr4h = Number.isFinite(input.atr4h) && input.atr4h > 0 ? input.atr4h : 0;
  const recentHigh1h = Number.isFinite(input.recentHigh1h) && input.recentHigh1h > 0 ? input.recentHigh1h : 0;
  const recentLow1h = Number.isFinite(input.recentLow1h) && input.recentLow1h > 0 ? input.recentLow1h : 0;
  const volatilityPct = Number.isFinite(input.volatilityPct) ? input.volatilityPct : 0;
  const trendPersistence = Math.max(0, Math.trunc(input.trendPersistence));

  const atrExpansion = atr4h > 0 ? Number((atr1h / atr4h).toFixed(4)) : 0;
  const rangeCompression =
    price > 0 && recentHigh1h > 0 && recentLow1h > 0 && recentHigh1h >= recentLow1h
      ? Number((((recentHigh1h - recentLow1h) / price)).toFixed(6))
      : 0;

  if (volatilityPct < 1.2) {
    return { regime: "LOW_VOL", atrExpansion, rangeCompression, trendPersistence };
  }

  if (rangeCompression < 0.015) {
    return { regime: "CHOPPY", atrExpansion, rangeCompression, trendPersistence };
  }

  if (atrExpansion > 1.3) {
    return { regime: "EXPANSION", atrExpansion, rangeCompression, trendPersistence };
  }

  if (trendPersistence >= 3) {
    return { regime: "TRENDING", atrExpansion, rangeCompression, trendPersistence };
  }

  return { regime: "CHOPPY", atrExpansion, rangeCompression, trendPersistence };
}
