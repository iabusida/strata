"use client";

import type { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";
import { AuthProvider } from "../contexts/auth-context";
import { NextAuthBridge } from "../components/next-auth-bridge";
import { AppHeaderNav } from "../components/app-header-nav";
import "./globals.css";

export function RootLayoutClient({
  session,
  children,
}: Readonly<{
  session: Session | null;
  children: React.ReactNode;
}>) {
  return (
    <SessionProvider session={session} refetchOnWindowFocus={false}>
      <AuthProvider>
        <NextAuthBridge />
        <div className="app-shell">
          <header className="app-header">
            <div className="app-header-inner">
              <div className="app-brand">
                <img className="brand-logo" src="/strata-logo.svg" alt="Strata" />
                <span className="app-brand-title">Strata</span>
              </div>
              <AppHeaderNav />
            </div>
          </header>
          <main className="app-content">{children}</main>
        </div>
      </AuthProvider>
    </SessionProvider>
  );
}
