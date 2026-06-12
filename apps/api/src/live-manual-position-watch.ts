function normalizePerpSymbolLike(raw: string): string {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) {
    return "";
  }

  const base = value
    .replace(/-USDT-SWAP$/i, "")
    .replace(/-USDT$/i, "")
    .replace(/USDT$/i, "")
    .replace(/-PERP$/i, "")
    .replace(/[^A-Z0-9]/g, "");

  return base ? `${base}-PERP` : "";
}

function parseSymbols(raw: string): string[] {
  const normalized = String(raw ?? "").trim();
  if (!normalized || normalized.toUpperCase() === "NONE") {
    return [];
  }

  const parts = normalized
    .split(",")
    .map((item) => normalizePerpSymbolLike(item))
    .filter((item) => item.length > 0);

  return Array.from(new Set(parts)).sort();
}

const watchedManualSymbols = new Set(parseSymbols(process.env.LIVE_MANUAL_POSITION_WATCH_SYMBOLS ?? "NONE"));

function listSorted(): string[] {
  return Array.from(watchedManualSymbols.values()).sort();
}

export function serializeManualWatchSymbols(symbols: string[]): string {
  if (symbols.length === 0) {
    return "NONE";
  }

  return Array.from(new Set(symbols.map((item) => normalizePerpSymbolLike(item)).filter((item) => item.length > 0)))
    .sort()
    .join(",");
}

export function listManualWatchSymbols(): string[] {
  return listSorted();
}

export function isManualPositionWatched(symbol: string): boolean {
  const normalized = normalizePerpSymbolLike(symbol);
  if (!normalized) {
    return false;
  }

  return watchedManualSymbols.has(normalized);
}

export function addManualWatchSymbol(symbol: string): { symbol: string; added: boolean; symbols: string[] } {
  const normalized = normalizePerpSymbolLike(symbol);
  if (!normalized) {
    throw new Error("invalid symbol");
  }

  const added = !watchedManualSymbols.has(normalized);
  watchedManualSymbols.add(normalized);
  return {
    symbol: normalized,
    added,
    symbols: listSorted()
  };
}

export function removeManualWatchSymbol(symbol: string): { symbol: string; removed: boolean; symbols: string[] } {
  const normalized = normalizePerpSymbolLike(symbol);
  if (!normalized) {
    throw new Error("invalid symbol");
  }

  const removed = watchedManualSymbols.delete(normalized);
  return {
    symbol: normalized,
    removed,
    symbols: listSorted()
  };
}