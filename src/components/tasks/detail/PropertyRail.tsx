"use client";

import { useState, type CSSProperties } from "react";
import {
  ApiCustomField,
  ApiProjectCategory,
  ApiSprint,
  ApiUser,
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
import { handoverOf, type Handover } from "@/lib/handover";
import { useAuth } from "@/hooks/use-auth";

const RECURRENCE_UNITS: Record<RecurrenceFrequency, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
};

function recurrenceLabel(recurrence: TaskDraft["recurrence"]): string | null {
  if (!recurrence) return null;
  const unit = RECURRENCE_UNITS[recurrence.frequency];
  return recurrence.interval === 1
    ? `Every ${unit}`
    : `Every ${recurrence.interval} ${unit}s`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// The claim takes a task or it does not, and logs nothing either way. An agent chosen on a task no
// machine will touch is the one state nobody could diagnose: the card looks entirely normal.
function HandoverNotice({ handover }: { handover: Handover | null }) {
  // "No agent" is the ordinary case and the default — it is what the picker already says, and
  // repeating it as a warning would put a notice on almost every task on the board.
  if (!handover || handover.runs || handover.reason === "no-agent") return null;

  const message =
    handover.reason === "unassigned"
      ? "Nothing will run this. A machine takes only work its owner assigned to themselves — assign it to yourself."
      : handover.reason === "assigner-unrecorded"
        ? "Nothing will run this. It was assigned before the board recorded who hands work over; assign it again to record that."
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
  users: ApiUser[];
  sprints: ApiSprint[];
  agents: ApiAgent[];
  /** Offered first in the picker once a machine is being chosen; never a fallback */
  projectDefaultAgent?: string;
  /**
   * The task as stored, not as edited. Whether a machine will take it depends on `assignedBy`,
   * which only the server writes — so a draft mid-edit has no answer, and judging one would
   * describe a state that has never existed.
   */
  stored: Pick<ApiTask, "agent" | "assignee" | "assignedBy">;
  /** Full rows, not names: the chip and the picker dot are tinted by the project's colour */
  categories: ApiProjectCategory[];
  customFields: ApiCustomField[];
  reporter: string | null;
  onDelete: () => void;
  /** Sheet rows are taller and the delete affordance sits beside the sheet's Done */
  touch?: boolean;
}

export function PropertyRail({
  draft,
  set,
  users,
  sprints,
  agents,
  projectDefaultAgent,
  stored,
  categories,
  customFields,
  reporter,
  onDelete,
  touch = false,
}: PropertyRailProps) {
  const assignedUser = users.find((u) => u.username === draft.assignee);
  const sprint = sprints.find((s) => s._id === draft.sprint);
  const fields = sortedFields(activeFields(customFields));
  const selectableSprints = sprints.filter((s) => s.status !== "completed");
  // Instance admin, which is what every other admin-only surface in this app keys on
  const { isAdmin } = useAuth();
  const agentName = agents.find((a) => a._id === draft.agent)?.name ?? "";
  // Suppressed while the draft and the stored task disagree: the answer changes as soon as the
  // pending edit saves, and a hint that contradicts what the person just typed is worse than none.
  const pending =
    (draft.agent ?? null) !== (stored.agent ?? null) ||
    (draft.assignee ?? null) !== (stored.assignee?.username ?? null);
  const handover = pending ? null : handoverOf(stored);

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
          options={users.map((user) => ({
            value: user.username,
            label: user.fullName,
            adornment: <Avatar name={user.fullName} size={20} />,
          }))}
          emptyOption="Unassigned"
          onChange={(username) => set("assignee", username || null)}
        >
          {(selected) => (
            <span className="flex items-center gap-2">
              <Avatar name={selected?.label} size={20} />
              {selected ? selected.label : <EmptyValue>Unassigned</EmptyValue>}
            </span>
          )}
        </ComboboxRow>

        {/* Readable by everyone, changeable by an admin: the agent decides what runs on the
            machine serving this project, and the server refuses the write either way (BP-345).
            Offering a picker that 403s would be the worse half of both. */}
        {isAdmin ? (
          <ComboboxRow
            label="Agent"
            touch={touch}
            value={draft.agent || ""}
            options={[...agents]
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
        ) : (
          <FieldRow label="Agent" touch={touch}>
            {agentName ? (
              <span className="truncate">{agentName}</span>
            ) : (
              <EmptyValue>No agent</EmptyValue>
            )}
          </FieldRow>
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
                      })
                    }
                  >
                    {frequency}
                  </OptionItem>
                ))}
              </OptionList>
              {draft.recurrence && (
                <label className="flex items-center gap-2 px-2.5 py-2 text-sm text-text-muted">
                  Every
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={draft.recurrence.interval}
                    onChange={(e) =>
                      set("recurrence", {
                        frequency: draft.recurrence!.frequency,
                        interval: Math.max(1, parseInt(e.target.value) || 1),
                      })
                    }
                    className="focus-ring w-16 rounded-lg border border-border bg-bg-input px-2 py-1 text-sm"
                  />
                  {RECURRENCE_UNITS[draft.recurrence.frequency]}s
                </label>
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
  // The form marked required fields; losing the marker with the form would make a
  // required field indistinguishable from an optional one
  const label = field.required ? `${field.name} *` : field.name;

  if (field.fieldType === "checkbox") {
    return (
      <FieldRow label={label} touch={touch}>
        {/* The row already names the field on its left, so the switch carries the name
            for a screen reader and nothing visible */}
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

  // Typed in the row rather than in a popup: there is nothing to choose from, so a panel
  // only put a second box on top of the one you were already looking at. Chromeless until
  // hovered or focused, so a column of values does not read as a column of form fields.
  //
  // Rounded only while it is not being edited. roundForDisplay says never to feed its
  // result back into anything that stores, and an editable control does exactly that —
  // one keystroke on a field holding 1.005 would commit the 1.01 it was showing.
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
        // A number input takes the wheel while focused, so scrolling the rail past a
        // field you had just clicked silently rewrote it
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
