type ScanControlBarProps = {
  market: "CRYPTO" | "STOCKS";
  timeframe: "15M" | "1H" | "4H" | "1D";
  tokenQuery: string;
  sortBy: "marketCap" | "score" | "volume24h" | "price";
  sortDirection: "asc" | "desc";
  lastUpdated: string | null;
  status: "Idle" | "Scanning" | "Error";
  helperText?: string;
  onMarketChange: (market: "CRYPTO" | "STOCKS") => void;
  onTimeframeChange: (timeframe: "15M" | "1H" | "4H" | "1D") => void;
  onTokenQueryChange: (value: string) => void;
  onSortByChange: (value: "marketCap" | "score" | "volume24h" | "price") => void;
  onSortDirectionChange: (value: "asc" | "desc") => void;
};

export function ScanControlBar({
  market,
  timeframe,
  tokenQuery,
  sortBy,
  sortDirection,
  lastUpdated,
  status,
  helperText = "Filter and sort the current market view.",
  onMarketChange,
  onTimeframeChange,
  onTokenQueryChange,
  onSortByChange,
  onSortDirectionChange,
}: ScanControlBarProps) {
  const statusClass = status === "Scanning"
    ? "text-[#3EC6FF]"
    : status === "Error"
      ? "text-[#EF4444]"
      : "text-[#9FB3C8]";

  return (
    <section className="rounded-strata border border-white/10 bg-[#0F172A] p-4 shadow-strata-card">
      <div className="flex flex-wrap items-center gap-3">
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
        </div>

        <div className="flex flex-wrap items-center gap-2">
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

        <span className={`text-xs font-semibold uppercase tracking-[0.12em] ${statusClass}`}>Status: {status}</span>
        <span className="text-xs text-[#6B859E]">Last updated: {lastUpdated ?? "--"}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3">
        <div className="flex min-w-[260px] flex-1 flex-wrap items-center gap-2">
          <input
            type="text"
            value={tokenQuery}
            onChange={(event) => onTokenQueryChange(event.target.value)}
            placeholder="Filter token or symbol"
            className="min-w-[220px] flex-1 rounded-lg border border-white/10 bg-[#0B1220] px-3 py-2 text-sm text-[#E6EDF3] outline-none placeholder:text-[#6B859E] focus:border-[#2F7BFF]/60"
          />
          <select
            value={sortBy}
            onChange={(event) => onSortByChange(event.target.value as "marketCap" | "score" | "volume24h" | "price")}
            className="rounded-lg border border-white/10 bg-[#0B1220] px-3 py-2 text-sm text-[#E6EDF3] outline-none focus:border-[#2F7BFF]/60"
          >
            <option value="marketCap">Sort: Market Cap</option>
            <option value="score">Sort: Score</option>
            <option value="volume24h">Sort: Volume</option>
            <option value="price">Sort: Price</option>
          </select>
          <select
            value={sortDirection}
            onChange={(event) => onSortDirectionChange(event.target.value as "asc" | "desc")}
            className="rounded-lg border border-white/10 bg-[#0B1220] px-3 py-2 text-sm text-[#E6EDF3] outline-none focus:border-[#2F7BFF]/60"
          >
            <option value="desc">Desc</option>
            <option value="asc">Asc</option>
          </select>
        </div>
        <p className="text-xs text-[#6B859E]">{helperText}</p>
      </div>
    </section>
  );
}
