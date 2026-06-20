"use client";

import { useEffect, useState } from "react";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787").replace(/\/+$/, "");

interface StylePolicy {
  id: string;
  userId: string;
  tradingStyle: string;
  allowedAssetTypes: string[];
  allowedIntervals: string[];
  refreshSeconds: number;
  maxUniverseSize: number;
}

interface StylePolicyForm {
  tradingStyle: string;
  allowedAssetTypes: string[];
  allowedIntervals: string[];
  refreshSeconds: number;
  maxUniverseSize: number;
}

export function StylePolicyManager() {
  const apiKey = "hype_2af395558e9da85cc594370c4743b879984c60e2a1b1940c";
  const userId = "cmqirji9y0003kjh35048yuur";
  const baseUrl = `${API_BASE}/api/v1`;

  const [policies, setPolicies] = useState<StylePolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<StylePolicyForm>({
    tradingStyle: "DAY_TRADING",
    allowedAssetTypes: ["CRYPTO"],
    allowedIntervals: ["M15", "H1"],
    refreshSeconds: 30,
    maxUniverseSize: 50,
  });
  const [showForm, setShowForm] = useState(false);

  const assetTypeOptions = ["CRYPTO", "STOCK", "FUTURE", "OPTION"];
  const intervalOptions = ["M15", "H1", "H4", "H12", "D1"];
  const styleOptions = ["DAY_TRADING", "SWING", "LONG_TERM", "SPOT_SHORT"];

  useEffect(() => {
    fetchPolicies();
  }, []);

  async function fetchPolicies() {
    try {
      setLoading(true);
      const res = await fetch(`${baseUrl}/data/style-policy/${userId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json();
      if (data.success) {
        setPolicies(data.policies || []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch policies");
    } finally {
      setLoading(false);
    }
  }

  async function handleSavePolicy() {
    try {
      const res = await fetch(
        `${baseUrl}/data/style-policy/${userId}/${formData.tradingStyle}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            allowedAssetTypes: formData.allowedAssetTypes,
            allowedIntervals: formData.allowedIntervals,
            refreshSeconds: formData.refreshSeconds,
            maxUniverseSize: formData.maxUniverseSize,
          }),
        }
      );

      const data = await res.json();
      if (data.success) {
        await fetchPolicies();
        setShowForm(false);
        setError(null);
      } else {
        setError(data.error || "Failed to save policy");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save policy");
    }
  }

  const handleAssetTypeChange = (type: string) => {
    setFormData((prev) => ({
      ...prev,
      allowedAssetTypes: prev.allowedAssetTypes.includes(type)
        ? prev.allowedAssetTypes.filter((t) => t !== type)
        : [...prev.allowedAssetTypes, type],
    }));
  };

  const handleIntervalChange = (interval: string) => {
    setFormData((prev) => ({
      ...prev,
      allowedIntervals: prev.allowedIntervals.includes(interval)
        ? prev.allowedIntervals.filter((i) => i !== interval)
        : [...prev.allowedIntervals, interval],
    }));
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <h1 className="text-3xl font-bold text-gray-900">Style Policies</h1>
          <p className="text-gray-600 text-sm mt-1">
            Configure asset types and intervals for each trading style
          </p>
        </div>
      </header>

      {error && (
        <div className="max-w-7xl mx-auto px-6 py-4 mt-6 bg-red-50 border border-red-200 rounded text-red-700">
          {error}
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Policies Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          {policies.map((policy) => (
            <div key={policy.id} className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-bold mb-4">{policy.tradingStyle}</h3>
              <div className="space-y-3 text-sm">
                <div>
                  <p className="text-gray-600 mb-1">Asset Types:</p>
                  <div className="flex flex-wrap gap-2">
                    {policy.allowedAssetTypes.map((type) => (
                      <span
                        key={type}
                        className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs"
                      >
                        {type}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-gray-600 mb-1">Intervals:</p>
                  <div className="flex flex-wrap gap-2">
                    {policy.allowedIntervals.map((interval) => (
                      <span
                        key={interval}
                        className="px-2 py-1 bg-green-100 text-green-800 rounded text-xs"
                      >
                        {interval}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-gray-600">
                    Refresh: {policy.refreshSeconds}s | Universe: {policy.maxUniverseSize}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setFormData({
                    tradingStyle: policy.tradingStyle,
                    allowedAssetTypes: policy.allowedAssetTypes,
                    allowedIntervals: policy.allowedIntervals,
                    refreshSeconds: policy.refreshSeconds,
                    maxUniverseSize: policy.maxUniverseSize,
                  });
                  setShowForm(true);
                }}
                className="mt-4 w-full px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
              >
                Edit
              </button>
            </div>
          ))}
        </div>

        {/* Form Modal */}
        {showForm && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
            <div className="bg-white rounded-lg shadow-lg p-8 max-w-2xl w-full mx-4">
              <h2 className="text-2xl font-bold mb-6">{formData.tradingStyle}</h2>

              <div className="space-y-6">
                {/* Asset Types */}
                <div>
                  <label className="block text-sm font-medium mb-3">Asset Types</label>
                  <div className="grid grid-cols-2 gap-3">
                    {assetTypeOptions.map((type) => (
                      <label key={type} className="flex items-center">
                        <input
                          type="checkbox"
                          checked={formData.allowedAssetTypes.includes(type)}
                          onChange={() => handleAssetTypeChange(type)}
                          className="mr-2"
                        />
                        <span className="text-sm">{type}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Intervals */}
                <div>
                  <label className="block text-sm font-medium mb-3">Intervals</label>
                  <div className="grid grid-cols-3 gap-3">
                    {intervalOptions.map((interval) => (
                      <label key={interval} className="flex items-center">
                        <input
                          type="checkbox"
                          checked={formData.allowedIntervals.includes(interval)}
                          onChange={() => handleIntervalChange(interval)}
                          className="mr-2"
                        />
                        <span className="text-sm">{interval}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Refresh Seconds */}
                <div>
                  <label className="block text-sm font-medium mb-2">Refresh Interval (seconds)</label>
                  <input
                    type="number"
                    min="10"
                    max="600"
                    value={formData.refreshSeconds}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        refreshSeconds: parseInt(e.target.value),
                      }))
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded"
                  />
                </div>

                {/* Max Universe Size */}
                <div>
                  <label className="block text-sm font-medium mb-2">Max Universe Size</label>
                  <input
                    type="number"
                    min="1"
                    max="500"
                    value={formData.maxUniverseSize}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        maxUniverseSize: parseInt(e.target.value),
                      }))
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded"
                  />
                </div>
              </div>

              <div className="flex gap-3 mt-8">
                <button
                  onClick={handleSavePolicy}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  Save Policy
                </button>
                <button
                  onClick={() => setShowForm(false)}
                  className="flex-1 px-4 py-2 bg-gray-300 text-gray-800 rounded hover:bg-gray-400"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
