"use client";

import { useEffect, useRef, useState } from "react";
import { ApiSprint, DEFAULT_PROJECT_ICON } from "@/types";
import { Button } from "@/components/ui/Button";
import {
  ALL_TASKS,
  BACKLOG,
  sprintScopeLabel,
} from "@/lib/sprint-scope";

interface BoardHeaderProps {
  projectName: string;
  projectIcon?: string;
  /** The only place the project's description is shown anywhere in the app */
  projectDescription?: string;
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
  projectDescription,
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

  function pick(next: string) {
    setScopeOpen(false);
    onScopeChange(next);
  }

  return (
    // z-30 keeps the scope menu over the board: @container makes the header a stacking context
    <header className="@container relative z-30 flex h-14 shrink-0 items-center gap-2 @md:gap-3 border-b border-border bg-bg px-3 @md:px-6">
      <div className="min-w-0">
        {/* Own row: centred on the title+scope block the icon hangs below the title */}
        <div className="flex items-center gap-2">
          <span aria-hidden className="hidden shrink-0 text-2xl leading-none @md:inline">
            {projectIcon || DEFAULT_PROJECT_ICON}
          </span>
          {/* 24px fits five characters in the ~90px a narrow header leaves the title */}
          <h1 className="truncate text-[15px] font-bold leading-tight @md:text-2xl">
            {projectName}
          </h1>
        </div>
        <div
          ref={scopeRef}
          className="relative flex items-center gap-1.5 text-[11px] leading-tight text-text-muted"
        >
          {/* The description truncates and the scope does not: one is prose, the
              other is the control that decides which tasks the board is showing */}
          {projectDescription && (
            <span className="truncate" title={projectDescription}>
              {projectDescription}
            </span>
          )}
          {projectDescription && sprints.length > 0 && (
            <span aria-hidden className="shrink-0">
              ·
            </span>
          )}
          {sprints.length > 0 && (
            <button
              type="button"
              onClick={() => setScopeOpen((v) => !v)}
              aria-expanded={scopeOpen}
              aria-label="Change sprint scope"
              className="focus-ring max-w-[12rem] shrink-0 truncate rounded px-1 py-0.5 text-text-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-text"
            >
              {scopeLabel ?? "All tasks"}
            </button>
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

      <div className="ml-auto flex h-11 shrink-0 items-center rounded-lg border border-border bg-bg-card p-0.5">
        {(["board", "list"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => onViewModeChange(mode)}
            aria-current={viewMode === mode ? "true" : undefined}
            // Small on a narrow header on purpose: this toggle and the project's name compete for
            // the same row, and the name is the one a reader needs. It grows back at @md.
            className={`focus-ring rounded-md px-1.5 py-1 text-[11px] transition-colors @md:px-3 @md:py-1.5 @md:text-[13px] ${
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
        className="focus-ring flex h-11 shrink-0 items-center justify-center rounded-lg px-2 text-text-muted transition-colors hover:bg-bg-card hover:text-text"
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
        aria-label="New task"
        // Button's own sm size is responsive (min-h-11 sm:min-h-[36px]); this row must not resize
        className="h-11 shrink-0 whitespace-nowrap"
      >
        <svg
          aria-hidden
          className="h-4 w-4 @md:hidden"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14M5 12h14" />
        </svg>
        <span className="hidden @md:inline">New task</span>
        <kbd className="ml-1 hidden rounded bg-black/25 px-1 text-[11px] @xl:inline">N</kbd>
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
      className={`focus-ring-inset block w-full truncate px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-bg-hover ${
        scope === value ? "font-semibold text-text" : "text-text-muted"
      }`}
    >
      {label}
    </button>
  );
}
