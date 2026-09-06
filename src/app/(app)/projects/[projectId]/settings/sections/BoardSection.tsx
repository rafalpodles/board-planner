"use client";

import { useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/components/ui/Toast";
import { COLUMN_ROLES, ColumnRole, ROLE_LABELS } from "@/types";
import { effectiveColumns } from "@/lib/columns";
import { escalationColumnId, flaggedColumnIds, withEscalationColumn } from "@/lib/escalation";
import { Input } from "@/components/ui/Input";
import { Popover } from "@/components/ui/Popover";
import { SwatchPicker } from "@/components/ui/SwatchPicker";
import { Button } from "@/components/ui/Button";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingRow } from "@/components/settings/SettingRow";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { SectionProps } from "./types";

interface ColumnDraft {
  id?: string;
  label: string;
  color: string;
  role: ColumnRole;
  triggersPmReview: boolean;
}

function toDrafts(columns: Parameters<typeof effectiveColumns>[0]): ColumnDraft[] {
  return effectiveColumns(columns).map((c) => ({
    id: c.id,
    label: c.label,
    color: c.color,
    role: c.role,
    triggersPmReview: c.triggersPmReview === true,
  }));
}

export function BoardSection({ projectId, project, patchProject, stats }: SectionProps) {
  const api = useApi();
  const { toast } = useToast();

  const draft = useDraft({ columns: toDrafts(project.columns) });
  const [newLabel, setNewLabel] = useState("");
  const taskCounts = stats?.statusBreakdown ?? {};
  const dragIndex = useRef<number | null>(null);

  const columns = draft.value.columns;

  function update(index: number, patch: Partial<ColumnDraft>) {
    draft.set(
      "columns",
      columns.map((c, i) => {
        if (i !== index) return c;
        const next = { ...c, ...patch };
        return next.role === "review" ? next : { ...next, triggersPmReview: false };
      })
    );
  }

  function reorder(from: number, to: number) {
    if (to < 0 || to >= columns.length || from === to) return;
    const next = [...columns];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    draft.set("columns", next);
  }

  function addColumn() {
    if (!newLabel.trim()) return;
    draft.set("columns", [
      ...columns,
      { label: newLabel.trim(), color: "#6b7280", role: "backlog", triggersPmReview: false },
    ]);
    setNewLabel("");
  }

  useDirtyGroup(
    { id: "board-columns", section: "board", label: "Board · Columns", count: draft.count },
    {
      save: async () => {
        try {
          const saved = await api.put(`/api/projects/${projectId}/columns`, { columns });
          patchProject({ columns: saved });
          draft.commit({ columns: toDrafts(saved) });
          toast("Columns saved", "success");
        } catch (err) {
          toast(err instanceof Error ? err.message : "Failed to save columns", "error");
        }
      },
      discard: draft.discard,
    }
  );

  const reviewColumns = columns.filter((c) => c.role === "review" && c.id);
  const escalation = escalationColumnId(columns);
  const explicit = columns.some((c) => c.triggersPmReview);
  const strandedFlags = flaggedColumnIds(effectiveColumns(project.columns)).filter(
    (id) => id !== escalation
  );

  return (
    <>
    <SettingsCard
      title="Columns"
      description="Drag to reorder. A column that still holds tasks can't be removed."
    >
      <div className="space-y-2">
        {columns.map((col, i) => (
          <div
            key={col.id ?? `new-${i}`}
            draggable
            onDragStart={() => {
              dragIndex.current = i;
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex.current !== null) {
                reorder(dragIndex.current, i);
                dragIndex.current = null;
              }
            }}
            className="flex cursor-grab flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-input/30 px-3 py-2"
          >
            <span className="select-none text-text-muted">⠿</span>
            <div className="min-w-0 flex-1 sm:w-[180px] sm:flex-none sm:shrink-0">
              <Input
                value={col.label}
                aria-label="Column name"
                onChange={(e) => update(i, { label: e.target.value })}
                className="py-1.5"
              />
            </div>
            <Popover
              width="w-auto"
              trigger={({ toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-label={`Colour for ${col.label}`}
                  className="focus-ring h-11 w-11 shrink-0 rounded-lg border border-border sm:h-9 sm:w-9"
                  style={{ backgroundColor: col.color }}
                />
              )}
            >
              {({ close }) => (
                <div className="p-2">
                  <SwatchPicker
                    value={col.color}
                    label={`Colour for ${col.label}`}
                    onChange={(hex) => {
                      update(i, { color: hex });
                      close();
                    }}
                  />
                </div>
              )}
            </Popover>
            <div className="min-w-0 flex-1 basis-full sm:min-w-[190px] sm:flex-none sm:basis-auto">
              <select
                value={col.role}
                aria-label={`What ${col.label || "this column"} means to automation`}
                onChange={(e) => update(i, { role: e.target.value as ColumnRole })}
                className="focus-ring w-full rounded-lg border border-border bg-bg-input min-h-11 px-2 py-1.5 text-sm sm:min-h-0"
              >
                {COLUMN_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r].label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-text-muted">{ROLE_LABELS[col.role].hint}</p>
            </div>
            <span className="flex-1" />
            {col.id && taskCounts[col.id] !== undefined && (
              <span className="text-xs text-text-muted">
                {taskCounts[col.id]} {taskCounts[col.id] === 1 ? "task" : "tasks"}
              </span>
            )}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => reorder(i, i - 1)}
                className="inline-flex h-11 w-11 items-center justify-center rounded text-text-muted sm:h-6 sm:w-auto sm:px-1 hover:text-text"
                aria-label="Move column up"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => reorder(i, i + 1)}
                className="inline-flex h-11 w-11 items-center justify-center rounded text-text-muted sm:h-6 sm:w-auto sm:px-1 hover:text-text"
                aria-label="Move column down"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => draft.set("columns", columns.filter((_, idx) => idx !== i))}
                className="inline-flex h-11 w-11 items-center justify-center rounded text-text-muted sm:h-6 sm:w-auto sm:px-1 hover:text-danger"
                aria-label={`Remove ${col.label}`}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      {!draft.value.columns.some((c) => c.role === "done") && (
        <div className="mb-3 flex gap-2 rounded-lg border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm">
          <span aria-hidden>⚠</span>
          <p className="m-0">
            No column means <strong>{ROLE_LABELS.done.label}</strong>. Nothing can be finished:
            sprint progress cannot be measured, and a worker will not take a task from this board.
          </p>
        </div>
      )}

      {!draft.value.columns.some((c) => c.role === "active") && (
        <div className="mb-3 flex gap-2 rounded-lg border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm">
          <span aria-hidden>⚠</span>
          <p className="m-0">
            No column means <strong>{ROLE_LABELS.active.label}</strong>. A worker has nowhere to
            move a task it takes, so it claims nothing, and the dashboard cannot count what is in
            progress.
          </p>
        </div>
      )}

      {!draft.value.columns.some((c) => c.role === "approved") && (
        <div className="mb-3 flex gap-2 rounded-lg border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm">
          <span aria-hidden>⚠</span>
          <p className="m-0">
            No column means <strong>{ROLE_LABELS.approved.label}</strong>. Workers and Claude Code
            have nowhere to take work from.
          </p>
        </div>
      )}
      <div className="flex gap-2">
        <Input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="New column name..."
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addColumn();
            }
          }}
        />
        <Button variant="secondary" disabled={!newLabel.trim()} onClick={addColumn}>
          Add column
        </Button>
      </div>
    </SettingsCard>

    <SettingsCard
      title="Hand-off to the PM agent"
      description="The one column that means a human or the PM agent needs to look at this."
    >
      <SettingRow label="Escalation column" hint="Two things land here">
        <div>
          <select
            value={explicit ? escalation : ""}
            aria-label="Escalation column"
            onChange={(e) =>
              draft.set("columns", withEscalationColumn(columns, e.target.value || null))
            }
            className="focus-ring w-full rounded-lg border border-border bg-bg-input min-h-11 px-3 py-2 text-sm sm:min-h-0"
          >
            <option value="">— none —</option>
            {reviewColumns.map((c) => (
              <option key={c.id ?? c.label} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-text-muted">
            A task whose worker run fails or times out is moved here, and — if PM autonomy is
            on — arriving here queues a PM turn against the daily cap.
          </p>
          {reviewColumns.length === 0 && (
            <p className="mt-1.5 text-xs text-text-muted">
              Only a column set to <strong>{ROLE_LABELS.review.label}</strong> can take the
              hand-off, and this board has none.
            </p>
          )}
          {!explicit && escalation && (
            <p className="mt-1.5 text-xs text-text-muted">
              Nothing is chosen, so automation falls back to the first review column —{" "}
              <strong>{columns.find((c) => c.id === escalation)?.label}</strong>.
            </p>
          )}
        </div>
      </SettingRow>

      {strandedFlags.length > 0 && (
        <div className="flex gap-2 rounded-lg border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm">
          <span aria-hidden>⚠</span>
          <p className="m-0">
            This board hands off from more than one column, which nothing supports. Saving keeps{" "}
            <strong>{columns.find((c) => c.id === escalation)?.label ?? "none"}</strong> and stops{" "}
            {strandedFlags
              .map((id) => effectiveColumns(project.columns).find((c) => c.id === id)?.label ?? id)
              .join(", ")}{" "}
            from queueing PM turns.
          </p>
        </div>
      )}
    </SettingsCard>
    </>
  );
}
