"use client";

import { ApiSprint } from "@/types";

interface SprintSelectorProps {
  sprints: ApiSprint[];
  selected: string; // sprint ID, "all", or "backlog"
  onChange: (value: string) => void;
}

export function SprintSelector({ sprints, selected, onChange }: SprintSelectorProps) {
  const activeSprint = sprints.find((s) => s.status === "active");
  const plannedSprints = sprints.filter((s) => s.status === "planned");

  if (sprints.length === 0) return null;

  return (
    <select
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs bg-bg-input border border-border rounded px-2 py-1.5 text-text focus:outline-none focus:ring-1 focus:ring-primary"
    >
      <option value="all">All Tasks</option>
      <option value="backlog">Backlog (no sprint)</option>
      {activeSprint && (
        <option value={activeSprint._id}>
          {activeSprint.name} (Active)
        </option>
      )}
      {plannedSprints.map((s) => (
        <option key={s._id} value={s._id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
