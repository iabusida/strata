"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo } from "react";
import { useAuth } from "../contexts/auth-context";

type NavLinkItem = {
  href: string;
  label: string;
};

type PrimaryTab = "Scan" | "Forecast" | "Simulate";

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

  if (pathname.startsWith("/test-simulation")) {
    return "Simulate";
  }

  return "Scan";
}

const primaryNav: NavLinkItem[] = [
  { href: "/", label: "Scan" },
  { href: "/markets/forecast", label: "Forecast" },
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
  Simulate: [
    { href: "/test-simulation", label: "Test" }
  ]
};

export function AppHeaderNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isLoading, logout } = useAuth();

  const activePrimary = useMemo(() => getPrimaryTab(pathname), [pathname]);

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

  if (isLoading) {
    return (
      <nav className="flex items-center gap-2" aria-label="Auth Navigation">
        <div className="rounded-md border border-white/10 px-3 py-2 text-xs uppercase tracking-[0.08em] text-[#6B859E]">
          Loading user
        </div>
      </nav>
    );
  }

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
          <details className="relative">
            <summary className="list-none cursor-pointer rounded-md border border-white/15 px-3 py-1.5 text-xs uppercase tracking-[0.08em] text-[#9FB3C8] transition hover:text-[#E6EDF3]">
              {user.email ?? "User Menu"}
            </summary>
            <div className="absolute right-0 z-20 mt-2 w-52 rounded-lg border border-white/10 bg-[#0B1220] p-1 shadow-xl">
              <Link href="/workspace/account" className="block rounded-md px-3 py-2 text-xs text-[#9FB3C8] hover:bg-white/5 hover:text-[#E6EDF3]">
                Manage Account
              </Link>
              <Link href="/workspace/simulation" className="block rounded-md px-3 py-2 text-xs text-[#9FB3C8] hover:bg-white/5 hover:text-[#E6EDF3]">
                Manage Bot
              </Link>
              <Link href="/settings" className="block rounded-md px-3 py-2 text-xs text-[#9FB3C8] hover:bg-white/5 hover:text-[#E6EDF3]">
                Settings
              </Link>
              <button
                onClick={handleLogout}
                className="mt-1 block w-full rounded-md px-3 py-2 text-left text-xs text-[#9FB3C8] hover:bg-white/5 hover:text-[#E6EDF3]"
              >
                Logout
              </button>
            </div>
          </details>
        </div>
      </div>
    </nav>
  );
}
