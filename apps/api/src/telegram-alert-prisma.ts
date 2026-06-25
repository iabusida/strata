import { PrismaClient } from "@prisma/client";
import { prisma as sharedPrisma } from "./prisma-client.js";

type AlertStage = "READY" | "OPENED" | "CLOSED" | "CAUTION";
type AlertChannel = "PUBLIC" | "PERSONAL";
type TelegramAlertPersistenceInput = {
  dedupeKey: string;
  stage: AlertStage;
  symbol: string;
  direction: "LONG" | "SHORT";
  signalType: string;
  alertChannel?: AlertChannel;
  recipientUserId?: string;
};

let prismaClient: PrismaClient | null = null;

function prisma(): PrismaClient {
  if (!prismaClient) {
    prismaClient = sharedPrisma;
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
      alertChannel: input.alertChannel ?? "PUBLIC",
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
        alertChannel: input.alertChannel ?? "PUBLIC",
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
  const alertChannel = input.alertChannel ?? "PUBLIC";
  
  await prisma().telegramAlertEvent.upsert({
    where: {
      dedupeKey_stage_alertChannel: {
        dedupeKey: input.dedupeKey,
        stage: input.stage,
        alertChannel
      }
    },
    create: {
      dedupeKey: input.dedupeKey,
      stage: input.stage,
      symbol: input.symbol,
      direction: input.direction,
      signalType: input.signalType,
      alertChannel,
      recipientUserId: input.recipientUserId,
      sentAt: new Date()
    },
    update: {
      symbol: input.symbol,
      direction: input.direction,
      signalType: input.signalType,
      recipientUserId: input.recipientUserId,
      sentAt: new Date()
    }
  });
}
