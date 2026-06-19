import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function seed() {
  console.log("🌱 Seeding database...");

  // Create default platform configuration
  let platformConfig = await prisma.platformConfiguration.findFirst();

  if (!platformConfig) {
    platformConfig = await prisma.platformConfiguration.create({
      data: {
        exchangeCredentials: {
          schwab: {
            clientId: process.env.SCHWAB_CLIENT_ID || "YOUR_SCHWAB_CLIENT_ID",
            clientSecret:
              process.env.SCHWAB_CLIENT_SECRET || "YOUR_SCHWAB_CLIENT_SECRET",
            redirectUri:
              process.env.SCHWAB_REDIRECT_URI || "http://localhost:8787/auth/schwab/callback",
          },
          coinbase: {
            apiKey: process.env.COINBASE_API_KEY || "YOUR_COINBASE_API_KEY",
            apiSecret:
              process.env.COINBASE_API_SECRET || "YOUR_COINBASE_API_SECRET",
          },
        },
        backfillPolicy: {
          hoursWindow: 90,
          maxSymbolsPerRun: 50,
          retryMaxAttempts: 3,
          retryDelayMs: 5000,
        },
        indicatorDefaults: {
          stochPeriod: 14,
          stochK: 3,
          stochD: 3,
          emaLengths: [9, 21, 55],
          rsiPeriod: 14,
          atrPeriod: 14,
        },
        alertChannels: {
          telegram: {
            botToken: process.env.TELEGRAM_BOT_TOKEN || "YOUR_TELEGRAM_BOT_TOKEN",
            chatId: process.env.TELEGRAM_CHAT_ID || "YOUR_TELEGRAM_CHAT_ID",
          },
          webhook: {
            enabled: false,
            url: process.env.WEBHOOK_URL || "https://your-webhook.com",
          },
        },
        riskDefaults: {
          maxConcurrentTrades: 3,
          maxRiskPerTrade: 2,
          maxDrawdownPct: 5,
        },
      },
    });

    console.log("✅ Created PlatformConfiguration");
  } else {
    console.log("ℹ️  PlatformConfiguration already exists");
  }

  // Create default organization
  let org = await prisma.organization.findUnique({
    where: { slug: "default" },
  });

  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: "Default Organization",
        slug: "default",
      },
    });

    console.log("✅ Created Organization:", org.id);
  } else {
    console.log("ℹ️  Organization already exists");
  }

  // Create demo user
  let user = await prisma.user.findUnique({
    where: { email: "demo@hype.trading" },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        email: "demo@hype.trading",
        organizationId: org.id,
        role: "admin",
      },
    });

    console.log("✅ Created Demo User:", user.id);
  } else {
    console.log("ℹ️  Demo User already exists");
  }

  // Create demo API key
  const { generateApiKey, hashApiKey } = await import(
    "../src/middleware/auth.js"
  );
  let apiKey = await prisma.apiKey.findFirst({
    where: { organizationId: org.id, name: "demo-key" },
  });

  if (!apiKey) {
    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);

    apiKey = await prisma.apiKey.create({
      data: {
        organizationId: org.id,
        name: "demo-key",
        keyHash,
      },
    });

    console.log("✅ Created Demo API Key");
    console.log(`   🔑 Key: ${rawKey}`);
    console.log("   ⚠️  Save this key securely - it will not be shown again");
  } else {
    console.log("ℹ️  Demo API Key already exists");
  }

  // Create user trading styles
  for (const style of [
    "DAY_TRADING",
    "SWING",
    "LONG_TERM",
    "SPOT_SHORT",
  ] as const) {
    const existing = await prisma.userConfiguration.findUnique({
      where: {
        userId_tradingStyle: {
          userId: user.id,
          tradingStyle: style,
        },
      },
    });

    if (!existing) {
      await prisma.userConfiguration.create({
        data: {
          userId: user.id,
          tradingStyle: style,
          symbolUniverse: ["BTC", "ETH", "AAPL", "GOOGL"],
          riskPerTrade: 2.0,
          maxConcurrentTrades: 3,
          dayTradeSettings: {
            maxHoldMinutes: 1440,
            tpPct: 2.0,
            slPct: 1.5,
          },
          swingSettings: {
            maxHoldDays: 14,
            tpPct: 5.0,
            slPct: 3.0,
          },
          longTermSettings: {
            maxHoldDays: 90,
            tpPct: 20.0,
            slPct: 10.0,
          },
          spotSettings: {
            maxHoldDays: 7,
            tpPct: 3.0,
            slPct: 2.0,
          },
        },
      });

      console.log(`✅ Created UserConfiguration for ${style}`);
    }

    const policyExists = await prisma.styleMarketPolicy.findUnique({
      where: {
        userId_tradingStyle: {
          userId: user.id,
          tradingStyle: style,
        },
      },
    });

    if (!policyExists) {
      await prisma.styleMarketPolicy.create({
        data: {
          userId: user.id,
          tradingStyle: style,
          allowedAssetTypes:
            style === "LONG_TERM"
              ? ["CRYPTO", "STOCK", "FUTURE"]
              : style === "SPOT_SHORT"
              ? ["CRYPTO", "STOCK"]
              : ["CRYPTO", "STOCK", "FUTURE", "OPTION"],
          allowedIntervals:
            style === "DAY_TRADING"
              ? ["M15", "H1"]
              : style === "LONG_TERM"
              ? ["D1", "H12"]
              : ["H1", "H4", "D1"],
          refreshSeconds: style === "DAY_TRADING" ? 30 : 60,
          maxUniverseSize: style === "LONG_TERM" ? 100 : 50,
          includeExtendedHours: style !== "SPOT_SHORT",
        },
      });

      console.log(`✅ Created StyleMarketPolicy for ${style}`);
    }
  }

  console.log("🌱 Seeding complete!");
}

seed()
  .catch((error) => {
    console.error("Seeding failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
