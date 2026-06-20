type TopOpportunityCardProps = {
  symbol: string;
  direction: string;
  actionLabel: string;
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
  confidence,
  confidenceBand,
  reason,
  triggerCondition,
  progressGradientClass = "from-[#3EC6FF] to-[#2F7BFF]",
}: TopOpportunityCardProps) {
  return (
    <article className="rounded-xl border border-white/10 bg-[#0B1220] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-base font-semibold text-[#E6EDF3]">{symbol}</p>
        <p className="text-xs text-[#9FB3C8]">{direction}</p>
      </div>
      <p className={`mt-1 text-sm font-semibold ${getActionLabelClass(actionLabel)}`}>{actionLabel}</p>
      <p className="mt-2 text-xs text-[#9FB3C8]">Confidence</p>
      <p className={`text-lg font-bold ${getConfidenceClass(confidence)}`}>{confidence}% ({confidenceBand})</p>
      <div className="mt-2 h-2 rounded-full bg-[#111F33]">
        <div
          className={`h-2 rounded-full bg-gradient-to-r ${progressGradientClass} transition-all`}
          style={{ width: `${confidence}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-[#9FB3C8]">{reason}</p>
      <p className="mt-2 text-xs font-medium text-[#FCD34D]">Trigger: {triggerCondition}</p>
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
      <p className="text-lg font-semibold text-[#FECACA]">🚫 Market inactive - no high-quality opportunities</p>
      <p className="mt-1 text-sm text-[#FCA5A5]">Current setups are weak or blocked. Wait for better structure.</p>
    </div>
  );
}