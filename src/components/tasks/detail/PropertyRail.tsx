"use client";

import { useState, type CSSProperties } from "react";
import {
  ApiCustomField,
  ApiProjectCategory,
  ApiSprint,
  ApiUserSummary,
  Category,
  PRIORITIES,
  PRIORITY_LABELS,
  Priority,
  RecurrenceFrequency,
} from "@/types";
import { activeFields, orderedOptions, sortedFields } from "@/lib/custom-fields";
import { categoryColor } from "@/lib/category-colors";
import { roundForDisplay } from "@/lib/estimates";
import { Switch } from "@/components/ui/Switch";
import { Avatar, PriorityBars, SectionLabel } from "./atoms";
import {
  ComboboxRow,
  EmptyValue,
  FieldRow,
  OptionItem,
  OptionList,
  PickerRow,
} from "./FieldRow";
import type { TaskDraft } from "./useTaskEditor";
import type { ApiAgent, ApiTask } from "@/types";
import { handoverOf, refIdOf, type Handover } from "@/lib/handover";
import { assigneeToShow } from "./assignee-display";
import type { AnyColumn } from "@/lib/columns";
import { MAX_RECURRENCE_INTERVAL, clampInterval } from "@/lib/recurrence";

const RECURRENCE_UNITS: Record<RecurrenceFrequency, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
};

function recurrenceLabel(recurrence: TaskDraft["recurrence"]): string | null {
  if (!recurrence) return null;
  const unit = RECURRENCE_UNITS[recurrence.frequency];
  const every =
    recurrence.interval === 1 ? `Every ${unit}` : `Every ${recurrence.interval} ${unit}s`;
  return recurrence.endDate ? `${every} until ${formatDate(recurrence.endDate)}` : every;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function HandoverNotice({ handover }: { handover: Handover | null }) {
  if (!handover || handover.runs || handover.reason === "no-agent") return null;

  const message =
    handover.reason === "not-approved-yet"
      ? "Nothing will run this yet. A machine only looks at the column work is approved in — move it there when it is ready."
      : handover.reason === "unassigned"
      ? "Nothing will run this. A machine takes only work its owner assigned to themselves — assign it to yourself."
      : handover.reason === "assigner-unrecorded"
        ? "Nothing will run this. It was assigned before the board recorded who hands work over; its assignee can record that by assigning it to themselves again."
        : handover.reason === "pm-assigned-for-someone-else"
        ? "Nothing will run this. The PM assigned it on somebody else's instruction — a machine runs a PM hand-over only for the person who asked for it."
        : `Nothing will run this. ${handover.by ?? "Somebody else"} assigned it, and a machine takes only work its owner assigned to themselves.`;

  return (
    <p
      data-testid="handover-notice"
      data-reason={handover.reason}
      className="mt-1 text-xs text-warning"
    >
      {message}
    </p>
  );
}

interface PropertyRailProps {
  draft: TaskDraft;
  set: <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => void;
  users: ApiUserSummary[];
  sprints: ApiSprint[];
  agents: ApiAgent[];
  projectId: string;
  projectDefaultAgent?: string;
  stored: Pick<ApiTask, "agent" | "assignee" | "assignedBy" | "status">;
  columns?: AnyColumn[];
  onRepairAssigner: (username: string | null) => void;
  currentUsername: string | null;
  categories: ApiProjectCategory[];
  customFields: ApiCustomField[];
  reporter: string | null;
  onDelete: () => void;
  touch?: boolean;
}

export function PropertyRail({
  draft,
  set,
  users,
  sprints,
  agents,
  projectId,
  projectDefaultAgent,
  stored,
  columns,
  onRepairAssigner,
  currentUsername,
  categories,
  customFields,
  reporter,
  onDelete,
  touch = false,
}: PropertyRailProps) {
  const shown = assigneeToShow(users, draft.assignee, stored.assignee);
  const offeredUsers =
    shown && !users.some((u) => u.username === shown.username) ? [...users, shown] : users;
  const sprint = sprints.find((s) => s._id === draft.sprint);
  const fields = sortedFields(activeFields(customFields));
  const selectableSprints = sprints.filter((s) => s.status !== "completed");
  const storedAgent = refIdOf(stored.agent);
  const pending =
    (draft.agent ?? null) !== storedAgent ||
    (draft.assignee ?? null) !== (stored.assignee?.username ?? null);
  const handover = pending ? null : handoverOf(stored, columns);
  const assignerUnrecorded = !!stored.assignee && !stored.assignedBy;
  const ownTask = !!currentUsername && draft.assignee === currentUsername;
  const onThisTask = (a: ApiAgent) => a._id === draft.agent;
  const mayRunForThisPerson = (a: ApiAgent) => a.scope !== "user" || ownTask || onThisTask(a);
  const mayRunOnThisBoard = (a: ApiAgent) =>
    a.scope !== "project" || a.projectId === projectId || onThisTask(a);
  const offeredAgents = agents.filter((a) => mayRunForThisPerson(a) && mayRunOnThisBoard(a));
  const notOffered = !!draft.agent && !agents.some((a) => a._id === draft.agent);
  const notOfferedName =
    stored.agent && typeof stored.agent === "object" ? stored.agent.name : null;
  const personalAgentsWithheld = !notOffered && agents.some((a) => !mayRunForThisPerson(a));

  return (
    <div className="flex h-full flex-col gap-6">
      <div className="flex flex-col gap-1">
        <div className="mb-1">
          <SectionLabel>Details</SectionLabel>
        </div>

        <ComboboxRow
          label="Assignee"
          touch={touch}
          value={draft.assignee || ""}
          options={offeredUsers.map((user) => ({
            value: user.username,
            label: user.fullName,
            adornment: <Avatar name={user.fullName} size={20} />,
          }))}
          emptyOption="Unassigned"
          onChange={(username) => {
            const picked = username || null;
            if (assignerUnrecorded && picked === (stored.assignee?.username ?? null)) {
              onRepairAssigner(picked);
            }
            set("assignee", picked);
          }}
        >
          {(selected) => (
            <span className="flex items-center gap-2">
              <Avatar name={selected?.label} size={20} />
              {selected ? selected.label : <EmptyValue>Unassigned</EmptyValue>}
            </span>
          )}
        </ComboboxRow>

        {notOffered ? (
          <FieldRow label="Agent" touch={touch}>
            <span data-testid="agent-not-offered" className="truncate">
              {notOfferedName ?? "An agent you cannot see"}
            </span>
          </FieldRow>
        ) : (
          <ComboboxRow
            label="Agent"
            touch={touch}
            value={draft.agent || ""}
            options={[...offeredAgents]
              .sort((a, b) =>
                a._id === projectDefaultAgent ? -1 : b._id === projectDefaultAgent ? 1 : 0
              )
              .map((a) => ({ value: a._id, label: a.name }))}
            emptyOption="No agent — a person does it"
            onChange={(id) => set("agent", id || null)}
          >
            {(selected) =>
              selected ? (
                <span className="truncate">{selected.label}</span>
              ) : (
                <EmptyValue>No agent</EmptyValue>
              )
            }
          </ComboboxRow>
        )}

        {notOffered && (
          <p data-testid="agent-not-offered-reason" className="mt-1 text-xs text-muted">
            Not yours to choose — a personal agent is only offered to the person who composed it. It
            stays on this task until the task changes hands.
          </p>
        )}

        {personalAgentsWithheld && (
          <p data-testid="personal-agents-withheld" className="mt-1 text-xs text-muted">
            Your own agents are not offered here — a personal agent only runs on a task you have
            assigned to yourself.
          </p>
        )}

        <HandoverNotice handover={handover} />

        <ComboboxRow
          label="Priority"
          touch={touch}
          value={draft.priority}
          options={PRIORITIES.map((priority) => ({
            value: priority,
            label: PRIORITY_LABELS[priority],
            adornment: <PriorityBars priority={priority} />,
          }))}
          onChange={(priority) => set("priority", priority as Priority)}
        >
          {() => (
            <span className="flex items-center gap-2">
              <PriorityBars priority={draft.priority} />
              {PRIORITY_LABELS[draft.priority]}
            </span>
          )}
        </ComboboxRow>

        <ComboboxRow
          label="Type"
          touch={touch}
          value={draft.category}
          options={categories.map((category) => ({
            value: category.name,
            label: category.name,
            color: category.color,
          }))}
          onChange={(category) => set("category", category as Category)}
        >
          {(selected) => (
            <span
              className="chip chip-custom inline-flex rounded px-2 py-0.5 text-xs"
              style={
                {
                  "--chip":
                    categoryColor(categories, draft.category) ||
                    "var(--color-text-muted)",
                } as CSSProperties
              }
            >
              {selected?.label || draft.category}
            </span>
          )}
        </ComboboxRow>

        <PickerRow
          label="Due date"
          touch={touch}
          value={
            draft.dueDate ? formatDate(draft.dueDate) : <EmptyValue>Add date</EmptyValue>
          }
          panel={() => (
            <div className="flex flex-col gap-2 p-1">
              <input
                type="date"
                value={draft.dueDate || ""}
                onChange={(e) => set("dueDate", e.target.value || null)}
                className="focus-ring w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm"
              />
              {draft.dueDate && (
                <button
                  type="button"
                  onClick={() => set("dueDate", null)}
                  className="focus-ring rounded-lg px-2 py-1.5 text-left text-sm text-text-muted hover:bg-bg-hover"
                >
                  Clear
                </button>
              )}
            </div>
          )}
        />

        {sprints.length > 0 && (
          <ComboboxRow
            label="Sprint"
            touch={touch}
            value={draft.sprint || ""}
            options={selectableSprints.map((s) => ({
              value: s._id,
              label: s.status === "active" ? `${s.name} · active` : s.name,
            }))}
            emptyOption="No sprint (backlog)"
            onChange={(sprintId) => set("sprint", sprintId || null)}
          >
            {() => (sprint ? sprint.name : <EmptyValue>Backlog</EmptyValue>)}
          </ComboboxRow>
        )}

        <PickerRow
          label="Repeats"
          touch={touch}
          value={recurrenceLabel(draft.recurrence) || <EmptyValue>Never</EmptyValue>}
          panel={() => (
            <div className="flex flex-col gap-1">
              <OptionList label="Repeats">
                <OptionItem
                  selected={!draft.recurrence}
                  onClick={() => set("recurrence", null)}
                >
                  Never
                </OptionItem>
                {(Object.keys(RECURRENCE_UNITS) as RecurrenceFrequency[]).map((frequency) => (
                  <OptionItem
                    key={frequency}
                    selected={draft.recurrence?.frequency === frequency}
                    onClick={() =>
                      set("recurrence", {
                        frequency,
                        interval: draft.recurrence?.interval || 1,
                        endDate: draft.recurrence?.endDate ?? null,
                      })
                    }
                  >
                    {frequency}
                  </OptionItem>
                ))}
              </OptionList>
              {draft.recurrence && (
                <>
                  <label className="flex items-center gap-2 px-2.5 py-2 text-sm text-text-muted">
                    Every
                    <input
                      type="number"
                      min={1}
                      max={MAX_RECURRENCE_INTERVAL}
                      value={draft.recurrence.interval}
                      onChange={(e) =>
                        set("recurrence", {
                          ...draft.recurrence!,
                          interval: clampInterval(e.target.value),
                        })
                      }
                      className="focus-ring w-16 rounded-lg border border-border bg-bg-input px-2 py-1 text-sm"
                    />
                    {RECURRENCE_UNITS[draft.recurrence.frequency]}s
                  </label>
                  <label className="flex items-center gap-2 px-2.5 py-2 text-sm text-text-muted">
                    Until
                    <input
                      type="date"
                      aria-label="Repeats until"
                      value={draft.recurrence.endDate ?? ""}
                      onChange={(e) =>
                        set("recurrence", {
                          ...draft.recurrence!,
                          endDate: e.target.value || null,
                        })
                      }
                      className="focus-ring rounded-lg border border-border bg-bg-input px-2 py-1 text-sm"
                    />
                  </label>
                </>
              )}
            </div>
          )}
        />

      </div>

      {fields.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="mb-1">
            <SectionLabel>Custom fields</SectionLabel>
          </div>
          {fields.map((field) => (
            <CustomFieldRow
              key={field._id}
              field={field}
              value={draft.customFieldValues[field._id]}
              touch={touch}
              onChange={(value) =>
                set("customFieldValues", { ...draft.customFieldValues, [field._id]: value })
              }
            />
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-col gap-3 border-t border-border pt-4">
        {reporter && (
          <div className="flex items-center gap-2 px-2.5 text-xs text-text-muted">
            <Avatar name={reporter} size={22} />
            Reported by {reporter}
          </div>
        )}
        <button
          type="button"
          onClick={onDelete}
          className={`focus-ring -mx-2.5 rounded-lg px-2.5 text-left text-sm text-danger transition-colors hover:bg-danger/10 ${
            touch ? "min-h-[44px]" : "py-1.5"
          }`}
        >
          Delete task
        </button>
      </div>
    </div>
  );
}

interface CustomFieldRowProps {
  field: ApiCustomField;
  value: unknown;
  onChange: (value: unknown) => void;
  touch?: boolean;
}

function CustomFieldRow({ field, value, onChange, touch }: CustomFieldRowProps) {
  const [editing, setEditing] = useState(false);
  const options = orderedOptions(field);
  const label = field.required ? `${field.name} *` : field.name;

  if (field.fieldType === "checkbox") {
    return (
      <FieldRow label={label} touch={touch}>
        <Switch
          labelHidden
          label={label}
          checked={!!value}
          onChange={onChange}
        />
      </FieldRow>
    );
  }

  if (field.fieldType === "dropdown" || field.fieldType === "multiselect") {
    const choices = options.map((option) => ({
      value: option.id,
      label: option.value,
      color: option.color,
    }));

    if (field.fieldType === "dropdown") {
      const selected = options.find((o) => o.id === value);
      return (
        <ComboboxRow
          label={label}
          touch={touch}
          value={typeof value === "string" ? value : ""}
          options={choices}
          emptyOption="Empty"
          onChange={onChange}
        >
          {() =>
            selected ? (
              <span
                className="chip chip-custom inline-flex rounded px-2 py-0.5 text-xs"
                style={{ "--chip": selected.color } as CSSProperties}
              >
                {selected.value}
              </span>
            ) : (
              <EmptyValue>Empty</EmptyValue>
            )
          }
        </ComboboxRow>
      );
    }

    const picked = Array.isArray(value) ? (value as string[]) : [];
    return (
      <ComboboxRow
        multiple
        label={label}
        touch={touch}
        align="start"
        value={picked}
        options={choices}
        emptyOption="Clear all"
        onChange={onChange}
      >
        {(selected) =>
          selected.length === 0 ? (
            <EmptyValue>Empty</EmptyValue>
          ) : (
            <span className="flex flex-wrap gap-1.5">
              {selected.map((option) => (
                <span
                  key={option.value}
                  className="chip chip-custom rounded px-2 py-0.5 text-xs"
                  style={{ "--chip": option.color } as CSSProperties}
                >
                  {option.label}
                </span>
              ))}
            </span>
          )
        }
      </ComboboxRow>
    );
  }

  const inputType =
    field.fieldType === "number" ? "number" : field.fieldType === "date" ? "date" : "text";

  const shown =
    value === undefined || value === ""
      ? ""
      : field.fieldType === "number" && !editing
        ? String(roundForDisplay(Number(value)))
        : String(value);

  return (
    <FieldRow label={label} touch={touch}>
      <input
        type={inputType}
        aria-label={label}
        value={shown}
        placeholder="Empty"
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        onWheel={(e) => e.currentTarget.blur()}
        onChange={(e) =>
          onChange(
            field.fieldType === "number"
              ? e.target.value
                ? Number(e.target.value)
                : ""
              : e.target.value,
          )
        }
        className={`focus-ring -mx-2 w-[calc(100%+1rem)] rounded-lg border border-transparent
          bg-transparent px-2 text-sm transition-colors placeholder:text-text-muted
          hover:border-border hover:bg-bg-input focus:border-border focus:bg-bg-input
          ${touch ? "min-h-[36px]" : "py-1"}`}
      />
    </FieldRow>
  );
}
