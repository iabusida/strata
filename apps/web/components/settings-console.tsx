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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787";

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
            <p className="brand-subtitle">Human-readable control center for access, strategy, and runtime keys</p>
          </div>
        </div>
      </section>

      {loading ? <p className="section-collapsed-note">Loading settings…</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {!loading && !error ? (
        <div className="settings-page-grid">
          <section className="panel settings-card">
            <h2>Access & Plan</h2>
            <p className="settings-note">Control license mode, plan, and account status. These values shape feature access and limits.</p>

            <div className="settings-grid">
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
            </div>

            {access ? (
              <p className="settings-source">
                Source {access.source} · Subscribed {access.isSubscribed ? "yes" : "no"} · Limits scan {access.limits.maxScanTokens}, active trades {access.limits.maxActiveTrades}
              </p>
            ) : null}

            <div className="settings-page-actions">
              <button type="button" className="settings-toggle" disabled={accessSaving || !accessDraft} onClick={() => void saveAccessSettings()}>
                {accessSaving ? "Saving…" : "Save Access"}
              </button>
            </div>
            {accessFeedback ? <p className={`settings-feedback ${accessFeedback.ok ? "ok" : "err"}`}>{accessFeedback.msg}</p> : null}
          </section>

          <section className="panel settings-card">
            <h2>Trading Strategy</h2>
            <p className="settings-note">Switch between Day and Swing modes. Core TP/SL defaults are shown for quick sanity checks.</p>

            <div className="settings-grid">
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
            </div>

            <div className="settings-page-actions">
              <button type="button" className="settings-toggle" disabled={strategySaving} onClick={() => void saveTradingMode()}>
                {strategySaving ? "Applying…" : "Apply Trading Mode"}
              </button>
            </div>
            {strategyFeedback ? <p className={`settings-feedback ${strategyFeedback.ok ? "ok" : "err"}`}>{strategyFeedback.msg}</p> : null}
          </section>

          <section className="panel settings-card settings-runtime-card">
            <h2>Runtime Settings</h2>
            <p className="settings-note">Source-of-truth DB keys used at startup. Search and edit values with readable labels.</p>
            <p className={`settings-feedback ${missingRequiredRuntimeKeys.length === 0 ? "ok" : "err"}`}>
              Required keys {requiredRuntimeKeys.length} · Missing {missingRequiredRuntimeKeys.length}
              {missingRequiredRuntimeKeys.length > 0 ? ` (${missingRequiredRuntimeKeys.join(", ")})` : ""}
            </p>

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

            <div className="settings-runtime-groups">
              {groupedRuntimeRows.map(([group, rows]) => (
                <section key={group} className="settings-runtime-group">
                  <h3>{humanizeRuntimeKey(group)}</h3>
                  <div className="settings-runtime-grid">
                    {rows.map((row) => (
                      <label key={row.key} className="settings-runtime-field">
                        <span>{humanizeRuntimeKey(row.key)}</span>
                        <small>{row.key}</small>
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
                </section>
              ))}
            </div>

            <div className="settings-page-actions">
              <button
                type="button"
                className="settings-toggle"
                disabled={runtimeSaving || missingRequiredRuntimeKeys.length > 0}
                onClick={() => void saveRuntimeSettings()}
              >
                {runtimeSaving ? "Saving…" : "Save Runtime Settings"}
              </button>
            </div>
            {runtimeFeedback ? <p className={`settings-feedback ${runtimeFeedback.ok ? "ok" : "err"}`}>{runtimeFeedback.msg}</p> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
