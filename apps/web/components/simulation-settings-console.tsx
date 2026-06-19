"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../contexts/auth-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787";

type SimulationProfile = {
  id?: string;
  userId?: string;
  initialBalanceUsd: number;
  riskPerTradePct: number;
  leverage: number;
  maxOpenTrades: number;
};

const DEFAULT_PROFILE: SimulationProfile = {
  initialBalanceUsd: 10000,
  riskPerTradePct: 1.5,
  leverage: 5,
  maxOpenTrades: 8
};

export function SimulationSettingsConsole() {
  const { token } = useAuth();
  const [profile, setProfile] = useState<SimulationProfile>(DEFAULT_PROFILE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Load profile from server on mount
  useEffect(() => {
    if (!token) return;

    async function loadProfile() {
      try {
        setLoading(true);
        const response = await fetch(`${API_BASE}/api/v1/user/simulation`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (response.ok) {
          const data = (await response.json()) as SimulationProfile;
          setProfile(data);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load profile");
      } finally {
        setLoading(false);
      }
    }

    loadProfile();
  }, [token]);

  const estimatedRiskUsd = useMemo(() => {
    return (profile.initialBalanceUsd * profile.riskPerTradePct) / 100;
  }, [profile]);

  async function saveProfile(): Promise<void> {
    if (!token) {
      setError("Not authenticated");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`${API_BASE}/api/v1/user/simulation`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(profile)
      });

      if (!response.ok) {
        throw new Error("Failed to save profile");
      }

      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell">
      <section className="panel">
        <h2>Simulation Balance Config</h2>
        <p className="section-collapsed-note">
          Configure your per-user simulation capital and risk settings. Changes are saved to your profile.
        </p>

        {error && (
          <div className="settings-error" style={{ marginBottom: "1rem", padding: "0.75rem", backgroundColor: "rgba(239, 68, 68, 0.1)", borderLeft: "3px solid #ef4444", color: "#fca5a5" }}>
            {error}
          </div>
        )}

        <div className="settings-grid">
          <div className="settings-field">
            <label htmlFor="sim-balance">Initial Balance (USD)</label>
            <input
              id="sim-balance"
              type="number"
              min={100}
              disabled={loading}
              value={profile.initialBalanceUsd}
              onChange={(e) => setProfile((prev) => ({ ...prev, initialBalanceUsd: Number(e.target.value) }))}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="sim-risk">Risk Per Trade (%)</label>
            <input
              id="sim-risk"
              type="number"
              step="0.1"
              min={0.1}
              disabled={loading}
              value={profile.riskPerTradePct}
              onChange={(e) => setProfile((prev) => ({ ...prev, riskPerTradePct: Number(e.target.value) }))}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="sim-lev">Leverage</label>
            <input
              id="sim-lev"
              type="number"
              min={1}
              disabled={loading}
              value={profile.leverage}
              onChange={(e) => setProfile((prev) => ({ ...prev, leverage: Number(e.target.value) }))}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="sim-max-trades">Max Open Trades</label>
            <input
              id="sim-max-trades"
              type="number"
              min={1}
              disabled={loading}
              value={profile.maxOpenTrades}
              onChange={(e) => setProfile((prev) => ({ ...prev, maxOpenTrades: Number(e.target.value) }))}
            />
          </div>
        </div>

        <div className="settings-actions" style={{ marginTop: "0.8rem" }}>
          <button type="button" className="settings-toggle" onClick={saveProfile} disabled={loading}>
            {loading ? "Saving..." : "Save Configuration"}
          </button>
        </div>

        <p className="section-collapsed-note">
          Risk per trade: ${estimatedRiskUsd.toFixed(2)} • Last saved: {savedAt ? new Date(savedAt).toLocaleString() : "not saved yet"}
        </p>
      </section>
    </main>
  );
}
