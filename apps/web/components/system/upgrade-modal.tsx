"use client";

import Link from "next/link";
import type { AccessEntitlements } from "../../hooks/use-app-access";

export type UpgradeFeature =
  | "profile_switch"
  | "full_scan"
  | "top_opportunities"
  | "trade_setup"
  | "simulation"
  | "entry_zone"
  | "trigger_details"
  | "risk_map";

export type UpgradeIntent = {
  feature: UpgradeFeature;
  symbol?: string;
  marketLabel?: "Crypto" | "Stocks";
  confidence?: number;
  actionLabel?: string;
  context?: string;
};

type UpgradeModalProps = {
  open: boolean;
  onClose: () => void;
  entitlements: AccessEntitlements;
  intent: UpgradeIntent | null;
};

type AccessValueBannerProps = {
  entitlements: AccessEntitlements;
  hiddenSignalCount: number;
  lockedOpportunityCount: number;
  marketLabel: "Crypto" | "Stocks";
  onUpgradeClick: (intent: UpgradeIntent) => void;
  accessError?: string | null;
};

function getFeatureCopy(intent: UpgradeIntent | null): {
  eyebrow: string;
  title: string;
  description: string;
  bullets: string[];
} {
  const symbolText = intent?.symbol ? ` for ${intent.symbol}` : "";
  const marketText = intent?.marketLabel ? `${intent.marketLabel.toLowerCase()} ` : "";

  switch (intent?.feature) {
    case "profile_switch":
      return {
        eyebrow: "Profile locked on Free",
        title: "You are close to making a better decision.",
        description: "Free keeps you in Day Trader mode so you can validate the engine fast. Pro unlocks profile switching for faster or slower decision styles.",
        bullets: [
          "Unlock Scalper, Swing Trader, and Long-Term Investor modes.",
          "Recompute decisions instantly with different timeframe weightings.",
          "Match the engine to your actual hold time instead of forcing one style.",
        ],
      };
    case "full_scan":
      return {
        eyebrow: "Full board locked",
        title: "Free stays focused on the top 3 setups.",
        description: "You already see the highest-priority ideas. Pro opens the rest of the ranked scan so you can compare more than the headline setups.",
        bullets: [
          "See every ranked signal instead of only the top 3.",
          "Filter the full list after the engine scores it.",
          "Spot second-order opportunities before they rotate higher.",
        ],
      };
    case "top_opportunities":
      return {
        eyebrow: "More opportunities waiting",
        title: "The best setup is visible. The bench is Pro.",
        description: `Free shows the top ${marketText}opportunity first. Pro unlocks the remaining ranked ideas${symbolText}.`,
        bullets: [
          "See the next best setups before the board reshuffles.",
          "Compare confidence, trigger quality, and structure side by side.",
          "Avoid overcommitting to only one name when rotation broadens.",
        ],
      };
    case "simulation":
      return {
        eyebrow: "Simulation locked",
        title: "You already have the signal. Pro stress-tests the trade.",
        description: `Run the forward simulation${symbolText} before capital is at risk and see whether the setup deserves execution.`,
        bullets: [
          "Preview path, target pressure, and failure conditions.",
          "Test the idea before sizing up.",
          "Separate high-confidence stories from high-confidence executions.",
        ],
      };
    case "entry_zone":
      return {
        eyebrow: "Entry map locked",
        title: "Free gives the thesis. Pro gives the exact zone.",
        description: `The engine already told you what it thinks${symbolText}. Pro reveals the precise entry zone, stop context, and target map.`,
        bullets: [
          "See the exact zone instead of guessing around the trigger.",
          "Align entry, stop, and exit with the current timeframe.",
          "Move from directional bias to executable plan.",
        ],
      };
    case "trigger_details":
      return {
        eyebrow: "Trigger details locked",
        title: "You know the direction. Pro tells you when.",
        description: "Free shows the decision and the why. Pro adds the confirmation trigger so you can wait for the right moment instead of forcing it.",
        bullets: [
          "See the exact condition that validates the setup.",
          "Avoid late entries and weak breakout chases.",
          "Act when the engine wants execution, not before.",
        ],
      };
    case "risk_map":
      return {
        eyebrow: "Risk map locked",
        title: "Better decisions need better risk framing.",
        description: "Free keeps the directional story visible. Pro exposes the risk layer so you can understand invalidation, liquidity pressure, and trade quality.",
        bullets: [
          "Reveal stop, target, and pressure context.",
          "See where the setup breaks before you enter.",
          "Protect capital with the same engine that found the trade.",
        ],
      };
    case "trade_setup":
    default:
      return {
        eyebrow: "You're 1 step away",
        title: "You're 1 step away from the exact trade.",
        description: `This is a high-probability setup${symbolText}. Unlock Pro to turn this decision into an executable trade.`,
        bullets: [
          "✅ Exact entry point",
          "✅ Risk / reward plan",
          "✅ Position sizing",
          "✅ Simulation results",
        ],
      };
  }
}

export function AccessValueBanner({
  entitlements,
  hiddenSignalCount,
  lockedOpportunityCount,
  marketLabel,
  onUpgradeClick,
  accessError,
}: AccessValueBannerProps) {
  if (!entitlements.isFreeTier) {
    return (
      <section className="rounded-strata border border-[#1D4ED8]/25 bg-[linear-gradient(135deg,rgba(8,47,73,0.92),rgba(15,23,42,0.98))] p-4 shadow-strata-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.14em] text-[#7DD3FC]">{entitlements.planLabel} Access</p>
            <p className="mt-1 text-lg font-semibold text-[#E6EDF3]">Full decision and execution layer unlocked.</p>
            <p className="mt-1 text-sm text-[#B6CCE3]">Profile switching, full scan visibility, setup detail, and simulation are available in this {marketLabel.toLowerCase()} view.</p>
          </div>
          <div className="rounded-full border border-[#38BDF8]/30 bg-[#082F49]/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.1em] text-[#BAE6FD]">
            {entitlements.statusLabel}
          </div>
        </div>
        {accessError ? <p className="mt-3 text-xs text-[#FDE68A]">Access note: {accessError}</p> : null}
      </section>
    );
  }

  return (
    <section className="rounded-strata border border-[#D97706]/30 bg-[linear-gradient(135deg,rgba(120,53,15,0.92),rgba(15,23,42,0.98))] p-4 shadow-strata-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <p className="text-[11px] uppercase tracking-[0.14em] text-[#FCD34D]">Free Plan Active</p>
          <p className="mt-1 text-lg font-semibold text-[#FFF7ED]">Value first, power later.</p>
          <p className="mt-1 text-sm text-[#FDE7C7]">You already get the decision, confidence, and reasoning. Free stays focused on Day Trader mode, the top 3 ranked setups, and the best current opportunity.</p>
          <p className="mt-2 text-sm text-[#FCD34D]">
            {hiddenSignalCount > 0 ? `${hiddenSignalCount} more ranked setups` : "Full scan access"} and {lockedOpportunityCount > 0 ? `${lockedOpportunityCount} more top opportunities` : "additional opportunities"} are waiting in Pro.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onUpgradeClick({ feature: "full_scan", marketLabel })}
          className="rounded-lg border border-[#FCD34D]/40 bg-[#451A03]/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-[#FDE68A] transition hover:bg-[#5B2107]"
        >
          {entitlements.upgradeLabel}
        </button>
      </div>
      {accessError ? <p className="mt-3 text-xs text-[#FDE68A]">Access status unavailable: {accessError}</p> : null}
    </section>
  );
}

export function UpgradeModal({ open, onClose, entitlements, intent }: UpgradeModalProps) {
  if (!open || !intent) {
    return null;
  }

  const copy = getFeatureCopy(intent);
  const confidenceText = typeof intent.confidence === "number" ? `${intent.confidence}% confidence` : null;
  const actionText = intent.actionLabel ? intent.actionLabel : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#020617]/78 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Upgrade to Pro">
      <div className="w-full max-w-3xl overflow-hidden rounded-[28px] border border-[#F59E0B]/30 bg-[linear-gradient(145deg,rgba(15,23,42,0.98),rgba(41,37,36,0.98))] shadow-[0_24px_80px_rgba(2,6,23,0.6)]">
        <div className="border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.22),transparent_45%),linear-gradient(135deg,rgba(120,53,15,0.45),rgba(15,23,42,0.15))] p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.16em] text-[#FCD34D]">{copy.eyebrow}</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-[#FFF7ED]">{copy.title}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[#E2E8F0]">{copy.description}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[#CBD5E1] transition hover:bg-white/10"
            >
              Close
            </button>
          </div>

          {confidenceText || actionText || intent.context ? (
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              {intent.symbol ? <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-[#E2E8F0]">{intent.symbol}</span> : null}
              {actionText ? <span className="rounded-full border border-[#22C55E]/25 bg-[#052E16]/60 px-3 py-1 text-[#BBF7D0]">{actionText}</span> : null}
              {confidenceText ? <span className="rounded-full border border-[#38BDF8]/25 bg-[#082F49]/60 px-3 py-1 text-[#BAE6FD]">{confidenceText}</span> : null}
              {intent.context ? <span className="rounded-full border border-[#F59E0B]/25 bg-[#451A03]/65 px-3 py-1 text-[#FDE68A]">{intent.context}</span> : null}
            </div>
          ) : null}
        </div>

        <div className="grid gap-6 p-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <p className="text-[11px] uppercase tracking-[0.14em] text-[#94A3B8]">What Pro Unlocks</p>
            <ul className="mt-3 space-y-3 text-sm text-[#E2E8F0]">
              {copy.bullets.map((bullet) => (
                <li key={bullet} className="rounded-2xl border border-white/8 bg-white/5 px-4 py-3">{bullet}</li>
              ))}
            </ul>
          </div>

          <div className="rounded-[24px] border border-[#F59E0B]/20 bg-[linear-gradient(180deg,rgba(124,45,18,0.24),rgba(15,23,42,0.5))] p-5">
            <p className="text-[11px] uppercase tracking-[0.14em] text-[#FCD34D]">Your Current Access</p>
            <p className="mt-2 text-2xl font-black text-[#FFF7ED]">{entitlements.planLabel}</p>
            <p className="mt-1 text-sm text-[#FDE7C7]">{entitlements.upgradeMessage}</p>

            <div className="mt-5 rounded-2xl border border-white/10 bg-[#0B1220]/70 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#93C5FD]">Free still gives you</p>
              <ul className="mt-3 space-y-2 text-sm text-[#D7E4F2]">
                <li>Decision summary and confidence</li>
                <li>Reasoning bullets and structure read</li>
                <li>The highest-priority live opportunity</li>
              </ul>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                href="/settings"
                className="inline-flex rounded-lg border border-[#FCD34D]/45 bg-[#F59E0B]/15 px-4 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-[#FDE68A] transition hover:bg-[#F59E0B]/25"
              >
                Open Access Console
              </Link>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-[#CBD5E1] transition hover:bg-white/10"
              >
                Keep Free View
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
