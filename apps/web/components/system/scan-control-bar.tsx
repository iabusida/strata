type ScanControlBarProps = {
  market: "CRYPTO" | "STOCKS";
  timeframe: "15M" | "1H" | "4H" | "1D";
  lastUpdated: string | null;
  status: "Idle" | "Scanning" | "Error";
  isRunning: boolean;
  onRunScan: () => void;
  onMarketChange: (market: "CRYPTO" | "STOCKS") => void;
  onTimeframeChange: (timeframe: "15M" | "1H" | "4H" | "1D") => void;
};

export function ScanControlBar({
  market,
  timeframe,
  lastUpdated,
  status,
  isRunning,
  onRunScan,
  onMarketChange,
  onTimeframeChange,
}: ScanControlBarProps) {
  const statusClass = status === "Scanning"
    ? "text-[#3EC6FF]"
    : status === "Error"
      ? "text-[#EF4444]"
      : "text-[#9FB3C8]";

  return (
    <section className="rounded-strata border border-white/10 bg-[#0F172A] p-4 shadow-strata-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isRunning}
            onClick={onRunScan}
            className="rounded-lg bg-gradient-to-r from-[#2F7BFF] to-[#3EC6FF] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[#2F7BFF]/30 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRunning ? "Scanning..." : "Run Scan"}
          </button>
          <span className={`text-xs font-semibold uppercase tracking-[0.12em] ${statusClass}`}>Status: {status}</span>
          <span className="text-xs text-[#6B859E]">Last updated: {lastUpdated ?? "--"}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="rounded-lg border border-white/10 bg-[#0B1220] p-1">
            {(["CRYPTO", "STOCKS"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => onMarketChange(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium tracking-[0.08em] ${market === value ? "bg-[#2F7BFF]/20 text-[#E6EDF3]" : "text-[#9FB3C8] hover:text-[#E6EDF3]"}`}
              >
                {value}
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-white/10 bg-[#0B1220] p-1">
            {(["15M", "1H", "4H", "1D"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => onTimeframeChange(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium tracking-[0.08em] ${timeframe === value ? "bg-[#3EC6FF]/20 text-[#E6EDF3]" : "text-[#9FB3C8] hover:text-[#E6EDF3]"}`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
