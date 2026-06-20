import { AlignmentPoint } from "./types";

type AlignmentBarProps = {
  points: AlignmentPoint[];
};

function arrowForDirection(direction: AlignmentPoint["direction"]): string {
  if (direction === "UP") return "↑";
  if (direction === "DOWN") return "↓";
  return "•";
}

function colorForDirection(direction: AlignmentPoint["direction"]): string {
  if (direction === "UP") return "text-[#22C55E]";
  if (direction === "DOWN") return "text-[#EF4444]";
  return "text-[#9FB3C8]";
}

export function AlignmentBar({ points }: AlignmentBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {points.map((point, index) => {
        const dominantClass = point.dominant ? "ring-1 ring-[#3EC6FF]/50 bg-[#3EC6FF]/10" : "bg-[#0B1220]";
        return (
          <div key={`${point.label}-${index}`} className="flex items-center gap-1">
            <span
              className={`inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 ${dominantClass}`}
              title={point.blocked ? "Alignment blocked at this timeframe" : "Alignment point"}
            >
              <span className="font-mono text-[10px] tracking-[0.12em] text-[#9FB3C8]">{point.label}</span>
              <span className={`font-semibold ${colorForDirection(point.direction)}`}>{arrowForDirection(point.direction)}</span>
            </span>
            {index < points.length - 1 ? (
              <span className="text-[#6B859E]">{point.blocked ? "-X-" : "--"}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
