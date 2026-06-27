"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { PrimaryNav } from "./navigation/PrimaryNav";
import { MarketFilter, type MarketType } from "./navigation/MarketFilter";
import { useAuth } from "../contexts/auth-context";

export function AppHeaderNav() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading, logout } = useAuth();
  const { data: session, status } = useSession();
  const [selectedMarket, setSelectedMarket] = useState<MarketType>("CRYPTO");
  const sessionEmail = session?.user?.email ?? null;
  const displayEmail = user?.email ?? sessionEmail;
  const authLoading = isLoading || status === "loading";

  const handleLogout = async () => {
    logout();
    await signOut({ redirect: false });
    router.push("/login");
  };

  useEffect(() => {
    if (pathname === "/markets/crypto" && selectedMarket === "STOCKS") {
      router.push("/markets/stocks");
      return;
    }

    if (pathname === "/markets/stocks" && selectedMarket === "CRYPTO") {
      router.push("/markets/crypto");
    }
  }, [pathname, selectedMarket, router]);

  if (authLoading) {
    return (
      <nav className="flex items-center gap-5" aria-label="Auth Navigation">
        <div className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-[#9FB3C8]">
          Loading user
        </div>
      </nav>
    );
  }

  if (!displayEmail) {
    return (
      <nav className="flex items-center gap-5" aria-label="Auth Navigation">
        <div className="inline-flex items-center gap-2 text-sm text-emerald-300">
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          <span className="text-[#9FB3C8]">Live</span>
        </div>
        <PrimaryNav />
        <div className="flex gap-2">
          <Link href="/login" className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-[#9FB3C8]">
            Sign In
          </Link>
          <Link href="/signup" className="rounded-md bg-[#2F7BFF] px-3 py-1.5 text-sm text-white">
            Sign Up
          </Link>
        </div>
      </nav>
    );
  }

  return (
    <nav className="flex w-full items-center justify-end gap-5" aria-label="Application Header">
      <div className="hidden items-center gap-2 text-sm text-emerald-300 lg:inline-flex">
        <span className="h-2 w-2 rounded-full bg-emerald-400" />
        <span className="text-[#9FB3C8]">Live</span>
      </div>

      <PrimaryNav />

      <MarketFilter value={selectedMarket} onChange={setSelectedMarket} className="hidden xl:flex" />

      <details className="relative">
        <summary className="list-none cursor-pointer rounded-md border border-white/15 px-3 py-1.5 text-sm text-[#9FB3C8] transition hover:text-[#E6EDF3]">
          {displayEmail ?? "User"}
        </summary>
        <div className="absolute right-0 z-20 mt-2 w-56 rounded-lg border border-white/10 bg-[#0B1220] p-1 shadow-xl">
          <Link href="/workspace/account" className="block rounded-md px-3 py-2 text-sm text-[#9FB3C8] hover:bg-white/5 hover:text-[#E6EDF3]">
            Manage Account
          </Link>
          <Link href="/workspace/simulation" className="block rounded-md px-3 py-2 text-sm text-[#9FB3C8] hover:bg-white/5 hover:text-[#E6EDF3]">
            Manage Bot
          </Link>
          <Link href="/settings" className="block rounded-md px-3 py-2 text-sm text-[#9FB3C8] hover:bg-white/5 hover:text-[#E6EDF3]">
            Settings
          </Link>
          <button
            onClick={handleLogout}
            className="mt-1 block w-full rounded-md px-3 py-2 text-left text-sm text-[#9FB3C8] hover:bg-white/5 hover:text-[#E6EDF3]"
          >
            Logout
          </button>
        </div>
      </details>

      <div className="inline-flex items-center gap-2 text-sm text-emerald-300 lg:hidden">
        <span className="h-2 w-2 rounded-full bg-emerald-400" />
      </div>
    </nav>
  );
}
