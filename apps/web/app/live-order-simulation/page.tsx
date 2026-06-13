import { Suspense } from "react";
import { Dashboard } from "../../components/dashboard";

export default function LiveOrderSimulationPage() {
  return (
    <Suspense fallback={null}>
      <Dashboard initialView="simulation" />
    </Suspense>
  );
}
