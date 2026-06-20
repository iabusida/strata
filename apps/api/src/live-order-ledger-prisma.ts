import { Prisma, PrismaClient } from "@prisma/client";
import { prisma as sharedPrisma } from "./prisma-client.js";

type ExchangeProvider = "BITUNIX";
type TradeDirection = "LONG" | "SHORT";
type LiveOrderType = "LIMIT" | "MARKET";

type LiveOrderAckInput = {
  provider: ExchangeProvider;
  symbol: string;
  perpToken: string;
  direction: TradeDirection;
  orderType: LiveOrderType;
  source: string;
  status?: string;
  localTradeId?: string;
  clientId?: string;
  orderId?: string;
  positionId?: string;
  stakeUsd?: number;
  leverage?: number;
  entryPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  openedAt?: string;
  meta?: Record<string, unknown>;
};

type LiveOrderOpenedInput = {
  provider: ExchangeProvider;
  clientId?: string;
  orderId?: string;
  positionId: string;
  openedAt?: string;
  meta?: Record<string, unknown>;
};

type LiveOrderClosedInput = {
  provider: ExchangeProvider;
  clientId?: string;
  orderId?: string;
  positionId?: string;
  closeReason: string;
  closedAt?: string;
  meta?: Record<string, unknown>;
};

export type LiveOrderLedgerReconcileRow = {
  id: string;
  provider: ExchangeProvider;
  symbol: string;
  perpToken: string;
  direction: TradeDirection;
  orderType: LiveOrderType;
  source: string;
  status: string;
  localTradeId: string | null;
  clientId: string | null;
  orderId: string | null;
  positionId: string | null;
  stakeUsd: number | null;
  leverage: number | null;
  entryPrice: number | null;
  tpPrice: number | null;
  slPrice: number | null;
  openedAt: string | null;
  updatedAt: string;
};

type BindLocalTradeIdInput = {
  provider: ExchangeProvider;
  localTradeId: string;
  clientId?: string;
  orderId?: string;
  positionId?: string;
};

let prismaSingleton: PrismaClient | null = null;

function prisma(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = sharedPrisma;
  }
  return prismaSingleton;
}

function normalizeUpper(value: string): string {
  return value.trim().toUpperCase();
}

function toJsonText(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {});
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

async function upsertByClientId(input: LiveOrderAckInput): Promise<void> {
  const openedAt = input.openedAt ? new Date(input.openedAt) : null;
  const status = input.status ?? "ACKED";

  await prisma().$executeRaw(
    Prisma.sql`
      INSERT INTO "LiveOrderLedger" (
        "provider", "symbol", "perpToken", "direction", "orderType", "source", "status",
        "localTradeId", "clientId", "orderId", "positionId",
        "stakeUsd", "leverage", "entryPrice", "tpPrice", "slPrice", "openedAt", "meta", "updatedAt"
      ) VALUES (
        ${input.provider}, ${normalizeUpper(input.symbol)}, ${normalizeUpper(input.perpToken)}, ${input.direction}, ${input.orderType}, ${input.source}, ${status},
        ${input.localTradeId ?? null}, ${input.clientId ?? null}, ${input.orderId ?? null}, ${input.positionId ?? null},
        ${input.stakeUsd ?? null}, ${input.leverage ?? null}, ${input.entryPrice ?? null}, ${input.tpPrice ?? null}, ${input.slPrice ?? null}, ${openedAt}, CAST(${toJsonText(input.meta)} AS JSONB), CURRENT_TIMESTAMP
      )
      ON CONFLICT ("provider", "clientId") DO UPDATE SET
        "symbol" = EXCLUDED."symbol",
        "perpToken" = EXCLUDED."perpToken",
        "direction" = EXCLUDED."direction",
        "orderType" = EXCLUDED."orderType",
        "source" = EXCLUDED."source",
        "status" = EXCLUDED."status",
        "localTradeId" = COALESCE(EXCLUDED."localTradeId", "LiveOrderLedger"."localTradeId"),
        "orderId" = COALESCE(EXCLUDED."orderId", "LiveOrderLedger"."orderId"),
        "positionId" = COALESCE(EXCLUDED."positionId", "LiveOrderLedger"."positionId"),
        "stakeUsd" = COALESCE(EXCLUDED."stakeUsd", "LiveOrderLedger"."stakeUsd"),
        "leverage" = COALESCE(EXCLUDED."leverage", "LiveOrderLedger"."leverage"),
        "entryPrice" = COALESCE(EXCLUDED."entryPrice", "LiveOrderLedger"."entryPrice"),
        "tpPrice" = COALESCE(EXCLUDED."tpPrice", "LiveOrderLedger"."tpPrice"),
        "slPrice" = COALESCE(EXCLUDED."slPrice", "LiveOrderLedger"."slPrice"),
        "openedAt" = COALESCE(EXCLUDED."openedAt", "LiveOrderLedger"."openedAt"),
        "meta" = EXCLUDED."meta",
        "updatedAt" = CURRENT_TIMESTAMP
    `
  );
}

async function upsertByOrderId(input: LiveOrderAckInput): Promise<void> {
  const openedAt = input.openedAt ? new Date(input.openedAt) : null;
  const status = input.status ?? "ACKED";

  await prisma().$executeRaw(
    Prisma.sql`
      INSERT INTO "LiveOrderLedger" (
        "provider", "symbol", "perpToken", "direction", "orderType", "source", "status",
        "localTradeId", "clientId", "orderId", "positionId",
        "stakeUsd", "leverage", "entryPrice", "tpPrice", "slPrice", "openedAt", "meta", "updatedAt"
      ) VALUES (
        ${input.provider}, ${normalizeUpper(input.symbol)}, ${normalizeUpper(input.perpToken)}, ${input.direction}, ${input.orderType}, ${input.source}, ${status},
        ${input.localTradeId ?? null}, ${input.clientId ?? null}, ${input.orderId ?? null}, ${input.positionId ?? null},
        ${input.stakeUsd ?? null}, ${input.leverage ?? null}, ${input.entryPrice ?? null}, ${input.tpPrice ?? null}, ${input.slPrice ?? null}, ${openedAt}, CAST(${toJsonText(input.meta)} AS JSONB), CURRENT_TIMESTAMP
      )
      ON CONFLICT ("provider", "orderId") DO UPDATE SET
        "symbol" = EXCLUDED."symbol",
        "perpToken" = EXCLUDED."perpToken",
        "direction" = EXCLUDED."direction",
        "orderType" = EXCLUDED."orderType",
        "source" = EXCLUDED."source",
        "status" = EXCLUDED."status",
        "localTradeId" = COALESCE(EXCLUDED."localTradeId", "LiveOrderLedger"."localTradeId"),
        "clientId" = COALESCE(EXCLUDED."clientId", "LiveOrderLedger"."clientId"),
        "positionId" = COALESCE(EXCLUDED."positionId", "LiveOrderLedger"."positionId"),
        "stakeUsd" = COALESCE(EXCLUDED."stakeUsd", "LiveOrderLedger"."stakeUsd"),
        "leverage" = COALESCE(EXCLUDED."leverage", "LiveOrderLedger"."leverage"),
        "entryPrice" = COALESCE(EXCLUDED."entryPrice", "LiveOrderLedger"."entryPrice"),
        "tpPrice" = COALESCE(EXCLUDED."tpPrice", "LiveOrderLedger"."tpPrice"),
        "slPrice" = COALESCE(EXCLUDED."slPrice", "LiveOrderLedger"."slPrice"),
        "openedAt" = COALESCE(EXCLUDED."openedAt", "LiveOrderLedger"."openedAt"),
        "meta" = EXCLUDED."meta",
        "updatedAt" = CURRENT_TIMESTAMP
    `
  );
}

export async function recordLiveOrderAck(input: LiveOrderAckInput): Promise<void> {
  if (input.clientId) {
    await upsertByClientId(input);
    return;
  }

  if (input.orderId) {
    await upsertByOrderId(input);
    return;
  }

  await prisma().$executeRaw(
    Prisma.sql`
      INSERT INTO "LiveOrderLedger" (
        "provider", "symbol", "perpToken", "direction", "orderType", "source", "status",
        "localTradeId", "clientId", "orderId", "positionId",
        "stakeUsd", "leverage", "entryPrice", "tpPrice", "slPrice", "openedAt", "meta", "updatedAt"
      ) VALUES (
        ${input.provider}, ${normalizeUpper(input.symbol)}, ${normalizeUpper(input.perpToken)}, ${input.direction}, ${input.orderType}, ${input.source}, ${input.status ?? "ACKED"},
        ${input.localTradeId ?? null}, ${input.clientId ?? null}, ${input.orderId ?? null}, ${input.positionId ?? null},
        ${input.stakeUsd ?? null}, ${input.leverage ?? null}, ${input.entryPrice ?? null}, ${input.tpPrice ?? null}, ${input.slPrice ?? null}, ${input.openedAt ? new Date(input.openedAt) : null}, CAST(${toJsonText(input.meta)} AS JSONB), CURRENT_TIMESTAMP
      )
    `
  );
}

export async function recordLiveOrderOpened(input: LiveOrderOpenedInput): Promise<void> {
  const openedAt = input.openedAt ? new Date(input.openedAt) : new Date();

  if (input.clientId) {
    await prisma().$executeRaw(
      Prisma.sql`
        UPDATE "LiveOrderLedger"
        SET "status" = 'FILLED_OPENED',
            "positionId" = ${input.positionId},
            "openedAt" = COALESCE("openedAt", ${openedAt}),
            "meta" = CAST(${toJsonText(input.meta)} AS JSONB),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "provider" = ${input.provider}
          AND "clientId" = ${input.clientId}
      `
    );
    return;
  }

  if (input.orderId) {
    await prisma().$executeRaw(
      Prisma.sql`
        UPDATE "LiveOrderLedger"
        SET "status" = 'FILLED_OPENED',
            "positionId" = ${input.positionId},
            "openedAt" = COALESCE("openedAt", ${openedAt}),
            "meta" = CAST(${toJsonText(input.meta)} AS JSONB),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "provider" = ${input.provider}
          AND "orderId" = ${input.orderId}
      `
    );
    return;
  }

  await prisma().$executeRaw(
    Prisma.sql`
      UPDATE "LiveOrderLedger"
      SET "status" = 'FILLED_OPENED',
          "positionId" = ${input.positionId},
          "openedAt" = COALESCE("openedAt", ${openedAt}),
          "meta" = CAST(${toJsonText(input.meta)} AS JSONB),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "provider" = ${input.provider}
        AND "positionId" = ${input.positionId}
    `
  );
}

export async function recordLiveOrderClosed(input: LiveOrderClosedInput): Promise<void> {
  const closedAt = input.closedAt ? new Date(input.closedAt) : new Date();

  if (input.clientId) {
    await prisma().$executeRaw(
      Prisma.sql`
        UPDATE "LiveOrderLedger"
        SET "status" = 'CLOSED',
            "closedAt" = ${closedAt},
            "closeReason" = ${input.closeReason},
            "meta" = CAST(${toJsonText(input.meta)} AS JSONB),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "provider" = ${input.provider}
          AND "clientId" = ${input.clientId}
      `
    );
    return;
  }

  if (input.orderId) {
    await prisma().$executeRaw(
      Prisma.sql`
        UPDATE "LiveOrderLedger"
        SET "status" = 'CLOSED',
            "closedAt" = ${closedAt},
            "closeReason" = ${input.closeReason},
            "meta" = CAST(${toJsonText(input.meta)} AS JSONB),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "provider" = ${input.provider}
          AND "orderId" = ${input.orderId}
      `
    );
    return;
  }

  if (input.positionId) {
    await prisma().$executeRaw(
      Prisma.sql`
        UPDATE "LiveOrderLedger"
        SET "status" = 'CLOSED',
            "closedAt" = ${closedAt},
            "closeReason" = ${input.closeReason},
            "meta" = CAST(${toJsonText(input.meta)} AS JSONB),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "provider" = ${input.provider}
          AND "positionId" = ${input.positionId}
      `
    );
  }
}

export async function listUnlinkedOpenLiveOrders(input: {
  provider: ExchangeProvider;
  limit?: number;
}): Promise<LiveOrderLedgerReconcileRow[]> {
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));

  const rows = await prisma().$queryRaw<Array<Record<string, unknown>>>(
    Prisma.sql`
      SELECT
        "id",
        "provider",
        "symbol",
        "perpToken",
        "direction",
        "orderType",
        "source",
        "status",
        "localTradeId",
        "clientId",
        "orderId",
        "positionId",
        "stakeUsd",
        "leverage",
        "entryPrice",
        "tpPrice",
        "slPrice",
        "openedAt",
        "updatedAt"
      FROM "LiveOrderLedger"
      WHERE "provider" = ${input.provider}
        AND "localTradeId" IS NULL
        AND "status" IN ('ACKED', 'FILLED_OPENED')
        AND "closedAt" IS NULL
      ORDER BY "updatedAt" DESC
      LIMIT ${limit}
    `
  );

  return rows
    .map((row) => {
      const provider = String(row.provider ?? "").trim().toUpperCase();
      if (provider !== "BITUNIX") {
        return null;
      }

      const direction = String(row.direction ?? "").trim().toUpperCase();
      if (direction !== "LONG" && direction !== "SHORT") {
        return null;
      }

      const orderType = String(row.orderType ?? "").trim().toUpperCase();
      if (orderType !== "MARKET" && orderType !== "LIMIT") {
        return null;
      }

      const updatedAt = toIso(row.updatedAt);
      if (!updatedAt) {
        return null;
      }

      return {
        id: String(row.id ?? ""),
        provider: "BITUNIX",
        symbol: String(row.symbol ?? "").trim().toUpperCase(),
        perpToken: String(row.perpToken ?? "").trim().toUpperCase(),
        direction,
        orderType,
        source: String(row.source ?? ""),
        status: String(row.status ?? ""),
        localTradeId: row.localTradeId == null ? null : String(row.localTradeId),
        clientId: row.clientId == null ? null : String(row.clientId),
        orderId: row.orderId == null ? null : String(row.orderId),
        positionId: row.positionId == null ? null : String(row.positionId),
        stakeUsd: toFiniteNumber(row.stakeUsd),
        leverage: toFiniteNumber(row.leverage),
        entryPrice: toFiniteNumber(row.entryPrice),
        tpPrice: toFiniteNumber(row.tpPrice),
        slPrice: toFiniteNumber(row.slPrice),
        openedAt: toIso(row.openedAt),
        updatedAt
      } satisfies LiveOrderLedgerReconcileRow;
    })
    .filter((row): row is LiveOrderLedgerReconcileRow => row !== null);
}

export async function bindLiveOrderToLocalTrade(input: BindLocalTradeIdInput): Promise<void> {
  const localTradeId = input.localTradeId.trim();
  if (!localTradeId) {
    return;
  }

  if (input.clientId) {
    await prisma().$executeRaw(
      Prisma.sql`
        UPDATE "LiveOrderLedger"
        SET "localTradeId" = ${localTradeId},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "provider" = ${input.provider}
          AND "clientId" = ${input.clientId}
          AND "closedAt" IS NULL
      `
    );
    return;
  }

  if (input.orderId) {
    await prisma().$executeRaw(
      Prisma.sql`
        UPDATE "LiveOrderLedger"
        SET "localTradeId" = ${localTradeId},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "provider" = ${input.provider}
          AND "orderId" = ${input.orderId}
          AND "closedAt" IS NULL
      `
    );
    return;
  }

  if (input.positionId) {
    await prisma().$executeRaw(
      Prisma.sql`
        UPDATE "LiveOrderLedger"
        SET "localTradeId" = ${localTradeId},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "provider" = ${input.provider}
          AND "positionId" = ${input.positionId}
          AND "closedAt" IS NULL
      `
    );
  }
}
