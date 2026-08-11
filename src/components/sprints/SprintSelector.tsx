"use client";

import { useState } from "react";
import { ApiSprint } from "@/types";
import { useMediaQuery } from "@/hooks/use-media-query";
import { groupSprints } from "@/lib/sprint-selection";
import { Select } from "@/components/ui/Select";

interface SprintSelectorProps {
  sprints: ApiSprint[];
  selectedId: string | null;
  onSelect: (sprintId: string) => void;
}

function counts(sprint: ApiSprint): string {
  return `${sprint.doneCount ?? 0}/${sprint.taskCount ?? 0}`;
}

export function SprintSelector({ sprints, selectedId, onSelect }: SprintSelectorProps) {
  const isWide = useMediaQuery("(min-width: 1024px)");
  const [showOlder, setShowOlder] = useState(false);
  const { active, planned, recentCompleted, olderCompleted } = groupSprints(sprints);

  if (!isWide) {
    return (
      <div className="mb-4 lg:hidden">
        <Select
          aria-label="Sprint"
          value={selectedId ?? ""}
          onChange={(e) => onSelect(e.target.value)}
          options={[...active, ...planned, ...recentCompleted, ...olderCompleted].map((s) => ({
            value: s._id,
            label: `${s.name} · ${counts(s)}`,
          }))}
        />
      </div>
    );
  }

  const completed = showOlder ? [...recentCompleted, ...olderCompleted] : recentCompleted;

  return (
    <nav
      aria-label="Sprint list"
      className="shrink-0 lg:w-60 lg:overflow-y-auto lg:border-r lg:border-border lg:pr-3"
    >
      <Group title="Active" sprints={active} selectedId={selectedId} onSelect={onSelect} />
      <Group title="Planned" sprints={planned} selectedId={selectedId} onSelect={onSelect} />
      <Group title="Completed" sprints={completed} selectedId={selectedId} onSelect={onSelect}>
        {olderCompleted.length > 0 && !showOlder && (
          <button
            type="button"
            onClick={() => setShowOlder(true)}
            className="focus-ring w-full rounded-lg px-2 py-1.5 text-left text-xs text-text-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-text"
          >
            Show {olderCompleted.length} older
          </button>
        )}
      </Group>
    </nav>
  );
}

function Group({
  title,
  sprints,
  selectedId,
  onSelect,
  children,
}: {
  title: string;
  sprints: ApiSprint[];
  selectedId: string | null;
  onSelect: (sprintId: string) => void;
  children?: React.ReactNode;
}) {
  if (sprints.length === 0 && !children) return null;

  return (
    <div className="mb-4">
      <div className="mb-1 px-2 text-[10.5px] font-bold uppercase tracking-wider text-text-muted">
        {title}
      </div>
      {sprints.map((sprint) => (
        <button
          key={sprint._id}
          type="button"
          onClick={() => onSelect(sprint._id)}
          aria-current={sprint._id === selectedId ? "true" : undefined}
          className={`focus-ring flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors ${
            sprint._id === selectedId
              ? "bg-bg-input font-semibold text-text"
              : "text-text-muted hover:bg-bg-hover hover:text-text"
          }`}
        >
          <span className="truncate">{sprint.name}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-text-muted">
            {counts(sprint)}
          </span>
        </button>
      ))}
      {children}
    </div>
  );
}
