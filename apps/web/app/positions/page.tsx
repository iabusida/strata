import { Suspense } from "react";
import { PositionManager } from "../../components/position-manager";

export default function PositionsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-center">Loading...</div>}>
      <PositionManager />
    </Suspense>
  );
}
