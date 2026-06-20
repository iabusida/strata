import { SignalState } from "./types";

const stateClassMap: Record<SignalState, string> = {
  READY: "bg-[#22C55E]/15 text-[#22C55E] border-[#22C55E]/40",
  CAUTION: "bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/40",
  BLOCKED: "bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/40",
  BUILDING: "bg-[#38BDF8]/15 text-[#38BDF8] border-[#38BDF8]/40",
};

type SignalStateBadgeProps = {
  state: SignalState;
};

export function SignalStateBadge({ state }: SignalStateBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-[0.08em] ${stateClassMap[state]}`}
    >
      {state}
    </span>
  );
}
