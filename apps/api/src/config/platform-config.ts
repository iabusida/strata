import { PrismaClient } from "@prisma/client";

export interface ExchangeCredentials {
  schwab?: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  coinbase?: {
    apiKey: string;
    apiSecret: string;
  };
  hyperliquid?: {
    apiKey: string;
    apiSecret: string;
  };
}

export interface BackfillPolicy {
  hoursWindow: number;
  maxSymbolsPerRun: number;
  retryMaxAttempts: number;
  retryDelayMs: number;
}

export interface IndicatorDefaults {
  stochPeriod: number;
  stochK: number;
  stochD: number;
  emaLengths: number[];
  rsiPeriod: number;
  atrPeriod: number;
}

export interface AlertChannels {
  telegram?: {
    botToken: string;
    chatId: string;
  };
  email?: {
    enabled: boolean;
    provider: string;
  };
  webhook?: {
    enabled: boolean;
    url: string;
  };
}

export interface RiskDefaults {
  maxConcurrentTrades: number;
  maxRiskPerTrade: number;
  maxDrawdownPct: number;
}

export interface PlatformConfig {
  exchangeCredentials: ExchangeCredentials;
  backfillPolicy: BackfillPolicy;
  indicatorDefaults: IndicatorDefaults;
  alertChannels: AlertChannels;
  riskDefaults: RiskDefaults;
}

let cachedConfig: PlatformConfig | null = null;

export async function loadPlatformConfig(
  prisma: PrismaClient
): Promise<PlatformConfig> {
  if (cachedConfig) return cachedConfig;

  const config = await prisma.platformConfiguration.findFirst();

  if (!config) {
    throw new Error(
      "Platform configuration not initialized. Please seed PlatformConfiguration in database."
    );
  }

  cachedConfig = {
    exchangeCredentials: config.exchangeCredentials as ExchangeCredentials,
    backfillPolicy: config.backfillPolicy as unknown as BackfillPolicy,
    indicatorDefaults: config.indicatorDefaults as unknown as IndicatorDefaults,
    alertChannels: config.alertChannels as AlertChannels,
    riskDefaults: config.riskDefaults as unknown as RiskDefaults,
  };

  return cachedConfig;
}

export function invalidatePlatformConfigCache() {
  cachedConfig = null;
}
