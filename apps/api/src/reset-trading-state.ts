import "./env.js";
import { PrismaClient } from "@prisma/client";

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    await prisma.sessionOpportunity.deleteMany({});
    await prisma.sessionTrade.deleteMany({});
    await prisma.tradingSession.deleteMany({});
    await prisma.tradeRuntimeState.deleteMany({});
    await prisma.scanState.deleteMany({});
  } finally {
    await prisma.$disconnect();
  }

  console.log("Trading runtime state reset complete (PostgreSQL).");
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
