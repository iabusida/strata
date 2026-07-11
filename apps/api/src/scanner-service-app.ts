#!/usr/bin/env node
import "./env.js";
import { startScanService, stopScanService } from "./scan-service.js";
import { prisma } from "./prisma-client.js";

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.info("[scanner-service-app] shutting down", { signal });
  stopScanService();
  await prisma.$disconnect();
  process.exit(0);
}

async function main(): Promise<void> {
  console.info("[scanner-service-app] starting scanner service");
  await startScanService();
  console.info("[scanner-service-app] scanner service started");
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

main().catch(async (error) => {
  console.error("[scanner-service-app] failed to start", error);
  await prisma.$disconnect();
  process.exit(1);
});
