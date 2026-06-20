import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import { RootLayoutClient } from "./layout-client";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-display" });
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "600"]
});

export const metadata: Metadata = {
  title: "Strata | Hyperliquid RSI Explorer",
  description: "Strata delivers multi-factor market intelligence for Hyperliquid tokens",
  icons: {
    icon: "/strata-icon.svg",
    apple: "/strata-icon.svg",
    shortcut: "/strata-icon.svg"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${plexMono.variable}`}>
        <RootLayoutClient>{children}</RootLayoutClient>
      </body>
    </html>
  );
}
