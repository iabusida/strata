import { Suspense } from "react";
import { SimulationHub } from "../../components/simulation-hub";

export default function TestSimulationPage() {
  return (
    <Suspense fallback={null}>
      <SimulationHub />
    </Suspense>
  );
}
