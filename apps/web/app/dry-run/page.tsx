import { redirect } from "next/navigation";

export default function DryRunPage() {
  redirect("/saas-dashboard?tab=dry-run");
}
