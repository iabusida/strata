"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Dashboard } from "./dashboard";
import { DryRunConsole } from "./dry-run-console";

type SimulationTab = "summary" | "dryRun";

export function SimulationHub() {
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") === "dry-run" ? "dryRun" : "summary";
  const [tab, setTab] = useState<SimulationTab>(initialTab);

  return (
    <div className="grid gap-3">
      <section className="rounded-strata border border-white/10 bg-[#0F172A] p-3 shadow-strata-card">
        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#0B1220] p-1 w-fit">
          <button
            type="button"
            onClick={() => setTab("summary")}
            className={`rounded-md px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.1em] ${tab === "summary" ? "bg-[#3EC6FF]/20 text-[#E6EDF3]" : "text-[#6B859E] hover:text-[#E6EDF3]"}`}
          >
            Summary
          </button>
          <button
            type="button"
            onClick={() => setTab("dryRun")}
            className={`rounded-md px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.1em] ${tab === "dryRun" ? "bg-[#3EC6FF]/20 text-[#E6EDF3]" : "text-[#6B859E] hover:text-[#E6EDF3]"}`}
          >
            Dry Run Queue
          </button>
        </div>
      </section>

      {tab === "summary" ? <Dashboard initialView="simulation" tradeMode="test" /> : null}
      {tab === "dryRun" ? <DryRunConsole /> : null}
    </div>
  );
}