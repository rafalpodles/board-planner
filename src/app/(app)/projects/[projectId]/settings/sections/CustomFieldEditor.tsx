"use client";

import { useState, type CSSProperties } from "react";
import { ApiCustomField, ICustomFieldOption, DEFAULT_OPTION_COLOR } from "@/types";
import { isOptionField, orderedOptions } from "@/lib/custom-fields";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

const SWITCHES = [
  { key: "required", label: "Required", hint: "Blocks saving a task while empty" },
  { key: "showOnCard", label: "On card", hint: "Shows as a badge on the board card" },
  { key: "showInList", label: "In list", hint: "Available as a sortable list column" },
  { key: "filterable", label: "Filterable", hint: "Appears in the board filter panel" },
] as const;

type SwitchKey = (typeof SWITCHES)[number]["key"];

interface Props {
  field: ApiCustomField;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onDelete: () => void;
}

export function CustomFieldEditor({ field, onSave, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(field.name);
  const [options, setOptions] = useState<ICustomFieldOption[]>(orderedOptions(field));
  const [flags, setFlags] = useState<Record<SwitchKey, boolean>>({
    required: !!field.required,
    showOnCard: !!field.showOnCard,
    showInList: !!field.showInList,
    filterable: !!field.filterable,
  });
  const [saving, setSaving] = useState(false);

  const hasOptions = isOptionField(field);

  function reset() {
    setName(field.name);
    setOptions(orderedOptions(field));
    setFlags({
      required: !!field.required,
      showOnCard: !!field.showOnCard,
      showInList: !!field.showInList,
      filterable: !!field.filterable,
    });
  }

  function move(index: number, by: number) {
    const next = [...options];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOptions(next.map((o, i) => ({ ...o, order: i })));
  }

  async function save() {
    setSaving(true);
    try {
      await onSave({ name, ...flags, ...(hasOptions ? { options } : {}) });
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  const activeSwitches = SWITCHES.filter((s) => flags[s.key]);

  return (
    <div
      className={`rounded-lg border border-border ${field.archived ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="text-sm font-medium">{field.name}</span>
        <span className="rounded bg-bg-input px-2 py-0.5 text-xs text-text-muted">
          {field.fieldType}
        </span>
        {field.archived && (
          <span className="rounded bg-bg-input px-2 py-0.5 text-xs text-warning">archived</span>
        )}
        {activeSwitches.map((s) => (
          <span key={s.key} className="rounded bg-bg-input px-2 py-0.5 text-[11px] text-text-muted">
            {s.label}
          </span>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            if (open) reset();
            setOpen(!open);
          }}
          aria-expanded={open}
          className="focus-ring rounded px-2 py-1 text-xs text-text-muted hover:text-text"
        >
          {open ? "Cancel" : "Edit"}
        </button>
        <button
          type="button"
          onClick={() => onSave({ archived: !field.archived })}
          className="focus-ring rounded px-2 py-1 text-xs text-text-muted hover:text-text"
        >
          {field.archived ? "Restore" : "Archive"}
        </button>
        {/* Deleting is only offered for a field nobody has filled in; archiving is
            for everything else, and it keeps the values */}
        <button
          type="button"
          onClick={onDelete}
          className="focus-ring rounded px-2 py-1 text-xs text-text-muted hover:text-danger"
        >
          Delete
        </button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} label="Name" />

          {hasOptions && (
            <div className="space-y-2">
              <span className="block text-sm font-medium">Options</span>
              {options.map((option, index) => (
                <div key={option.id} className="flex items-center gap-2">
                  <input
                    type="color"
                    value={option.color || DEFAULT_OPTION_COLOR}
                    onChange={(e) =>
                      setOptions(
                        options.map((o, i) => (i === index ? { ...o, color: e.target.value } : o))
                      )
                    }
                    aria-label={`Colour for ${option.value}`}
                    className="h-8 w-8 shrink-0 cursor-pointer rounded border border-border bg-bg-input"
                  />
                  <input
                    value={option.value}
                    onChange={(e) =>
                      setOptions(
                        options.map((o, i) => (i === index ? { ...o, value: e.target.value } : o))
                      )
                    }
                    aria-label={`Option ${index + 1}`}
                    className="focus-ring min-w-0 flex-1 rounded-lg border border-border bg-bg-input px-3 py-1.5 text-sm"
                  />
                  {/* Buttons rather than drag: the order matters to sorting, and a
                      keyboard user has to be able to set it */}
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${option.value} up`}
                    className="focus-ring rounded px-1.5 py-1 text-xs text-text-muted hover:text-text disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === options.length - 1}
                    aria-label={`Move ${option.value} down`}
                    className="focus-ring rounded px-1.5 py-1 text-xs text-text-muted hover:text-text disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => setOptions(options.filter((_, i) => i !== index))}
                    aria-label={`Remove ${option.value}`}
                    className="focus-ring rounded px-1.5 py-1 text-xs text-text-muted hover:text-danger"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setOptions([
                    ...options,
                    { id: "", value: "", color: DEFAULT_OPTION_COLOR, order: options.length },
                  ])
                }
              >
                Add option
              </Button>
            </div>
          )}

          <div className="flex flex-wrap gap-4">
            {SWITCHES.map((s) => (
              <label key={s.key} title={s.hint} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={flags[s.key]}
                  onChange={(e) => setFlags({ ...flags, [s.key]: e.target.checked })}
                  className="focus-ring rounded border-border"
                />
                {s.label}
              </label>
            ))}
          </div>

          {flags.required && field.archived && (
            <p className="text-xs text-text-muted">
              Archived wins over required — this field will not block saving a task.
            </p>
          )}

          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save field"}
            </Button>
          </div>
        </div>
      )}

      {!open && hasOptions && orderedOptions(field).length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
          {orderedOptions(field).map((option) => (
            <span
              key={option.id}
              className="chip chip-custom rounded-full px-2 py-0.5 text-[11px]"
              style={{ "--chip": option.color } as CSSProperties}
            >
              {option.value}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
