"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { MAX_COLUMNS, MAX_COLUMN_LABEL } from "@/lib/columns";
import { COLUMN_ROLES, ColumnRole, ROLE_LABELS } from "@/types";
import {
  DEFAULT_COLUMNS,
  SIMPLE_COLUMNS,
  columnsOf,
  nextColumnUid,
  roleSummary,
  workflowProblem,
  type ColumnDraft,
  type Preset,
  type WizardState,
} from "./wizard-model";

interface WorkflowStepProps {
  state: WizardState;
  onChange: (patch: Partial<WizardState>) => void;
}

const PRESETS: { id: Preset; title: string; blurb: string }[] = [
  { id: "default", title: "Default", blurb: "The seven columns Board Planner runs on, with review hand-offs." },
  { id: "simple", title: "Simple", blurb: "Backlog, To Do, In Progress, Done. No review step." },
  { id: "custom", title: "Custom", blurb: "Start from Simple and shape it yourself." },
];

function Strip({ columns }: { columns: ColumnDraft[] }) {
  return (
    <span aria-hidden="true" className="mt-2.5 flex gap-[3px]">
      {columns.map((c, i) => (
        <i key={i} className="h-1.5 flex-1 rounded-[3px]" style={{ background: c.color }} />
      ))}
    </span>
  );
}

type Focus =
  | { kind: "control"; uid: string; control: "up" | "down" | "remove" }
  | { kind: "name"; uid: string }
  | { kind: "new" };

export function WorkflowStep({ state, onChange }: WorkflowStepProps) {
  const [newLabel, setNewLabel] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const pending = useRef<Focus | null>(null);
  const columns = columnsOf(state);
  const custom = state.customColumns;
  const problem = workflowProblem(state);

  // Focus follows the column a button acted on, not the position it was in: the row at that
  // position is somebody else's after a move or a removal
  useEffect(() => {
    const target = pending.current;
    if (!target) return;
    pending.current = null;
    const root = document.getElementById("wizard-columns");
    if (target.kind === "new") {
      document.getElementById("wizard-new-column")?.focus();
    } else if (target.kind === "name") {
      root?.querySelector<HTMLElement>(`[data-uid="${target.uid}"] [data-control="name"]`)?.focus();
    } else {
      const wanted = root?.querySelector<HTMLButtonElement>(`[data-uid="${target.uid}"] [data-control="${target.control}"]`);
      const fallback = root?.querySelector<HTMLElement>(`[data-uid="${target.uid}"] [data-control="name"]`);
      (wanted && !wanted.disabled ? wanted : fallback)?.focus();
    }
  });

  function setCustom(next: ColumnDraft[]) {
    onChange({ customColumns: next });
  }
  function update(index: number, patch: Partial<ColumnDraft>) {
    setCustom(custom.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }
  function move(index: number, to: number, control: "up" | "down") {
    if (to < 0 || to >= custom.length) return;
    const next = [...custom];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    pending.current = { kind: "control", uid: moved.uid, control };
    setAnnouncement(`${moved.label || "Column"} moved to position ${to + 1} of ${next.length}`);
    setCustom(next);
  }
  function remove(index: number) {
    const gone = custom[index];
    const neighbour = custom[index + 1] ?? custom[index - 1];
    pending.current = neighbour ? { kind: "name", uid: neighbour.uid } : { kind: "new" };
    setAnnouncement(`${gone.label || "Column"} removed`);
    setCustom(custom.filter((_, i) => i !== index));
  }
  function add() {
    const label = newLabel.trim();
    if (!label || custom.length >= MAX_COLUMNS) return;
    const created = { uid: nextColumnUid(), label, role: "active" as ColumnRole, color: "#6b7280", triggersPmReview: false };
    pending.current = { kind: "new" };
    setAnnouncement(`${label} added`);
    setCustom([...custom, created]);
    setNewLabel("");
  }

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div role="radiogroup" aria-label="Column preset" className="grid gap-2.5 sm:grid-cols-3">
        {PRESETS.map((preset) => {
          const shown =
            preset.id === "default" ? DEFAULT_COLUMNS : preset.id === "simple" ? SIMPLE_COLUMNS : custom;
          const checked = state.preset === preset.id;
          return (
            <label
              key={preset.id}
              className={`block cursor-pointer rounded-xl border p-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary ${
                checked ? "border-primary bg-primary/10" : "border-border bg-bg-input/30"
              }`}
            >
              <input
                type="radio"
                name="preset"
                value={preset.id}
                checked={checked}
                onChange={() => onChange({ preset: preset.id })}
                className="sr-only"
              />
              <b className="block text-sm">{preset.title}</b>
              <span className="mt-0.5 block text-xs text-text-muted">{preset.blurb}</span>
              <Strip columns={shown} />
            </label>
          );
        })}
      </div>

      {state.preset === "custom" ? (
        <div>
          <p className="mb-2 text-[13.5px] font-semibold">Columns</p>
          <ul id="wizard-columns" className="space-y-2">
            {custom.map((col, i) => (
              <li
                key={col.uid}
                data-uid={col.uid}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-border bg-bg-input/30 p-2 sm:grid-cols-[minmax(0,1fr)_190px_auto]"
              >
                <input
                  value={col.label}
                  data-control="name"
                  aria-label="Column name"
                  maxLength={MAX_COLUMN_LABEL}
                  onChange={(e) => update(i, { label: e.target.value })}
                  className="focus-ring min-h-11 w-full rounded-lg border border-border bg-bg-input px-3 py-1.5 text-text sm:min-h-10"
                />
                <div className="flex items-center gap-0.5 sm:order-3">
                  <button
                    type="button"
                    data-control="up"
                    onClick={() => move(i, i - 1, "up")}
                    disabled={i === 0}
                    aria-label={`Move ${col.label || "column"} up`}
                    className="focus-ring h-11 w-11 rounded-lg text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-30 sm:h-10 sm:w-9"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    data-control="down"
                    onClick={() => move(i, i + 1, "down")}
                    disabled={i === custom.length - 1}
                    aria-label={`Move ${col.label || "column"} down`}
                    className="focus-ring h-11 w-11 rounded-lg text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-30 sm:h-10 sm:w-9"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    data-control="remove"
                    onClick={() => remove(i)}
                    aria-label={`Remove ${col.label || "column"}`}
                    className="focus-ring h-11 w-11 rounded-lg text-text-muted hover:bg-bg-hover hover:text-text sm:h-10 sm:w-9"
                  >
                    ✕
                  </button>
                </div>
                <select
                  value={col.role}
                  aria-label={`Role for ${col.label || "column"}`}
                  onChange={(e) => update(i, { role: e.target.value as ColumnRole })}
                  className="focus-ring col-span-2 min-h-11 w-full rounded-lg border border-border bg-bg-input px-2 py-1.5 text-sm text-text sm:order-2 sm:col-span-1 sm:min-h-10"
                >
                  {COLUMN_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role].label}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <input
              id="wizard-new-column"
              value={newLabel}
              aria-label="New column name"
              placeholder="New column"
              maxLength={MAX_COLUMN_LABEL}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              className="focus-ring min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-bg-input px-3 py-1.5 text-text placeholder:text-text-muted sm:min-h-10"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={add}
              disabled={!newLabel.trim() || custom.length >= MAX_COLUMNS}
            >
              Add column
            </Button>
          </div>
          <p className="mt-2 text-xs text-text-muted">
            Column colours and which column hands over to the PM are set in Settings → Board once the
            project exists.
          </p>
        </div>
      ) : (
        <div>
          <p className="mb-2 text-[13.5px] font-semibold">
            Columns <span className="ml-1.5 text-xs font-normal text-text-muted">{columns.length} on the board</span>
          </p>
          <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {columns.map((c, i) => (
              <li
                key={c.uid}
                className="min-w-0 rounded-lg border border-border bg-bg-input/30 px-2.5 py-1.5"
                style={{ borderLeft: `3px solid ${c.color}` }}
              >
                <b className="block text-[13px]">{c.label}</b>
                <span className="block text-[11px] text-text-muted">
                  {ROLE_LABELS[c.role].label}
                  {c.triggersPmReview ? " · PM review" : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {problem && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}

      <div>
        <p className="mb-2 text-[13.5px] font-semibold">
          What automation reads
          <span className="ml-1.5 text-xs font-normal text-text-muted">
            Workers and the PM agent key on roles, not names.
          </span>
        </p>
        <dl className="overflow-hidden rounded-xl border border-border">
          {roleSummary(columns).map((row) => (
            <div
              key={row.role}
              className="grid gap-1 border-b border-border px-3 py-2.5 text-[13px] last:border-b-0 sm:grid-cols-[170px_minmax(0,1fr)] sm:gap-3"
            >
              <dt className="font-semibold">
                {row.label}
                <span className="block text-xs font-normal text-text-muted">{row.hint}</span>
              </dt>
              <dd className="m-0">
                {row.columns.length > 0 ? (
                  row.columns.join(", ")
                ) : (
                  <span className="text-text-muted">No column.</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}
