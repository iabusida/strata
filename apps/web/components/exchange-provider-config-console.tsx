"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../contexts/auth-context";

type ExchangeCredentials = Record<string, Record<string, string>>;

type PlatformConfig = {
  id: string;
  exchangeCredentials: ExchangeCredentials;
  updatedAt: string;
};

type ExchangeType = "BITUNIX" | "OKX" | "HYPERLIQUID" | "COINBASE" | "SCHWAB";

const EXCHANGE_LABELS: Record<ExchangeType, { name: string; requiredFields: string[] }> = {
  BITUNIX: {
    name: "Bitunix",
    requiredFields: ["apiKey", "secretKey", "passphrase"]
  },
  OKX: {
    name: "OKX",
    requiredFields: ["apiKey", "secretKey", "passphrase"]
  },
  HYPERLIQUID: {
    name: "Hyperliquid",
    requiredFields: ["privateKey"]
  },
  COINBASE: {
    name: "Coinbase",
    requiredFields: ["apiKey", "secretKey"]
  },
  SCHWAB: {
    name: "Schwab",
    requiredFields: ["consumerKey", "consumerSecret", "accessToken"]
  }
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787";

export function ExchangeProviderConfigConsole() {
  const { token } = useAuth();
  const [config, setConfig] = useState<PlatformConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingExchange, setEditingExchange] = useState<ExchangeType | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    async function loadConfig(): Promise<void> {
      try {
        const response = await fetch(`${API_BASE}/api/v1/config/platform`, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) {
          if (response.status === 404) {
            setConfig({ id: "new", exchangeCredentials: {}, updatedAt: new Date().toISOString() });
          } else {
            throw new Error(`Failed to load config (${response.status})`);
          }
          return;
        }
        const payload = (await response.json()) as PlatformConfig;
        if (!cancelled) {
          setConfig(payload);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, [token]);

  function startEdit(exchange: ExchangeType): void {
    const existing = config?.exchangeCredentials?.[exchange.toLowerCase()] ?? {};
    setEditingExchange(exchange);
    setCredentials(existing);
  }

  function cancelEdit(): void {
    setEditingExchange(null);
    setCredentials({});
  }

  async function saveExchange(): Promise<void> {
    if (!editingExchange || !config) return;

    setSaving(true);
    setError(null);

    try {
      const updated: ExchangeCredentials = {
        ...config.exchangeCredentials,
        [editingExchange.toLowerCase()]: credentials
      };

      const response = await fetch(`${API_BASE}/api/v1/config/platform`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ exchangeCredentials: updated })
      });

      if (!response.ok) {
        throw new Error(`Failed to save config (${response.status})`);
      }

      const payload = (await response.json()) as PlatformConfig;
      setConfig(payload);
      setEditingExchange(null);
      setCredentials({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!token) {
    return (
      <main className="shell">
        <section className="panel">
          <h2>Exchange Provider Configuration</h2>
          <p className="section-collapsed-note" style={{ color: "var(--cold)" }}>
            Authentication required. Please sign in to configure exchange credentials.
          </p>
        </section>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="shell">
        <section className="panel">
          <h2>Exchange Provider Configuration</h2>
          <p className="section-collapsed-note">Loading...</p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel">
        <h2>Exchange API Keys & Credentials</h2>
        <p className="section-collapsed-note">
          Store exchange credentials in the database (encrypted at rest in production). Each exchange can be configured independently.
          Keys are NOT sent to the client—only the server uses them.
        </p>

        {error ? <p className="error">{error}</p> : null}

        <div className="settings-grid" style={{ marginTop: "1.2rem" }}>
          {(Object.keys(EXCHANGE_LABELS) as ExchangeType[]).map((exchangeType) => {
            const label = EXCHANGE_LABELS[exchangeType];
            const lowerKey = exchangeType.toLowerCase();
            const isConfigured = !!(config?.exchangeCredentials?.[lowerKey] && Object.keys(config.exchangeCredentials[lowerKey]).length > 0);
            const isEditing = editingExchange === exchangeType;

            return (
              <div key={exchangeType} className="panel" style={{ padding: "1rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                  <h3 style={{ margin: "0 0 0.4rem 0", fontSize: "0.95rem" }}>{label.name}</h3>
                  <span style={{ fontSize: "0.75rem", color: isConfigured ? "#6ee7f3" : "#9eb5c9" }}>
                    {isConfigured ? "✓ Configured" : "○ Not configured"}
                  </span>
                </div>

                {isEditing ? (
                  <div style={{ marginTop: "0.6rem" }}>
                    {label.requiredFields.map((field) => (
                      <div key={field} className="settings-field" style={{ marginBottom: "0.5rem" }}>
                        <label htmlFor={`cred-${field}`} style={{ fontSize: "0.8rem" }}>
                          {field}
                        </label>
                        <input
                          id={`cred-${field}`}
                          type={field.toLowerCase().includes("key") || field.toLowerCase().includes("secret") || field.toLowerCase().includes("token") ? "password" : "text"}
                          value={credentials[field] ?? ""}
                          onChange={(e) => setCredentials((prev) => ({ ...prev, [field]: e.target.value }))}
                          placeholder={`Enter ${field}`}
                          style={{ fontSize: "0.85rem", padding: "0.35rem 0.4rem" }}
                        />
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.6rem" }}>
                      <button
                        type="button"
                        className="settings-toggle"
                        onClick={() => void saveExchange()}
                        disabled={saving}
                        style={{ flex: 1, fontSize: "0.8rem" }}
                      >
                        {saving ? "Saving..." : "Save"}
                      </button>
                      <button
                        type="button"
                        className="settings-toggle"
                        onClick={cancelEdit}
                        disabled={saving}
                        style={{ flex: 1, fontSize: "0.8rem", opacity: 0.6 }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="settings-toggle"
                    onClick={() => startEdit(exchangeType)}
                    style={{ width: "100%", fontSize: "0.8rem" }}
                  >
                    {isConfigured ? "Update" : "Configure"}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <p className="section-collapsed-note" style={{ marginTop: "1.2rem" }}>
          <strong>Security note:</strong> Credentials are encrypted at rest in the database. In production, use envelope encryption and HSM-backed key management. Never log or transmit credentials over unencrypted channels.
        </p>
      </section>
    </main>
  );
}
