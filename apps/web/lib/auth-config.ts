import type { NextAuthOptions } from "next-auth";
import type { Adapter, AdapterUser } from "next-auth/adapters";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import jwt from "jsonwebtoken";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8787";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-key-change-in-prod";

// Lazy Prisma import to avoid database initialization during build
async function getPrismaClient() {
  const { prisma } = await import("@/lib/prisma-client");
  return prisma;
}

function makeOrgSlug(seed: string): string {
  const normalized = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${normalized || "org"}-${suffix}`;
}

// Lazy proxy adapter - defers Prisma initialization until first auth operation
function createLazyAdapter(): Adapter {
  let initialized = false;
  let realAdapter: Adapter | null = null;

  const initializeAdapter = async () => {
    if (initialized && realAdapter) return realAdapter;
    initialized = true;

    const prisma = await getPrismaClient();
    const baseAdapter = PrismaAdapter(prisma);

    // Create a custom adapter that wraps the base Prisma adapter
    // with additional logic for organization management
    realAdapter = {
      ...baseAdapter,
      async createUser(data: Omit<AdapterUser, "id">) {
        if (!data.email) {
          throw new Error("OAuth user email is required");
        }

        const prisma = await getPrismaClient();

        // If a user exists without an account link, reuse it and make sure tenant data exists.
        const existingUser = await prisma.user.findUnique({
          where: { email: data.email },
          include: { organization: true },
        });

        if (existingUser) {
          let organizationId = existingUser.organizationId;

          if (!existingUser.organization) {
            const org = await prisma.organization.create({
              data: {
                name: existingUser.name || data.name || data.email.split("@")[0],
                slug: makeOrgSlug(data.email.split("@")[0]),
              },
            });
            organizationId = org.id;
          }

          const updatedUser = await prisma.user.update({
            where: { id: existingUser.id },
            data: {
              name: data.name ?? existingUser.name,
              image: data.image ?? existingUser.image,
              emailVerified: data.emailVerified ?? existingUser.emailVerified,
              organizationId,
            },
          });

          await prisma.userSimulationProfile.upsert({
            where: { userId: updatedUser.id },
            update: {},
            create: {
              userId: updatedUser.id,
              initialBalanceUsd: 10000,
              riskPerTradePct: 1.5,
              leverage: 5,
              maxOpenTrades: 8,
            },
          });

          return {
            id: updatedUser.id,
            name: updatedUser.name,
            email: updatedUser.email,
            image: updatedUser.image,
            emailVerified: updatedUser.emailVerified,
          } as AdapterUser;
        }

        const org = await prisma.organization.create({
          data: {
            name: data.name || data.email.split("@")[0],
            slug: makeOrgSlug(data.email.split("@")[0]),
          },
        });

        const user = await prisma.user.create({
          data: {
            email: data.email,
            name: data.name,
            image: data.image,
            emailVerified: data.emailVerified,
            organizationId: org.id,
            role: "admin",
          },
        });

        await prisma.userSimulationProfile.create({
          data: {
            userId: user.id,
            initialBalanceUsd: 10000,
            riskPerTradePct: 1.5,
            leverage: 5,
            maxOpenTrades: 8,
          },
        });

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          emailVerified: user.emailVerified,
        } as AdapterUser;
      },
    } as Adapter;

    return realAdapter;
  };

  // Return a lazy proxy that initializes on first method call
  return {
    async createUser(data: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).createUser(data as any);
    },
    async getUser(id: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).getUser?.(id as any) ?? null;
    },
    async getUserByEmail(email: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).getUserByEmail?.(email as any) ?? null;
    },
    async getUserByAccount(account: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).getUserByAccount?.(account as any) ?? null;
    },
    async updateUser(user: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).updateUser?.(user as any) as any;
    },
    async deleteUser(id: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).deleteUser?.(id as any) ?? undefined;
    },
    async linkAccount(account: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).linkAccount?.(account as any) ?? undefined;
    },
    async unlinkAccount(account: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).unlinkAccount?.(account as any) ?? undefined;
    },
    async createSession(session: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).createSession?.(session as any) as any;
    },
    async getSessionAndUser(sessionToken: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).getSessionAndUser?.(sessionToken as any) as any;
    },
    async updateSession(session: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).updateSession?.(session as any) ?? null;
    },
    async deleteSession(sessionToken: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).deleteSession?.(sessionToken as any) ?? undefined;
    },
    async createVerificationToken(verificationToken: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).createVerificationToken?.(verificationToken as any) as any;
    },
    async useVerificationToken(verificationToken: unknown) {
      const adapter = await initializeAdapter();
      return (adapter as any).useVerificationToken?.(verificationToken as any) ?? null;
    },
  } as Adapter;
}

export const authOptions: NextAuthOptions = {
  adapter: createLazyAdapter(),
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    }),
    CredentialsProvider({
      id: "credentials",
      name: "Email/Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error("Missing credentials");
        }

        const response = await fetch(`${API_BASE}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: credentials.email,
            password: credentials.password,
          }),
        });

        if (!response.ok) {
          throw new Error("Invalid credentials");
        }

        const user = await response.json();
        return user;
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      console.log("[NextAuth] signIn called:", { provider: account?.provider, email: user.email });

      // Allow all sign-ins; adapter createUser enforces required tenant data.
      return true;
    },
    async jwt({ token, user, account }) {
      console.log("[NextAuth] jwt callback:", { hasUser: !!user, provider: account?.provider });
      if (user) {
        // For OAuth users, fetch from database to get organizationId
        if (account?.provider !== "credentials") {
          const prisma = await getPrismaClient();
          const dbUser = await prisma.user.findUnique({
            where: { email: user.email! },
          });
          if (dbUser) {
            token.userId = dbUser.id;
            token.organizationId = dbUser.organizationId;
            console.log("[NextAuth] JWT updated with userId:", dbUser.id);
          }
        } else {
          // For credentials, user object contains these from the login response
          // But also fetch from DB to ensure organizationId is always correct
          token.userId = (user as any).userId;
          token.organizationId = (user as any).organizationId;
          // If organizationId missing from login response, fetch from DB
          if (!token.organizationId && token.userId) {
            const prisma = await getPrismaClient();
            const dbUser = await prisma.user.findUnique({ where: { id: String(token.userId) } });
            if (dbUser) token.organizationId = dbUser.organizationId;
          }
        }
      }
      // Always regenerate the signed API JWT when userId/organizationId are present
      // This is the token that gets sent to the API server for authentication
      if (token.userId && token.organizationId) {
        token.jwtToken = jwt.sign(
          { userId: token.userId, organizationId: token.organizationId },
          JWT_SECRET,
          { expiresIn: "7d" }
        );
      }
      return token;
    },
    async session({ session, token }) {
      console.log("[NextAuth] session callback");
      if (session.user) {
        (session.user as any).userId = token.userId;
        (session.user as any).organizationId = token.organizationId;
        (session.user as any).jwtToken = token.jwtToken;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: {
    strategy: "jwt",
  },
  secret: process.env.NEXTAUTH_SECRET,
};
