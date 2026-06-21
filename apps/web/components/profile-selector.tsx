"use client";

export type TradingProfile = "scalp" | "day" | "swing" | "long_term";
export type RiskLevel = "low" | "medium" | "high";

export interface ProfileConfig {
  id: TradingProfile;
  name: string;
  emoji: string;
  description: string;
  minConfidence: number;
  holdTime: string;
  strategy: string;
  timeframeWeighting: string;
  structureCriteria: string;
  nextStepGuidance: string;
  opportunityFocus: string;
}

export const PROFILE_OPTIONS: ProfileConfig[] = [
  {
    id: "scalp",
    name: "Scalper",
    emoji: "⚡",
    description: "Quick trades in minutes",
    minConfidence: 40,
    holdTime: "minutes",
    strategy: "Momentum spikes + rapid breakout execution",
    timeframeWeighting: "1M + 5M dominant, 15M confirmation",
    structureCriteria: "Micro momentum must align fast",
    nextStepGuidance: "Enter on momentum spike within minutes",
    opportunityFocus: "Momentum assets",
  },
  {
    id: "day",
    name: "Day Trader",
    emoji: "📈",
    description: "Intraday trades",
    minConfidence: 50,
    holdTime: "hours",
    strategy: "Session breakout + intraday trend continuation",
    timeframeWeighting: "5M + 15M dominant, 1H context",
    structureCriteria: "Intraday structure must stay aligned",
    nextStepGuidance: "Wait for breakout during session",
    opportunityFocus: "Intraday breakouts",
  },
  {
    id: "swing",
    name: "Swing Trader",
    emoji: "📊",
    description: "Medium-term trades",
    minConfidence: 60,
    holdTime: "days",
    strategy: "Trend continuation + pullback entries",
    timeframeWeighting: "1H + 4H dominant, 1D bias",
    structureCriteria: "Trend and pullback structure must agree",
    nextStepGuidance: "Enter on pullback to support",
    opportunityFocus: "Trend-aligned assets",
  },
  {
    id: "long_term",
    name: "Long-Term Investor",
    emoji: "🏦",
    description: "Buy & hold",
    minConfidence: 65,
    holdTime: "months",
    strategy: "Gradual accumulation inside strong macro trends",
    timeframeWeighting: "4H + 1D dominant, noise ignored",
    structureCriteria: "Macro trend must stay constructive",
    nextStepGuidance: "Accumulate gradually",
    opportunityFocus: "Macro leaders",
  },
];

export function getProfileConfig(profile: TradingProfile): ProfileConfig {
  return PROFILE_OPTIONS.find((option) => option.id === profile) ?? PROFILE_OPTIONS[2];
}

export function formatProfileName(profile: TradingProfile): string {
  return getProfileConfig(profile).name;
}

export const RISK_LEVEL_OPTIONS: Array<{ id: RiskLevel; name: string; emoji: string }> = [
  { id: "low", name: "Low Risk", emoji: "🛡️" },
  { id: "medium", name: "Medium Risk", emoji: "⚖️" },
  { id: "high", name: "High Risk", emoji: "🚀" },
];

interface ProfileSelectorProps {
  activeProfile: TradingProfile;
  activeRiskLevel: RiskLevel;
  onProfileChange: (profile: TradingProfile) => void;
  onRiskLevelChange: (riskLevel: RiskLevel) => void;
  lockedProfile?: TradingProfile | null;
  onLockedProfileAttempt?: (profile: TradingProfile) => void;
}

export function ProfileSelector({
  activeProfile,
  activeRiskLevel,
  onProfileChange,
  onRiskLevelChange,
  lockedProfile = null,
  onLockedProfileAttempt,
}: ProfileSelectorProps) {
  const activeConfig = getProfileConfig(activeProfile);

  return (
    <section className="rounded-strata border border-white/10 bg-[#0F172A] p-5 shadow-strata-card">
      <div className="mb-4">
        <p className="mb-3 text-[11px] uppercase tracking-[0.14em] text-[#AFC2D7]">Trading Profile</p>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {PROFILE_OPTIONS.map((option) => (
            (() => {
              const isLocked = lockedProfile != null && option.id !== lockedProfile;

              return (
            <button
              key={option.id}
              onClick={() => {
                if (isLocked) {
                  onLockedProfileAttempt?.(option.id);
                  return;
                }

                onProfileChange(option.id);
              }}
              className={`rounded-lg border px-2 py-2.5 text-center transition-all ${
                activeProfile === option.id
                  ? "border-[#60A5FA] bg-[#1E40AF]/30 shadow-[0_0_12px_rgba(96,165,250,0.2)]"
                  : isLocked
                    ? "border-[#F59E0B]/20 bg-[#1F2937]/60 hover:border-[#F59E0B]/35"
                  : "border-white/10 bg-[#0F172A]/50 hover:border-white/20 hover:bg-[#1a2332]"
              }`}
            >
              <div className="flex items-center justify-center gap-1 text-xl">
                <span>{option.emoji}</span>
                {isLocked ? (
                  <span className="rounded-full border border-[#F59E0B]/30 bg-[#78350F]/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#FCD34D]">
                    Pro
                  </span>
                ) : null}
              </div>
              <div className="mt-1 text-xs font-semibold text-[#E6EDF3]">{option.name}</div>
              <div className="mt-0.5 text-[10px] text-[#9FB3C8]">{option.description}</div>
            </button>
              );
            })()
          ))}
        </div>
        {lockedProfile ? (
          <p className="mt-3 text-xs text-[#FCD34D]">
            Free mode stays in {getProfileConfig(lockedProfile).name}. Upgrade to switch trading styles.
          </p>
        ) : null}
      </div>

      <div>
        <p className="mb-3 text-[11px] uppercase tracking-[0.14em] text-[#AFC2D7]">Risk Tolerance</p>
        <div className="flex gap-2">
          {RISK_LEVEL_OPTIONS.map((option) => (
            <button
              key={option.id}
              onClick={() => onRiskLevelChange(option.id)}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition-all ${
                activeRiskLevel === option.id
                  ? "border-[#10B981] bg-[#065F46]/30 shadow-[0_0_12px_rgba(16,185,129,0.2)]"
                  : "border-white/10 bg-[#0F172A]/50 hover:border-white/20 hover:bg-[#1a2332]"
              }`}
            >
              <span className="mr-2">{option.emoji}</span>
              {option.name}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-[#9FB3C8]">
        <span className="rounded-full border border-white/10 bg-[#0B1220] px-2.5 py-1">
          Risk: {RISK_LEVEL_OPTIONS.find((r) => r.id === activeRiskLevel)?.name}
        </span>
        <span className="rounded-full border border-white/10 bg-[#0B1220] px-2.5 py-1">
          Min Confidence: {activeConfig.minConfidence}%
        </span>
        <span className="rounded-full border border-white/10 bg-[#0B1220] px-2.5 py-1">
          Weighting: {activeConfig.timeframeWeighting}
        </span>
      </div>
    </section>
  );
}

// ─── Compact one-row control bar (replaces the large selection cards + banner) ──

interface CompactProfileBarProps {
  activeProfile: TradingProfile;
  activeRiskLevel: RiskLevel;
  onProfileChange: (profile: TradingProfile) => void;
  onRiskLevelChange: (riskLevel: RiskLevel) => void;
  lockedProfile?: TradingProfile | null;
  onLockedProfileAttempt?: (profile: TradingProfile) => void;
}

export function CompactProfileBar({
  activeProfile,
  activeRiskLevel,
  onProfileChange,
  onRiskLevelChange,
  lockedProfile = null,
  onLockedProfileAttempt,
}: CompactProfileBarProps) {
  const activeConfig = getProfileConfig(activeProfile);
  const activeRisk = RISK_LEVEL_OPTIONS.find((r) => r.id === activeRiskLevel)!;

  const handleProfileChange = (value: string) => {
    const profile = value as TradingProfile;
    if (lockedProfile != null && profile !== lockedProfile) {
      onLockedProfileAttempt?.(profile);
      return;
    }
    onProfileChange(profile);
  };

  return (
    <section className="rounded-strata border border-white/10 bg-[#0B1220] px-4 py-2.5 shadow-strata-card">
      <div className="flex flex-wrap items-center gap-3">
        {/* Mode dropdown */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-[#6B859E]">Mode</span>
          <select
            value={activeProfile}
            onChange={(e) => handleProfileChange(e.target.value)}
            className="rounded-md border border-white/15 bg-[#0F172A] px-2.5 py-1 text-xs font-semibold text-[#E6EDF3] focus:border-[#60A5FA]/60 focus:outline-none"
          >
            {PROFILE_OPTIONS.map((option) => {
              const isLocked = lockedProfile != null && option.id !== lockedProfile;
              return (
                <option key={option.id} value={option.id}>
                  {option.emoji} {option.name}{isLocked ? " (Pro)" : ""}
                </option>
              );
            })}
          </select>
        </div>

        <span className="hidden h-4 w-px bg-white/10 sm:block" />

        {/* Risk dropdown */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-[#6B859E]">Risk</span>
          <select
            value={activeRiskLevel}
            onChange={(e) => onRiskLevelChange(e.target.value as RiskLevel)}
            className="rounded-md border border-white/15 bg-[#0F172A] px-2.5 py-1 text-xs font-semibold text-[#E6EDF3] focus:border-[#10B981]/60 focus:outline-none"
          >
            {RISK_LEVEL_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.emoji} {option.name}
              </option>
            ))}
          </select>
        </div>

        <span className="hidden h-4 w-px bg-white/10 sm:block" />

        {/* Live summary pills */}
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-[#9FB3C8]">
          <span className="rounded-full border border-white/10 bg-[#0F172A] px-2 py-0.5">
            {activeConfig.holdTime}
          </span>
          <span className="rounded-full border border-white/10 bg-[#0F172A] px-2 py-0.5">
            min confidence {activeConfig.minConfidence}%
          </span>
          <span className="rounded-full border border-white/10 bg-[#0F172A] px-2 py-0.5">
            {activeRisk.emoji} {activeRisk.name}
          </span>
        </div>
      </div>
    </section>
  );
}

// ─── Full-size profile selector (kept for settings / advanced views) ──────────

type ProfileContextBannerProps = {
  activeProfile: TradingProfile;
};

export function ProfileContextBanner({ activeProfile }: ProfileContextBannerProps) {
  const config = getProfileConfig(activeProfile);

  return (
    <section className="rounded-strata border border-[#60A5FA]/20 bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.18),_rgba(15,23,42,0.98)_55%)] p-5 shadow-strata-card">
      <p className="text-xl font-bold tracking-tight text-[#E6EDF3]">
        {config.emoji} {config.name} Mode Active
      </p>
      <div className="mt-3 grid gap-2 text-sm text-[#C7D6E7] md:grid-cols-2 xl:grid-cols-4">
        <p><span className="text-[#8FB3D9]">Holding Time:</span> {config.holdTime}</p>
        <p><span className="text-[#8FB3D9]">Min Confidence:</span> {config.minConfidence}%</p>
        <p><span className="text-[#8FB3D9]">Weighting:</span> {config.timeframeWeighting}</p>
        <p><span className="text-[#8FB3D9]">Strategy:</span> {config.strategy}</p>
      </div>
      <p className="mt-3 text-xs uppercase tracking-[0.12em] text-[#93C5FD]">
        Decisions recompute instantly using {config.structureCriteria.toLowerCase()}.
      </p>
    </section>
  );
}
