import {
  AssetType,
  CandleInterval,
  RiskLevel,
  TradingProfileStyle,
  TradingStyle,
  type Prisma,
} from "@prisma/client";
import { prisma } from "./prisma-client.js";
import { generateApiKey, hashApiKey, hashPassword } from "./middleware/auth.js";

type TraderArchetype = {
  key: string;
  email: string;
  name: string;
  password: string;
  profileStyle: TradingProfileStyle;
  riskLevel: RiskLevel;
  minConfidence: number;
  defaultStyle: TradingStyle;
  symbolUniverse: string[];
  riskPerTrade: number;
  maxConcurrentTrades: number;
  simulation: {
    initialBalanceUsd: number;
    riskPerTradePct: number;
    leverage: number;
    maxOpenTrades: number;
  };
  policy: {
    allowedAssetTypes: AssetType[];
    allowedIntervals: CandleInterval[];
    refreshSeconds: number;
    maxUniverseSize: number;
    includeExtendedHours: boolean;
  };
};

const traders: TraderArchetype[] = [
  {
    key: "scalper",
    email: "test.scalper@strata.local",
    name: "Test Scalper",
    password: "Trader123!",
    profileStyle: TradingProfileStyle.SCALP,
    riskLevel: RiskLevel.HIGH,
    minConfidence: 72,
    defaultStyle: TradingStyle.DAY_TRADING,
    symbolUniverse: ["BTC", "ETH", "SOL", "AIXBT"],
    riskPerTrade: 1.0,
    maxConcurrentTrades: 10,
    simulation: {
      initialBalanceUsd: 5000,
      riskPerTradePct: 1.0,
      leverage: 8,
      maxOpenTrades: 10,
    },
    policy: {
      allowedAssetTypes: [AssetType.CRYPTO],
      allowedIntervals: [CandleInterval.M15, CandleInterval.H1],
      refreshSeconds: 15,
      maxUniverseSize: 40,
      includeExtendedHours: false,
    },
  },
  {
    key: "daytrader",
    email: "test.daytrader@strata.local",
    name: "Test Day Trader",
    password: "Trader123!",
    profileStyle: TradingProfileStyle.DAY,
    riskLevel: RiskLevel.MEDIUM,
    minConfidence: 66,
    defaultStyle: TradingStyle.DAY_TRADING,
    symbolUniverse: ["BTC", "ETH", "NVDA", "TSLA", "AAPL"],
    riskPerTrade: 1.5,
    maxConcurrentTrades: 6,
    simulation: {
      initialBalanceUsd: 10000,
      riskPerTradePct: 1.5,
      leverage: 5,
      maxOpenTrades: 8,
    },
    policy: {
      allowedAssetTypes: [AssetType.CRYPTO, AssetType.STOCK, AssetType.FUTURE],
      allowedIntervals: [CandleInterval.M15, CandleInterval.H1, CandleInterval.H4],
      refreshSeconds: 30,
      maxUniverseSize: 60,
      includeExtendedHours: true,
    },
  },
  {
    key: "swingtrader",
    email: "test.swingtrader@strata.local",
    name: "Test Swing Trader",
    password: "Trader123!",
    profileStyle: TradingProfileStyle.SWING,
    riskLevel: RiskLevel.MEDIUM,
    minConfidence: 62,
    defaultStyle: TradingStyle.SWING,
    symbolUniverse: ["BTC", "ETH", "SOL", "AAPL", "MSFT"],
    riskPerTrade: 2.0,
    maxConcurrentTrades: 4,
    simulation: {
      initialBalanceUsd: 15000,
      riskPerTradePct: 2.0,
      leverage: 3,
      maxOpenTrades: 6,
    },
    policy: {
      allowedAssetTypes: [AssetType.CRYPTO, AssetType.STOCK, AssetType.FUTURE],
      allowedIntervals: [CandleInterval.H1, CandleInterval.H4, CandleInterval.H12],
      refreshSeconds: 60,
      maxUniverseSize: 80,
      includeExtendedHours: true,
    },
  },
  {
    key: "longterm",
    email: "test.longterm@strata.local",
    name: "Test Long Term",
    password: "Trader123!",
    profileStyle: TradingProfileStyle.LONG_TERM,
    riskLevel: RiskLevel.LOW,
    minConfidence: 58,
    defaultStyle: TradingStyle.LONG_TERM,
    symbolUniverse: ["BTC", "ETH", "SPY", "QQQ", "AAPL"],
    riskPerTrade: 3.0,
    maxConcurrentTrades: 3,
    simulation: {
      initialBalanceUsd: 25000,
      riskPerTradePct: 3.0,
      leverage: 1,
      maxOpenTrades: 3,
    },
    policy: {
      allowedAssetTypes: [AssetType.CRYPTO, AssetType.STOCK],
      allowedIntervals: [CandleInterval.D1, CandleInterval.H12],
      refreshSeconds: 300,
      maxUniverseSize: 120,
      includeExtendedHours: true,
    },
  },
];

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function ensureDefaultStyleConfig(userId: string, trader: TraderArchetype): Promise<void> {
  const sharedSettings: Prisma.UserConfigurationUncheckedCreateInput = {
    userId,
    tradingStyle: trader.defaultStyle,
    symbolUniverse: trader.symbolUniverse,
    riskPerTrade: trader.riskPerTrade,
    maxConcurrentTrades: trader.maxConcurrentTrades,
    dayTradeSettings: { maxHoldMinutes: 1440, tpPct: 2.0, slPct: 1.2 },
    swingSettings: { maxHoldDays: 14, tpPct: 5.0, slPct: 3.0 },
    longTermSettings: { maxHoldDays: 90, tpPct: 20.0, slPct: 10.0 },
    spotSettings: { maxHoldDays: 7, tpPct: 3.0, slPct: 2.0 },
  };

  await prisma.userConfiguration.upsert({
    where: {
      userId_tradingStyle: {
        userId,
        tradingStyle: trader.defaultStyle,
      },
    },
    update: {
      symbolUniverse: trader.symbolUniverse,
      riskPerTrade: trader.riskPerTrade,
      maxConcurrentTrades: trader.maxConcurrentTrades,
    },
    create: sharedSettings,
  });

  await prisma.styleMarketPolicy.upsert({
    where: {
      userId_tradingStyle: {
        userId,
        tradingStyle: trader.defaultStyle,
      },
    },
    update: {
      allowedAssetTypes: trader.policy.allowedAssetTypes,
      allowedIntervals: trader.policy.allowedIntervals,
      refreshSeconds: trader.policy.refreshSeconds,
      maxUniverseSize: trader.policy.maxUniverseSize,
      includeExtendedHours: trader.policy.includeExtendedHours,
    },
    create: {
      userId,
      tradingStyle: trader.defaultStyle,
      allowedAssetTypes: trader.policy.allowedAssetTypes,
      allowedIntervals: trader.policy.allowedIntervals,
      refreshSeconds: trader.policy.refreshSeconds,
      maxUniverseSize: trader.policy.maxUniverseSize,
      includeExtendedHours: trader.policy.includeExtendedHours,
    },
  });
}

async function main() {
  console.log("Seeding trader archetype accounts...");

  for (const trader of traders) {
    const orgSlug = `test-${slugify(trader.key)}-${slugify(trader.defaultStyle)}`;

    const org = await prisma.organization.upsert({
      where: { slug: orgSlug },
      update: {
        name: `${trader.name} Org`,
      },
      create: {
        name: `${trader.name} Org`,
        slug: orgSlug,
      },
    });

    const user = await prisma.user.upsert({
      where: { email: trader.email },
      update: {
        name: trader.name,
        passwordHash: hashPassword(trader.password),
        organizationId: org.id,
        role: "admin",
      },
      create: {
        email: trader.email,
        name: trader.name,
        passwordHash: hashPassword(trader.password),
        organizationId: org.id,
        role: "admin",
      },
    });

    await prisma.userTradingProfile.upsert({
      where: { userId: user.id },
      update: {
        style: trader.profileStyle,
        riskLevel: trader.riskLevel,
        minConfidence: trader.minConfidence,
      },
      create: {
        userId: user.id,
        style: trader.profileStyle,
        riskLevel: trader.riskLevel,
        minConfidence: trader.minConfidence,
      },
    });

    await prisma.userSimulationProfile.upsert({
      where: { userId: user.id },
      update: {
        initialBalanceUsd: trader.simulation.initialBalanceUsd,
        riskPerTradePct: trader.simulation.riskPerTradePct,
        leverage: trader.simulation.leverage,
        maxOpenTrades: trader.simulation.maxOpenTrades,
      },
      create: {
        userId: user.id,
        initialBalanceUsd: trader.simulation.initialBalanceUsd,
        riskPerTradePct: trader.simulation.riskPerTradePct,
        leverage: trader.simulation.leverage,
        maxOpenTrades: trader.simulation.maxOpenTrades,
      },
    });

    await ensureDefaultStyleConfig(user.id, trader);

    const keyName = "test-dashboard-key";
    const existingKey = await prisma.apiKey.findFirst({
      where: {
        organizationId: org.id,
        name: keyName,
        revokedAt: null,
      },
    });

    let rawApiKey: string | null = null;
    if (!existingKey) {
      rawApiKey = generateApiKey();
      await prisma.apiKey.create({
        data: {
          organizationId: org.id,
          name: keyName,
          keyHash: hashApiKey(rawApiKey),
        },
      });
    }

    console.log("---");
    console.log(`Account: ${trader.name}`);
    console.log(`Email: ${trader.email}`);
    console.log(`Password: ${trader.password}`);
    console.log(`Default style: ${trader.defaultStyle}`);
    if (rawApiKey) {
      console.log(`API key (save now): ${rawApiKey}`);
    } else {
      console.log("API key: already exists (not reprinted)");
    }
  }

  console.log("Trader archetype seeding complete.");
}

main()
  .catch((error) => {
    console.error("Failed to seed trader archetypes:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
