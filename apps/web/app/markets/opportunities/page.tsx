"use client";

import { Suspense, useState, useEffect } from "react";
import { Dashboard } from "../../../components/dashboard";
import { StocksDashboard } from "../../../components/stocks-dashboard";
import { ProtectedRoute } from "../../../components/protected-route";
import { MARKET_FILTER_EVENT, MARKET_FILTER_STORAGE_KEY, type MarketType } from "../../../components/navigation/MarketFilter";

function OpportunitiesContent() {
  const [market, setMarket] = useState<MarketType>("CRYPTO");
  const [mounted, setMounted] = useState(false);

  // Load market preference from localStorage
  useEffect(() => {
    const stored = localStorage.getItem(MARKET_FILTER_STORAGE_KEY) as MarketType | null;
    if (stored && (stored === "CRYPTO" || stored === "STOCKS")) {
      setMarket(stored);
    }
    setMounted(true);
  }, []);

  // Listen for market changes from MarketFilter component
  useEffect(() => {
    if (!mounted) return;

    const applyMarket = (value: string | null) => {
      if (!value) return;
      const newMarket = value as MarketType;
      if (newMarket === "CRYPTO" || newMarket === "STOCKS") {
        setMarket(newMarket);
      }
    };

    const handleMarketStorageChange = (event: StorageEvent) => {
      if (event.key === MARKET_FILTER_STORAGE_KEY && event.newValue) {
        const newMarket = event.newValue as MarketType;
        if (newMarket === "CRYPTO" || newMarket === "STOCKS") {
          setMarket(newMarket);
        }
      }
    };

    const handleMarketCustomChange = (event: Event) => {
      const customEvent = event as CustomEvent<MarketType>;
      applyMarket(customEvent.detail ?? null);
    };

    window.addEventListener("storage", handleMarketStorageChange);
    window.addEventListener(MARKET_FILTER_EVENT, handleMarketCustomChange as EventListener);
    return () => {
      window.removeEventListener("storage", handleMarketStorageChange);
      window.removeEventListener(MARKET_FILTER_EVENT, handleMarketCustomChange as EventListener);
    };
  }, [mounted]);

  if (!mounted) {
    return <div className="p-8 text-center text-[#6B859E]">Loading opportunities...</div>;
  }

  return market === "CRYPTO" ? <Dashboard /> : <StocksDashboard />;
}

export default function OpportunitiesPage() {
  return (
    <ProtectedRoute>
      <Suspense fallback={<div className="p-8 text-center text-[#6B859E]">Loading opportunities...</div>}>
        <OpportunitiesContent />
      </Suspense>
    </ProtectedRoute>
  );
}
