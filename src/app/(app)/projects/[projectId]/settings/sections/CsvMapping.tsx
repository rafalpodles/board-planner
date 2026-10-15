"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import type { ImportBundle, ImportMapping } from "@/lib/import/bundle";
import { MAX_IMPORT_TASKS } from "@/lib/import/limits";
import { type CsvTable, type CsvTarget, commentAuthors, csvToBundle, distinctValues, guessTargets, headerRuns, isJiraExport, repeatable, shapeKey } from "@/lib/import/csv";
import { effectiveColumns, MAX_COLUMN_LABEL } from "@/lib/columns";
import { COLUMN_ROLES, type ApiProject, type ApiProjectColumn, type ColumnRole, ROLE_LABELS } from "@/types";

export interface CsvPayload {
  bundle: ImportBundle;
  mapping: ImportMapping;
}

interface Saved {
  targets: CsvTarget[];
  statuses: Record<string, string>;
  users: Record<string, string | null>;
}

const AUTOMATIC = "";
const UNASSIGNED = "\u0000unassigned";
const LISTED_VALUES = 100;
const SOURCE_MAX = 30;

const sourceFrom = (fileName: string) =>
  fileName.replace(/\.[^.]+$/, "").replace(/\s*\(\d+\)$/, "").trim().slice(0, SOURCE_MAX) || "CSV";

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
  { value: "comment", label: "Comment (one per column)" },
  { value: "parent", label: "Parent (listed, not linked)" },
];

const storageKey = (projectId: string, headers: string[]) => `bp:csv-import:${projectId}:${shapeKey(headers)}`;

const exactShape = (headers: string[]) => headers.map((h) => h.trim().toLowerCase()).join("\u0001");

interface Stored {
  // One choice per run of a repeated header, kept when every column of the run agreed
  runs?: CsvTarget[];
  // Every column's choice, for exactly this layout
  targets?: CsvTarget[];
  shape?: string;
  statuses?: Record<string, string>;
  users?: Record<string, string | null>;
}

// Targets that fit no longer leave the status and people choices behind: those are the slow ones to redo
function recall(projectId: string, headers: string[]): { targets?: CsvTarget[]; statuses: Record<string, string>; users: Record<string, string | null> } | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey(projectId, headers)) ?? "null") as Stored | null;
    if (!saved || typeof saved !== "object") return null;
    const runs = headerRuns(headers);
    const expand = (perRun: CsvTarget[]) => headers.map((_, i) => perRun[runs.filter((start) => start <= i).length - 1]);
    let targets: CsvTarget[] | undefined;
    if (Array.isArray(saved.targets) && saved.targets.length === headers.length && (saved.shape ?? exactShape(headers)) === exactShape(headers)) {
      targets = saved.targets;
    } else if (Array.isArray(saved.runs) && saved.runs.length === runs.length) targets = expand(saved.runs);
    else if (!saved.shape && Array.isArray(saved.targets) && saved.targets.length === runs.length) targets = expand(saved.targets);
    return { targets, statuses: saved.statuses ?? {}, users: saved.users ?? {} };
  } catch {
    return null;
  }
}

export function rememberCsvMapping(projectId: string, headers: string[], saved: Saved) {
  try {
    const runs = headerRuns(headers);
    const uniform = runs.every((start, r) => saved.targets.slice(start, runs[r + 1] ?? headers.length).every((t) => t === saved.targets[start]));
    const stored: Stored = {
      ...(uniform && { runs: runs.map((start) => saved.targets[start]) }),
      targets: saved.targets,
      shape: exactShape(headers),
      statuses: saved.statuses,
      users: saved.users,
    };
    window.localStorage.setItem(storageKey(projectId, headers), JSON.stringify(stored));
  } catch {}
}

function headerLabels(headers: string[]): string[] {
  const shown = headers.map((h, i) => {
    const text = h || `Column ${i + 1}`;
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  });
  return shown.map((label, i) => (shown.indexOf(label) !== shown.lastIndexOf(label) ? `${label} (column ${i + 1})` : label));
}

function columnFor(columns: ApiProjectColumn[], value: string): string {
  const wanted = value.trim().toLowerCase();
  return columns.find((c) => c.id.toLowerCase() === wanted || c.label.trim().toLowerCase() === wanted)?.id ?? AUTOMATIC;
}

export function CsvMapping({
  projectId,
  project,
  table,
  fileName,
  disabled,
  onColumns,
  onChange,
}: {
  projectId: string;
  project: ApiProject;
  table: CsvTable;
  fileName: string;
  disabled: boolean;
  onColumns: (columns: ApiProjectColumn[]) => void;
  onChange: (payload: CsvPayload | null, remember: Saved, key: string) => void;
}) {
  const api = useApi();
  const columns = useMemo(() => effectiveColumns(project.columns) as ApiProjectColumn[], [project.columns]);
  const fields = useMemo(() => project.customFields.filter((f) => !f.archived), [project.customFields]);
  const fieldShapes = useMemo(() => fields.map((f) => ({ name: f.name, fieldType: f.fieldType })), [fields]);
  const targetOptions = useMemo(
    () => [...BUILT_IN, ...fields.map((f) => ({ value: `field:${f.name}` as CsvTarget, label: `Field: ${f.name}` }))],
    [fields]
  );
  const remembered = useMemo(() => recall(projectId, table.headers), [projectId, table.headers]);
  const [upload] = useState(() => Math.random().toString(36).slice(2, 10));

  const [targets, setTargets] = useState<CsvTarget[]>(() => remembered?.targets ?? guessTargets(table.headers, fieldShapes));
  const [statuses, setStatuses] = useState<Record<string, string>>(remembered?.statuses ?? {});
  const [users, setUsers] = useState<Record<string, string | null>>(remembered?.users ?? {});
  // Not remembered: a source name carried over to another file of the same shape would update that file's tasks
  // Every Jira export, whatever its kind or file name, is one source, so its tasks update whichever kind comes next
  const [source, setSource] = useState(() => (isJiraExport(table.headers) ? "Jira" : sourceFrom(fileName)));
  const [members, setMembers] = useState<{ username: string; fullName?: string }[] | null>(null);
  const [membersFailed, setMembersFailed] = useState(false);
  const [roles, setRoles] = useState<Record<string, ColumnRole>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<{ value: string; message: string } | null>(null);

  useEffect(() => {
    api
      .get(`/api/projects/${projectId}/assignable-users`)
      .then((list: { username: string; fullName?: string }[]) => setMembers(list))
      .catch(() => {
        setMembers([]);
        setMembersFailed(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const statusValues = useMemo(() => distinctValues(table, targets.indexOf("status")), [table, targets]);
  const userValues = useMemo(
    () => [...new Set([...distinctValues(table, targets.indexOf("assignee")), ...commentAuthors(table, targets)])],
    [table, targets]
  );
  // A recalled choice that no longer names something on this board falls back to the automatic one
  const liveTargets = useMemo(
    () =>
      targets.map((t, i) => {
        if (!targetOptions.some((o) => o.value === t)) return "ignore";
        // A remembered repeat stays only while the target still takes one; otherwise the first column keeps it
        return t !== "ignore" && targets.indexOf(t) < i && !repeatable(t, fieldShapes) ? "ignore" : t;
      }),
    [targets, targetOptions, fieldShapes]
  );
  const statusOf = (value: string) => {
    const chosen = statuses[value];
    if (chosen && columns.some((c) => c.id === chosen)) return chosen;
    return columnFor(columns, value);
  };
  const userOf = (value: string): string | null | undefined => {
    if (!Object.hasOwn(users, value)) return undefined;
    const chosen = users[value];
    return chosen === null || members?.some((m) => m.username === chosen) ? chosen : undefined;
  };
  const columnsKey = columns.map((c) => `${c.id}\u0001${c.label}`).join("\u0002");
  const fieldsKey = fieldShapes.map((f) => `${f.name}\u0001${f.fieldType}`).join("\u0002");
  const membersKey = members?.map((m) => m.username).join("\u0001") ?? "";

  const hasTitle = liveTargets.includes("title");
  const hasId = liveTargets.includes("id");
  const tooMany = table.rows.length > MAX_IMPORT_TASKS;
  const trimmedSource = source.trim();

  useEffect(() => {
    const remember = { targets: liveTargets, statuses, users };
    if (!hasTitle || tooMany || !trimmedSource || adding !== null || members === null) return onChange(null, remember, "");
    const mappedStatuses: Record<string, string> = {};
    for (const value of statusValues) {
      const id = statusOf(value);
      if (id) mappedStatuses[value] = id;
    }
    const mappedUsers: Record<string, string | null> = {};
    for (const value of userValues) {
      const chosen = userOf(value);
      if (chosen !== undefined) mappedUsers[value] = chosen;
    }
    // With no id column a row is known only by its line, so each upload stands on its own
    const name = hasId ? trimmedSource : `${trimmedSource} ${upload}`;
    // What decides the payload, cheaper to compare than the payload itself
    const key = JSON.stringify([upload, liveTargets, mappedStatuses, mappedUsers, name, fieldsKey]);
    onChange(
      { bundle: csvToBundle(table, liveTargets, name, fieldShapes, upload), mapping: { statuses: mappedStatuses, users: mappedUsers } },
      remember,
      key
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the keys stand for the arrays they are built from
  }, [liveTargets, statuses, users, trimmedSource, columnsKey, fieldsKey, membersKey, table, adding, upload]);

  async function addColumn(value: string) {
    setAdding(value);
    setAddError(null);
    try {
      const next: ApiProjectColumn[] = await api.post(`/api/projects/${projectId}/columns`, {
        label: value.trim().slice(0, MAX_COLUMN_LABEL),
        role: roles[value] ?? "active",
      });
      onColumns(next);
      const made = next.find((c) => !columns.some((old) => old.id === c.id));
      if (made) setStatuses((s) => ({ ...s, [value]: made.id }));
    } catch (e) {
      setAddError({ value, message: e instanceof Error ? e.message : "The column could not be added" });
    } finally {
      setAdding(null);
    }
  }

  const labels = headerLabels(table.headers);
  const columnOptions = [
    { value: AUTOMATIC, label: "Not matched (listed in the report)" },
    ...columns.map((c) => ({ value: c.id, label: c.label })),
  ];
  const userOptions = [
    { value: AUTOMATIC, label: "By username or e-mail" },
    { value: UNASSIGNED, label: "Not on this board (left unassigned, named in comments)" },
    ...(members ?? []).map((m) => ({ value: m.username, label: m.fullName ? `${m.fullName} (${m.username})` : m.username })),
  ];

  return (
    <div data-testid="csv-mapping" className="space-y-5">
      <p className="text-sm text-text-muted">
        {table.rows.length} rows, {table.headers.length} columns.
        {isJiraExport(table.headers) && " Recognised as a Jira export."}
        {((n) => (n > 0 ? ` Its ${n} ${n === 1 ? "comment comes" : "comments come"} with it.` : ""))(
          table.comments?.reduce((total, c) => total + c.length, 0) ?? 0
        )}
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
                label={labels[i]}
                aria-describedby={table.rows[0]?.[i] ? `csv-example-${i}` : undefined}
                value={liveTargets[i]}
                options={targetOptions}
                onChange={(e) => {
                  const value = e.target.value as CsvTarget;
                  setTargets(
                    liveTargets.map((t, j) =>
                      j === i ? value : value !== "ignore" && t === value && !repeatable(value, fieldShapes) ? "ignore" : t
                    )
                  );
                }}
              />
              {table.rows[0]?.[i] && (
                <p id={`csv-example-${i}`} className="mt-0.5 truncate text-xs text-text-muted" title={table.rows[0][i]}>
                  e.g. {table.rows[0][i]}
                </p>
              )}
            </div>
          ))}
        </div>
        <p role="status" className="text-sm text-danger empty:hidden">
          {hasTitle ? "" : "Choose the column that holds each task's title."}
        </p>
        {!hasId && (
          <p className="text-sm text-text-muted">
            No ID column: uploading this file again will add its tasks again rather than update them.
          </p>
        )}
      </fieldset>

      {statusValues.length > 0 && (
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="mb-1 text-sm font-medium">Statuses</legend>
          {statusValues.slice(0, LISTED_VALUES).map((value) => (
            <div key={value} className="grid items-end gap-2 sm:grid-cols-[1fr_auto]">
              <Select
                label={`Status “${value}”`}
                value={statusOf(value)}
                options={columnOptions}
                onChange={(e) => {
                  const picked = e.target.value;
                  setStatuses((s) => {
                    const next = { ...s };
                    if (picked === AUTOMATIC) delete next[value];
                    else next[value] = picked;
                    return next;
                  });
                }}
              />
              {!statusOf(value) && (
                <div className="flex items-end gap-2">
                  <Select
                    aria-label={`Kind of column for “${value}”`}
                    value={roles[value] ?? "active"}
                    options={COLUMN_ROLES.map((r) => ({ value: r, label: `Kind: ${ROLE_LABELS[r].label}` }))}
                    onChange={(e) => setRoles((r) => ({ ...r, [value]: e.target.value as ColumnRole }))}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="min-h-[44px] shrink-0"
                    disabled={adding !== null}
                    aria-label={`Add column “${value}”`}
                    onClick={() => addColumn(value)}
                  >
                    {adding === value ? "Adding…" : "Add column"}
                  </Button>
                </div>
              )}
              {addError?.value === value && (
                <p role="alert" className="text-sm text-danger sm:col-span-2">
                  {addError.message}
                </p>
              )}
            </div>
          ))}
          {statusValues.length > LISTED_VALUES && (
            <p className="text-sm text-text-muted">
              And {statusValues.length - LISTED_VALUES} more, each matched to a column of its own name or put where new tasks go.
            </p>
          )}
        </fieldset>
      )}

      {userValues.length > 0 && (
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="mb-1 text-sm font-medium">People</legend>
          {membersFailed && <p className="text-sm text-danger">The board&apos;s members could not be loaded, so none can be picked here.</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {userValues.slice(0, LISTED_VALUES).map((value) => (
              <Select
                key={value}
                label={`Person “${value}”`}
                value={((chosen) => (chosen === undefined ? AUTOMATIC : (chosen ?? UNASSIGNED)))(userOf(value))}
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
          {userValues.length > LISTED_VALUES && (
            <p className="text-sm text-text-muted">
              And {userValues.length - LISTED_VALUES} more, each matched by username or e-mail.
            </p>
          )}
        </fieldset>
      )}

      {(liveTargets.includes("createdAt") || liveTargets.includes("completedAt")) && (
        <p className="text-sm text-text-muted">A time with no zone is read as UTC.</p>
      )}

      <div className="max-w-xs">
        <Input
          label="Source name"
          value={source}
          maxLength={SOURCE_MAX}
          disabled={disabled}
          onChange={(e) => setSource(e.target.value)}
          error={trimmedSource ? undefined : "Name where these tasks come from"}
        />
        {hasId && <p className="mt-1 text-xs text-text-muted">A re-upload under the same name updates the tasks it made.</p>}
      </div>
    </div>
  );
}
