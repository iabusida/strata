"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../contexts/auth-context";

type UiContext = {
  marketDataProvider: string;
  exchangeProviderLabel: string;
};

type NavLinkItem = {
  href: string;
  label: string;
};

type NavSection = {
  title: string;
  links: NavLinkItem[];
};

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

export function AppHeaderNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [exchangeProviderLabel, setExchangeProviderLabel] = useState("EXCHANGE");

  useEffect(() => {
    let cancelled = false;

    async function loadUiContext(): Promise<void> {
      try {
        const response = await fetch(`${getApiBase()}/api/ui/context`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as UiContext;
        if (!cancelled && payload.exchangeProviderLabel) {
          setExchangeProviderLabel(String(payload.exchangeProviderLabel).toUpperCase());
        }
      } catch {
        // Keep fallback label for nav resiliency.
      }
    }

    void loadUiContext();
    return () => {
      cancelled = true;
    };
  }, []);

  const sections = useMemo<NavSection[]>(() => {
    if (!user) return [];

    return [
      {
        title: "Markets",
        links: [
          { href: "/markets/crypto", label: "Crypto" },
          { href: "/markets/stocks", label: "Stocks" },
          { href: "/markets/forecast", label: "Forecast" },
          { href: "/analysis", label: "Analysis" }
        ]
      },
      {
        title: "Pre-Pump",
        links: [
          { href: "/pre-pump/crypto", label: "Crypto" },
          { href: "/pre-pump/stocks", label: "Stocks" }
        ]
      },
      {
        title: "Execution",
        links: [
          { href: "/", label: "Alignment" },
          { href: "/test-simulation", label: "Simulation" },
          { href: "/live-order-simulation", label: "Live Trading" },
          { href: "/dry-run", label: "Dry Run" }
        ]
      },
      {
        title: "Workspace",
        links: [
          { href: "/workspace/account", label: "Account" },
          { href: "/workspace/trading-style", label: "Trading Style" },
          { href: "/workspace/simulation", label: "Balance Config" },
          { href: "/workspace/exchange-providers", label: "Exchange Keys" },
          { href: "/bitunix-account", label: `${exchangeProviderLabel} Account` },
          { href: "/settings", label: "Settings" }
        ]
      }
    ];
  }, [exchangeProviderLabel, user]);

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

  if (!user) {
    return (
      <nav className="app-nav" aria-label="Auth Navigation">
        <div style={{ display: "flex", gap: "1rem" }}>
          <Link href="/login" className="app-nav-link" style={{ color: "var(--hot)" }}>
            Sign In
          </Link>
          <Link href="/signup" className="app-nav-link" style={{ backgroundColor: "var(--hot)", color: "white", padding: "0.5rem 1rem", borderRadius: "0.25rem" }}>
            Sign Up
          </Link>
        </div>
      </nav>
    );
  }

  return (
    <nav className="app-nav" aria-label="Primary Navigation">
      {sections.map((section) => (
        <div key={section.title} className="app-nav-group">
          <span className="app-nav-group-title">{section.title}</span>
          <div className="app-nav-links">
            {section.links.map((link) => {
              const active = isActive(pathname, link.href);
              return (
                <Link
                  key={link.href}
                  className={`app-nav-link ${active ? "app-nav-link-active" : ""}`}
                  href={link.href}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
      <div className="app-nav-group">
        <span className="app-nav-group-title">User</span>
        <div className="app-nav-links">
          <span style={{ fontSize: "0.875rem", color: "var(--muted)", padding: "0.5rem 0" }}>
            {user.email}
          </span>
          <button
            onClick={handleLogout}
            style={{
              backgroundColor: "transparent",
              color: "var(--hot)",
              border: "none",
              cursor: "pointer",
              fontSize: "0.875rem",
              padding: "0.5rem 0",
              textAlign: "left"
            }}
          >
            Logout
          </button>
        </div>
      </div>
    </nav>
  );
}
