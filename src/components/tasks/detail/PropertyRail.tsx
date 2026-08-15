"use client";

import type { CSSProperties } from "react";
import {
  ApiCustomField,
  ApiSprint,
  ApiUser,
  Category,
  PRIORITIES,
  PRIORITY_LABELS,
  Priority,
  RecurrenceFrequency,
} from "@/types";
import { activeFields, orderedOptions, sortedFields } from "@/lib/custom-fields";
import { roundForDisplay } from "@/lib/estimates";
import { Avatar, PriorityBars, SectionLabel } from "./atoms";
import { EmptyValue, FieldRow, OptionItem, OptionList, PickerRow } from "./FieldRow";
import type { TaskDraft } from "./useTaskEditor";

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

interface PropertyRailProps {
  draft: TaskDraft;
  set: <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => void;
  users: ApiUser[];
  sprints: ApiSprint[];
  categories: string[];
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

  return (
    <div className="flex h-full flex-col gap-6">
      <div className="flex flex-col gap-1">
        <div className="mb-1">
          <SectionLabel>Details</SectionLabel>
        </div>

        <PickerRow
          label="Assignee"
          touch={touch}
          value={
            <span className="flex items-center gap-2">
              <Avatar name={assignedUser?.fullName} size={20} />
              {assignedUser ? (
                assignedUser.fullName
              ) : (
                <EmptyValue>Unassigned</EmptyValue>
              )}
            </span>
          }
          panel={(close) => (
            <OptionList label="Assignee">
              <OptionItem
                selected={!draft.assignee}
                onClick={() => {
                  set("assignee", null);
                  close();
                }}
              >
                <Avatar size={20} />
                Unassigned
              </OptionItem>
              {users.map((user) => (
                <OptionItem
                  key={user._id}
                  selected={user.username === draft.assignee}
                  onClick={() => {
                    set("assignee", user.username);
                    close();
                  }}
                >
                  <Avatar name={user.fullName} size={20} />
                  <span className="truncate">{user.fullName}</span>
                </OptionItem>
              ))}
            </OptionList>
          )}
        />

        <PickerRow
          label="Priority"
          touch={touch}
          value={
            <span className="flex items-center gap-2">
              <PriorityBars priority={draft.priority} />
              {PRIORITY_LABELS[draft.priority]}
            </span>
          }
          panel={(close) => (
            <OptionList label="Priority">
              {PRIORITIES.map((priority) => (
                <OptionItem
                  key={priority}
                  selected={priority === draft.priority}
                  onClick={() => {
                    set("priority", priority as Priority);
                    close();
                  }}
                >
                  <PriorityBars priority={priority} />
                  {PRIORITY_LABELS[priority]}
                </OptionItem>
              ))}
            </OptionList>
          )}
        />

        <PickerRow
          label="Type"
          touch={touch}
          value={
            <span
              className="chip inline-flex rounded px-2 py-0.5 text-xs"
              style={{ "--chip": "var(--color-primary)" } as CSSProperties}
            >
              {draft.category}
            </span>
          }
          panel={(close) => (
            <OptionList label="Type">
              {categories.map((category) => (
                <OptionItem
                  key={category}
                  selected={category === draft.category}
                  onClick={() => {
                    set("category", category as Category);
                    close();
                  }}
                >
                  {category}
                </OptionItem>
              ))}
            </OptionList>
          )}
        />

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
          <PickerRow
            label="Sprint"
            touch={touch}
            value={sprint ? sprint.name : <EmptyValue>Backlog</EmptyValue>}
            panel={(close) => (
              <OptionList label="Sprint">
                <OptionItem
                  selected={!draft.sprint}
                  onClick={() => {
                    set("sprint", null);
                    close();
                  }}
                >
                  No sprint (backlog)
                </OptionItem>
                {selectableSprints.map((s) => (
                  <OptionItem
                    key={s._id}
                    selected={s._id === draft.sprint}
                    onClick={() => {
                      set("sprint", s._id);
                      close();
                    }}
                  >
                    {s.name}
                    {s.status === "active" && (
                      <span className="text-xs text-text-muted">active</span>
                    )}
                  </OptionItem>
                ))}
              </OptionList>
            )}
          />
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
  const options = orderedOptions(field);
  // The form marked required fields; losing the marker with the form would make a
  // required field indistinguishable from an optional one
  const label = field.required ? `${field.name} *` : field.name;

  if (field.fieldType === "checkbox") {
    return (
      <FieldRow label={label} touch={touch}>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="rounded border-border"
          />
          <span className="text-text-muted">{value ? "Yes" : "No"}</span>
        </label>
      </FieldRow>
    );
  }

  if (field.fieldType === "dropdown") {
    const selected = options.find((o) => o.id === value);
    return (
      <PickerRow
        label={label}
        touch={touch}
        value={
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
        panel={(close) => (
          <OptionList label={label}>
            <OptionItem
              selected={!selected}
              onClick={() => {
                onChange("");
                close();
              }}
            >
              Empty
            </OptionItem>
            {options.map((option) => (
              <OptionItem
                key={option.id}
                selected={option.id === value}
                onClick={() => {
                  onChange(option.id);
                  close();
                }}
              >
                <span
                  aria-hidden
                  className="h-[7px] w-[7px] shrink-0 rounded-full"
                  style={{ background: option.color }}
                />
                {option.value}
              </OptionItem>
            ))}
          </OptionList>
        )}
      />
    );
  }

  if (field.fieldType === "multiselect") {
    const picked = Array.isArray(value) ? (value as string[]) : [];
    return (
      <PickerRow
        label={label}
        touch={touch}
        align="start"
        value={
          picked.length === 0 ? (
            <EmptyValue>Empty</EmptyValue>
          ) : (
            <span className="flex flex-wrap gap-1.5">
              {options
                .filter((o) => picked.includes(o.id))
                .map((option) => (
                  <span
                    key={option.id}
                    className="chip chip-custom rounded px-2 py-0.5 text-xs"
                    style={{ "--chip": option.color } as CSSProperties}
                  >
                    {option.value}
                  </span>
                ))}
            </span>
          )
        }
        panel={() => (
          <div className="flex flex-wrap gap-1.5 p-1.5">
            {options.map((option) => {
              const on = picked.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    onChange(
                      on ? picked.filter((id) => id !== option.id) : [...picked, option.id]
                    )
                  }
                  className={`focus-ring chip chip-custom rounded-full px-2.5 py-1 text-xs transition-opacity ${
                    on ? "" : "opacity-40"
                  }`}
                  style={{ "--chip": option.color } as CSSProperties}
                >
                  {option.value}
                </button>
              );
            })}
          </div>
        )}
      />
    );
  }

  const inputType =
    field.fieldType === "number" ? "number" : field.fieldType === "date" ? "date" : "text";

  return (
    <PickerRow
      label={label}
      touch={touch}
      value={
        value === undefined || value === "" ? (
          <EmptyValue>Empty</EmptyValue>
        ) : field.fieldType === "number" ? (
          String(roundForDisplay(Number(value)))
        ) : (
          String(value)
        )
      }
      panel={() => (
        <div className="p-1">
          <input
            type={inputType}
            value={(value as string) ?? ""}
            autoFocus
            onChange={(e) =>
              onChange(
                field.fieldType === "number"
                  ? e.target.value
                    ? Number(e.target.value)
                    : ""
                  : e.target.value
              )
            }
            className="focus-ring w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm"
          />
        </div>
      )}
    />
  );
}
