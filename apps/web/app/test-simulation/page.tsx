import { Suspense } from "react";
import { Dashboard } from "../../components/dashboard";

export default function TestSimulationPage() {
  return (
    <Suspense fallback={null}>
      <Dashboard initialView="simulation" tradeMode="test" />
    </Suspense>
  );
}
