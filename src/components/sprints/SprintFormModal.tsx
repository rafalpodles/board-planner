"use client";

import { FormEvent, useState } from "react";
import { ApiSprint } from "@/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import {
  addDays,
  daysBetween,
  nextSprintDates,
  nextSprintName,
  overlappingSprint,
} from "@/lib/sprint-defaults";

const DURATION_OPTIONS = [
  { value: "7", label: "1 week" },
  { value: "14", label: "2 weeks" },
  { value: "21", label: "3 weeks" },
];

export interface SprintFormValues {
  name: string;
  startDate: string;
  endDate: string;
  goal: string;
}

interface SprintFormModalProps {
  sprints: ApiSprint[];
  editing: ApiSprint | null;
  saving: boolean;
  onSubmit: (values: SprintFormValues) => void;
  onClose: () => void;
}

export function SprintFormModal({
  sprints,
  editing,
  saving,
  onSubmit,
  onClose,
}: SprintFormModalProps) {
  const [initial] = useState<SprintFormValues>(() => {
    if (editing) {
      return {
        name: editing.name,
        startDate: editing.startDate?.substring(0, 10) ?? "",
        endDate: editing.endDate?.substring(0, 10) ?? "",
        goal: editing.goal,
      };
    }
    const dates = nextSprintDates(sprints, new Date());
    return { name: nextSprintName(sprints), ...dates, goal: "" };
  });

  const [name, setName] = useState(initial.name);
  const [startDate, setStartDate] = useState(initial.startDate);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [goal, setGoal] = useState(initial.goal);

  function handleStartDateChange(value: string) {
    const duration = daysBetween(startDate, endDate);
    setStartDate(value);
    if (value && duration > 0) setEndDate(addDays(value, duration));
  }

  function handleDurationChange(days: string) {
    if (!days || !startDate) return;
    setEndDate(addDays(startDate, Number(days)));
  }

  const duration = startDate && endDate ? daysBetween(startDate, endDate) : 0;
  const durationValue = DURATION_OPTIONS.some((o) => o.value === String(duration))
    ? String(duration)
    : "";
  const overlap =
    startDate && endDate
      ? overlappingSprint(sprints, startDate, endDate, editing?._id)
      : null;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit({ name, startDate, endDate, goal });
  }

  return (
    <Modal open onClose={onClose} title={editing ? "Edit Sprint" : "New Sprint"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Sprint 1"
          required
        />
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => handleStartDateChange(e.target.value)}
              required
              className="focus-ring w-full bg-bg-input border border-border rounded px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <Select
              label="Duration"
              value={durationValue}
              onChange={(e) => handleDurationChange(e.target.value)}
              options={DURATION_OPTIONS}
              placeholder="Custom"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              required
              className="focus-ring w-full bg-bg-input border border-border rounded px-3 py-1.5 text-sm"
            />
          </div>
        </div>
        {duration > 0 && (
          <p className="text-xs text-text-muted -mt-2">
            {duration} {duration === 1 ? "day" : "days"}
          </p>
        )}
        {overlap && (
          <p className="text-xs text-warning">
            Overlaps &quot;{overlap.name}&quot; ({overlap.startDate?.substring(0, 10) ?? "?"} &ndash;{" "}
            {overlap.endDate?.substring(0, 10) ?? "?"}). You can still save.
          </p>
        )}
        <Input
          label="Goal (optional)"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="What do we want to achieve?"
        />
        <div className="flex gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : editing ? "Update" : "Create"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
