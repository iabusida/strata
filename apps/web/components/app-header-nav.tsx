"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../contexts/auth-context";

type NavLinkItem = {
  href: string;
  label: string;
};

type PrimaryTab = "Scan" | "Forecast" | "Execute" | "Simulate";

type SystemStatus = "Idle" | "Scanning" | "Error";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim();

function getApiBase(): string {
  return API_BASE.replace(/\/+$/, "");
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

function getPrimaryTab(pathname: string): PrimaryTab {
  if (pathname.startsWith("/markets/forecast")) {
    return "Forecast";
  }

  if (pathname.startsWith("/live-order-simulation") || pathname.startsWith("/dry-run")) {
    return "Execute";
  }

  if (pathname.startsWith("/test-simulation")) {
    return "Simulate";
  }

  return "Scan";
}

const primaryNav: NavLinkItem[] = [
  { href: "/", label: "Scan" },
  { href: "/markets/forecast", label: "Forecast" },
  { href: "/live-order-simulation", label: "Execute" },
  { href: "/test-simulation", label: "Simulate" }
];

const secondaryNav: Record<PrimaryTab, NavLinkItem[]> = {
  Scan: [
    { href: "/markets/crypto", label: "Crypto" },
    { href: "/markets/stocks", label: "Stocks" }
  ],
  Forecast: [
    { href: "/markets/forecast", label: "Overview" }
  ],
  Execute: [
    { href: "/live-order-simulation", label: "Live" },
    { href: "/dry-run", label: "Dry Run" }
  ],
  Simulate: [
    { href: "/test-simulation", label: "Test" }
  ]
};

export function AppHeaderNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [systemStatus, setSystemStatus] = useState<SystemStatus>("Idle");

  useEffect(() => {
    let cancelled = false;

    async function loadSystemStatus(): Promise<void> {
      try {
        const response = await fetch(`${getApiBase()}/api/state?mode=live`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`State endpoint failed (${response.status})`);
        }

        const payload = (await response.json()) as {
          service?: {
            lastSignalScanAt?: string;
            signalIntervalMs?: number;
          };
        };

        if (cancelled) {
          return;
        }

        const lastSignalMs = payload.service?.lastSignalScanAt ? Date.parse(payload.service.lastSignalScanAt) : Number.NaN;
        const cadence = payload.service?.signalIntervalMs ?? 30_000;
        const recent = Number.isFinite(lastSignalMs) && Date.now() - lastSignalMs < cadence * 2;

        setSystemStatus(recent ? "Scanning" : "Idle");
      } catch {
        if (!cancelled) {
          setSystemStatus("Error");
        }
      }
    }

    void loadSystemStatus();
    const intervalId = setInterval(() => {
      void loadSystemStatus();
    }, 15_000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  const activePrimary = useMemo(() => getPrimaryTab(pathname), [pathname]);

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

  if (!user) {
    return (
      <nav className="flex items-center gap-2" aria-label="Auth Navigation">
        <div className="flex gap-2">
          <Link href="/login" className="rounded-md border border-white/10 px-3 py-2 text-xs uppercase tracking-[0.08em] text-[#9FB3C8]">
            Sign In
          </Link>
          <Link href="/signup" className="rounded-md bg-[#2F7BFF] px-3 py-2 text-xs uppercase tracking-[0.08em] text-white">
            Sign Up
          </Link>
        </div>
      </nav>
    );
  }

  return (
    <nav className="w-full" aria-label="Primary Navigation">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#0B1220] p-1">
            {primaryNav.map((link) => {
              const isCurrentPrimary = link.label === activePrimary;
              return (
                <Link
                  key={link.href}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.1em] ${isCurrentPrimary ? "bg-[#2F7BFF]/20 text-[#E6EDF3]" : "text-[#9FB3C8] hover:text-[#E6EDF3]"}`}
                  href={link.href}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>

          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#0B1220] p-1">
            {secondaryNav[activePrimary].map((link) => {
              const active = isActive(pathname, link.href);
              return (
                <Link
                  key={link.href}
                  className={`rounded-md px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.1em] ${active ? "bg-[#3EC6FF]/20 text-[#E6EDF3]" : "text-[#6B859E] hover:text-[#E6EDF3]"}`}
                  href={link.href}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={`rounded-full border border-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] ${systemStatus === "Error" ? "text-[#EF4444]" : systemStatus === "Scanning" ? "text-[#3EC6FF]" : "text-[#9FB3C8]"}`}>
            {systemStatus}
          </span>
          <span className="hidden text-xs text-[#9FB3C8] md:inline">
            {user.email}
          </span>
          <button
            onClick={handleLogout}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs uppercase tracking-[0.08em] text-[#9FB3C8] transition hover:text-[#E6EDF3]"
          >
            Logout
          </button>
        </div>
      </div>
    </nav>
  );
}
