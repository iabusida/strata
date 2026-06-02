import type { Metadata } from "next";
import Link from "next/link";
import { Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-display" });
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "600"]
});

export const metadata: Metadata = {
  title: "Ciphora | Hyperliquid RSI Explorer",
  description: "Ciphora delivers multi-factor market intelligence for Hyperliquid tokens"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${spaceGrotesk.variable} ${plexMono.variable}`}>
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
              <nav className="app-nav" aria-label="Primary Navigation">
                <Link className="app-nav-link" href="/?view=results">Alignment Results</Link>
                <Link className="app-nav-link" href="/?view=simulation">Trade Simulation</Link>
                <Link className="app-nav-link" href="/dry-run">Dry Run</Link>
                <Link className="app-nav-link" href="/bitunix-account">Bitunix Account</Link>
                <Link className="app-nav-link" href="/settings">Settings</Link>
              </nav>
            </div>
          </header>
          <main className="app-content">{children}</main>
        </div>
      </body>
    </html>
  );
}
