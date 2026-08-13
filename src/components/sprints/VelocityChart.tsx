"use client";

import { ApiSprint } from "@/types";
import { roundForDisplay } from "@/lib/estimates";

const BAR_TRACK_PX = 96;
const MIN_VISIBLE_BAR_PX = 4;

function oldestFirst(sprints: ApiSprint[]): ApiSprint[] {
  return [...sprints].sort((a, b) => {
    const byStart = a.startDate.localeCompare(b.startDate);
    return byStart !== 0 ? byStart : a._id.localeCompare(b._id);
  });
}

interface VelocityChartProps {
  sprints: ApiSprint[];
}

export function VelocityChart({ sprints }: VelocityChartProps) {
  const completed = oldestFirst(sprints.filter((s) => s.status === "completed"));

  if (completed.length === 0) return null;

  if (completed.length < 2) {
    return (
      <p className="text-sm text-text-muted">
        Velocity appears once there are two completed sprints.
      </p>
    );
  }

  const values = completed.map((s) => Math.max(s.estimateDone ?? 0, 0));
  const hasVelocity = values.some((v) => v > 0);
  const max = Math.max(...values);

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-text">Velocity</h3>
      {hasVelocity ? (
        <div className="flex items-end gap-4">
          {completed.map((sprint, i) => {
            const value = values[i];
            const barHeight =
              value > 0
                ? Math.max(Math.round((value / max) * BAR_TRACK_PX), MIN_VISIBLE_BAR_PX)
                : 0;
            return (
              <div key={sprint._id} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                <svg
                  role="img"
                  aria-label={`${sprint.name}: ${roundForDisplay(value)} completed`}
                  width="100%"
                  height={BAR_TRACK_PX}
                >
                  <rect
                    x="0"
                    y={BAR_TRACK_PX - barHeight}
                    width="100%"
                    height={barHeight}
                    fill="var(--color-primary)"
                  />
                </svg>
                <span className="max-w-full truncate text-xs text-text-muted">{sprint.name}</span>
                <span className="text-xs font-medium tabular-nums text-text">
                  {roundForDisplay(value)}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex h-24 items-center justify-center rounded border border-dashed border-border px-4">
          <p className="text-center text-xs text-text-muted">No completed sprint has a total yet.</p>
        </div>
      )}
    </div>
  );
}
