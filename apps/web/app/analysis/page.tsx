import { Suspense } from "react";
import MarketAnalysis from "../../components/market-analysis";
import { ProtectedRoute } from "../../components/protected-route";

export const metadata = {
  title: "Market Analysis - Strata",
  description: "Detailed market analysis with charts and signal context for crypto and stocks"
};

export default function MarketAnalysisPage() {
  return (
    <ProtectedRoute>
      <Suspense fallback={<div className="p-6 text-center">Loading market analysis...</div>}>
        <MarketAnalysis />
      </Suspense>
    </ProtectedRoute>
  );
}
