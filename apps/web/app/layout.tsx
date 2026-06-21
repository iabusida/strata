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
  title: "Strata | Signal Intelligence for Crypto & Stocks",
  description: "Strata delivers data-driven signals, pre-pump detection, and market intelligence for crypto and stocks",
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
