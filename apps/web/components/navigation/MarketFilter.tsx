"use client";

import { useCallback, useEffect, useState } from "react";

export type MarketType = "CRYPTO" | "STOCKS";

interface MarketFilterProps {
  value: MarketType;
  onChange: (market: MarketType) => void;
  className?: string;
}

const STORAGE_KEY = "strata-market-filter";

export function MarketFilter({ value, onChange, className = "" }: MarketFilterProps) {
  const [mounted, setMounted] = useState(false);

  // Load persisted value on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as MarketType | null;
    if (stored && (stored === "CRYPTO" || stored === "STOCKS")) {
      onChange(stored);
    }
    setMounted(true);
  }, [onChange]);

  const handleChange = useCallback(
    (market: MarketType) => {
      onChange(market);
      localStorage.setItem(STORAGE_KEY, market);
    },
    [onChange]
  );

  if (!mounted) {
    return <div className={`h-10 ${className}`} />;
  }

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <span className="text-xs font-medium uppercase tracking-[0.05em] text-[#6B859E]">
        Market
      </span>
      <div className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0B1220] p-1">
        {(["CRYPTO", "STOCKS"] as const).map((market) => (
          <button
            key={market}
            onClick={() => handleChange(market)}
            className={`
              px-3 py-1.5 text-xs font-medium uppercase tracking-[0.08em]
              rounded-md transition-colors duration-150
              ${
                value === market
                  ? "bg-[#3EC6FF]/20 text-[#E6EDF3]"
                  : "text-[#6B859E] hover:text-[#9FB3C8]"
              }
            `}
            aria-pressed={value === market}
          >
            {market}
          </button>
        ))}
      </div>
    </div>
  );
}
