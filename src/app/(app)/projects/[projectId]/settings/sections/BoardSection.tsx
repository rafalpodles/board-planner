"use client";

import { useEffect, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/components/ui/Toast";
import { COLUMN_ROLES, ColumnRole, ROLE_LABELS } from "@/types";
import { effectiveColumns } from "@/lib/columns";
import { Input } from "@/components/ui/Input";
import { Popover } from "@/components/ui/Popover";
import { SwatchPicker } from "@/components/ui/SwatchPicker";
import { Button } from "@/components/ui/Button";
import { SettingsCard } from "@/components/settings/SettingsCard";
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

export function BoardSection({
  projectId,
  project,
  patchProject,
  active,
}: SectionProps & { active: boolean }) {
  const api = useApi();
  const { toast } = useToast();

  const draft = useDraft({ columns: toDrafts(project.columns) });
  const [newLabel, setNewLabel] = useState("");
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [countsRequested, setCountsRequested] = useState(false);
  const dragIndex = useRef<number | null>(null);

  // /stats runs several aggregations — only pay for it once the section is opened
  useEffect(() => {
    if (!active || countsRequested) return;
    setCountsRequested(true);
    api
      .get(`/api/projects/${projectId}/stats`)
      .then((s: { statusBreakdown: Record<string, number> }) => setTaskCounts(s.statusBreakdown || {}))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, countsRequested, projectId]);

  const columns = draft.value.columns;

  function update(index: number, patch: Partial<ColumnDraft>) {
    draft.set(
      "columns",
      columns.map((c, i) => (i === index ? { ...c, ...patch } : c))
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

  return (
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
            <div className="w-[180px] shrink-0">
              <Input
                value={col.label}
                onChange={(e) => update(i, { label: e.target.value })}
                className="min-h-[38px] py-1.5"
              />
            </div>
            <Popover
              width="w-auto"
              trigger={({ toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-label={`Colour for ${col.label}`}
                  className="focus-ring h-9 w-9 shrink-0 rounded-lg border border-border"
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
            <div className="min-w-[190px]">
              <select
                value={col.role}
                aria-label={`What ${col.label || "this column"} means to automation`}
                onChange={(e) => update(i, { role: e.target.value as ColumnRole })}
                className="focus-ring w-full rounded-lg border border-border bg-bg-input px-2 py-1.5 text-sm"
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
                className="px-1 text-text-muted hover:text-text"
                aria-label="Move column up"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => reorder(i, i + 1)}
                className="px-1 text-text-muted hover:text-text"
                aria-label="Move column down"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => draft.set("columns", columns.filter((_, idx) => idx !== i))}
                className="px-1 text-text-muted hover:text-danger"
                aria-label={`Remove ${col.label}`}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      {!draft.value.columns.some((c) => c.role === "approved") && (
        <div className="mb-3 flex gap-2 rounded-lg border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm">
          <span aria-hidden>⚠</span>
          <p className="m-0">
            No column means <strong>{ROLE_LABELS.approved.label}</strong>. Workers and Claude Code
            have nowhere to take work from, and will stop without reporting anything.
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
  );
}
