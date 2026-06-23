"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { PrimaryNav } from "./navigation/PrimaryNav";
import { MarketFilter, type MarketType } from "./navigation/MarketFilter";
import { useAuth } from "../contexts/auth-context";

export function AppHeaderNav() {
  const router = useRouter();
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

  if (authLoading) {
    return (
      <nav className="flex items-center gap-2" aria-label="Auth Navigation">
        <div className="rounded-md border border-white/10 px-3 py-2 text-xs uppercase tracking-[0.08em] text-[#6B859E]">
          Loading user
        </div>
      </nav>
    );
  }

  if (!displayEmail) {
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
    <header className="w-full space-y-3 border-b border-white/5 bg-[#0A0F1A] py-4" aria-label="Application Header">
      {/* Primary Navigation - What the user is doing */}
      <div className="flex items-center justify-between px-6">
        <PrimaryNav />
        <details className="relative">
          <summary className="list-none cursor-pointer rounded-md border border-white/15 px-3 py-1.5 text-xs uppercase tracking-[0.08em] text-[#9FB3C8] transition hover:text-[#E6EDF3]">
            {displayEmail ?? "User Menu"}
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

      {/* Secondary Filter Bar - How to filter data */}
      <div className="border-t border-white/5 px-6 pt-3">
        <MarketFilter value={selectedMarket} onChange={setSelectedMarket} />
      </div>
    </header>
  );
}
