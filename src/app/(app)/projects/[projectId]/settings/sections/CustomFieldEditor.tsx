"use client";

import { useState } from "react";
import { ApiCustomField, FIELD_TYPE_LABELS } from "@/types";
import { isOptionField, orderedOptions } from "@/lib/custom-fields";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface Props {
  field: ApiCustomField;
  onEdit: () => void;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onDelete: () => void;
}

const FLAG_CHIPS = [
  { key: "required", label: "Required" },
  { key: "showOnCard", label: "On card" },
  { key: "showInList", label: "In list" },
  { key: "filterable", label: "Filterable" },
] as const;

/**
 * The collapsed row for one field. Editing lives in CustomFieldForm — the same form
 * that creates one. Keeping those apart is what left three of the four flags
 * unreachable until after a field already existed.
 */
export function CustomFieldEditor({ field, onEdit, onSave, onDelete }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const optionCount = isOptionField(field) ? orderedOptions(field).length : 0;
  const type = FIELD_TYPE_LABELS[field.fieldType];

  async function toggleArchived() {
    setBusy(true);
    try {
      await onSave({ archived: !field.archived });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 ${
        field.archived ? "opacity-60" : ""
      }`}
    >
      <div className="min-w-[140px] flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{field.name}</span>
          {field.archived && (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
              Archived
            </span>
          )}
        </div>
        <p className="text-xs text-text-muted">
          {type.label}
          {optionCount > 0 && ` · ${optionCount} option${optionCount === 1 ? "" : "s"}`}
          {field.archived && " · values kept on tasks"}
        </p>
      </div>

      <div className="flex flex-wrap gap-1">
        {FLAG_CHIPS.filter((c) => field[c.key]).map((c) => (
          <span
            key={c.key}
            className="rounded-full bg-bg-input px-2 py-0.5 text-[11px] text-text-muted"
          >
            {c.label}
          </span>
        ))}
      </div>

      <div className="ml-auto flex gap-1">
        <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}>
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={toggleArchived} disabled={busy}>
          {field.archived ? "Restore" : "Archive"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} disabled={busy}>
          Delete
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        title={`Delete “${field.name}”?`}
        message={
          "Every task's value for this field is erased and cannot be recovered. " +
          "Archive instead to hide the field and keep them."
        }
        confirmLabel="Delete field"
        onConfirm={() => {
          setConfirming(false);
          onDelete();
        }}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
