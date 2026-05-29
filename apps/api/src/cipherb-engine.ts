/**
 * CipherB Pattern Recognition Engine
 * Detects harmonic reversal patterns (CipherB, Gartley, Butterfly, etc.)
 * CipherB is a proprietary harmonic pattern focusing on specific Fibonacci ratios
 */

export interface HarmonicPattern {
  name: string; // "CipherB", "Gartley", "Butterfly", "Crab", "Shark"
  type: "bullish" | "bearish";
  confidence: number; // 0-1
  points: {
    x: number; // High or low
    a: number; // First leg
    b: number; // Retracement
    c: number; // Second leg
    d: number; // Final reversal zone
  };
  priceTarget: number;
  reversalZone: {
    min: number;
    max: number;
  };
}

export interface CipherBSetup {
  detected: boolean;
  confidence: number; // 0-1
  lastFive: {
    price: number;
    ratio: number; // Fib ratio
    type: string;
  }[];
  reversalZones: { min: number; max: number }[];
  recommendation: "ENTRY" | "CAUTION" | "AVOID" | null;
}

/**
 * Calculate ratio between two price swings
 * Used to identify harmonic patterns
 */
function calculateSwingRatio(swing1: number, swing2: number): number {
  if (swing1 === 0) return 0;
  return Math.abs(swing2 / swing1);
}

/**
 * Check if a ratio matches a target Fibonacci ratio within tolerance
 */
function matchesFibRatio(
  actual: number,
  target: number,
  tolerance: number = 0.05
): boolean {
  return Math.abs(actual - target) <= tolerance;
}

/**
 * Detect CipherB harmonic patterns
 * CipherB patterns typically have:
 * - XA leg (initial move)
 * - AB retracement (38.2-61.8% of XA)
 * - BC leg (161.8-261.8% of AB)
 * - CD completion (127% to 161.8% of BC)
 * - PRZ (Potential Reversal Zone) = confluence of retracements
 */
export function detectCipherBPattern(
  priceHistory: number[],
  sensitivity: number = 0.85 // 0-1, higher = stricter pattern matching
): CipherBSetup {
  if (priceHistory.length < 5) {
    return {
      detected: false,
      confidence: 0,
      lastFive: [],
      reversalZones: [],
      recommendation: null,
    };
  }

  const tolerance = 1 - sensitivity; // Convert sensitivity to tolerance
  const recentPrices = priceHistory.slice(-20); // Last 20 candles

  let patterns: HarmonicPattern[] = [];
  let reversalZones: { min: number; max: number }[] = [];

  // Scan for potential reversal points
  for (let i = 4; i < recentPrices.length; i++) {
    const x = recentPrices[i - 4];
    const a = recentPrices[i - 3];
    const b = recentPrices[i - 2];
    const c = recentPrices[i - 1];
    const d = recentPrices[i];

    // Calculate swings
    const xaSwing = Math.abs(a - x);
    const abSwing = Math.abs(b - a);
    const bcSwing = Math.abs(c - b);
    const cdSwing = Math.abs(d - c);

    // Calculate ratios (CipherB pattern rules)
    const abRatio = calculateSwingRatio(xaSwing, abSwing);
    const bcRatio = calculateSwingRatio(abSwing, bcSwing);
    const cdRatio = calculateSwingRatio(bcSwing, cdSwing);

    // CipherB Pattern Detection
    // AB should be 38.2-61.8% of XA
    const abValid =
      matchesFibRatio(abRatio, 0.382, tolerance) ||
      matchesFibRatio(abRatio, 0.618, tolerance) ||
      (abRatio >= 0.382 && abRatio <= 0.618);

    // BC should be 161.8-261.8% of AB
    const bcValid =
      matchesFibRatio(bcRatio, 1.618, tolerance) ||
      matchesFibRatio(bcRatio, 2.618, tolerance) ||
      (bcRatio >= 1.618 && bcRatio <= 2.618);

    // CD should be 127-161.8% of BC
    const cdValid =
      matchesFibRatio(cdRatio, 1.27, tolerance) ||
      matchesFibRatio(cdRatio, 1.618, tolerance) ||
      (cdRatio >= 1.27 && cdRatio <= 1.618);

    if (abValid && bcValid && cdValid) {
      const isBullish = a > x && c > b;
      const isPattern = a < x && c < b;

      if (isPattern) {
        const patternType = isBullish ? "bullish" : "bearish";
        const confidence = Math.min(
          (abRatio * 0.33 + bcRatio * 0.33 + cdRatio * 0.34) / 2,
          1
        );

        // Calculate PRZ (Potential Reversal Zone)
        const przMin = Math.min(d, c * 0.618);
        const przMax = Math.max(d, c * 1.618);

        patterns.push({
          name: "CipherB",
          type: patternType,
          confidence: sensitivity, // Use sensitivity as confidence
          points: { x, a, b, c, d },
          priceTarget: isBullish ? przMax : przMin,
          reversalZone: { min: przMin, max: przMax },
        });

        reversalZones.push({ min: przMin, max: przMax });
      }
    }
  }

  const recommendation = calculateCipherBRecommendation(
    patterns,
    recentPrices[recentPrices.length - 1],
    sensitivity
  );

  return {
    detected: patterns.length > 0,
    confidence:
      patterns.length > 0
        ? patterns.reduce((sum, p) => sum + p.confidence, 0) / patterns.length
        : 0,
    lastFive: recentPrices.slice(-5).map((price, idx) => ({
      price,
      ratio: idx > 0 ? Math.abs((price - recentPrices[idx - 1]) / price) : 0,
      type: idx === recentPrices.length - 5 ? "X" : `${idx}`,
    })),
    reversalZones,
    recommendation,
  };
}

/**
 * Calculate trading recommendation based on CipherB patterns
 */
function calculateCipherBRecommendation(
  patterns: HarmonicPattern[],
  currentPrice: number,
  sensitivity: number
): "ENTRY" | "CAUTION" | "AVOID" | null {
  if (patterns.length === 0) return null;

  const strongPatterns = patterns.filter((p) => p.confidence >= 0.7);

  if (strongPatterns.length === 0) return "CAUTION";

  // Check if price is in PRZ
  for (const pattern of strongPatterns) {
    const inPrz =
      currentPrice >= pattern.reversalZone.min &&
      currentPrice <= pattern.reversalZone.max;

    if (inPrz && sensitivity >= 0.8) {
      return "ENTRY";
    }
  }

  return "CAUTION";
}

/**
 * Score CipherB pattern quality
 */
export function scoreCipherBPattern(setup: CipherBSetup): number {
  if (!setup.detected) return 0;

  let score = 0;

  // Base score from confidence
  score += setup.confidence * 40;

  // Bonus for strong reversal zones
  if (setup.reversalZones.length > 0) {
    score += Math.min(setup.reversalZones.length * 15, 40);
  }

  // Recommendation bonus
  if (setup.recommendation === "ENTRY") {
    score += 20;
  } else if (setup.recommendation === "CAUTION") {
    score += 10;
  }

  return Math.min(score, 100);
}

/**
 * Enhanced Gartley pattern detection (classic harmonic)
 * Stricter than CipherB for confirmation
 */
export function detectGartleyPattern(
  priceHistory: number[],
  sensitivity: number = 0.85
): HarmonicPattern | null {
  if (priceHistory.length < 5) return null;

  const tolerance = 1 - sensitivity;
  const recentPrices = priceHistory.slice(-20);

  for (let i = 4; i < recentPrices.length; i++) {
    const x = recentPrices[i - 4];
    const a = recentPrices[i - 3];
    const b = recentPrices[i - 2];
    const c = recentPrices[i - 1];
    const d = recentPrices[i];

    const xaSwing = Math.abs(a - x);
    const abSwing = Math.abs(b - a);
    const bcSwing = Math.abs(c - b);
    const cdSwing = Math.abs(d - c);

    const abRatio = calculateSwingRatio(xaSwing, abSwing);
    const bcRatio = calculateSwingRatio(abSwing, bcSwing);
    const cdRatio = calculateSwingRatio(bcSwing, cdSwing);

    // Gartley stricter requirements
    const abValid = matchesFibRatio(abRatio, 0.618, tolerance * 0.5);
    const bcValid = matchesFibRatio(bcRatio, 1.618, tolerance * 0.5);
    const cdValid = matchesFibRatio(cdRatio, 1.618, tolerance * 0.5);

    if (abValid && bcValid && cdValid) {
      const isBullish = a > x && c > b;
      return {
        name: "Gartley",
        type: isBullish ? "bullish" : "bearish",
        confidence: sensitivity,
        points: { x, a, b, c, d },
        priceTarget: d,
        reversalZone: {
          min: Math.min(d, x * 0.786),
          max: Math.max(d, x * 1.27),
        },
      };
    }
  }

  return null;
}
