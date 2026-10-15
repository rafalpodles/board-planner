"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import type { ImportBundle, ImportMapping } from "@/lib/import/bundle";
import { MAX_IMPORT_TASKS } from "@/lib/import/limits";
import { type CsvTable, type CsvTarget, csvToBundle, distinctValues, guessTargets, shapeKey } from "@/lib/import/csv";
import { COLUMN_ROLES, type ApiProject, type ApiProjectColumn, type ColumnRole, ROLE_LABELS } from "@/types";

export interface CsvPayload {
  bundle: ImportBundle;
  mapping: ImportMapping;
}

interface Saved {
  targets: CsvTarget[];
  statuses: Record<string, string>;
  users: Record<string, string | null>;
  source: string;
}

const AUTOMATIC = "";
const UNASSIGNED = "\u0000unassigned";

const BUILT_IN: { value: CsvTarget; label: string }[] = [
  { value: "ignore", label: "Leave out" },
  { value: "id", label: "ID (matches a re-upload)" },
  { value: "title", label: "Title" },
  { value: "description", label: "Description" },
  { value: "status", label: "Status" },
  { value: "assignee", label: "Assignee" },
  { value: "priority", label: "Priority" },
  { value: "category", label: "Category" },
  { value: "dueDate", label: "Due date" },
  { value: "createdAt", label: "Created" },
  { value: "completedAt", label: "Completed" },
];

const storageKey = (projectId: string, headers: string[]) => `bp:csv-import:${projectId}:${shapeKey(headers)}`;

function recall(projectId: string, headers: string[]): Saved | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey(projectId, headers)) ?? "null") as Saved | null;
    return saved && Array.isArray(saved.targets) && saved.targets.length === headers.length ? saved : null;
  } catch {
    return null;
  }
}

export function rememberCsvMapping(projectId: string, headers: string[], saved: Saved) {
  try {
    window.localStorage.setItem(storageKey(projectId, headers), JSON.stringify(saved));
  } catch {}
}

function columnFor(columns: ApiProjectColumn[], value: string): string {
  const wanted = value.trim().toLowerCase();
  return columns.find((c) => c.id.toLowerCase() === wanted || c.label.trim().toLowerCase() === wanted)?.id ?? AUTOMATIC;
}

export function CsvMapping({
  projectId,
  project,
  table,
  disabled,
  onColumns,
  onChange,
}: {
  projectId: string;
  project: ApiProject;
  table: CsvTable;
  disabled: boolean;
  onColumns: (columns: ApiProjectColumn[]) => void;
  onChange: (payload: CsvPayload | null, remember: Saved) => void;
}) {
  const api = useApi();
  const columns = useMemo(() => project.columns ?? [], [project.columns]);
  const fields = useMemo(() => project.customFields.filter((f) => !f.archived), [project.customFields]);
  const fieldShapes = useMemo(() => fields.map((f) => ({ name: f.name, fieldType: f.fieldType })), [fields]);
  const remembered = useMemo(() => recall(projectId, table.headers), [projectId, table.headers]);

  const [targets, setTargets] = useState<CsvTarget[]>(() => remembered?.targets ?? guessTargets(table.headers, fieldShapes));
  const [statuses, setStatuses] = useState<Record<string, string>>(remembered?.statuses ?? {});
  const [users, setUsers] = useState<Record<string, string | null>>(remembered?.users ?? {});
  const [source, setSource] = useState(remembered?.source ?? "CSV");
  const [members, setMembers] = useState<{ username: string; fullName?: string }[]>([]);
  const [roles, setRoles] = useState<Record<string, ColumnRole>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState("");

  useEffect(() => {
    api
      .get(`/api/projects/${projectId}/assignable-users`)
      .then((list: { username: string; fullName?: string }[]) => setMembers(list))
      .catch(() => setMembers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const statusValues = useMemo(() => distinctValues(table, targets.indexOf("status")), [table, targets]);
  const userValues = useMemo(() => distinctValues(table, targets.indexOf("assignee")), [table, targets]);
  const statusOf = (value: string) => statuses[value] ?? columnFor(columns, value);

  const hasTitle = targets.includes("title");
  const hasId = targets.includes("id");
  const tooMany = table.rows.length > MAX_IMPORT_TASKS;
  const trimmedSource = source.trim();

  useEffect(() => {
    const remember = { targets, statuses, users, source: trimmedSource };
    if (!hasTitle || tooMany || !trimmedSource) return onChange(null, remember);
    const mappedStatuses = Object.fromEntries(statusValues.map((v) => [v, statusOf(v)]).filter(([, id]) => id));
    const mappedUsers = Object.fromEntries(
      userValues.filter((v) => Object.hasOwn(users, v)).map((v) => [v, users[v]])
    );
    // With no id column a row is known only by its line, so each upload stands on its own
    const name = hasId ? trimmedSource : `${trimmedSource} ${new Date().toISOString().slice(0, 16)}`.slice(0, 50);
    onChange(
      { bundle: csvToBundle(table, targets, name, fieldShapes), mapping: { statuses: mappedStatuses, users: mappedUsers } },
      remember
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, statuses, users, trimmedSource, columns, table]);

  async function addColumn(value: string) {
    setAdding(value);
    setAddError("");
    try {
      const next: ApiProjectColumn[] = await api.post(`/api/projects/${projectId}/columns`, {
        label: value.slice(0, 50),
        role: roles[value] ?? "active",
      });
      onColumns(next);
      const made = next.find((c) => !columns.some((old) => old.id === c.id));
      if (made) setStatuses((s) => ({ ...s, [value]: made.id }));
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "The column could not be added");
    } finally {
      setAdding(null);
    }
  }

  const targetOptions = [
    ...BUILT_IN,
    ...fields.map((f) => ({ value: `field:${f.name}` as CsvTarget, label: `Field: ${f.name}` })),
  ];
  const columnOptions = [
    { value: AUTOMATIC, label: "Where new tasks go" },
    ...columns.map((c) => ({ value: c.id, label: c.label })),
  ];
  const userOptions = [
    { value: AUTOMATIC, label: "By username or e-mail" },
    { value: UNASSIGNED, label: "Leave unassigned" },
    ...members.map((m) => ({ value: m.username, label: m.fullName ? `${m.fullName} (${m.username})` : m.username })),
  ];

  return (
    <div data-testid="csv-mapping" className="space-y-5">
      <p className="text-sm text-text-muted">
        {table.rows.length} rows, {table.headers.length} columns.
      </p>
      {tooMany && (
        <p role="alert" className="text-sm text-danger">
          An import takes at most {MAX_IMPORT_TASKS.toLocaleString("en-US")} rows; split the file.
        </p>
      )}

      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="mb-1 text-sm font-medium">Columns</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {table.headers.map((header, i) => (
            <div key={i} className="min-w-0">
              <Select
                label={header || `Column ${i + 1}`}
                value={targets[i]}
                options={targetOptions}
                onChange={(e) => {
                  const value = e.target.value as CsvTarget;
                  setTargets((all) => all.map((t, j) => (j === i ? value : value !== "ignore" && t === value ? "ignore" : t)));
                }}
              />
              {table.rows[0]?.[i] && (
                <p className="mt-0.5 truncate text-xs text-text-muted" title={table.rows[0][i]}>
                  e.g. {table.rows[0][i]}
                </p>
              )}
            </div>
          ))}
        </div>
        {!hasTitle && <p className="text-sm text-danger">Choose the column that holds each task&apos;s title.</p>}
        {!hasId && (
          <p className="text-sm text-text-muted">
            No ID column: uploading this file again will add its tasks again rather than update them.
          </p>
        )}
      </fieldset>

      {statusValues.length > 0 && (
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="mb-1 text-sm font-medium">Statuses</legend>
          {addError && (
            <p role="alert" className="text-sm text-danger">
              {addError}
            </p>
          )}
          {statusValues.map((value) => (
            <div key={value} className="grid items-end gap-2 sm:grid-cols-[1fr_auto]">
              <Select
                label={`Status “${value}”`}
                value={statusOf(value)}
                options={columnOptions}
                onChange={(e) => setStatuses((s) => ({ ...s, [value]: e.target.value }))}
              />
              {!statusOf(value) && (
                <div className="flex items-end gap-2">
                  <Select
                    aria-label={`Kind of column for “${value}”`}
                    value={roles[value] ?? "active"}
                    options={COLUMN_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r].label }))}
                    onChange={(e) => setRoles((r) => ({ ...r, [value]: e.target.value as ColumnRole }))}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="min-h-[44px] shrink-0"
                    disabled={adding !== null}
                    onClick={() => addColumn(value)}
                  >
                    {adding === value ? "Adding…" : "Add column"}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </fieldset>
      )}

      {userValues.length > 0 && (
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="mb-1 text-sm font-medium">People</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {userValues.map((value) => (
              <Select
                key={value}
                label={`Assignee “${value}”`}
                value={Object.hasOwn(users, value) ? (users[value] ?? UNASSIGNED) : AUTOMATIC}
                options={userOptions}
                onChange={(e) => {
                  const picked = e.target.value;
                  setUsers((u) => {
                    const next = { ...u };
                    if (picked === AUTOMATIC) delete next[value];
                    else next[value] = picked === UNASSIGNED ? null : picked;
                    return next;
                  });
                }}
              />
            ))}
          </div>
        </fieldset>
      )}

      <div className="max-w-xs">
        <Input
          label="Source name"
          value={source}
          maxLength={30}
          disabled={disabled}
          onChange={(e) => setSource(e.target.value)}
          error={trimmedSource ? undefined : "Name where these tasks come from"}
        />
        <p className="mt-1 text-xs text-text-muted">A re-upload under the same name updates the tasks it made.</p>
      </div>
    </div>
  );
}
