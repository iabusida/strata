"use client";

import { Suspense, useEffect } from "react";
import { Dashboard } from "../../../components/dashboard";
import { ProtectedRoute } from "../../../components/protected-route";

export default function CryptoMarketsPage() {
  useEffect(() => {
    // Set market filter to CRYPTO
    localStorage.setItem("strata-market-filter", "CRYPTO");
    // Dispatch storage event for other components to listen
    window.dispatchEvent(new StorageEvent("storage", {
      key: "strata-market-filter",
      newValue: "CRYPTO"
    }));
  }, []);

  return (
    <ProtectedRoute allowGuestPreview>
      <Suspense fallback={null}>
        <Dashboard />
      </Suspense>
    </ProtectedRoute>
  );
}
