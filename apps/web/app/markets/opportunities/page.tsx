"use client";

import { Suspense, useState, useEffect } from "react";
import { Dashboard } from "../../../components/dashboard";
import { StocksDashboard } from "../../../components/stocks-dashboard";
import { ProtectedRoute } from "../../../components/protected-route";
import type { MarketType } from "../../../components/navigation/MarketFilter";

function OpportunitiesContent() {
  const [market, setMarket] = useState<MarketType>("CRYPTO");
  const [mounted, setMounted] = useState(false);

  // Load market preference from localStorage
  useEffect(() => {
    const stored = localStorage.getItem("strata-market-filter") as MarketType | null;
    if (stored && (stored === "CRYPTO" || stored === "STOCKS")) {
      setMarket(stored);
    }
    setMounted(true);
  }, []);

  // Listen for market changes from MarketFilter component
  useEffect(() => {
    if (!mounted) return;

    const handleMarketChange = (event: StorageEvent) => {
      if (event.key === "strata-market-filter" && event.newValue) {
        const newMarket = event.newValue as MarketType;
        if (newMarket === "CRYPTO" || newMarket === "STOCKS") {
          setMarket(newMarket);
        }
      }
    };

    window.addEventListener("storage", handleMarketChange);
    return () => window.removeEventListener("storage", handleMarketChange);
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
