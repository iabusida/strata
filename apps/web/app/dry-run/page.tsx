import { redirect } from "next/navigation";

export default function DryRunPage() {
  redirect("/test-simulation?tab=dry-run");
}
