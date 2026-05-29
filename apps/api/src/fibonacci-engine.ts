/**
 * Fibonacci Retracement Indicator
 * Calculates key Fibonacci levels for support/resistance identification
 */

export interface FibonacciLevels {
  level0: number; // 0%
  level236: number; // 23.6%
  level382: number; // 38.2%
  level50: number; // 50%
  level618: number; // 61.8%
  level786: number; // 78.6%
  level100: number; // 100%
  highPoint: number;
  lowPoint: number;
  trend: "uptrend" | "downtrend";
}

export interface FibConfluence {
  price: number;
  levels: string[];
  strength: number; // 0-1, higher = more confluent
}

/**
 * Calculate Fibonacci retracement levels between a high and low point
 * For uptrend: measure swing from low to high
 * For downtrend: measure swing from high to low
 */
export function calculateFibonacciLevels(
  highPoint: number,
  lowPoint: number,
  trend: "uptrend" | "downtrend" = "uptrend"
): FibonacciLevels {
  const diff = highPoint - lowPoint;

  if (trend === "uptrend") {
    // Retracement DOWN from high
    return {
      level0: highPoint, // No retracement
      level236: highPoint - diff * 0.236,
      level382: highPoint - diff * 0.382,
      level50: highPoint - diff * 0.5,
      level618: highPoint - diff * 0.618,
      level786: highPoint - diff * 0.786,
      level100: lowPoint, // Full retracement
      highPoint,
      lowPoint,
      trend: "uptrend",
    };
  } else {
    // Retracement UP from low
    return {
      level0: lowPoint, // No retracement
      level236: lowPoint + diff * 0.236,
      level382: lowPoint + diff * 0.382,
      level50: lowPoint + diff * 0.5,
      level618: lowPoint + diff * 0.618,
      level786: lowPoint + diff * 0.786,
      level100: highPoint, // Full retracement
      highPoint,
      lowPoint,
      trend: "downtrend",
    };
  }
}

/**
 * Find Fibonacci confluence zones
 * Identifies where multiple fibonacci levels or other technical levels converge
 */
export function findFibonacciConfluence(
  fiboLevels: FibonacciLevels,
  tolerance: number = 0.005 // 0.5% tolerance
): FibConfluence[] {
  const levelMap = [
    { price: fiboLevels.level0, label: "0%" },
    { price: fiboLevels.level236, label: "23.6%" },
    { price: fiboLevels.level382, label: "38.2%" },
    { price: fiboLevels.level50, label: "50%" },
    { price: fiboLevels.level618, label: "61.8%" },
    { price: fiboLevels.level786, label: "78.6%" },
    { price: fiboLevels.level100, label: "100%" },
  ];

  const confluenceZones: FibConfluence[] = [];
  const sortedLevels = [...levelMap].sort((a, b) => a.price - b.price);

  for (let i = 0; i < sortedLevels.length; i++) {
    const level = sortedLevels[i];
    const confluent = [level.label];
    const toleranceRange = tolerance * level.price;

    // Check for confluence with nearby levels
    for (let j = 0; j < sortedLevels.length; j++) {
      if (i !== j) {
        const other = sortedLevels[j];
        if (Math.abs(level.price - other.price) <= toleranceRange) {
          confluent.push(other.label);
        }
      }
    }

    // Only include confluence zones (2+ levels converging)
    if (confluent.length > 1) {
      const strength = Math.min(confluent.length / 4, 1); // Normalize to 0-1
      confluenceZones.push({
        price: level.price,
        levels: [...new Set(confluent)], // Remove duplicates
        strength,
      });
    }
  }

  // Remove duplicate confluence zones
  const uniqueZones: FibConfluence[] = [];
  for (const zone of confluenceZones) {
    const isDuplicate = uniqueZones.some(
      (z) => Math.abs(z.price - zone.price) < tolerance * zone.price
    );
    if (!isDuplicate) {
      uniqueZones.push(zone);
    }
  }

  return uniqueZones;
}

/**
 * Identify if price is near a key Fibonacci level
 * Returns the nearest level and distance in %
 */
export function getNearestFibLevel(
  currentPrice: number,
  fiboLevels: FibonacciLevels
): {
  level: string;
  price: number;
  distancePct: number;
} | null {
  const levels = [
    { label: "0%", price: fiboLevels.level0 },
    { label: "23.6%", price: fiboLevels.level236 },
    { label: "38.2%", price: fiboLevels.level382 },
    { label: "50%", price: fiboLevels.level50 },
    { label: "61.8%", price: fiboLevels.level618 },
    { label: "78.6%", price: fiboLevels.level786 },
    { label: "100%", price: fiboLevels.level100 },
  ];

  let nearest = levels[0];
  let minDist = Math.abs(currentPrice - nearest.price);

  for (const level of levels) {
    const dist = Math.abs(currentPrice - level.price);
    if (dist < minDist) {
      minDist = dist;
      nearest = level;
    }
  }

  const distancePct = (minDist / currentPrice) * 100;

  // Consider "near" if within 1% of price
  if (distancePct <= 1.0) {
    return {
      level: nearest.label,
      price: nearest.price,
      distancePct,
    };
  }

  return null;
}

/**
 * Score price action based on Fibonacci levels
 * Higher score = stronger setup
 */
export function scoreFibSetup(
  entryPrice: number,
  fiboLevels: FibonacciLevels,
  targetPrice: number,
  stopPrice: number
): number {
  let score = 0;

  // Check if entry is at key fib level
  const nearestLevel = getNearestFibLevel(entryPrice, fiboLevels);
  if (nearestLevel && nearestLevel.distancePct <= 0.5) {
    score += 30; // Strong entry point
  } else if (nearestLevel && nearestLevel.distancePct <= 1.0) {
    score += 15; // Moderate entry point
  }

  // Check if target is at key fib level
  const targetNearestLevel = getNearestFibLevel(targetPrice, fiboLevels);
  if (targetNearestLevel && targetNearestLevel.distancePct <= 0.5) {
    score += 25; // Confluence target
  } else if (targetNearestLevel && targetNearestLevel.distancePct <= 1.0) {
    score += 10;
  }

  // Check if stop is at key fib level
  const stopNearestLevel = getNearestFibLevel(stopPrice, fiboLevels);
  if (stopNearestLevel && stopNearestLevel.distancePct <= 0.5) {
    score += 20; // Confluence stop
  } else if (stopNearestLevel && stopNearestLevel.distancePct <= 1.0) {
    score += 8;
  }

  // Bonus for confluence zones
  const confluence = findFibonacciConfluence(fiboLevels);
  if (
    confluence.some((z) => Math.abs(entryPrice - z.price) < entryPrice * 0.002)
  ) {
    score += 10; // Entry in confluence zone
  }

  return Math.min(score, 100);
}
