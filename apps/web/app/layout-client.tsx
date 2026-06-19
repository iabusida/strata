"use client";

import { AuthProvider } from "../contexts/auth-context";
import { AppHeaderNav } from "../components/app-header-nav";
import "./globals.css";

export function RootLayoutClient({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AuthProvider>
      <div className="app-shell">
        <header className="app-header">
          <div className="app-header-inner">
            <div className="app-brand">
              <img className="brand-logo" src="/ciphora-logo.svg" alt="Ciphora logo" />
              <div>
                <p className="eyebrow">Ciphora</p>
                <p className="brand-subtitle">Multi-Factor Market Intelligence</p>
              </div>
            </div>
            <AppHeaderNav />
          </div>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </AuthProvider>
  );
}
