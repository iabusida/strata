import type { Metadata } from "next";
import { Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import { RootLayoutClient } from "./layout-client";
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
        <RootLayoutClient>{children}</RootLayoutClient>
      </body>
    </html>
  );
}
