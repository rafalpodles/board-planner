"use client";

import { useEffect, useRef, useState } from "react";
import { ApiSprint, DEFAULT_PROJECT_ICON } from "@/types";
import { Button } from "@/components/ui/Button";
import {
  ALL_TASKS,
  BACKLOG,
  boardSubtitle,
  sprintScopeLabel,
} from "@/lib/sprint-scope";

interface BoardHeaderProps {
  projectName: string;
  projectIcon?: string;
  taskCount: number;
  doneCount: number;
  sprints: ApiSprint[];
  scope: string;
  onScopeChange: (scope: string) => void;
  viewMode: "board" | "list";
  onViewModeChange: (mode: "board" | "list") => void;
  onRefresh: () => void;
  onNewTask: () => void;
}

export function BoardHeader({
  projectName,
  projectIcon,
  taskCount,
  doneCount,
  sprints,
  scope,
  onScopeChange,
  viewMode,
  onViewModeChange,
  onRefresh,
  onNewTask,
}: BoardHeaderProps) {
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scopeOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (scopeRef.current && !scopeRef.current.contains(e.target as Node)) {
        setScopeOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [scopeOpen]);

  const scopeLabel = sprintScopeLabel(scope, sprints);
  const activeSprint = sprints.find((s) => s.status === "active");
  const plannedSprints = sprints.filter((s) => s.status === "planned");
  const progress = taskCount > 0 ? (doneCount / taskCount) * 100 : 0;

  function pick(next: string) {
    setScopeOpen(false);
    onScopeChange(next);
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-bg px-6">
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="shrink-0 text-[17px] leading-none">
          {projectIcon || DEFAULT_PROJECT_ICON}
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold leading-tight">{projectName}</h1>
          <div
            ref={scopeRef}
            className="relative flex items-center gap-1 whitespace-nowrap text-[11px] leading-tight text-text-muted"
          >
            {sprints.length === 0 ? (
              <span className="truncate">{boardSubtitle(null, taskCount)}</span>
            ) : (
              <>
                <span>Board ·</span>
                <button
                  type="button"
                  onClick={() => setScopeOpen((v) => !v)}
                  aria-expanded={scopeOpen}
                  aria-label="Change sprint scope"
                  className="max-w-[12rem] truncate rounded px-1 text-text-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-text"
                >
                  {scopeLabel ?? "All tasks"}
                </button>
                <span>· {taskCount === 1 ? "1 task" : `${taskCount} tasks`}</span>
              </>
            )}

            {scopeOpen && (
              <div
                role="menu"
                aria-label="Sprint scope"
                className="absolute left-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-bg-card py-1 shadow-lg"
              >
                <ScopeOption label="All tasks" value={ALL_TASKS} scope={scope} onPick={pick} />
                <ScopeOption
                  label="Backlog (no sprint)"
                  value={BACKLOG}
                  scope={scope}
                  onPick={pick}
                />
                {activeSprint && (
                  <ScopeOption
                    label={`${activeSprint.name} (Active)`}
                    value={activeSprint._id}
                    scope={scope}
                    onPick={pick}
                  />
                )}
                {plannedSprints.map((s) => (
                  <ScopeOption
                    key={s._id}
                    label={s.name}
                    value={s._id}
                    scope={scope}
                    onPick={pick}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {taskCount > 0 && (
        <div className="flex shrink-0 items-center gap-2">
          <div className="h-[5px] w-16 overflow-hidden rounded-full bg-bg-input">
            <div
              className="h-full rounded-full bg-status-done transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-[11px] text-text-muted">
            {doneCount}/{taskCount}
          </span>
        </div>
      )}

      <div className="ml-auto flex shrink-0 items-center rounded-lg border border-border bg-bg-card p-0.5">
        {(["board", "list"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => onViewModeChange(mode)}
            aria-current={viewMode === mode ? "true" : undefined}
            className={`rounded-md px-3 py-1.5 text-[13px] transition-colors ${
              viewMode === mode
                ? "bg-bg-input font-medium text-text"
                : "text-text-muted hover:text-text"
            }`}
          >
            {mode === "board" ? "Board" : "List"}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onRefresh}
        title="Refresh board (R)"
        aria-label="Refresh board"
        className="shrink-0 rounded-lg p-2 text-text-muted transition-colors hover:bg-bg-card hover:text-text"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
      </button>

      <Button
        size="sm"
        onClick={onNewTask}
        title="New task (N)"
        className="shrink-0 whitespace-nowrap"
      >
        New task
        <kbd className="ml-1 rounded bg-bg-input px-1 text-[10px] opacity-50">N</kbd>
      </Button>
    </header>
  );
}

function ScopeOption({
  label,
  value,
  scope,
  onPick,
}: {
  label: string;
  value: string;
  scope: string;
  onPick: (v: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(value)}
      aria-current={scope === value ? "true" : undefined}
      className={`block w-full truncate px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-bg-hover ${
        scope === value ? "font-semibold text-text" : "text-text-muted"
      }`}
    >
      {label}
    </button>
  );
}
