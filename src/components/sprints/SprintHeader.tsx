"use client";

import { type CSSProperties } from "react";
import { ApiSprint, SprintStatus, SPRINT_STATUS_LABELS } from "@/types";
import { Button } from "@/components/ui/Button";

interface SprintHeaderProps {
  sprint: ApiSprint;
  doneCount: number;
  totalCount: number;
  onActivate: () => void;
  onComplete: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function statusBadge(status: SprintStatus) {
  const accents: Record<SprintStatus, string | undefined> = {
    planned: undefined,
    active: "var(--color-primary)",
    completed: "var(--color-status-done)",
  };
  const accent = accents[status];
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full font-medium ${
        accent ? "chip" : "bg-bg-input text-text-muted"
      }`}
      style={accent ? ({ "--chip": accent } as CSSProperties) : undefined}
    >
      {SPRINT_STATUS_LABELS[status]}
    </span>
  );
}

function dateRange(sprint: ApiSprint): string | null {
  if (!sprint.startDate || !sprint.endDate) return null;
  const start = new Date(sprint.startDate);
  const end = new Date(sprint.endDate);
  return `${start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })} — ${end.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

function daysLeft(sprint: ApiSprint): string | null {
  if (sprint.status === "completed" || !sprint.endDate) return null;
  const days = Math.ceil((new Date(sprint.endDate).getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return null;
  if (days < 0) return `${-days} ${-days === 1 ? "day" : "days"} over`;
  if (days === 0) return "ends today";
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

export function SprintHeader({
  sprint,
  doneCount,
  totalCount,
  onActivate,
  onComplete,
  onEdit,
  onDelete,
}: SprintHeaderProps) {
  const progress = totalCount > 0 ? (doneCount / totalCount) * 100 : 0;
  const range = dateRange(sprint);
  const remaining = daysLeft(sprint);
  const closed = sprint.status === "completed";

  return (
    <div className="mb-4 shrink-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{sprint.name}</h2>
            {statusBadge(sprint.status)}
          </div>
          {sprint.goal && <p className="mt-0.5 text-sm text-text-muted">{sprint.goal}</p>}
        </div>

        {!closed && (
          <div className="flex shrink-0 gap-1">
            {sprint.status === "planned" && (
              <Button size="sm" variant="secondary" onClick={onActivate}>
                Activate
              </Button>
            )}
            {sprint.status === "active" && (
              <Button size="sm" variant="secondary" onClick={onComplete}>
                Complete
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onEdit}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete sprint ${sprint.name}`}
              onClick={onDelete}
            >
              <svg
                className="h-4 w-4 text-danger"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </Button>
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs text-text-muted">
        {range && <span>{range}</span>}
        {remaining && <span>{remaining}</span>}
        <div className="h-1.5 max-w-[16rem] flex-1 overflow-hidden rounded-full bg-bg-input">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span data-testid="sprint-progress" className="tabular-nums">
          {doneCount}/{totalCount}
        </span>
      </div>
    </div>
  );
}
