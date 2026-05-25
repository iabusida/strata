import { Prisma, PrismaClient, BackfillTokenStatus } from "@prisma/client";

type BackfillTokenRecord = {
  symbol: string;
  status: BackfillTokenStatus;
  lastAttemptedAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  dataAvailableFrom: Date | null;
  candleCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export async function getBackfillStatus(prisma: PrismaClient, symbol: string): Promise<BackfillTokenRecord | null> {
  const record = await prisma.backfillToken.findUnique({
    where: { symbol }
  });

  if (!record) {
    return null;
  }

  return {
    symbol: record.symbol,
    status: record.status as BackfillTokenStatus,
    lastAttemptedAt: record.lastAttemptedAt,
    lastSuccessAt: record.lastSuccessAt,
    lastError: record.lastError,
    dataAvailableFrom: record.dataAvailableFrom,
    candleCount: record.candleCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export async function getPendingTokens(prisma: PrismaClient, limit: number = 50): Promise<string[]> {
  const records = await prisma.backfillToken.findMany({
    where: {
      status: "PENDING"
    },
    select: { symbol: true },
    orderBy: { createdAt: "asc" },
    take: limit
  });

  return records.map((r) => r.symbol);
}

export async function getFailedTokens(prisma: PrismaClient, limit: number = 50): Promise<string[]> {
  const records = await prisma.backfillToken.findMany({
    where: {
      status: {
        in: ["IN_PROGRESS"]
      }
    },
    select: { symbol: true },
    orderBy: { lastAttemptedAt: "asc" },
    take: limit
  });

  return records.map((r) => r.symbol);
}

export async function getCompletedTokens(prisma: PrismaClient, limit: number = 100): Promise<string[]> {
  const records = await prisma.backfillToken.findMany({
    where: {
      status: "COMPLETED"
    },
    select: { symbol: true },
    orderBy: { lastSuccessAt: "desc" },
    take: limit
  });

  return records.map((r) => r.symbol);
}

export async function initializeOrUpdateStatus(
  prisma: PrismaClient,
  symbol: string,
  status: BackfillTokenStatus = "PENDING"
): Promise<void> {
  await prisma.backfillToken.upsert({
    where: { symbol },
    create: {
      symbol,
      status
    },
    update: {
      status
    }
  });
}

export async function markBackfillStarted(prisma: PrismaClient, symbol: string): Promise<void> {
  await prisma.backfillToken.update({
    where: { symbol },
    data: {
      status: "IN_PROGRESS",
      lastAttemptedAt: new Date()
    }
  });
}

export async function markBackfillSuccess(
  prisma: PrismaClient,
  symbol: string,
  candleCount: number,
  dataAvailableFrom: Date | null = null
): Promise<void> {
  await prisma.backfillToken.update({
    where: { symbol },
    data: {
      status: "COMPLETED",
      lastSuccessAt: new Date(),
      lastError: null,
      dataAvailableFrom,
      candleCount
    }
  });
}

export async function markBackfillFailed(prisma: PrismaClient, symbol: string, errorMessage: string): Promise<void> {
  await prisma.backfillToken.update({
    where: { symbol },
    data: {
      status: "PENDING",
      lastAttemptedAt: new Date(),
      lastError: errorMessage.slice(0, 500)
    }
  });
}

export async function markBackfillNoData(prisma: PrismaClient, symbol: string): Promise<void> {
  await prisma.backfillToken.update({
    where: { symbol },
    data: {
      status: "NO_DATA",
      lastAttemptedAt: new Date(),
      lastError: "No candle data available from upstream (token too new or delisted)"
    }
  });
}

export async function markBackfillSkipped(prisma: PrismaClient, symbol: string, reason: string): Promise<void> {
  await prisma.backfillToken.update({
    where: { symbol },
    data: {
      status: "SKIPPED",
      lastAttemptedAt: new Date(),
      lastError: reason.slice(0, 500)
    }
  });
}

export async function getSummary(prisma: PrismaClient): Promise<Record<string, number>> {
  const counts = await prisma.backfillToken.groupBy({
    by: ["status"],
    _count: true
  });

  const result: Record<string, number> = {
    PENDING: 0,
    IN_PROGRESS: 0,
    COMPLETED: 0,
    NO_DATA: 0,
    SKIPPED: 0
  };

  for (const record of counts) {
    result[record.status] = record._count;
  }

  return result;
}
