import { Types } from "mongoose";
import type { ColumnRole } from "@/types";
import type { ScopedDb } from "@/lib/db-scope";
import { getProjectColumns } from "@/lib/columns";

export type HistoryRole = ColumnRole | "unknown";

export interface StatusRow {
  _id: unknown;
  oldValue: string;
  newValue: string;
  createdAt: Date;
}

export type StatusHistory =
  | { kind: "no-history" }
  | {
      kind: "recorded";
      startedAt: Date | null;
      startInferred: boolean;
      finishedAt: Date | null;
      reopened: number;
      endedIn: HistoryRole;
      unknownColumns: string[];
      gap: boolean;
    };

interface Entry {
  column: string;
  at: Date | null;
  afterBreak?: boolean;
}

/**
 * A task's entries are every recorded change, oldest first, preceded by the column the first row
 * left. That column is taken to be where the task was created, at `task.createdAt`, because a row
 * keeps nothing else about it; `startInferred` says a start came from that and not from a row.
 *
 * started  — the first entry into an `active`-role column.
 * finished — the start of the final uninterrupted stay in `done`-role columns. Moving between two
 *            done columns is not an exit; leaving for any other role is, and a task that left has
 *            no finish until it is done again.
 * reopened — how many times it left `done` after having been finished.
 *
 * A column id the project no longer has resolves to `unknown`: it neither starts nor finishes a task
 * and does not undo a finish, so a deleted column costs a task its role and not its history.
 * `endedIn` says what role the task's last recorded column had, `unknown` being its own bucket.
 * A task with no rows is `no-history`: nothing is known about it, which is not the same as zero days.
 *
 * `gap` says a transition is missing: a row's `oldValue` is not the column the previous row left
 * the task in, or the last recorded column is not where the task is now. A break before any start
 * was seen leaves the start unknown whatever the column beyond it is, because the missing moves may
 * have passed through an active one; the column on the far side is entered at an unknown time.
 * A reader that wants durations leaves out a task with `gap` or `startInferred`.
 *
 * What the rows cannot show: a move out and back with nothing written in between (a claim that was
 * released, a lease that expired) leaves a chain that holds together, and so no gap.
 */
export function statusHistory(
  rows: StatusRow[],
  roleOf: (columnId: string) => HistoryRole,
  task: { createdAt: Date; status?: string }
): StatusHistory {
  if (rows.length === 0) return { kind: "no-history" };

  const ordered = [...rows].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0)
  );

  const entries: Entry[] = [];
  let gap = false;
  if (ordered[0].oldValue) entries.push({ column: ordered[0].oldValue, at: task.createdAt });
  for (const [index, row] of ordered.entries()) {
    if (index > 0 && row.oldValue !== ordered[index - 1].newValue) {
      gap = true;
      entries.push({ column: row.oldValue, at: null, afterBreak: true });
    }
    entries.push({ column: row.newValue, at: row.createdAt });
  }

  let startedAt: Date | null = null;
  let startSeen = false;
  let startInferred = false;
  let finishedAt: Date | null = null;
  let reopened = 0;
  let inDone = false;
  const unknownColumns = new Set<string>();

  const hasCreationEntry = Boolean(ordered[0].oldValue);
  for (const [position, { column, at, afterBreak }] of entries.entries()) {
    if (afterBreak && !startSeen) startSeen = true;
    const role = roleOf(column);
    if (role === "unknown") {
      if (column) unknownColumns.add(column);
      continue;
    }
    if (role === "active" && !startSeen) {
      startSeen = true;
      startedAt = at;
      startInferred = hasCreationEntry && position === 0;
    }
    if (role === "done") {
      if (!inDone) finishedAt = at;
      inDone = true;
    } else {
      if (inDone) {
        reopened++;
        finishedAt = null;
      }
      inDone = false;
    }
  }

  const last = entries[entries.length - 1].column;
  if (task.status !== undefined && task.status !== last) gap = true;

  return {
    kind: "recorded",
    startedAt,
    startInferred,
    finishedAt,
    reopened,
    endedIn: roleOf(last),
    unknownColumns: [...unknownColumns],
    gap,
  };
}

export const STATUS_CHANGE_ACTION = "status_changed" as const;

export function statusChangeFilter(projectId: string | Types.ObjectId) {
  return { project: projectId, action: STATUS_CHANGE_ACTION };
}

export const STATUS_CHANGE_SORT = { createdAt: 1 } as const;

export interface TaskStatusHistory {
  taskId: string;
  taskNumber: number;
  status: string;
  archived: boolean;
  history: StatusHistory;
}

/**
 * Every task of a project with what its status rows say, from one read each of the project, its
 * rows and its tasks. The rows come through `{project, action, createdAt}`; a task with none is included, as
 * `no-history`, so a caller cannot mistake a missing row for a fast task.
 */
export async function projectStatusHistories(db: ScopedDb, projectId: string): Promise<TaskStatusHistory[]> {
  const project = await db.Project.findById(projectId, "columns").lean();
  if (!project) return [];
  const roleByColumn = new Map(getProjectColumns(project).map((column) => [column.id, column.role as HistoryRole]));
  const roleOf = (columnId: string): HistoryRole => roleByColumn.get(columnId) ?? "unknown";

  const [rows, tasks] = await Promise.all([
    db.ActivityLog.find(statusChangeFilter(projectId), "task oldValue newValue createdAt")
      .sort(STATUS_CHANGE_SORT)
      .lean(),
    db.Task.find({ project: projectId }, "taskNumber status createdAt archivedAt").lean(),
  ]);

  const byTask = new Map<string, StatusRow[]>();
  for (const row of rows) {
    const key = String(row.task);
    const held = byTask.get(key);
    if (held) held.push(row);
    else byTask.set(key, [row]);
  }

  return tasks.map((task) => ({
    taskId: String(task._id),
    taskNumber: task.taskNumber,
    status: task.status,
    archived: task.archivedAt != null,
    history: statusHistory(byTask.get(String(task._id)) ?? [], roleOf, {
      createdAt: task.createdAt,
      status: task.status,
    }),
  }));
}
