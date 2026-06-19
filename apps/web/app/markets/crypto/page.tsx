"use client";

import { Suspense } from "react";
import { Dashboard } from "../../../components/dashboard";
import { ProtectedRoute } from "../../../components/protected-route";

export default function CryptoMarketsPage() {
  return (
    <ProtectedRoute>
      <Suspense fallback={null}>
        <Dashboard />
      </Suspense>
    </ProtectedRoute>
  );
}
