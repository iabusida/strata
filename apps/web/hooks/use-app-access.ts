"use client";

import { useEffect, useMemo, useState } from "react";
import type { TradingProfile } from "../components/profile-selector";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787").replace(/\/+$/, "");

export type AccessState = {
  mode: "open" | "licensed";
  plan: "FREE" | "PRO" | "ELITE";
  status: "ACTIVE" | "TRIALING" | "PAST_DUE" | "INACTIVE";
  source: "license_file" | "environment";
  requiresSubscription: boolean;
  isSubscribed: boolean;
  message: string | null;
  features: {
    dashboard: boolean;
    liveState: boolean;
    onDemandScan: boolean;
    backgroundAutomation: boolean;
    telegramAlerts: boolean;
    manualTradeControls: boolean;
  };
  limits: {
    maxScanTokens: number;
    maxActiveTrades: number;
  };
};

export type AccessEntitlements = {
  isResolved: boolean;
  planLabel: string;
  statusLabel: string;
  isFreeTier: boolean;
  isPremiumUnlocked: boolean;
  forcedProfile: TradingProfile | null;
  maxVisibleSignals: number | null;
  visibleTopOpportunityCount: number;
  lockTradeSetup: boolean;
  lockSimulation: boolean;
  lockEntryZone: boolean;
  lockTriggerDetails: boolean;
  lockRiskDetails: boolean;
  upgradeLabel: string;
  upgradeMessage: string;
};

function getResolvedPlan(access: AccessState | null): "FREE" | "PRO" | "ELITE" | "OPEN" | "UNKNOWN" {
  if (!access) {
    return "UNKNOWN";
  }

  if (access.mode === "open") {
    return "OPEN";
  }

  if (!access.isSubscribed) {
    return "FREE";
  }

  return access.plan;
}

export function deriveAccessEntitlements(access: AccessState | null): AccessEntitlements {
  const resolvedPlan = getResolvedPlan(access);
  const isFreeTier = resolvedPlan === "FREE";
  const isPremiumUnlocked = resolvedPlan === "OPEN" || resolvedPlan === "PRO" || resolvedPlan === "ELITE";

  if (!access) {
    return {
      isResolved: false,
      planLabel: "Access status loading",
      statusLabel: "Unresolved",
      isFreeTier: false,
      isPremiumUnlocked: true,
      forcedProfile: null,
      maxVisibleSignals: null,
      visibleTopOpportunityCount: 3,
      lockTradeSetup: false,
      lockSimulation: false,
      lockEntryZone: false,
      lockTriggerDetails: false,
      lockRiskDetails: false,
      upgradeLabel: "Unlock Pro",
      upgradeMessage: "Access status is still loading.",
    };
  }

  if (isFreeTier) {
    return {
      isResolved: true,
      planLabel: "FREE",
      statusLabel: access.status,
      isFreeTier: true,
      isPremiumUnlocked: false,
      forcedProfile: "day",
      maxVisibleSignals: 3,
      visibleTopOpportunityCount: 1,
      lockTradeSetup: true,
      lockSimulation: true,
      lockEntryZone: true,
      lockTriggerDetails: true,
      lockRiskDetails: true,
      upgradeLabel: "Unlock Pro Decision Layer",
      upgradeMessage: "Free shows the decision first. Pro unlocks the execution layer.",
    };
  }

  return {
    isResolved: true,
    planLabel: access.mode === "open" ? "OPEN" : access.plan,
    statusLabel: access.status,
    isFreeTier: false,
    isPremiumUnlocked: isPremiumUnlocked,
    forcedProfile: null,
    maxVisibleSignals: null,
    visibleTopOpportunityCount: 3,
    lockTradeSetup: false,
    lockSimulation: false,
    lockEntryZone: false,
    lockTriggerDetails: false,
    lockRiskDetails: false,
    upgradeLabel: access.mode === "open" ? "Open access active" : "Pro unlocked",
    upgradeMessage: access.message ?? "Full setup, trigger, and simulation tools are available.",
  };
}

export function useAppAccess(): {
  access: AccessState | null;
  entitlements: AccessEntitlements;
  isLoading: boolean;
  error: string | null;
} {
  const [access, setAccess] = useState<AccessState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadAccess(): Promise<void> {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(`${API_BASE}/api/access`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Failed to load access state (${response.status})`);
        }

        const payload = (await response.json()) as AccessState;
        if (!cancelled) {
          setAccess(payload);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
          setAccess(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadAccess();

    return () => {
      cancelled = true;
    };
  }, []);

  const entitlements = useMemo(() => deriveAccessEntitlements(access), [access]);

  return {
    access,
    entitlements,
    isLoading,
    error,
  };
}
