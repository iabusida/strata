import { Suspense } from "react";
import { SimulationHub } from "../../components/simulation-hub";

export default function SimulationPage() {
  return (
    <Suspense fallback={<div className="p-6 text-center">Loading...</div>}>
      <SimulationHub />
    </Suspense>
  );
}
