import { Suspense } from "react";
import MarketAnalysis from "../../components/market-analysis";
import { ProtectedRoute } from "../../components/protected-route";

export const metadata = {
  title: "Market Analysis - Hype Trading",
  description: "Detailed market analysis with charts, RSI, and MACD indicators"
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
