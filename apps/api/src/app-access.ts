import "./env.js";
import { loadLicenseSync } from "./license-store.js";

export type AccessMode = "open" | "licensed";
export type AccessPlan = "FREE" | "PRO" | "ELITE";
export type SubscriptionStatus = "ACTIVE" | "TRIALING" | "PAST_DUE" | "INACTIVE";
export type AccessFeature =
  | "dashboard"
  | "liveState"
  | "onDemandScan"
  | "backgroundAutomation"
  | "telegramAlerts"
  | "manualTradeControls";

export type AppAccessState = {
  mode: AccessMode;
  plan: AccessPlan;
  status: SubscriptionStatus;
  source: "license_file" | "environment";
  requiresSubscription: boolean;
  isSubscribed: boolean;
  message: string | null;
  features: Record<AccessFeature, boolean>;
  limits: {
    maxScanTokens: number;
    maxActiveTrades: number;
  };
};

type PlanProfile = {
  features: Record<AccessFeature, boolean>;
  limits: AppAccessState["limits"];
};

const MAX_SCAN_TOKENS = 200;

const PLAN_PROFILES: Record<AccessPlan, PlanProfile> = {
  FREE: {
    features: {
      dashboard: true,
      liveState: true,
      onDemandScan: true,
      backgroundAutomation: false,
      telegramAlerts: false,
      manualTradeControls: false
    },
    limits: {
      maxScanTokens: 30,
      maxActiveTrades: 0
    }
  },
  PRO: {
    features: {
      dashboard: true,
      liveState: true,
      onDemandScan: true,
      backgroundAutomation: true,
      telegramAlerts: true,
      manualTradeControls: true
    },
    limits: {
      maxScanTokens: 120,
      maxActiveTrades: 3
    }
  },
  ELITE: {
    features: {
      dashboard: true,
      liveState: true,
      onDemandScan: true,
      backgroundAutomation: true,
      telegramAlerts: true,
      manualTradeControls: true
    },
    limits: {
      maxScanTokens: MAX_SCAN_TOKENS,
      maxActiveTrades: 10
    }
  }
};

function normalizeAccessMode(value: string | undefined): AccessMode {
  return value?.trim().toLowerCase() === "licensed" ? "licensed" : "open";
}

function normalizePlan(value: string | undefined): AccessPlan {
  const candidate = value?.trim().toUpperCase();
  if (candidate === "FREE" || candidate === "PRO" || candidate === "ELITE") {
    return candidate;
  }

  return "PRO";
}

function normalizeStatus(value: string | undefined): SubscriptionStatus {
  const candidate = value?.trim().toUpperCase();
  if (candidate === "ACTIVE" || candidate === "TRIALING" || candidate === "PAST_DUE" || candidate === "INACTIVE") {
    return candidate;
  }

  return "ACTIVE";
}

function resolveRestrictedMessage(status: SubscriptionStatus): string {
  if (status === "PAST_DUE") {
    return "Subscription is past due. Background automation and trade controls are locked until billing is restored.";
  }

  if (status === "INACTIVE") {
    return "No active subscription. Background automation and trade controls are locked.";
  }

  return "Subscription is not active enough to unlock premium automation.";
}

export function getAppAccessState(): AppAccessState {
  // License file takes precedence; env vars are the final fallback for quick bootstrapping.
  const license = loadLicenseSync();
  const source: AppAccessState["source"] = "license_file";

  const mode: AccessMode = license.mode;
  const plan: AccessPlan = license.plan;
  const status: SubscriptionStatus = license.status;
  const planProfile = PLAN_PROFILES[plan];

  const resolvedLimits: AppAccessState["limits"] = {
    maxScanTokens:
      license.maxScanTokensOverride != null
        ? Math.min(MAX_SCAN_TOKENS, license.maxScanTokensOverride)
        : planProfile.limits.maxScanTokens,
    maxActiveTrades:
      license.maxActiveTradesOverride != null
        ? license.maxActiveTradesOverride
        : planProfile.limits.maxActiveTrades
  };

  if (mode === "open") {
    return {
      mode,
      plan,
      status,
      source,
      requiresSubscription: false,
      isSubscribed: true,
      message: null,
      features: {
        dashboard: true,
        liveState: true,
        onDemandScan: true,
        backgroundAutomation: true,
        telegramAlerts: true,
        manualTradeControls: true
      },
      limits: {
        maxScanTokens: resolvedLimits.maxScanTokens > 0 ? resolvedLimits.maxScanTokens : MAX_SCAN_TOKENS,
        maxActiveTrades: resolvedLimits.maxActiveTrades > 0 ? resolvedLimits.maxActiveTrades : planProfile.limits.maxActiveTrades
      }
    };
  }

  const isSubscribed = status === "ACTIVE" || status === "TRIALING";
  const restrictedFeatures: Record<AccessFeature, boolean> = {
    dashboard: true,
    liveState: true,
    onDemandScan: true,
    backgroundAutomation: false,
    telegramAlerts: false,
    manualTradeControls: false
  };

  return {
    mode,
    plan,
    status,
    source,
    requiresSubscription: true,
    isSubscribed,
    message: isSubscribed ? null : resolveRestrictedMessage(status),
    features: isSubscribed ? { ...planProfile.features } : restrictedFeatures,
    limits: isSubscribed
      ? resolvedLimits
      : {
          maxScanTokens: PLAN_PROFILES.FREE.limits.maxScanTokens,
          maxActiveTrades: 0
        }
  };
}

export function isFeatureEnabled(feature: AccessFeature): boolean {
  return getAppAccessState().features[feature];
}

export function getEffectiveScanLimit(requestedLimit: number): number {
  const maxScanTokens = getAppAccessState().limits.maxScanTokens;
  return Math.max(1, Math.min(MAX_SCAN_TOKENS, Math.min(Math.trunc(requestedLimit), maxScanTokens)));
}

export function getFeatureLock(feature: AccessFeature): {
  allowed: boolean;
  statusCode: number;
  body: {
    error: string;
    feature: AccessFeature;
    access: AppAccessState;
  };
} {
  const access = getAppAccessState();
  const allowed = access.features[feature];

  return {
    allowed,
    statusCode: allowed ? 200 : 403,
    body: {
      error: allowed
        ? ""
        : `Feature ${feature} is unavailable for plan ${access.plan} with subscription status ${access.status}`,
      feature,
      access
    }
  };
}
