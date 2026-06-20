import { Direction, TimeframeView } from "./types";

export const TIMEFRAME_VIEWS: TimeframeView[] = ["1M", "5M", "15M", "1H", "4H", "1D"];

export function getDefaultTimeframeForProfile(profile: "scalp" | "day" | "swing" | "long_term"): TimeframeView {
  if (profile === "scalp") return "5M";
  if (profile === "day") return "15M";
  if (profile === "long_term") return "1D";
  return "4H";
}

export function getAnalysisIntervalForTimeframe(timeframe: TimeframeView): "15m" | "1h" | "4h" | "1d" {
  if (timeframe === "1H") return "1h";
  if (timeframe === "4H") return "4h";
  if (timeframe === "1D") return "1d";
  return "15m";
}

export function getTimeframeDirectionLabel(direction: Direction): "Bullish" | "Bearish" | "Mixed" {
  if (direction === "UP") return "Bullish";
  if (direction === "DOWN") return "Bearish";
  return "Mixed";
}

export function getTimeframeStructureText(timeframe: TimeframeView, direction: Direction): string {
  if (direction === "UP") {
    return `✅ ${timeframe} Bullish (High Confidence)`;
  }
  if (direction === "DOWN") {
    return `❌ ${timeframe} Bearish (Strong Momentum)`;
  }
  return `⚠️ ${timeframe} Mixed (Low Confidence)`;
}

export function getTimeframeAnalysisHelperText(
  market: "CRYPTO" | "STOCKS",
): string {
  const marketLabel = market === "CRYPTO" ? "Spot crypto scan" : "Live stock quotes";
  return `${marketLabel} sorted independently. Timeframes are selected inside each token card.`;
}

export function getTimeframeTriggerLabel(options: {
  timeframe: TimeframeView;
  direction: Direction;
  price: number;
  upBuffer: number;
  downBuffer: number;
}): string {
  const { timeframe, direction, price, upBuffer, downBuffer } = options;

  if (direction === "UP") {
    return `Break above $${(price * (1 + upBuffer)).toFixed(2)} with ${timeframe} follow-through`;
  }

  if (direction === "DOWN") {
    return `Break below $${(price * (1 - downBuffer)).toFixed(2)} with ${timeframe} follow-through`;
  }

  return `Wait for ${timeframe} direction to clarify`;
}