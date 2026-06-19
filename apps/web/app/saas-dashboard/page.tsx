import { Suspense } from "react";
import { SaaSDashboard } from "../../components/saas-dashboard";

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="p-6 text-center">Loading...</div>}>
      <SaaSDashboard />
    </Suspense>
  );
}
