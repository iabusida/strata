"use client";

import { useEffect, useMemo, useState } from "react";

type AccessState = {
  mode: "open" | "licensed";
  plan: "FREE" | "PRO" | "ELITE";
  status: "ACTIVE" | "TRIALING" | "PAST_DUE" | "INACTIVE";
  source: "license_file" | "environment";
  requiresSubscription: boolean;
  isSubscribed: boolean;
  message: string | null;
  features: {
    dashboard: boolean;
    liveState: boolean;
    onDemandScan: boolean;
    backgroundAutomation: boolean;
    telegramAlerts: boolean;
    manualTradeControls: boolean;
  };
  limits: {
    maxScanTokens: number;
    maxActiveTrades: number;
  };
};

type RuntimeSetting = {
  key: string;
  value: string;
  updatedAt: string;
};

type RuntimeSettingsResponse = {
  requiredKeys: string[];
  settings: RuntimeSetting[];
};

type StrategyConfig = {
  tradingMode: "DAY_TRADING" | "SWING_TRADING";
  dayTradingTpPct?: number;
  dayTradingSlPct?: number;
  swingTradingTpPct?: number;
  swingTradingSlPct?: number;
  [key: string]: unknown;
};

type TradingMode = "simple" | "advanced" | "pro";

type SettingsDomain =
  | "risk"
  | "strategy"
  | "entry"
  | "exit"
  | "tradeManagement"
  | "system";

type Preset = "conservative" | "balanced" | "aggressive" | "custom";
type TraderLevel = "conservative" | "balanced" | "aggressive";

type RuntimeUiSetting = RuntimeSetting & {
  label: string;
  domain: SettingsDomain;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787";

const KEY_TO_LABEL: Record<string, string> = {
  RISK_PER_TRADE: "Risk Per Trade",
  MAX_DAILY_DRAWDOWN_PCT: "Max Daily Drawdown Pct",
  MAX_CONCURRENT_RISK_PCT: "Max Concurrent Risk Pct",
  SCORE_ENTRY_THRESHOLD: "Score Entry Threshold",
  SIGNAL_DIRECTION_MODE: "Signal Direction Mode",
  ENTRY_CANDLE_CONFIRMATION_ENABLED: "Entry Candle Confirmation Enabled",
  HTF_MOMENTUM_ALIGNMENT_ENABLED: "Htf Momentum Alignment Enabled",
  STOP_LOSS_PCT: "Stop Loss Pct",
  TAKE_PROFIT_PCT: "Take Profit Pct",
  MAX_ACTIVE_TRADES_AT_OR_ABOVE_1000: "Max Active Trades At Or Above 1000",
  TELEGRAM_ALERTS_ENABLED: "Telegram Alerts Enabled",
  MARKET_DATA_PROVIDER: "Market Data Provider",
  LEVERAGE: "Leverage",
  LIQUIDITY_HUNT_ENTRY_LEVERAGE: "Liquidity Hunt Entry Leverage",
};

const settingsDomainMap: Record<string, SettingsDomain> = {
  "Risk Per Trade": "risk",
  "Max Daily Drawdown Pct": "risk",
  "Max Concurrent Risk Pct": "risk",
  "Score Entry Threshold": "strategy",
  "Signal Direction Mode": "strategy",
  "Entry Candle Confirmation Enabled": "entry",
  "Htf Momentum Alignment Enabled": "entry",
  "Stop Loss Pct": "exit",
  "Take Profit Pct": "exit",
  "Max Active Trades At Or Above 1000": "tradeManagement",
  "Telegram Alerts Enabled": "system",
  "Market Data Provider": "system"
};

const presets: Record<Exclude<Preset, "custom">, Record<string, number>> = {
  conservative: {
    "Risk Per Trade": 1,
    "Max Daily Drawdown Pct": 3,
    "Take Profit Pct": 2,
    "Stop Loss Pct": 1
  },
  balanced: {
    "Risk Per Trade": 2,
    "Max Daily Drawdown Pct": 5,
    "Take Profit Pct": 3,
    "Stop Loss Pct": 1.5
  },
  aggressive: {
    "Risk Per Trade": 5,
    "Max Daily Drawdown Pct": 10,
    "Take Profit Pct": 5,
    "Stop Loss Pct": 3
  }
};

const SIMPLE_MODE_LABELS = new Set([
  "Risk Per Trade",
  "Max Daily Drawdown Pct",
  "Stop Loss Pct",
  "Take Profit Pct",
  "Max Active Trades At Or Above 1000",
  "Score Entry Threshold"
]);

const DOMAIN_ORDER: SettingsDomain[] = ["risk", "strategy", "entry", "exit", "tradeManagement", "system"];

const TRADER_LEVEL_LABELS: Record<TraderLevel, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  aggressive: "Aggressive",
};

function humanizeRuntimeKey(key: string): string {
  return key
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function runtimeGroupKey(key: string): string {
  const parts = key.split("_");
  if (parts.length >= 2) {
    return `${parts[0]}_${parts[1]}`;
  }
  return parts[0] ?? "GENERAL";
}

function getSettingLabel(key: string): string {
  return KEY_TO_LABEL[key] ?? humanizeRuntimeKey(key);
}

function getDomainForLabel(label: string): SettingsDomain {
  return settingsDomainMap[label] ?? "system";
}

function isVisible(label: string, mode: TradingMode): boolean {
  const domain = getDomainForLabel(label);

  if (mode === "pro") return true;

  if (mode === "advanced") {
    return domain !== "system";
  }

  if (mode === "simple") {
    return SIMPLE_MODE_LABELS.has(label);
  }

  return false;
}

function getExplanation(label: string, _value: string) {
  if (label === "Risk Per Trade") {
    return "Percentage of your account risked per trade. Lower values are safer.";
  }
  if (label === "Max Daily Drawdown Pct") {
    return "Maximum daily loss before trading is paused.";
  }
  if (label === "Stop Loss Pct") {
    return "Distance to forced loss exit for each position.";
  }
  if (label === "Take Profit Pct") {
    return "Target profit percentage used to close winning trades.";
  }
  if (label === "Score Entry Threshold") {
    return "Minimum confluence score required before opening a trade.";
  }
  if (label === "Max Active Trades At Or Above 1000") {
    return "Maximum simultaneous trades when account size is at least 1000.";
  }
  if (label === "Leverage") {
    return "Multiplier on position exposure. Higher leverage increases risk rapidly.";
  }
  return "";
}

function compactRuntimeValue(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "(empty)";
  }

  if (normalized.length <= 60) {
    return normalized;
  }

  return `${normalized.slice(0, 57)}...`;
}

type SettingsModalProps = {
  title: string;
  subtitle: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
};

function SettingsModal({ title, subtitle, open, onClose, children, footer }: SettingsModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="settings-modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="settings-modal">
        <div className="settings-modal-header">
          <div>
            <h3>{title}</h3>
            <p>{subtitle}</p>
          </div>
          <button type="button" className="settings-toggle" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="settings-modal-body">{children}</div>
        <div className="settings-modal-footer">{footer}</div>
      </div>
    </div>
  );
}

type SettingItemProps = {
  label: string;
  value: string;
};

function SettingItem({ label, value }: SettingItemProps) {
  const explanation = getExplanation(label, value);

  return (
    <div className="settings-item">
      <div className="settings-item-title">{label}</div>
      <div className="settings-item-value">{compactRuntimeValue(value)}</div>
      {explanation ? <div className="settings-item-explanation">{explanation}</div> : null}
    </div>
  );
}

export function SettingsConsole() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [access, setAccess] = useState<AccessState | null>(null);
  const [accessDraft, setAccessDraft] = useState<{ mode: AccessState["mode"]; plan: AccessState["plan"]; status: AccessState["status"] } | null>(null);
  const [accessSaving, setAccessSaving] = useState(false);
  const [accessFeedback, setAccessFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const [strategyConfig, setStrategyConfig] = useState<StrategyConfig | null>(null);
  const [tradingMode, setTradingMode] = useState<"DAY_TRADING" | "SWING_TRADING">("DAY_TRADING");
  const [strategySaving, setStrategySaving] = useState(false);
  const [strategyFeedback, setStrategyFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const [requiredRuntimeKeys, setRequiredRuntimeKeys] = useState<string[]>([]);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSetting[]>([]);
  const [runtimeDrafts, setRuntimeDrafts] = useState<Record<string, string>>({});
  const [runtimeSearch, setRuntimeSearch] = useState("");
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeFeedback, setRuntimeFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [mode, setMode] = useState<TradingMode>("simple");
  const [preset, setPreset] = useState<Preset>("custom");
  const [traderLevel, setTraderLevel] = useState<TraderLevel>("balanced");
  const [advancedTradingEnabled, setAdvancedTradingEnabled] = useState(false);
  const [expandedDomains, setExpandedDomains] = useState<Partial<Record<SettingsDomain, boolean>>>({});
  const [showHeatmap, setShowHeatmap] = useState(false);

  const [platformModalOpen, setPlatformModalOpen] = useState(false);
  const [platformModalTab, setPlatformModalTab] = useState<"access" | "strategy">("access");
  const [runtimeModalGroup, setRuntimeModalGroup] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadAll(): Promise<void> {
      setLoading(true);
      setError(null);

      try {
        const [accessResponse, strategyResponse, runtimeResponse] = await Promise.all([
          fetch(`${API_BASE}/api/access`, { cache: "no-store" }),
          fetch(`${API_BASE}/api/strategy/config`, { cache: "no-store" }),
          fetch(`${API_BASE}/api/runtime-settings`, { cache: "no-store" })
        ]);

        if (!accessResponse.ok) {
          throw new Error(`Failed to load access state (${accessResponse.status})`);
        }

        const accessPayload = (await accessResponse.json()) as AccessState;
        const strategyPayload = strategyResponse.ok ? ((await strategyResponse.json()) as StrategyConfig) : null;
        const runtimePayload = runtimeResponse.ok ? ((await runtimeResponse.json()) as RuntimeSettingsResponse) : null;

        if (cancelled) {
          return;
        }

        setAccess(accessPayload);
        setAccessDraft({ mode: accessPayload.mode, plan: accessPayload.plan, status: accessPayload.status });

        if (strategyPayload) {
          setStrategyConfig(strategyPayload);
          setTradingMode(strategyPayload.tradingMode ?? "DAY_TRADING");
        }

        if (runtimePayload) {
          setRequiredRuntimeKeys(runtimePayload.requiredKeys ?? []);
          setRuntimeSettings(runtimePayload.settings ?? []);
          setRuntimeDrafts(
            (runtimePayload.settings ?? []).reduce<Record<string, string>>((acc, row) => {
              acc[row.key] = row.value;
              return acc;
            }, {})
          );
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadAll();

    return () => {
      cancelled = true;
    };
  }, []);

  const missingRequiredRuntimeKeys = useMemo(() => {
    const byKey = new Map(runtimeSettings.map((row) => [row.key, String(runtimeDrafts[row.key] ?? row.value ?? "").trim()]));
    return requiredRuntimeKeys.filter((key) => !byKey.get(key));
  }, [requiredRuntimeKeys, runtimeDrafts, runtimeSettings]);

  const filteredRuntimeRows = useMemo(() => {
    const query = runtimeSearch.trim().toLowerCase();
    if (!query) {
      return runtimeSettings;
    }

    return runtimeSettings.filter((row) => row.key.toLowerCase().includes(query) || humanizeRuntimeKey(row.key).toLowerCase().includes(query));
  }, [runtimeSearch, runtimeSettings]);

  const groupedRuntimeRows = useMemo(() => {
    const groups = new Map<string, RuntimeSetting[]>();
    for (const row of filteredRuntimeRows) {
      const group = runtimeGroupKey(row.key);
      const current = groups.get(group) ?? [];
      current.push(row);
      groups.set(group, current);
    }

    return Array.from(groups.entries()).sort((left, right) => left[0].localeCompare(right[0]));
  }, [filteredRuntimeRows]);

  const runtimeUiSettings = useMemo<RuntimeUiSetting[]>(() => {
    return runtimeSettings.map((row) => {
      const label = getSettingLabel(row.key);
      return {
        ...row,
        label,
        domain: getDomainForLabel(label)
      };
    });
  }, [runtimeSettings]);

  const groupedByDomain = useMemo(() => {
    const grouped: Record<SettingsDomain, RuntimeUiSetting[]> = {
      risk: [],
      strategy: [],
      entry: [],
      exit: [],
      tradeManagement: [],
      system: []
    };

    for (const setting of runtimeUiSettings) {
      grouped[setting.domain].push(setting);
    }

    return grouped;
  }, [runtimeUiSettings]);

  const selectedRuntimeGroupRows = useMemo(() => {
    if (!runtimeModalGroup) {
      return [] as RuntimeUiSetting[];
    }

    const domain = runtimeModalGroup as SettingsDomain;
    const base = groupedByDomain[domain] ?? [];
    const query = runtimeSearch.trim().toLowerCase();

    return base.filter((row) => {
      if (!isVisible(row.label, mode)) {
        return false;
      }
      if (!advancedTradingEnabled && row.label.toLowerCase().includes("leverage")) {
        return false;
      }
      if (!query) {
        return true;
      }
      return row.label.toLowerCase().includes(query);
    });
  }, [advancedTradingEnabled, groupedByDomain, mode, runtimeModalGroup, runtimeSearch]);

  function getSettingValueByLabel(label: string): string {
    const row = runtimeUiSettings.find((candidate) => candidate.label === label);
    if (!row) {
      return "";
    }
    return String(runtimeDrafts[row.key] ?? row.value ?? "");
  }

  function toNumber(value: string, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function toBool(value: string): boolean {
    const normalized = String(value).trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
  }

  const heatmapMetrics = useMemo(() => {
    const riskPerTrade = toNumber(getSettingValueByLabel("Risk Per Trade"));
    const maxDailyDrawdown = toNumber(getSettingValueByLabel("Max Daily Drawdown Pct"));
    const maxConcurrentRisk = toNumber(getSettingValueByLabel("Max Concurrent Risk Pct"));
    const scoreThreshold = toNumber(getSettingValueByLabel("Score Entry Threshold"), 65);
    const htfAlignmentEnabled = toBool(getSettingValueByLabel("Htf Momentum Alignment Enabled"));
    const stopLoss = toNumber(getSettingValueByLabel("Stop Loss Pct"), 1);
    const takeProfit = toNumber(getSettingValueByLabel("Take Profit Pct"), 2);
    const maxActiveTrades = toNumber(getSettingValueByLabel("Max Active Trades At Or Above 1000"), 2);
    const leverage = toNumber(getSettingValueByLabel("Leverage"), 1);

    const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

    const riskIntensity = clamp((riskPerTrade * 12) + (maxDailyDrawdown * 3.2) + (maxConcurrentRisk * 2.2));
    const entryStrictness = clamp((scoreThreshold - 45) * 2 + (htfAlignmentEnabled ? 20 : 0));
    const exitAggressiveness = clamp((takeProfit * 12) - (stopLoss * 6) + 45);
    const exposureIntensity = clamp((maxActiveTrades * 10) + (leverage * 8));

    return [
      {
        name: "Risk Intensity",
        score: riskIntensity,
        note: "Derived from risk-per-trade and drawdown caps."
      },
      {
        name: "Entry Strictness",
        score: entryStrictness,
        note: "Higher threshold and HTF alignment raise strictness."
      },
      {
        name: "Exit Profile",
        score: exitAggressiveness,
        note: "TP/SL relationship shapes aggressiveness."
      },
      {
        name: "Exposure",
        score: exposureIntensity,
        note: "Active trades and leverage drive portfolio heat."
      }
    ];
  }, [runtimeDrafts, runtimeUiSettings]);

  const balanceDiagnostics = useMemo(() => {
    const scoreThreshold = toNumber(getSettingValueByLabel("Score Entry Threshold"), 3.7);
    const riskPerTrade = toNumber(getSettingValueByLabel("Risk Per Trade"), 2);
    const maxActiveTrades = toNumber(getSettingValueByLabel("Max Active Trades At Or Above 1000"), 2);
    const stopLoss = toNumber(getSettingValueByLabel("Stop Loss Pct"), 1.5);
    const takeProfit = toNumber(getSettingValueByLabel("Take Profit Pct"), 3);
    const leverage = toNumber(getSettingValueByLabel("Leverage"), 1);
    const entryConfirm = toBool(getSettingValueByLabel("Entry Candle Confirmation Enabled"));
    const htfAlign = toBool(getSettingValueByLabel("Htf Momentum Alignment Enabled"));

    const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
    const entryStrictness = clamp((scoreThreshold - 2.5) * 20 + (entryConfirm ? 8 : 0) + (htfAlign ? 10 : 0));
    const riskAggression = clamp((riskPerTrade * 14) + (maxActiveTrades * 6) + (leverage * 5));
    const exitAggression = clamp(((takeProfit / Math.max(0.5, stopLoss)) * 22) + (stopLoss * 6));

    const targetBands: Record<TraderLevel, {
      strictness: [number, number];
      risk: [number, number];
      exit: [number, number];
    }> = {
      conservative: {
        strictness: [58, 84],
        risk: [20, 45],
        exit: [35, 60],
      },
      balanced: {
        strictness: [45, 70],
        risk: [35, 65],
        exit: [45, 70],
      },
      aggressive: {
        strictness: [30, 62],
        risk: [55, 88],
        exit: [55, 82],
      },
    };

    const band = targetBands[traderLevel];

    const classify = (value: number, [low, high]: [number, number]) => {
      if (value < low) return "too_strict";
      if (value > high) return "too_loose";
      return "balanced";
    };

    const strictnessStatus = classify(entryStrictness, band.strictness);
    const riskStatus = classify(riskAggression, band.risk);
    const exitStatus = classify(exitAggression, band.exit);

    const suggestions: string[] = [];
    if (strictnessStatus === "too_strict") {
      suggestions.push("Entry rules are too strict. Lower Score Entry Threshold slightly or relax one confirmation gate.");
    }
    if (strictnessStatus === "too_loose") {
      suggestions.push("Entry rules are too loose. Raise Score Entry Threshold or enable HTF alignment to reduce noise.");
    }
    if (riskStatus === "too_strict") {
      suggestions.push("Risk posture is too defensive. Increase Risk Per Trade slightly or allow one more active slot.");
    }
    if (riskStatus === "too_loose") {
      suggestions.push("Risk posture is too aggressive. Lower leverage or Risk Per Trade to prevent oversized exposure.");
    }
    if (exitStatus === "too_strict") {
      suggestions.push("Exit profile is too tight. Slightly widen Stop Loss or increase TP:SL ratio for smoother trade lifecycle.");
    }
    if (exitStatus === "too_loose") {
      suggestions.push("Exit profile is too loose. Reduce TP distance or tighten Stop Loss to lock outcomes sooner.");
    }

    const balancedCount = [strictnessStatus, riskStatus, exitStatus].filter((status) => status === "balanced").length;
    const overall = balancedCount === 3 ? "balanced" : balancedCount >= 2 ? "mostly_balanced" : "needs_tuning";

    return {
      entryStrictness,
      riskAggression,
      exitAggression,
      strictnessStatus,
      riskStatus,
      exitStatus,
      overall,
      suggestions,
      targetBand: band,
    };
  }, [getSettingValueByLabel, toBool, toNumber, traderLevel]);

  function updateSettingByLabel(label: string, value: string): void {
    const row = runtimeUiSettings.find((candidate) => candidate.label === label);
    if (!row) {
      return;
    }

    setRuntimeDrafts((prev) => ({
      ...prev,
      [row.key]: String(value)
    }));
  }

  function applyPreset(nextPreset: Preset): void {
    setPreset(nextPreset);
    if (nextPreset === "custom") {
      return;
    }

    setTraderLevel(nextPreset);

    const config = presets[nextPreset];
    for (const [label, value] of Object.entries(config)) {
      updateSettingByLabel(label, String(value));
    }

    setRuntimeFeedback({ ok: true, msg: `${nextPreset[0].toUpperCase()}${nextPreset.slice(1)} preset applied to drafts.` });
  }

  async function saveAccessSettings(): Promise<void> {
    if (!accessDraft) {
      return;
    }

    setAccessSaving(true);
    setAccessFeedback(null);

    try {
      const response = await fetch(`${API_BASE}/api/access`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(accessDraft)
      });

      const payload = (await response.json()) as { saved?: boolean; access?: AccessState; error?: string };
      if (!response.ok || !payload.saved || !payload.access) {
        throw new Error(payload.error ?? "Failed to save access settings");
      }

      setAccess(payload.access);
      setAccessDraft({ mode: payload.access.mode, plan: payload.access.plan, status: payload.access.status });
      setAccessFeedback({ ok: true, msg: "Access settings saved." });
    } catch (saveError) {
      setAccessFeedback({ ok: false, msg: saveError instanceof Error ? saveError.message : String(saveError) });
    } finally {
      setAccessSaving(false);
    }
  }

  async function saveTradingMode(): Promise<void> {
    setStrategySaving(true);
    setStrategyFeedback(null);

    try {
      const response = await fetch(`${API_BASE}/api/strategy/mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: tradingMode })
      });

      const payload = (await response.json()) as { success?: boolean; config?: StrategyConfig; error?: string; details?: string };
      if (!response.ok || !payload.success || !payload.config) {
        throw new Error(payload.error ?? payload.details ?? "Failed to update trading mode");
      }

      setStrategyConfig(payload.config);
      setTradingMode(payload.config.tradingMode ?? tradingMode);
      setStrategyFeedback({ ok: true, msg: "Trading mode updated." });
    } catch (saveError) {
      setStrategyFeedback({ ok: false, msg: saveError instanceof Error ? saveError.message : String(saveError) });
    } finally {
      setStrategySaving(false);
    }
  }

  async function saveRuntimeSettings(): Promise<void> {
    setRuntimeSaving(true);
    setRuntimeFeedback(null);

    try {
      const settingsPayload = runtimeSettings.map((row) => ({
        key: row.key,
        value: String(runtimeDrafts[row.key] ?? row.value ?? "").trim()
      }));

      const response = await fetch(`${API_BASE}/api/runtime-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: settingsPayload })
      });

      const payload = (await response.json()) as {
        success?: boolean;
        settings?: RuntimeSetting[];
        error?: string;
        details?: string;
      };

      if (!response.ok || !payload.success || !payload.settings) {
        throw new Error(payload.error ?? payload.details ?? "Failed to save runtime settings");
      }

      setRuntimeSettings(payload.settings);
      setRuntimeDrafts(
        payload.settings.reduce<Record<string, string>>((acc, row) => {
          acc[row.key] = row.value;
          return acc;
        }, {})
      );
      setRuntimeFeedback({ ok: true, msg: "Runtime settings saved. Restart API workers to apply everywhere." });
    } catch (saveError) {
      setRuntimeFeedback({ ok: false, msg: saveError instanceof Error ? saveError.message : String(saveError) });
    } finally {
      setRuntimeSaving(false);
    }
  }

  return (
    <main className="shell settings-shell">
      <section className="hero settings-hero">
        <div className="brand-row">
          <img className="brand-logo" src="/strata-logo.svg" alt="Strata logo" />
          <div>
            <p className="eyebrow">Strata Settings</p>
            <p className="brand-subtitle">Organized control center for access, strategy, and runtime keys</p>
          </div>
        </div>
      </section>

      {loading ? <p className="section-collapsed-note">Loading settings…</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {!loading && !error ? (
        <div className="settings-page-grid">
          <section className="panel settings-card">
            <h2>Overview</h2>
            <p className="settings-note">Use quick summaries to navigate. Open a focused modal to update each area without scrolling through long forms.</p>
            <div className="settings-overview-grid">
              <div className="settings-overview-item">
                <span>Access</span>
                <strong>{access?.mode ?? "-"}</strong>
                <small>{access?.plan ?? "-"} · {access?.status ?? "-"}</small>
              </div>
              <div className="settings-overview-item">
                <span>Strategy</span>
                <strong>{strategyConfig?.tradingMode ?? "-"}</strong>
                <small>Day {strategyConfig?.dayTradingTpPct ?? "-"}%/{strategyConfig?.dayTradingSlPct ?? "-"}% · Swing {strategyConfig?.swingTradingTpPct ?? "-"}%/{strategyConfig?.swingTradingSlPct ?? "-"}%</small>
              </div>
              <div className="settings-overview-item">
                <span>Runtime Health</span>
                <strong>{requiredRuntimeKeys.length - missingRequiredRuntimeKeys.length}/{requiredRuntimeKeys.length}</strong>
                <small>{missingRequiredRuntimeKeys.length === 0 ? "All required keys are set" : `${missingRequiredRuntimeKeys.length} required keys missing`}</small>
              </div>
            </div>
          </section>

          <section className="panel settings-card">
            <h2>Platform Settings</h2>
            <p className="settings-note">Access and strategy are managed together in one modal with tabs for faster navigation.</p>

            <div className="settings-summary-grid">
              <div className="settings-summary-item">
                <span>Access</span>
                <strong>{accessDraft?.mode ?? access?.mode ?? "-"} · {accessDraft?.plan ?? access?.plan ?? "-"}</strong>
              </div>
              <div className="settings-summary-item">
                <span>Status</span>
                <strong>{accessDraft?.status ?? access?.status ?? "-"}</strong>
              </div>
              <div className="settings-summary-item">
                <span>Strategy Mode</span>
                <strong>{tradingMode}</strong>
              </div>
              <div className="settings-summary-item">
                <span>Risk Defaults</span>
                <strong>Day {strategyConfig?.dayTradingTpPct ?? "-"}%/{strategyConfig?.dayTradingSlPct ?? "-"}% · Swing {strategyConfig?.swingTradingTpPct ?? "-"}%/{strategyConfig?.swingTradingSlPct ?? "-"}%</strong>
              </div>
            </div>

            <div className="settings-page-actions">
              <button
                type="button"
                className="settings-toggle"
                onClick={() => {
                  setPlatformModalTab("access");
                  setPlatformModalOpen(true);
                }}
              >
                Edit Platform Settings
              </button>
            </div>
            {accessFeedback ? <p className={`settings-feedback ${accessFeedback.ok ? "ok" : "err"}`}>{accessFeedback.msg}</p> : null}
            {strategyFeedback ? <p className={`settings-feedback ${strategyFeedback.ok ? "ok" : "err"}`}>{strategyFeedback.msg}</p> : null}
          </section>

          <section className="panel settings-card settings-runtime-card">
            <h2>Runtime Settings</h2>
            <p className="settings-note">Search keys and edit grouped settings in modal popups. Save applies all draft changes together.</p>
            <p className={`settings-feedback ${missingRequiredRuntimeKeys.length === 0 ? "ok" : "err"}`}>
              Required keys {requiredRuntimeKeys.length} · Missing {missingRequiredRuntimeKeys.length}
              {missingRequiredRuntimeKeys.length > 0 ? ` (${missingRequiredRuntimeKeys.join(", ")})` : ""}
            </p>

            <div className="settings-runtime-toolbar">
              <div className="settings-mode-selector">
                {(["simple", "advanced", "pro"] as TradingMode[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setMode(option)}
                    className={mode === option ? "settings-mode-btn active" : "settings-mode-btn"}
                  >
                    {option.toUpperCase()}
                  </button>
                ))}
              </div>

              <div className="settings-preset-wrap">
                <label htmlFor="settings-preset">Preset</label>
                <select
                  id="settings-preset"
                  value={preset}
                  onChange={(event) => applyPreset(event.target.value as Preset)}
                >
                  <option value="conservative">Conservative</option>
                  <option value="balanced">Balanced</option>
                  <option value="aggressive">Aggressive</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              <div className="settings-preset-wrap">
                <label htmlFor="settings-trader-level">Trader Level</label>
                <select
                  id="settings-trader-level"
                  value={traderLevel}
                  onChange={(event) => setTraderLevel(event.target.value as TraderLevel)}
                >
                  <option value="conservative">Conservative</option>
                  <option value="balanced">Balanced</option>
                  <option value="aggressive">Aggressive</option>
                </select>
              </div>

              <label className="settings-advanced-toggle">
                <input
                  type="checkbox"
                  checked={advancedTradingEnabled}
                  onChange={() => setAdvancedTradingEnabled((prev) => !prev)}
                />
                Enable Advanced Trading Features
              </label>

              <div className="settings-search-wrap">
                <label htmlFor="runtime-search">Search runtime keys</label>
                <input
                  id="runtime-search"
                  type="text"
                  placeholder="Try: pre pump, violent move, risk reward..."
                  value={runtimeSearch}
                  onChange={(event) => setRuntimeSearch(event.target.value)}
                />
              </div>
              <div className="settings-page-actions">
                <button
                  type="button"
                  className="settings-toggle"
                  disabled={runtimeSaving || missingRequiredRuntimeKeys.length > 0}
                  onClick={() => void saveRuntimeSettings()}
                >
                  {runtimeSaving ? "Saving…" : "Save Runtime Drafts"}
                </button>
                {mode !== "simple" ? (
                  <button
                    type="button"
                    className="settings-toggle"
                    onClick={() => setShowHeatmap((prev) => !prev)}
                  >
                    {showHeatmap ? "Hide Risk Heatmap" : "Show Risk Heatmap"}
                  </button>
                ) : null}
              </div>
            </div>

            <section className="settings-balance-panel" aria-label="Trader Balance Diagnostics">
              <div className="settings-balance-header">
                <h3>Balance Diagnostics</h3>
                <span className="settings-source">Target Profile: {TRADER_LEVEL_LABELS[traderLevel]}</span>
              </div>
              <div className="settings-balance-grid">
                <div className="settings-balance-item">
                  <span>Entry Strictness</span>
                  <strong>{balanceDiagnostics.entryStrictness}</strong>
                  <small>Target {balanceDiagnostics.targetBand.strictness[0]}-{balanceDiagnostics.targetBand.strictness[1]}</small>
                  <p className={`settings-balance-state ${balanceDiagnostics.strictnessStatus}`}>{balanceDiagnostics.strictnessStatus.replace("_", " ")}</p>
                </div>
                <div className="settings-balance-item">
                  <span>Risk Aggression</span>
                  <strong>{balanceDiagnostics.riskAggression}</strong>
                  <small>Target {balanceDiagnostics.targetBand.risk[0]}-{balanceDiagnostics.targetBand.risk[1]}</small>
                  <p className={`settings-balance-state ${balanceDiagnostics.riskStatus}`}>{balanceDiagnostics.riskStatus.replace("_", " ")}</p>
                </div>
                <div className="settings-balance-item">
                  <span>Exit Aggression</span>
                  <strong>{balanceDiagnostics.exitAggression}</strong>
                  <small>Target {balanceDiagnostics.targetBand.exit[0]}-{balanceDiagnostics.targetBand.exit[1]}</small>
                  <p className={`settings-balance-state ${balanceDiagnostics.exitStatus}`}>{balanceDiagnostics.exitStatus.replace("_", " ")}</p>
                </div>
              </div>
              <p className={`settings-feedback ${balanceDiagnostics.overall === "balanced" ? "ok" : balanceDiagnostics.overall === "mostly_balanced" ? "ok" : "err"}`}>
                Overall: {balanceDiagnostics.overall.replace("_", " ")}
              </p>
              {balanceDiagnostics.suggestions.length > 0 ? (
                <ul className="settings-balance-suggestions">
                  {balanceDiagnostics.suggestions.map((tip) => (
                    <li key={tip}>{tip}</li>
                  ))}
                </ul>
              ) : (
                <p className="settings-note">Current runtime drafts are well balanced for this trader level.</p>
              )}
            </section>

            {mode !== "simple" && showHeatmap ? (
              <section className="settings-heatmap" aria-label="Risk Heatmap">
                <div className="settings-heatmap-header">
                  <h3>Risk Heatmap</h3>
                  <p className="settings-note">Draft-aware guidance panel for advanced users.</p>
                </div>
                <div className="settings-heatmap-grid">
                  {heatmapMetrics
                    .filter((metric) => advancedTradingEnabled || metric.name !== "Exposure")
                    .map((metric) => {
                      const tone = metric.score >= 70 ? "high" : metric.score >= 40 ? "mid" : "low";
                      return (
                        <article key={metric.name} className={`settings-heat-cell ${tone}`}>
                          <div className="settings-heat-title">{metric.name}</div>
                          <div className="settings-heat-score">{metric.score}</div>
                          <div className="settings-heat-note">{metric.note}</div>
                        </article>
                      );
                    })}
                </div>
              </section>
            ) : null}

            <div className="settings-runtime-list">
              {DOMAIN_ORDER.map((domain) => {
                const domainItems = groupedByDomain[domain] ?? [];
                const query = runtimeSearch.trim().toLowerCase();
                const visibleItems = domainItems.filter((item) => {
                  if (!isVisible(item.label, mode)) {
                    return false;
                  }

                  if (!advancedTradingEnabled && item.label.toLowerCase().includes("leverage")) {
                    return false;
                  }

                  if (!query) {
                    return true;
                  }

                  return item.label.toLowerCase().includes(query);
                });

                if (!visibleItems.length) {
                  return null;
                }

                const expanded = Boolean(expandedDomains[domain]);
                const renderItems = expanded ? visibleItems : visibleItems.slice(0, 5);

                return (
                  <section key={domain} className="settings-runtime-group">
                    <div className="settings-runtime-group-header">
                      <div className="settings-runtime-group-title-wrap">
                        <h3>{domain === "tradeManagement" ? "Trade Management" : domain}</h3>
                        <p className="settings-note">{visibleItems.length} settings visible in {mode.toUpperCase()} mode</p>
                      </div>
                      <div className="settings-page-actions">
                        <button type="button" className="settings-toggle" onClick={() => setRuntimeModalGroup(domain)}>
                          Edit Group
                        </button>
                      </div>
                    </div>

                    <div className="settings-domain-items">
                      {renderItems.map((item) => (
                        <SettingItem
                          key={item.key}
                          label={item.label}
                          value={runtimeDrafts[item.key] ?? item.value ?? ""}
                        />
                      ))}
                    </div>

                    {visibleItems.length > 5 ? (
                      <button
                        type="button"
                        className="settings-domain-toggle"
                        onClick={() => setExpandedDomains((prev) => ({ ...prev, [domain]: !expanded }))}
                      >
                        {expanded ? "Hide Advanced Settings" : "Show Advanced Settings"}
                      </button>
                    ) : null}
                  </section>
                );
              })}
            </div>
            {runtimeFeedback ? <p className={`settings-feedback ${runtimeFeedback.ok ? "ok" : "err"}`}>{runtimeFeedback.msg}</p> : null}
          </section>

          <SettingsModal
            title="Edit Platform Settings"
            subtitle="Access and strategy controls in one place"
            open={platformModalOpen}
            onClose={() => setPlatformModalOpen(false)}
            footer={(
              <>
                <button type="button" className="settings-toggle" onClick={() => setPlatformModalOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="settings-toggle"
                  disabled={platformModalTab === "access" ? accessSaving || !accessDraft : strategySaving}
                  onClick={() => {
                    if (platformModalTab === "access") {
                      void saveAccessSettings();
                      return;
                    }
                    void saveTradingMode();
                  }}
                >
                  {platformModalTab === "access"
                    ? accessSaving ? "Saving…" : "Save Access"
                    : strategySaving ? "Applying…" : "Apply Strategy Mode"}
                </button>
              </>
            )}
          >
            <div className="settings-modal-grid">
              <div className="settings-tabs">
                <button
                  type="button"
                  className={`settings-tab ${platformModalTab === "access" ? "active" : ""}`}
                  onClick={() => setPlatformModalTab("access")}
                >
                  Access
                </button>
                <button
                  type="button"
                  className={`settings-tab ${platformModalTab === "strategy" ? "active" : ""}`}
                  onClick={() => setPlatformModalTab("strategy")}
                >
                  Strategy
                </button>
              </div>

              {platformModalTab === "access" ? (
                <>
                  <div className="settings-field">
                    <label htmlFor="access-mode">Mode</label>
                    <select
                      id="access-mode"
                      value={accessDraft?.mode ?? "licensed"}
                      disabled={accessSaving}
                      onChange={(event) => setAccessDraft((prev) => prev ? { ...prev, mode: event.target.value as AccessState["mode"] } : prev)}
                    >
                      <option value="open">Open (enforcement bypassed)</option>
                      <option value="licensed">Licensed (plan limits enforced)</option>
                    </select>
                  </div>
                  <div className="settings-field">
                    <label htmlFor="access-plan">Plan</label>
                    <select
                      id="access-plan"
                      value={accessDraft?.plan ?? "FREE"}
                      disabled={accessSaving}
                      onChange={(event) => setAccessDraft((prev) => prev ? { ...prev, plan: event.target.value as AccessState["plan"] } : prev)}
                    >
                      <option value="FREE">FREE</option>
                      <option value="PRO">PRO</option>
                      <option value="ELITE">ELITE</option>
                    </select>
                  </div>
                  <div className="settings-field">
                    <label htmlFor="access-status">Status</label>
                    <select
                      id="access-status"
                      value={accessDraft?.status ?? "ACTIVE"}
                      disabled={accessSaving}
                      onChange={(event) => setAccessDraft((prev) => prev ? { ...prev, status: event.target.value as AccessState["status"] } : prev)}
                    >
                      <option value="ACTIVE">ACTIVE</option>
                      <option value="TRIALING">TRIALING</option>
                      <option value="PAST_DUE">PAST_DUE</option>
                      <option value="INACTIVE">INACTIVE</option>
                    </select>
                  </div>
                </>
              ) : null}

              {platformModalTab === "strategy" ? (
                <>
                  <div className="settings-field">
                    <label htmlFor="strategy-mode">Trading Mode</label>
                    <select
                      id="strategy-mode"
                      value={tradingMode}
                      disabled={strategySaving}
                      onChange={(event) => setTradingMode(event.target.value as "DAY_TRADING" | "SWING_TRADING")}
                    >
                      <option value="DAY_TRADING">Day Trading</option>
                      <option value="SWING_TRADING">Swing Trading</option>
                    </select>
                  </div>
                  <div className="settings-field settings-field-readonly">
                    <label>Day TP / SL</label>
                    <div>{strategyConfig?.dayTradingTpPct ?? "-"}% / {strategyConfig?.dayTradingSlPct ?? "-"}%</div>
                  </div>
                  <div className="settings-field settings-field-readonly">
                    <label>Swing TP / SL</label>
                    <div>{strategyConfig?.swingTradingTpPct ?? "-"}% / {strategyConfig?.swingTradingSlPct ?? "-"}%</div>
                  </div>
                </>
              ) : null}
            </div>
          </SettingsModal>

          <SettingsModal
            title={runtimeModalGroup ? `Edit ${humanizeRuntimeKey(runtimeModalGroup)}` : "Edit Runtime Group"}
            subtitle="Update related settings together"
            open={Boolean(runtimeModalGroup)}
            onClose={() => setRuntimeModalGroup(null)}
            footer={(
              <>
                <button type="button" className="settings-toggle" onClick={() => setRuntimeModalGroup(null)}>
                  Done
                </button>
              </>
            )}
          >
            {runtimeModalGroup ? (
              <div className="settings-modal-grid">
                <div className="settings-runtime-group-edit-list">
                  {selectedRuntimeGroupRows.map((row) => (
                    <label key={row.key} className="settings-runtime-field">
                      <span>{row.label}</span>
                      <input
                        type="text"
                        value={runtimeDrafts[row.key] ?? row.value ?? ""}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setRuntimeDrafts((prev) => ({ ...prev, [row.key]: nextValue }));
                        }}
                      />
                    </label>
                  ))}
                </div>
                <p className="settings-note">
                  Group updates are staged as drafts and only persisted after clicking <strong>Save Runtime Drafts</strong> in the Runtime Settings section.
                </p>
              </div>
            ) : null}
          </SettingsModal>
        </div>
      ) : null}
    </main>
  );
}
