function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

let liveTradingEnabledRuntime = parseBooleanEnv(process.env.LIVE_TRADING_ENABLED, false);

export function isLiveTradingEnabled(): boolean {
  return liveTradingEnabledRuntime;
}

export function setLiveTradingEnabled(enabled: boolean): void {
  liveTradingEnabledRuntime = enabled;
  process.env.LIVE_TRADING_ENABLED = enabled ? "true" : "false";
}
