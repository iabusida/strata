"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";

type PrimaryTab = "Opportunities" | "Forecast" | "Pre-Pump" | "Simulate";

type PrimaryNavItem = {
  id: PrimaryTab;
  label: string;
  href: string;
};

const NAV_ITEMS: PrimaryNavItem[] = [
  { id: "Opportunities", label: "Opportunities", href: "/markets/opportunities" },
  { id: "Forecast", label: "Forecast", href: "/markets/forecast" },
  { id: "Pre-Pump", label: "Pre-Pump", href: "/pre-pump" },
  { id: "Simulate", label: "Simulate", href: "/simulation" }
];

function getActivePrimaryTab(pathname: string): PrimaryTab {
  // Check for Opportunities (including the old /markets/crypto and /markets/stocks routes for backward compatibility)
  if (pathname.startsWith("/markets/opportunities") || pathname === "/markets/crypto" || pathname === "/markets/stocks" || pathname === "/") {
    return "Opportunities";
  }
  if (pathname.startsWith("/markets/forecast")) {
    return "Forecast";
  }
  if (pathname.startsWith("/pre-pump")) {
    return "Pre-Pump";
  }
  if (pathname.startsWith("/simulation") || pathname.startsWith("/test-simulation")) {
    return "Simulate";
  }
  return "Opportunities";
}

interface PrimaryNavProps {
  className?: string;
}

export function PrimaryNav({ className = "" }: PrimaryNavProps) {
  const pathname = usePathname();
  const activeTab = useMemo(() => getActivePrimaryTab(pathname), [pathname]);

  return (
    <nav className={`flex items-center gap-1 ${className}`} aria-label="Primary Navigation">
      {NAV_ITEMS.map((item) => {
        const isActive = item.id === activeTab;
        return (
          <Link
            key={item.id}
            href={item.href}
            className={`
              px-4 py-2.5 text-sm font-semibold uppercase tracking-[0.08em]
              rounded-md transition-all duration-200
              ${
                isActive
                  ? "bg-[#2F7BFF] text-white shadow-lg shadow-[#2F7BFF]/30"
                  : "text-[#9FB3C8] hover:text-[#E6EDF3] hover:bg-white/5"
              }
            `}
            aria-current={isActive ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
