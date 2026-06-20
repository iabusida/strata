"use client";

import { useCallback, useEffect, useState } from "react";
import { TradingProfile, RiskLevel } from "../components/profile-selector";

const PROFILE_STORAGE_KEY = "strata_user_profile";
const RISK_LEVEL_STORAGE_KEY = "strata_user_risk_level";

export interface UserProfileState {
  profile: TradingProfile;
  riskLevel: RiskLevel;
}

/**
 * Hook to manage user's trading profile with localStorage persistence
 */
export function useUserProfile(): UserProfileState & {
  setProfile: (profile: TradingProfile) => void;
  setRiskLevel: (riskLevel: RiskLevel) => void;
  isLoading: boolean;
} {
  const [profile, setProfileState] = useState<TradingProfile>("swing");
  const [riskLevel, setRiskLevelState] = useState<RiskLevel>("medium");
  const [isLoading, setIsLoading] = useState(true);

  // Load from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(PROFILE_STORAGE_KEY);
    const savedRisk = localStorage.getItem(RISK_LEVEL_STORAGE_KEY);

    if (saved) {
      setProfileState(saved as TradingProfile);
    }

    if (savedRisk) {
      setRiskLevelState(savedRisk as RiskLevel);
    }

    setIsLoading(false);
  }, []);

  const setProfile = useCallback((newProfile: TradingProfile) => {
    setProfileState(newProfile);
    localStorage.setItem(PROFILE_STORAGE_KEY, newProfile);

    // Broadcast to other tabs
    window.dispatchEvent(
      new CustomEvent("profileChanged", { detail: { profile: newProfile } })
    );
  }, []);

  const setRiskLevel = useCallback((newRiskLevel: RiskLevel) => {
    setRiskLevelState(newRiskLevel);
    localStorage.setItem(RISK_LEVEL_STORAGE_KEY, newRiskLevel);

    // Broadcast to other tabs
    window.dispatchEvent(
      new CustomEvent("riskLevelChanged", { detail: { riskLevel: newRiskLevel } })
    );
  }, []);

  return {
    profile,
    riskLevel,
    setProfile,
    setRiskLevel,
    isLoading,
  };
}

/**
 * Hook to listen for profile changes from other tabs
 */
export function useProfileChangeListener(
  callback: (profile: TradingProfile, riskLevel: RiskLevel) => void
) {
  useEffect(() => {
    const handleProfileChange = (event: Event) => {
      const customEvent = event as CustomEvent;
      const profile = customEvent.detail?.profile as TradingProfile;
      const riskLevel = localStorage.getItem(RISK_LEVEL_STORAGE_KEY) as RiskLevel;

      if (profile) {
        callback(profile, riskLevel || "medium");
      }
    };

    const handleRiskChange = (event: Event) => {
      const customEvent = event as CustomEvent;
      const riskLevel = customEvent.detail?.riskLevel as RiskLevel;
      const profile = localStorage.getItem(PROFILE_STORAGE_KEY) as TradingProfile;

      if (riskLevel) {
        callback(profile || "swing", riskLevel);
      }
    };

    window.addEventListener("profileChanged", handleProfileChange);
    window.addEventListener("riskLevelChanged", handleRiskChange);

    return () => {
      window.removeEventListener("profileChanged", handleProfileChange);
      window.removeEventListener("riskLevelChanged", handleRiskChange);
    };
  }, [callback]);
}
