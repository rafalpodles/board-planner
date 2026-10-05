import { ApiEpicProgress } from "@/types";
import { progressLine } from "@/lib/epic-progress";

export function EpicProgress({
  progress,
  className = "",
}: {
  progress: Pick<ApiEpicProgress, "done" | "total">;
  className?: string;
}) {
  const pct = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  return (
    <div className={`flex items-center gap-1.5 ${className}`} data-testid="epic-progress">
      <div
        role="progressbar"
        aria-label="Children done"
        aria-valuenow={progress.done}
        aria-valuetext={progressLine(progress)}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-input"
      >
        <div
          className="h-full rounded-full bg-success transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="whitespace-nowrap text-[11px] text-text-muted">{progressLine(progress)}</span>
    </div>
  );
}
