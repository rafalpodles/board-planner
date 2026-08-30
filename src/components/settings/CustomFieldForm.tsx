"use client";

import { useId, useState } from "react";
import {
  ApiCustomField,
  CUSTOM_FIELD_TYPES,
  CustomFieldType,
  FIELD_TYPE_LABELS,
  ICustomFieldOption,
} from "@/types";
import { isOptionField, orderedOptions } from "@/lib/custom-fields";
import { nextColour } from "@/lib/palette";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Popover } from "@/components/ui/Popover";
import { SwatchPicker } from "@/components/ui/SwatchPicker";
import { Switch } from "@/components/ui/Switch";

export interface FieldDraft {
  name: string;
  fieldType: CustomFieldType;
  options: ICustomFieldOption[];
  required: boolean;
  showOnCard: boolean;
  showInList: boolean;
  filterable: boolean;
}

function draftFrom(field?: ApiCustomField): FieldDraft {
  return {
    name: field?.name ?? "",
    fieldType: field?.fieldType ?? "dropdown",
    options: field ? orderedOptions(field) : [],
    required: field?.required ?? false,
    showOnCard: field?.showOnCard ?? false,
    showInList: field?.showInList ?? true,
    filterable: field?.filterable ?? true,
  };
}

interface CustomFieldFormProps {
  /** Absent when creating. Its presence is the only difference between the two modes. */
  field?: ApiCustomField;
  onSubmit: (draft: FieldDraft) => Promise<void>;
  onCancel: () => void;
}

/**
 * One form for creating and editing a field.
 *
 * They used to be two unrelated forms over the same object, which is why three of the
 * four flags existed only after the field had been created, and why the type had a
 * hardcoded `=== "dropdown"` branch that left multiselect impossible to make.
 */
export function CustomFieldForm({ field, onSubmit, onCancel }: CustomFieldFormProps) {
  const [draft, setDraft] = useState<FieldDraft>(() => draftFrom(field));
  // The visible label is the name, pointed at the control rather than left beside it — the way
  // `Select` does it. Without this the field announced as "combo box, text" (BP-498).
  const typeId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const editing = !!field;
  const hasOptions = isOptionField({ fieldType: draft.fieldType });

  function set<K extends keyof FieldDraft>(key: K, value: FieldDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setError("");
  }

  function setOption(index: number, patch: Partial<ICustomFieldOption>) {
    set(
      "options",
      draft.options.map((o, i) => (i === index ? { ...o, ...patch } : o))
    );
  }

  async function submit() {
    if (!draft.name.trim()) {
      setError("Give the field a name.");
      return;
    }
    if (hasOptions && draft.options.filter((o) => o.value.trim()).length === 0) {
      setError("A choice field needs at least one option.");
      return;
    }
    setSaving(true);
    try {
      await onSubmit({ ...draft, name: draft.name.trim() });
    } catch (e) {
      // Stays open and keeps what was typed: the old editor closed on failure and
      // silently dropped the edit
      setError(e instanceof Error ? e.message : "Could not save the field.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-border bg-bg-input/20 p-4">
      <div>
        <Input
          label="Name"
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Component"
          error={error && !draft.name.trim() ? error : undefined}
        />
      </div>

      <div>
        <label htmlFor={typeId} className="mb-1 block text-sm font-medium text-text-muted">
          Type
        </label>
        <select
          id={typeId}
          value={draft.fieldType}
          disabled={editing}
          onChange={(e) => set("fieldType", e.target.value as CustomFieldType)}
          className="focus-ring w-full rounded-lg border border-border bg-bg-input min-h-11 px-3 py-2 text-sm sm:min-h-0 disabled:opacity-60"
        >
          {CUSTOM_FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {FIELD_TYPE_LABELS[t].label} — {FIELD_TYPE_LABELS[t].hint}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-text-muted">
          {editing
            ? "The type cannot change once tasks hold values for the field."
            : "This cannot be changed later."}
        </p>
      </div>

      {hasOptions && (
        <div>
          <label className="mb-1 block text-sm font-medium text-text-muted">Options</label>
          <div className="space-y-2">
            {draft.options.map((option, i) => (
              <div key={option.id || `new-${i}`} className="flex items-center gap-2">
                <Popover
                  width="w-auto"
                  trigger={({ toggle }) => (
                    <button
                      type="button"
                      onClick={toggle}
                      aria-label={`Colour for ${option.value || "this option"}`}
                      className="focus-ring h-11 w-11 shrink-0 rounded-lg border border-border sm:h-9 sm:w-9"
                      style={{ backgroundColor: option.color }}
                    />
                  )}
                >
                  {({ close }) => (
                    <div className="p-2">
                      <SwatchPicker
                        value={option.color}
                        label={`Colour for ${option.value || "this option"}`}
                        onChange={(hex) => {
                          setOption(i, { color: hex });
                          close();
                        }}
                      />
                    </div>
                  )}
                </Popover>
                <Input
                  value={option.value}
                  onChange={(e) => setOption(i, { value: e.target.value })}
                  placeholder="Option name"
                  className="py-1.5"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${option.value || "option"}`}
                  onClick={() => set("options", draft.options.filter((_, j) => j !== i))}
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                set("options", [
                  ...draft.options,
                  {
                    // No id: the server mints one. Sending "" used to become the id.
                    id: "",
                    value: "",
                    color: nextColour(draft.options.map((o) => o.color)),
                    order: draft.options.length,
                  },
                ])
              }
            >
              + Add option
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <Switch
          checked={draft.required}
          onChange={(v) => set("required", v)}
          label="Required"
          hint="A task cannot be saved without a value"
        />
        <Switch
          checked={draft.showOnCard}
          onChange={(v) => set("showOnCard", v)}
          label="On the card"
          hint="Shown as a badge on the board"
        />
        <Switch
          checked={draft.showInList}
          onChange={(v) => set("showInList", v)}
          label="In the list"
          hint="Available as a list column — switch it on in the list's own column picker"
        />
        <Switch
          checked={draft.filterable}
          onChange={(v) => set("filterable", v)}
          label="Filterable"
          hint="Adds it to the board's filter panel"
        />
      </div>

      {error && draft.name.trim() && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={saving}>
          {editing ? "Save field" : "Create field"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
