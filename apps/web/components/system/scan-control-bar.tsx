type ScanControlBarProps = {
  tokenQuery: string;
  sortBy: "marketCap" | "score" | "volume24h" | "price";
  sortDirection: "asc" | "desc";
  helperText?: string;
  onTokenQueryChange: (value: string) => void;
  onSortByChange: (value: "marketCap" | "score" | "volume24h" | "price") => void;
  onSortDirectionChange: (value: "asc" | "desc") => void;
};

export function ScanControlBar({
  tokenQuery,
  sortBy,
  sortDirection,
  helperText = "Filter and sort the current market view.",
  onTokenQueryChange,
  onSortByChange,
  onSortDirectionChange,
}: ScanControlBarProps) {
  return (
    <section className="rounded-strata border border-white/10 bg-[#0F172A] p-4 shadow-strata-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
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
