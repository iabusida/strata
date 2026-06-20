"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { getForecastInterpretation } from "../../../components/system/profile-decision";

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forecast, setForecast] = useState<ForecastApiResponse | null>(null);

  const apiBase = getApiBase();
  const forecastUrl = useMemo(() => {
    const normalizedSymbol = symbol.trim().toUpperCase() || "BTC";
    return `${apiBase}/api/v1/forecast/${encodeURIComponent(normalizedSymbol)}/${encodeURIComponent(interval)}?assetType=${encodeURIComponent(assetType)}`;
  }, [apiBase, assetType, interval, symbol]);

  const loadForecast = async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(forecastUrl, { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as ForecastApiResponse;

      if (!response.ok) {
        setForecast(null);
        setError(payload.details ?? payload.error ?? "Failed to load forecast.");
        return;
      }

      setForecast(payload);
    } catch (requestError) {
      setForecast(null);
      setError(requestError instanceof Error ? requestError.message : "Failed to load forecast.");
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void loadForecast();
  };

  return (
    <main className="shell">
      <section className="panel">
        <h2>Momentum Forecasts</h2>
        <p className="section-collapsed-note">
          Forecasts are generated from stored market candles, with no prediction-market dependency.
        </p>
        <form
          onSubmit={onSubmit}
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
            type="submit"
            disabled={loading}
            style={{
              border: "1px solid var(--hot)",
              borderRadius: "0.375rem",
              padding: "0.5rem 0.75rem",
              background: loading ? "#64748b" : "var(--hot)",
              color: "white",
              cursor: loading ? "not-allowed" : "pointer"
            }}
          >
            {loading ? "Loading..." : "Load Forecast"}
          </button>
        </form>

        {error ? (
          <div className="rounded-lg border border-[#EF4444]/40 bg-[#EF4444]/10 p-3 text-sm text-[#FCA5A5]" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        ) : null}

        {forecast ? (
          <div style={{ display: "grid", gap: "0.75rem", marginBottom: "1rem" }}>
            <div
              style={{
                display: "grid",
                gap: "0.75rem",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))"
              }}
            >
              <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
                <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Symbol</p>
                <p className="mt-1 text-sm font-semibold">{forecast.symbol}</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
                <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Bias</p>
                <p className="mt-1 text-sm font-semibold">{forecast.forecast.directionBias}</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
                <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Momentum Score</p>
                <p className="mt-1 text-sm font-semibold">{forecast.forecast.momentumScore}</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
                <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Latest Price</p>
                <p className="mt-1 text-sm font-semibold">{forecast.latestPrice.toFixed(6)} ({forecast.latestPriceSource})</p>
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]" style={{ marginBottom: "0.5rem" }}>Probabilities</p>
              <div
                style={{
                  display: "grid",
                  gap: "0.75rem",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))"
                }}
              >
                <div>
                  <p className="text-xs text-[#9FB3C8]">Up</p>
                  <p className="text-sm font-semibold">{forecast.forecast.probabilitiesPct.up}%</p>
                </div>
                <div>
                  <p className="text-xs text-[#9FB3C8]">Down</p>
                  <p className="text-sm font-semibold">{forecast.forecast.probabilitiesPct.down}%</p>
                </div>
                <div>
                  <p className="text-xs text-[#9FB3C8]">Sideways</p>
                  <p className="text-sm font-semibold">{forecast.forecast.probabilitiesPct.sideways}%</p>
                </div>
              </div>
            </div>

            {(() => {
              const interpretation = getForecastInterpretation(
                forecast.forecast.probabilitiesPct.up,
                forecast.forecast.probabilitiesPct.down,
              );
              const toneClass = interpretation.tone === "green"
                ? "border-[#22C55E]/35 bg-[#0F2E25]/45"
                : interpretation.tone === "red"
                  ? "border-[#EF4444]/35 bg-[#3F1218]/40"
                  : "border-[#F59E0B]/35 bg-[#3A2A0E]/45";
              return (
                <div className={`rounded-lg border p-3 ${toneClass}`}>
                  <p className="text-xs uppercase tracking-[0.1em] text-[#AFC2D7]" style={{ marginBottom: "0.4rem" }}>What To Do With This</p>
                  <p className="text-sm font-semibold text-[#E6EDF3]">👉 Interpretation: {interpretation.interpretation}</p>
                  <p className="mt-1 text-sm font-semibold text-[#E6EDF3]">👉 Strategy: {interpretation.strategy}</p>
                </div>
              );
            })()}

            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]" style={{ marginBottom: "0.5rem" }}>Run Details</p>
              <p className="text-sm text-[#E6EDF3]">Requested {forecast.intervalRequested} {"->"} Using {forecast.intervalUsed} ({forecast.baseIntervalUsed} x{forecast.aggregationBucketSize})</p>
              <p className="text-sm text-[#E6EDF3]">Trader Profile: {forecast.traderProfile} | Candles Used: {forecast.candlesUsed}</p>
              <p className="text-sm text-[#E6EDF3]">Latest Price As Of: {new Date(forecast.latestPriceAsOf).toLocaleString()}</p>
            </div>

            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]" style={{ marginBottom: "0.5rem" }}>Notes</p>
              <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                {(forecast.notes ?? []).map((note) => (
                  <li key={note} className="text-sm text-[#E6EDF3]" style={{ marginBottom: "0.25rem" }}>
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        <div className="settings-grid">
          <button className="app-nav-link app-nav-link-active" type="button" onClick={() => { setSymbol("BTC"); setInterval("15m"); setAssetType("CRYPTO"); }}>
            BTC 15m Preset
          </button>
          <button className="app-nav-link app-nav-link-active" type="button" onClick={() => { setSymbol("BTC"); setInterval("1h"); setAssetType("CRYPTO"); }}>
            BTC 1h Preset
          </button>
          <button className="app-nav-link app-nav-link-active" type="button" onClick={() => { setSymbol("BTC"); setInterval("1w"); setAssetType("CRYPTO"); }}>
            BTC 1w Preset
          </button>
          <Link className="app-nav-link app-nav-link-active" href="/pre-pump/crypto">Pre-Pump Crypto</Link>
          <Link className="app-nav-link app-nav-link-active" href="/pre-pump/stocks">Pre-Pump Stocks</Link>
        </div>
      </section>
    </main>
  );
}

type ForecastApiResponse = {
  error?: string;
  details?: string;
  symbol: string;
  intervalRequested: string;
  intervalUsed: string;
  baseIntervalUsed: string;
  aggregationBucketSize: number;
  traderProfile: string;
  candlesUsed: number;
  latestPrice: number;
  latestPriceSource: string;
  latestPriceAsOf: string;
  notes: string[];
  forecast: {
    directionBias: string;
    momentumScore: number;
    probabilitiesPct: {
      up: number;
      down: number;
      sideways: number;
    };
  };
};
