import { getSignalStatePresentation, type SignalActionState } from "./profile-decision";

type TopOpportunityCardProps = {
  symbol: string;
  direction: string;
  actionLabel: string;
  signalState: SignalActionState;
  confidence: number;
  confidenceBand: string;
  reason: string;
  triggerCondition: string;
  progressGradientClass?: string;
};

function getActionLabelClass(actionLabel: string): string {
  if (actionLabel.includes("BUY") || actionLabel.includes("Buy")) return "text-[#22C55E]";
  if (actionLabel.includes("HOLD")) return "text-[#60A5FA]";
  if (actionLabel.includes("SELL") || actionLabel.includes("Sell")) return "text-[#EF4444]";
  if (actionLabel.includes("PREPARE") || actionLabel.includes("Wait") || actionLabel.includes("Watch")) return "text-[#F59E0B]";
  return "text-[#F87171]";
}

function getConfidenceClass(confidence: number): string {
  if (confidence >= 80) return "text-[#22C55E]";
  if (confidence >= 60) return "text-[#84CC16]";
  if (confidence >= 40) return "text-[#F59E0B]";
  return "text-[#EF4444]";
}

export function TopOpportunityCard({
  symbol,
  direction,
  actionLabel,
  signalState,
  confidence,
  confidenceBand,
  reason,
  triggerCondition,
  progressGradientClass = "from-[#3EC6FF] to-[#2F7BFF]",
}: TopOpportunityCardProps) {
  const isLong = actionLabel.toUpperCase().includes("BUY") || direction.toUpperCase().includes("LONG") || direction.toUpperCase().includes("BUY");
  const isShort = actionLabel.toUpperCase().includes("SELL") || direction.toUpperCase().includes("SHORT") || direction.toUpperCase().includes("SELL");
  return (
    <article className="rounded-xl border border-white/10 bg-[#0B1220] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-base font-extrabold text-[#E6EDF3]">{symbol}</p>
        <span
          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-bold uppercase tracking-[0.08em] ${
            isLong
              ? "border-[#22C55E]/40 bg-[#0F2E25]/50 text-[#86EFAC]"
              : isShort
                ? "border-[#EF4444]/40 bg-[#3F1218]/40 text-[#FCA5A5]"
                : "border-[#F59E0B]/40 bg-[#3A2A0E]/40 text-[#FDE68A]"
          }`}
        >
          {isLong ? "BUY" : isShort ? "SELL" : "WATCH"}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <p className={`text-lg font-bold ${getConfidenceClass(confidence)}`}>{confidence}%</p>
        <div className="flex-1 h-1.5 rounded-full bg-[#111F33]">
          <div
            className={`h-1.5 rounded-full bg-gradient-to-r ${progressGradientClass} transition-all`}
            style={{ width: `${confidence}%` }}
          />
        </div>
      </div>
      <p className="mt-2 text-xs font-medium text-[#FCD34D]">{triggerCondition}</p>
    </article>
  );
}

type LockedOpportunityTeaserCardProps = {
  hiddenCount: number;
  onUnlock: () => void;
};

export function LockedOpportunityTeaserCard({ hiddenCount, onUnlock }: LockedOpportunityTeaserCardProps) {
  return (
    <article className="rounded-xl border border-[#F59E0B]/25 bg-[linear-gradient(145deg,rgba(120,53,15,0.35),rgba(11,18,32,0.95))] p-3">
      <p className="text-[11px] uppercase tracking-[0.12em] text-[#FCD34D]">Pro Teaser</p>
      <p className="mt-2 text-base font-semibold text-[#FFF7ED]">
        {hiddenCount === 1 ? "1 more ranked setup is waiting" : `${hiddenCount} more ranked setups are waiting`}
      </p>
      <p className="mt-2 text-sm text-[#FDE7C7]">
        You already see the best current opportunity. Unlock the rest of the queue when you want more than the headline trade.
      </p>
      <button
        type="button"
        onClick={onUnlock}
        className="mt-3 rounded-lg border border-[#FCD34D]/35 bg-[#451A03]/70 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#FDE68A] transition hover:bg-[#5B2107]"
      >
        Unlock Pro Opportunities
      </button>
    </article>
  );
}

export function TopOpportunityEmptyState() {
  return (
    <div className="rounded-xl border border-[#EF4444]/25 bg-[#3F1218]/35 p-4">
      <p className="text-sm font-semibold text-[#FECACA]">No high-quality setups right now</p>
      <p className="mt-1 text-xs text-[#FCA5A5]">Current setups are below threshold. Wait for better structure.</p>
    </div>
  );
}

export function NoActiveTradesState() {
  return (
    <div className="rounded-xl border border-[#F59E0B]/30 bg-[#3A2A0E]/40 p-4">
      <p className="text-lg font-semibold text-[#FDE68A]">🚫 No Active Trades</p>
      <p className="mt-1 text-sm text-[#FCD34D]">Only setups forming — wait for confirmation before entering.</p>
    </div>
  );
}