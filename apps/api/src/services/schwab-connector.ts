import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { loadPlatformConfig } from "../config/platform-config.js";

const prisma = new PrismaClient();

const SCHWAB_API_BASE = "https://api.schwabapi.com";
const SCHWAB_OAUTH_BASE = "https://auth.schwab.com";

export interface SchwabOAuthToken {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export interface SchwabAccount {
  accountNumber: string;
  type: string;
  nickname?: string;
  isDayTrader: boolean;
  isClosingOnlyRestricted: boolean;
  initialBalances: {
    accountValue: number;
    cashBalance: number;
    buyingPower: number;
  };
  currentBalances: {
    accountValue: number;
    cashBalance: number;
    buyingPower: number;
  };
}

export interface SchwabCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number;
}

export class SchwabConnector {
  private accessToken?: string;
  private refreshToken?: string;

  async getOAuthUrl(): Promise<string> {
    const config = await loadPlatformConfig(prisma);
    const schwabCreds = config.exchangeCredentials.schwab;

    if (!schwabCreds) {
      throw new Error("Schwab credentials not configured");
    }

    const params = new URLSearchParams({
      client_id: schwabCreds.clientId,
      redirect_uri: schwabCreds.redirectUri,
      response_type: "code",
      scope: "PlaceTrades AccountAccess MoveMoney",
    });

    return `${SCHWAB_OAUTH_BASE}/oauth/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<SchwabOAuthToken> {
    const config = await loadPlatformConfig(prisma);
    const schwabCreds = config.exchangeCredentials.schwab;

    if (!schwabCreds) {
      throw new Error("Schwab credentials not configured");
    }

    try {
      const response = await axios.post(
        `${SCHWAB_OAUTH_BASE}/oauth/token`,
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: schwabCreds.clientId,
          client_secret: schwabCreds.clientSecret,
          redirect_uri: schwabCreds.redirectUri,
        }),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }
      );

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;

      return response.data;
    } catch (error) {
      console.error("OAuth token exchange failed:", error);
      throw new Error("Failed to exchange code for token");
    }
  }

  async getAccounts(): Promise<SchwabAccount[]> {
    if (!this.accessToken) {
      throw new Error("Not authenticated");
    }

    try {
      const response = await axios.get(`${SCHWAB_API_BASE}/trader/v1/accounts`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      return response.data;
    } catch (error) {
      console.error("Failed to fetch accounts:", error);
      throw new Error("Failed to fetch Schwab accounts");
    }
  }

  async getCandles(
    symbol: string,
    periodType: string,
    period: number,
    frequencyType: string,
    frequency: number,
    endDate?: number
  ): Promise<SchwabCandle[]> {
    if (!this.accessToken) {
      throw new Error("Not authenticated");
    }

    try {
      const params = new URLSearchParams({
        periodType,
        period: period.toString(),
        frequencyType,
        frequency: frequency.toString(),
        ...(endDate && { endDate: endDate.toString() }),
      });

      const response = await axios.get(
        `${SCHWAB_API_BASE}/marketdata/v1/${symbol}/pricehistory?${params}`,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        }
      );

      return response.data.candles || [];
    } catch (error) {
      console.error(`Failed to fetch candles for ${symbol}:`, error);
      throw new Error(`Failed to fetch candles for ${symbol}`);
    }
  }

  async getAccountBalance(accountNumber: string): Promise<number> {
    if (!this.accessToken) {
      throw new Error("Not authenticated");
    }

    try {
      const response = await axios.get(
        `${SCHWAB_API_BASE}/trader/v1/accounts/${accountNumber}`,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        }
      );

      return response.data.securitiesAccount?.currentBalances?.accountValue || 0;
    } catch (error) {
      console.error("Failed to fetch account balance:", error);
      throw new Error("Failed to fetch account balance");
    }
  }
}

/**
 * Store Schwab tokens for a user
 */
export async function storeSchwabTokens(
  organizationId: string,
  tokens: SchwabOAuthToken
): Promise<void> {
  const config = await prisma.platformConfiguration.findFirst();

  if (!config) {
    throw new Error("Platform config not found");
  }

  const credentials = (config.exchangeCredentials as any) || {};

  if (!credentials.schwab) {
    credentials.schwab = {};
  }

  credentials.schwab.accessToken = tokens.access_token;
  credentials.schwab.refreshToken = tokens.refresh_token;
  credentials.schwab.tokenExpiresAt = Date.now() + tokens.expires_in * 1000;

  await prisma.platformConfiguration.update({
    where: { id: config.id },
    data: {
      exchangeCredentials: credentials,
    },
  });
}
