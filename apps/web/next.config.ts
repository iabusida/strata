import { config as loadDotEnv } from "dotenv";
import type { NextConfig } from "next";
import { resolve } from "node:path";

// Keep API and web aligned on a single repository-level env file.
loadDotEnv({ path: resolve(__dirname, "../../.env") });

const nextConfig: NextConfig = {
  reactStrictMode: true
};

export default nextConfig;
