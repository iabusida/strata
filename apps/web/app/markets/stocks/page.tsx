"use client";

import { Suspense, useEffect } from "react";
import { StocksDashboard } from "../../../components/stocks-dashboard";
import { ProtectedRoute } from "../../../components/protected-route";

export default function StockMarketsPage() {
  useEffect(() => {
    // Set market filter to STOCKS
    localStorage.setItem("strata-market-filter", "STOCKS");
    // Dispatch storage event for other components to listen
    window.dispatchEvent(new StorageEvent("storage", {
      key: "strata-market-filter",
      newValue: "STOCKS"
    }));
  }, []);

  return (
    <ProtectedRoute>
      <Suspense fallback={null}>
        <StocksDashboard />
      </Suspense>
    </ProtectedRoute>
  );
}
