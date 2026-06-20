import { TradingMode, StrategyConfig } from "@prisma/client";
import { prisma } from "./prisma-client.js";

export interface StrategySettings {
  tradingMode: TradingMode;
  enableFibonacci: boolean;
  enableCipherB: boolean;
  enableVWAP: boolean;
  enableEMA: boolean;
  enableStructure: boolean;
  enableOrderFlow: boolean;
  enableATR: boolean;
  enableRSI: boolean;
  fiboTargetLevels: number[];
  cipherBSensitivity: number;
  dayTradingMaxHoldTime: number;
  swingTradingMaxHoldTime: number;
  dayTradingTpPct: number;
  swingTradingTpPct: number;
  dayTradingSlPct: number;
  swingTradingSlPct: number;
}

let cachedConfig: StrategyConfig | null = null;

async function ensureConfigExists(): Promise<StrategyConfig> {
  try {
    let config = await prisma.strategyConfig.findUnique({
      where: { id: 1 },
    });

    if (!config) {
      config = await prisma.strategyConfig.create({
        data: {
          id: 1,
          tradingMode: "DAY_TRADING",
          enableFibonacci: true,
          enableCipherB: true,
          enableVWAP: true,
          enableEMA: true,
          enableStructure: true,
          enableOrderFlow: true,
          enableATR: true,
          enableRSI: true,
          fiboTargetLevels: "0.23,0.38,0.5,0.618,0.786",
          cipherBSensitivity: 0.85,
          dayTradingMaxHoldTime: 1440,
          swingTradingMaxHoldTime: 10080,
          dayTradingTpPct: 2.0,
          swingTradingTpPct: 5.0,
          dayTradingSlPct: 1.5,
          swingTradingSlPct: 3.0,
        },
      });
    }

    cachedConfig = config;
    return config;
  } catch (error) {
    console.error("Failed to ensure strategy config exists:", error);
    throw error;
  }
}

export async function getStrategyConfig(): Promise<StrategySettings> {
  try {
    if (!cachedConfig) {
      cachedConfig = await ensureConfigExists();
    }

    return parseStrategyConfig(cachedConfig);
  } catch (error) {
    console.error("Failed to get strategy config:", error);
    throw error;
  }
}

export async function updateStrategyConfig(
  updates: Partial<Omit<StrategySettings, "fiboTargetLevels">> & {
    fiboTargetLevels?: number[];
  }
): Promise<StrategySettings> {
  try {
    const data: any = { ...updates };

    // Convert array back to comma-separated string if provided
    if (updates.fiboTargetLevels) {
      data.fiboTargetLevels = updates.fiboTargetLevels.join(",");
    }

    delete data.fiboTargetLevels; // Remove from data, we'll handle separately if needed

    const updated = await prisma.strategyConfig.update({
      where: { id: 1 },
      data: updates.fiboTargetLevels
        ? {
            ...data,
            fiboTargetLevels: updates.fiboTargetLevels.join(","),
          }
        : data,
    });

    cachedConfig = updated;
    return parseStrategyConfig(updated);
  } catch (error) {
    console.error("Failed to update strategy config:", error);
    throw error;
  }
}

export async function setTradingMode(
  mode: "DAY_TRADING" | "SWING_TRADING"
): Promise<StrategySettings> {
  try {
    const updated = await prisma.strategyConfig.update({
      where: { id: 1 },
      data: { tradingMode: mode as TradingMode },
    });

    cachedConfig = updated;
    console.log(`✓ Strategy mode switched to: ${mode}`);
    return parseStrategyConfig(updated);
  } catch (error) {
    console.error("Failed to set trading mode:", error);
    throw error;
  }
}

export async function getCurrentTpSlPercentages(): Promise<{
  tpPct: number;
  slPct: number;
}> {
  try {
    const config = await getStrategyConfig();

    if (config.tradingMode === "DAY_TRADING") {
      return {
        tpPct: config.dayTradingTpPct,
        slPct: config.dayTradingSlPct,
      };
    } else {
      return {
        tpPct: config.swingTradingTpPct,
        slPct: config.swingTradingSlPct,
      };
    }
  } catch (error) {
    console.error("Failed to get TP/SL percentages:", error);
    return { tpPct: 2.0, slPct: 1.5 }; // Default day trading
  }
}

export async function getCurrentMaxHoldTime(): Promise<number> {
  try {
    const config = await getStrategyConfig();

    if (config.tradingMode === "DAY_TRADING") {
      return config.dayTradingMaxHoldTime;
    } else {
      return config.swingTradingMaxHoldTime;
    }
  } catch (error) {
    console.error("Failed to get max hold time:", error);
    return 1440; // Default 1 day
  }
}

function parseStrategyConfig(config: StrategyConfig): StrategySettings {
  return {
    tradingMode: config.tradingMode as TradingMode,
    enableFibonacci: config.enableFibonacci,
    enableCipherB: config.enableCipherB,
    enableVWAP: config.enableVWAP,
    enableEMA: config.enableEMA,
    enableStructure: config.enableStructure,
    enableOrderFlow: config.enableOrderFlow,
    enableATR: config.enableATR,
    enableRSI: config.enableRSI,
    fiboTargetLevels: config.fiboTargetLevels
      .split(",")
      .map((x) => parseFloat(x.trim())),
    cipherBSensitivity: config.cipherBSensitivity,
    dayTradingMaxHoldTime: config.dayTradingMaxHoldTime,
    swingTradingMaxHoldTime: config.swingTradingMaxHoldTime,
    dayTradingTpPct: config.dayTradingTpPct,
    swingTradingTpPct: config.swingTradingTpPct,
    dayTradingSlPct: config.dayTradingSlPct,
    swingTradingSlPct: config.swingTradingSlPct,
  };
}

export function getDefaultStrategySettings(): StrategySettings {
  return {
    tradingMode: "DAY_TRADING",
    enableFibonacci: true,
    enableCipherB: true,
    enableVWAP: true,
    enableEMA: true,
    enableStructure: true,
    enableOrderFlow: true,
    enableATR: true,
    enableRSI: true,
    fiboTargetLevels: [0.23, 0.38, 0.5, 0.618, 0.786],
    cipherBSensitivity: 0.85,
    dayTradingMaxHoldTime: 1440,
    swingTradingMaxHoldTime: 10080,
    dayTradingTpPct: 2.0,
    swingTradingTpPct: 5.0,
    dayTradingSlPct: 1.5,
    swingTradingSlPct: 3.0,
  };
}

export async function invalidateCache(): Promise<void> {
  cachedConfig = null;
}
