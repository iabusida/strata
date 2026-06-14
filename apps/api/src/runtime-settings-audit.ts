import { listRuntimeSettings } from "./runtime-settings.js";

export type RuntimeAuditEntry = {
  key: string;
  dbValue: string | null;
  envValue: string | null;
  effectiveValue: string | null;
  source: "db" | "env" | "missing";
  matches: boolean;
};

const AUDIT_KEYS = [
  "MARKET_DATA_PROVIDER",
  "TEST_OPEN_MODE",
  "FIXED_STAKE_ENABLED",
  "SIGNAL_SIM_STAKE_USD",
  "SIGNAL_SIM_MAX_ACTIVE_TRADES",
  "LIVE_TRADING_ENABLED",
  "LIVE_BOT_AUTO_CLOSE_ENABLED",
  "LIVE_ENFORCE_TELEGRAM_OPEN_CLOSE_FROM_LIVE",
  "LIQUIDITY_HUNT_ONLY_MODE",
  "LIQUIDITY_HUNT_ENTRY_MODE",
  "LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE",
  "LIVE_MULTI_TRADE_MIN_BALANCE_USD",
  "MAX_ACTIVE_TRADES_UNDER_1000",
  "MAX_ACTIVE_TRADES_AT_OR_ABOVE_1000",
  "TELEGRAM_ALERTS_ENABLED",
  "TELEGRAM_ALERT_STAGES",
  "TELEGRAM_ALERT_DEDUPE_MINUTES",
  "TELEGRAM_TOKEN_REPEAT_MINUTES",
  "TELEGRAM_OPENED_REPEAT_MINUTES",
  "TELEGRAM_COMMANDS_ENABLED",
  "TELEGRAM_TOKEN_ALERT_MATCH_WINDOW_SECONDS"
] as const;

const ENV_ONLY_OPERATIONAL_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_COMMAND_CHAT_IDS",
  "BITUNIX_API_BASE_URL",
  "BITUNIX_API_KEY",
  "BITUNIX_API_SECRET",
  "BITUNIX_API_LANGUAGE",
  "BITUNIX_ACCOUNT_MARGIN_COIN",
  "LIVE_ORPHAN_EARLY_DRAWDOWN_PROTECTION",
  "LIVE_TELEGRAM_ALERT_ON_EXECUTION_FAILURE",
  "BITUNIX_DRY_RUN_ENABLED"
] as const;

export async function getRuntimeSettingsAudit(targetStakeUsd = 7): Promise<{
  generatedAt: string;
  compared: RuntimeAuditEntry[];
  envOnlyOperationalKeys: string[];
  warnings: Array<{ code: string; message: string; key?: string; currentValue?: string | null; recommendedValue?: string | null }>;
}> {
  const settings = await listRuntimeSettings();
  const db = new Map(settings.map((row) => [row.key, row.value]));

  const compared: RuntimeAuditEntry[] = AUDIT_KEYS.map((key) => {
    const dbValue = db.get(key) ?? null;
    const envValue = process.env[key] ?? null;
    const source = dbValue != null ? "db" : envValue != null ? "env" : "missing";
    const effectiveValue = dbValue ?? envValue ?? null;

    return {
      key,
      dbValue,
      envValue,
      effectiveValue,
      source,
      matches: (dbValue ?? null) === (envValue ?? null)
    };
  });

  const byKey = new Map(compared.map((entry) => [entry.key, entry]));
  const warnings: Array<{ code: string; message: string; key?: string; currentValue?: string | null; recommendedValue?: string | null }> = [];

  const testOpen = byKey.get("TEST_OPEN_MODE")?.effectiveValue;
  if (String(testOpen).toLowerCase() === "true") {
    warnings.push({
      code: "TEST_OPEN_MODE_ENABLED",
      key: "TEST_OPEN_MODE",
      currentValue: testOpen,
      recommendedValue: "false",
      message: "TEST_OPEN_MODE is enabled, which bypasses parts of normal trade gating and can invalidate live/simulation parity."
    });
  }

  const stake = byKey.get("SIGNAL_SIM_STAKE_USD")?.effectiveValue;
  if (stake !== String(targetStakeUsd)) {
    warnings.push({
      code: "STAKE_DRIFT",
      key: "SIGNAL_SIM_STAKE_USD",
      currentValue: stake,
      recommendedValue: String(targetStakeUsd),
      message: `Simulation/live fixed stake is not aligned with the requested ${targetStakeUsd} USDT test profile.`
    });
  }

  const simMax = byKey.get("SIGNAL_SIM_MAX_ACTIVE_TRADES")?.effectiveValue;
  if (simMax !== "1") {
    warnings.push({
      code: "SIM_MULTI_TRADE_ENABLED",
      key: "SIGNAL_SIM_MAX_ACTIVE_TRADES",
      currentValue: simMax,
      recommendedValue: "1",
      message: "Fixed-stake simulation allows more than one concurrent trade, which breaks single-trade test consistency."
    });
  }

  const liveMultiThreshold = byKey.get("LIVE_MULTI_TRADE_MIN_BALANCE_USD")?.effectiveValue;
  if (liveMultiThreshold !== "500") {
    warnings.push({
      code: "LIVE_MULTI_TRADE_THRESHOLD_DRIFT",
      key: "LIVE_MULTI_TRADE_MIN_BALANCE_USD",
      currentValue: liveMultiThreshold,
      recommendedValue: "500",
      message: "Live multi-trade threshold is below the requested 500 USDT single-position guard."
    });
  }

  const under1000 = byKey.get("MAX_ACTIVE_TRADES_UNDER_1000")?.effectiveValue;
  if (under1000 !== "1") {
    warnings.push({
      code: "UNDER_1000_CAP_DRIFT",
      key: "MAX_ACTIVE_TRADES_UNDER_1000",
      currentValue: under1000,
      recommendedValue: "1",
      message: "Sub-1000 active trade cap is greater than one, which conflicts with the current single-trade test profile."
    });
  }

  const preSweepMode = byKey.get("LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE")?.effectiveValue;
  if (preSweepMode !== "LIMIT") {
    warnings.push({
      code: "PRE_SWEEP_EXECUTION_DRIFT",
      key: "LIQUIDITY_HUNT_PRE_SWEEP_EXECUTION_MODE",
      currentValue: preSweepMode,
      recommendedValue: "LIMIT",
      message: "Liquidity-hunt pre-sweep execution mode is not using LIMIT, which differs from the previously working limit-order flow."
    });
  }

  const provider = byKey.get("MARKET_DATA_PROVIDER")?.effectiveValue;
  if (provider === "BITUNIX") {
    warnings.push({
      code: "BITUNIX_PROVIDER_ACTIVE",
      key: "MARKET_DATA_PROVIDER",
      currentValue: provider,
      recommendedValue: null,
      message: "Bitunix is the active market-data provider. If Bitunix requests are 403-blocked, scan, simulation, and live checks will all degrade together."
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    compared,
    envOnlyOperationalKeys: [...ENV_ONLY_OPERATIONAL_KEYS],
    warnings
  };
}
