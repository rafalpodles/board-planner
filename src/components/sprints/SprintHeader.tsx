"use client";

import { type CSSProperties } from "react";
import { ApiSprint, SprintStatus, SPRINT_STATUS_LABELS } from "@/types";
import { Button } from "@/components/ui/Button";
import { roundForDisplay } from "@/lib/estimates";
import { groupSprints, sprintOptionLabel } from "@/lib/sprint-selection";

interface SprintHeaderProps {
  sprint: ApiSprint;
  sprints: ApiSprint[];
  doneCount: number;
  totalCount: number;
  /** False when the board defines no column meaning Done, so `doneCount` is 0 for a reason */
  canMeasureDone?: boolean;
  estimate?: { total: number; done: number; label: string };
  readOnly: boolean;
  view: "board" | "planning";
  onViewChange: (view: "board" | "planning") => void;
  onActivate: () => void;
  onComplete: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSelectSprint: (sprintId: string) => void;
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
      data-testid="sprint-status"
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

function daysLeft(sprint: ApiSprint, closed: boolean): string | null {
  if (closed || !sprint.endDate) return null;
  const days = Math.ceil((new Date(sprint.endDate).getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return null;
  if (days < 0) return `${-days} ${-days === 1 ? "day" : "days"} over`;
  if (days === 0) return "ends today";
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

export function SprintHeader({
  sprint,
  sprints,
  doneCount,
  totalCount,
  canMeasureDone = true,
  estimate,
  readOnly,
  view,
  onViewChange,
  onActivate,
  onComplete,
  onEdit,
  onDelete,
  onSelectSprint,
}: SprintHeaderProps) {
  const progress = totalCount > 0 ? (doneCount / totalCount) * 100 : 0;
  const closed = readOnly;
  const range = dateRange(sprint);
  const remaining = daysLeft(sprint, closed);
  const canPickSprint = sprints.length > 1;
  const { active, planned, completed } = groupSprints(sprints);

  return (
    <div className="mb-4 shrink-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 basis-full sm:basis-auto">
          <div className="flex items-center gap-2">
            <div className="relative inline-flex min-w-0 items-center gap-1">
              <h2 data-testid="sprint-name" className="truncate text-lg font-semibold">{sprint.name}</h2>
              {canPickSprint && (
                <svg
                  aria-hidden="true"
                  data-testid="sprint-picker-chevron"
                  className="h-4 w-4 shrink-0 text-text-muted lg:hidden"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              )}
              {canPickSprint && (
                <select
                  aria-label="Sprint"
                  value={sprint._id}
                  onChange={(e) => onSelectSprint(e.target.value)}
                  className="focus-ring absolute inset-0 h-full w-full cursor-pointer appearance-none border-0 bg-transparent text-transparent lg:hidden"
                >
                  {active.length > 0 && (
                    <optgroup label="Active">
                      {active.map((s) => (
                        <option key={s._id} value={s._id}>
                          {sprintOptionLabel(s)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {planned.length > 0 && (
                    <optgroup label="Planned">
                      {planned.map((s) => (
                        <option key={s._id} value={s._id}>
                          {sprintOptionLabel(s)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {completed.length > 0 && (
                    <optgroup label="Completed">
                      {completed.map((s) => (
                        <option key={s._id} value={s._id}>
                          {sprintOptionLabel(s)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              )}
            </div>
            {statusBadge(sprint.status)}
          </div>
          {sprint.goal && <p className="mt-0.5 text-sm text-text-muted">{sprint.goal}</p>}
        </div>

        {/* readOnly means "don't fumble a finished sprint", not an integrity boundary — the
            server enforces nothing about completed sprints. Reopening one is a separate
            question nobody has decided, so Activate/Complete stay withheld; Edit and Delete
            are ordinary sprint metadata edits and stay available regardless. */}
        <div className="flex shrink-0 items-center gap-1">
          {!closed && (
            <>
              <div className="mr-1 flex items-center rounded-lg border border-border bg-bg-card p-0.5">
                {(["board", "planning"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onViewChange(mode)}
                    aria-current={view === mode ? "true" : undefined}
                    className={`focus-ring rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
                      view === mode
                        ? "bg-bg-input font-medium text-text"
                        : "text-text-muted hover:text-text"
                    }`}
                  >
                    {mode === "board" ? "Board" : "Planning"}
                  </button>
                ))}
              </div>
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
            </>
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
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-muted">
        {range && <span>{range}</span>}
        {remaining && <span>{remaining}</span>}
        {canMeasureDone && (
          <div className="h-1.5 max-w-[16rem] flex-1 overflow-hidden rounded-full bg-bg-input">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
        {canMeasureDone ? (
          <span data-testid="sprint-progress" className="tabular-nums">
            {doneCount}/{totalCount}
          </span>
        ) : (
          // 0/N here would be a statement about the sprint. It is a statement about the board: no
          // column carries the Done role, so nothing can ever count as finished (BP-311).
          <span data-testid="sprint-progress-unmeasurable" className="text-warning">
            no Done column — progress cannot be measured
          </span>
        )}
        {estimate && (
          <span
            data-testid="sprint-estimate-progress"
            className="min-w-0 truncate tabular-nums"
          >
            {roundForDisplay(estimate.done)}/{roundForDisplay(estimate.total)} {estimate.label}
          </span>
        )}
      </div>
    </div>
  );
}
