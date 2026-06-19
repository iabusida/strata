"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

const API_BASE_ENV = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim();

function getApiBase(): string {
  if (API_BASE_ENV) {
    return API_BASE_ENV.replace(/\/+$/, "");
  }
  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "https" : "http";
    return `${protocol}://${window.location.hostname}:8787`;
  }
  return "http://localhost:8787";
}

export default function MomentumForecastsPage() {
  const [symbol, setSymbol] = useState("BTC");
  const [interval, setInterval] = useState("1h");
  const [assetType, setAssetType] = useState("CRYPTO");

  const apiBase = getApiBase();
  const forecastUrl = useMemo(() => {
    const normalizedSymbol = symbol.trim().toUpperCase() || "BTC";
    return `${apiBase}/api/v1/forecast/${encodeURIComponent(normalizedSymbol)}/${encodeURIComponent(interval)}?assetType=${encodeURIComponent(assetType)}`;
  }, [apiBase, assetType, interval, symbol]);

  return (
    <main className="shell">
      <section className="panel">
        <h2>Momentum Forecasts</h2>
        <p className="section-collapsed-note">
          Forecasts are generated from stored market candles, with no prediction-market dependency.
        </p>
        <div
          style={{
            display: "grid",
            gap: "0.75rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            alignItems: "end",
            marginBottom: "1rem"
          }}
        >
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span>Symbol</span>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="BTC"
              style={{
                border: "1px solid var(--border)",
                borderRadius: "0.375rem",
                padding: "0.5rem 0.625rem",
                background: "var(--panel)",
                color: "var(--text)"
              }}
            />
          </label>

          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span>Interval</span>
            <select
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              style={{
                border: "1px solid var(--border)",
                borderRadius: "0.375rem",
                padding: "0.5rem 0.625rem",
                background: "var(--panel)",
                color: "var(--text)"
              }}
            >
              <option value="5m">5m (scalp)</option>
              <option value="15m">15m (scalp)</option>
              <option value="30m">30m</option>
              <option value="1h">1h (day trade)</option>
              <option value="2h">2h</option>
              <option value="4h">4h (swing)</option>
              <option value="6h">6h</option>
              <option value="8h">8h</option>
              <option value="12h">12h</option>
              <option value="1d">1d</option>
              <option value="3d">3d</option>
              <option value="1w">1w (position)</option>
              <option value="2w">2w</option>
              <option value="1m">1m</option>
            </select>
          </label>

          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span>Asset Type</span>
            <select
              value={assetType}
              onChange={(e) => setAssetType(e.target.value)}
              style={{
                border: "1px solid var(--border)",
                borderRadius: "0.375rem",
                padding: "0.5rem 0.625rem",
                background: "var(--panel)",
                color: "var(--text)"
              }}
            >
              <option value="CRYPTO">CRYPTO</option>
              <option value="STOCK">STOCK</option>
            </select>
          </label>

          <button
            onClick={() => window.open(forecastUrl, "_blank", "noopener,noreferrer")}
            style={{
              border: "1px solid var(--hot)",
              borderRadius: "0.375rem",
              padding: "0.5rem 0.75rem",
              background: "var(--hot)",
              color: "white",
              cursor: "pointer"
            }}
          >
            Open Forecast JSON
          </button>
        </div>
        <p className="section-collapsed-note" style={{ wordBreak: "break-all" }}>
          Endpoint preview: {forecastUrl}
        </p>
        <div className="settings-grid">
          <a className="app-nav-link app-nav-link-active" href={`${apiBase}/api/v1/forecast/BTC/15m?assetType=CRYPTO`} target="_blank" rel="noreferrer">BTC 15m Forecast API</a>
          <a className="app-nav-link app-nav-link-active" href={`${apiBase}/api/v1/forecast/BTC/1h?assetType=CRYPTO`} target="_blank" rel="noreferrer">BTC 1h Forecast API</a>
          <a className="app-nav-link app-nav-link-active" href={`${apiBase}/api/v1/forecast/BTC/1w?assetType=CRYPTO`} target="_blank" rel="noreferrer">BTC 1w Forecast API</a>
          <Link className="app-nav-link app-nav-link-active" href="/pre-pump/crypto">Crypto Pre-Pump</Link>
        </div>
      </section>
    </main>
  );
}
