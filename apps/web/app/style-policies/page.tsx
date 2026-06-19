import { Suspense } from "react";
import { StylePolicyManager } from "../../components/style-policy-manager";

export default function StylePoliciesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-center">Loading...</div>}>
      <StylePolicyManager />
    </Suspense>
  );
}
