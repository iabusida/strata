"use client";

import { Suspense } from "react";
import { StocksDashboard } from "../../../components/stocks-dashboard";
import { ProtectedRoute } from "../../../components/protected-route";

export default function StockMarketsPage() {
  return (
    <ProtectedRoute>
      <Suspense fallback={null}>
        <StocksDashboard />
      </Suspense>
    </ProtectedRoute>
  );
}
