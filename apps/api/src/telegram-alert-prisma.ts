import { PrismaClient } from "@prisma/client";

type AlertStage = "READY" | "OPENED" | "CLOSED" | "CAUTION";
type TelegramAlertPersistenceInput = {
  dedupeKey: string;
  stage: AlertStage;
  symbol: string;
  direction: "LONG" | "SHORT";
  signalType: string;
};

let prismaClient: PrismaClient | null = null;

function prisma(): PrismaClient {
  if (!prismaClient) {
    prismaClient = new PrismaClient();
  }

  return prismaClient;
}

export async function wasTelegramAlertRecentlySent(
  input: TelegramAlertPersistenceInput,
  windows: {
    dedupeWindowMs: number;
    tokenRepeatWindowMs: number;
  }
): Promise<{ duplicateKey: boolean; duplicateTokenDirection: boolean }> {
  const now = Date.now();
  const dedupeSince = new Date(now - windows.dedupeWindowMs);
  const tokenRepeatSince = new Date(now - windows.tokenRepeatWindowMs);

  const duplicateByKey = await prisma().telegramAlertEvent.findFirst({
    where: {
      dedupeKey: input.dedupeKey,
      stage: input.stage,
      sentAt: {
        gte: dedupeSince
      }
    },
    select: { id: true }
  });

  let duplicateTokenDirection = false;
  if (input.stage === "READY" || input.stage === "CAUTION") {
    const priorDirectional = await prisma().telegramAlertEvent.findFirst({
      where: {
        symbol: input.symbol,
        direction: input.direction,
        signalType: input.signalType,
        stage: {
          in: ["READY", "CAUTION"]
        },
        sentAt: {
          gte: tokenRepeatSince
        }
      },
      select: { id: true }
    });
    duplicateTokenDirection = Boolean(priorDirectional);
  }

  return {
    duplicateKey: Boolean(duplicateByKey),
    duplicateTokenDirection
  };
}

export async function recordTelegramAlertSent(input: TelegramAlertPersistenceInput): Promise<void> {
  await prisma().telegramAlertEvent.upsert({
    where: {
      dedupeKey_stage: {
        dedupeKey: input.dedupeKey,
        stage: input.stage
      }
    },
    create: {
      dedupeKey: input.dedupeKey,
      stage: input.stage,
      symbol: input.symbol,
      direction: input.direction,
      signalType: input.signalType,
      sentAt: new Date()
    },
    update: {
      symbol: input.symbol,
      direction: input.direction,
      signalType: input.signalType,
      sentAt: new Date()
    }
  });
}
