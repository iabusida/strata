/**
 * Trendline pattern detection.
 *
 * Detects two classic line patterns used as entry triggers:
 *  - Descending trendline breakout → bullish (LONG entry)
 *    Connects a series of lower swing highs; a close above this line is a breakout.
 *  - Ascending trendline breakdown → bearish (SHORT entry)
 *    Connects a series of higher swing lows; a close below this line is a breakdown.
 */

export type TrendlineResult = {
  /** Whether the line-pattern trigger fired. */
  detected: boolean;
  /** Value of the trendline projected to the current (last) bar index. */
  trendlineValue: number | null;
  /** Per-candle slope of the trendline (negative = descending, positive = ascending). */
  slope: number | null;
  /** Number of confirmed swing pivots found in the lookback window. */
  pivotCount: number;
};

type Pivot = {
  index: number;
  value: number;
};

const DEFAULT_LEFT_BARS = 2;
const DEFAULT_RIGHT_BARS = 2;

function findSwingHighPivots(
  highs: number[],
  leftBars: number = DEFAULT_LEFT_BARS,
  rightBars: number = DEFAULT_RIGHT_BARS
): Pivot[] {
  const pivots: Pivot[] = [];

  // Only consider candles that have `rightBars` confirmed candles after them.
  const limit = highs.length - rightBars;
  for (let i = leftBars; i < limit; i += 1) {
    const val = highs[i];
    if (!Number.isFinite(val) || val <= 0) {
      continue;
    }

    let isPivot = true;
    for (let j = 1; j <= leftBars; j += 1) {
      if ((highs[i - j] ?? -Infinity) >= val) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) {
      for (let j = 1; j <= rightBars; j += 1) {
        if ((highs[i + j] ?? -Infinity) >= val) {
          isPivot = false;
          break;
        }
      }
    }

    if (isPivot) {
      pivots.push({ index: i, value: val });
    }
  }

  return pivots;
}

function findSwingLowPivots(
  lows: number[],
  leftBars: number = DEFAULT_LEFT_BARS,
  rightBars: number = DEFAULT_RIGHT_BARS
): Pivot[] {
  const pivots: Pivot[] = [];

  const limit = lows.length - rightBars;
  for (let i = leftBars; i < limit; i += 1) {
    const val = lows[i];
    if (!Number.isFinite(val) || val <= 0) {
      continue;
    }

    let isPivot = true;
    for (let j = 1; j <= leftBars; j += 1) {
      if ((lows[i - j] ?? Infinity) <= val) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) {
      for (let j = 1; j <= rightBars; j += 1) {
        if ((lows[i + j] ?? Infinity) <= val) {
          isPivot = false;
          break;
        }
      }
    }

    if (isPivot) {
      pivots.push({ index: i, value: val });
    }
  }

  return pivots;
}

/**
 * Detect a descending trendline (lower swing highs) and whether the current
 * price has closed above it — a bullish breakout signal.
 *
 * @param highs  Array of candle highs ordered oldest → newest.
 * @param currentClose  Current (latest) close price.
 */
export function detectDescendingTrendlineBreakout(
  highs: number[],
  currentClose: number
): TrendlineResult {
  const pivots = findSwingHighPivots(highs);

  if (pivots.length < 2) {
    return { detected: false, trendlineValue: null, slope: null, pivotCount: pivots.length };
  }

  // Use the two most recent confirmed swing highs.
  const p1 = pivots[pivots.length - 2];
  const p2 = pivots[pivots.length - 1];

  // Must be a genuine descending trendline (p2 lower than p1).
  if (p2.value >= p1.value || p2.index <= p1.index) {
    return { detected: false, trendlineValue: null, slope: null, pivotCount: pivots.length };
  }

  const slope = (p2.value - p1.value) / (p2.index - p1.index);
  const lastIndex = highs.length - 1;
  const trendlineValue = p2.value + slope * (lastIndex - p2.index);

  // Breakout: closing price is above the projected trendline.
  const detected = Number.isFinite(currentClose) && currentClose > 0 && currentClose > trendlineValue;

  return {
    detected,
    trendlineValue: Number(trendlineValue.toFixed(8)),
    slope: Number(slope.toFixed(8)),
    pivotCount: pivots.length
  };
}

/**
 * Detect an ascending trendline (higher swing lows) and whether the current
 * price has closed below it — a bearish breakdown signal.
 *
 * @param lows  Array of candle lows ordered oldest → newest.
 * @param currentClose  Current (latest) close price.
 */
export function detectAscendingTrendlineBreakdown(
  lows: number[],
  currentClose: number
): TrendlineResult {
  const pivots = findSwingLowPivots(lows);

  if (pivots.length < 2) {
    return { detected: false, trendlineValue: null, slope: null, pivotCount: pivots.length };
  }

  const p1 = pivots[pivots.length - 2];
  const p2 = pivots[pivots.length - 1];

  // Must be a genuine ascending trendline (p2 higher than p1).
  if (p2.value <= p1.value || p2.index <= p1.index) {
    return { detected: false, trendlineValue: null, slope: null, pivotCount: pivots.length };
  }

  const slope = (p2.value - p1.value) / (p2.index - p1.index);
  const lastIndex = lows.length - 1;
  const trendlineValue = p2.value + slope * (lastIndex - p2.index);

  // Breakdown: closing price is below the projected trendline.
  const detected = Number.isFinite(currentClose) && currentClose > 0 && currentClose < trendlineValue;

  return {
    detected,
    trendlineValue: Number(trendlineValue.toFixed(8)),
    slope: Number(slope.toFixed(8)),
    pivotCount: pivots.length
  };
}
