export type StructureContext = {
  highs1h: number[];
  lows1h: number[];
};

function finiteSeries(values: number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
}

function last(values: number[]): number | null {
  return values.length > 0 ? values[values.length - 1] : null;
}

function prev(values: number[]): number | null {
  return values.length > 1 ? values[values.length - 2] : null;
}

export function higherLow(lows: number[]): boolean {
  const clean = finiteSeries(lows);
  const latest = last(clean);
  const previous = prev(clean);
  return latest != null && previous != null && latest >= previous;
}

export function lowerHigh(highs: number[]): boolean {
  const clean = finiteSeries(highs);
  const latest = last(clean);
  const previous = prev(clean);
  return latest != null && previous != null && latest <= previous;
}

export function breakoutHigh(highs: number[]): boolean {
  const clean = finiteSeries(highs);
  if (clean.length < 3) {
    return false;
  }

  const latest = clean[clean.length - 1];
  const previousMax = Math.max(...clean.slice(0, -1));
  return latest > previousMax;
}

export function breakdownLow(lows: number[]): boolean {
  const clean = finiteSeries(lows);
  if (clean.length < 3) {
    return false;
  }

  const latest = clean[clean.length - 1];
  const previousMin = Math.min(...clean.slice(0, -1));
  return latest < previousMin;
}

export function evaluateStructure(ctx: StructureContext, signalType: string): boolean {
  const longSignal = signalType.includes("LONG");
  const shortSignal = signalType.includes("SHORT");
  const reversalSignal = signalType.startsWith("REVERSAL");

  if (longSignal) {
    const higherLowOk = higherLow(ctx.lows1h);
    const breakoutOk = breakoutHigh(ctx.highs1h);
    if (reversalSignal) {
      return breakoutOk;
    }
    return higherLowOk || breakoutOk;
  }

  if (shortSignal) {
    const lowerHighOk = lowerHigh(ctx.highs1h);
    const breakdownOk = breakdownLow(ctx.lows1h);
    if (reversalSignal) {
      return breakdownOk;
    }
    return lowerHighOk || breakdownOk;
  }

  return false;
}
