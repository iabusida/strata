import { config as loadDotEnv } from "dotenv";
import type { NextConfig } from "next";
import { resolve } from "node:path";

// Keep API and web aligned on a single repository-level env file.
loadDotEnv({ path: resolve(__dirname, "../../.env") });

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["islams-mac-mini.local", "192.168.1.153", "*.trycloudflare.com"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8787/api/:path*"
      }
    ];
  }
};

export default nextConfig;
