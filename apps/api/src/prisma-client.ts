import { PrismaClient } from "@prisma/client";

// Single shared PrismaClient for the long-lived API process.
//
// Previously, ~30 modules each instantiated their own PrismaClient, and every
// instance opens its own connection pool. Against a remote/pooled Postgres
// (e.g. Neon) that multiplies connection pressure and slows cold queries.
// Reusing one client keeps a single pool for the whole process.
//
// The globalThis guard ensures we keep one instance even across hot-reload or
// multiple module-resolution graphs during local dev (tsx watch).
const globalForPrisma = globalThis as unknown as { __strataPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__strataPrisma ?? new PrismaClient();

if (!globalForPrisma.__strataPrisma) {
  globalForPrisma.__strataPrisma = prisma;
}
