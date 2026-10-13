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
      finishedAt: Date | null;
      reopened: number;
      endedIn: HistoryRole;
      unknownColumns: string[];
      gap: boolean;
    };

/**
 * A task's entries are its creation (into the column the first row left, which is the one fact a
 * row's `oldValue` keeps) followed by every recorded change, oldest first.
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
 * `gap` says the last recorded column is not where the task is now, so a row went unwritten.
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

  const entries = [
    ...(ordered[0].oldValue ? [{ column: ordered[0].oldValue, at: task.createdAt }] : []),
    ...ordered.map((row) => ({ column: row.newValue, at: row.createdAt })),
  ];

  let startedAt: Date | null = null;
  let finishedAt: Date | null = null;
  let reopened = 0;
  let inDone = false;
  const unknownColumns = new Set<string>();

  for (const { column, at } of entries) {
    const role = roleOf(column);
    if (role === "unknown") {
      unknownColumns.add(column);
      continue;
    }
    if (role === "active" && startedAt === null) startedAt = at;
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
  return {
    kind: "recorded",
    startedAt,
    finishedAt,
    reopened,
    endedIn: roleOf(last),
    unknownColumns: [...unknownColumns],
    gap: task.status !== undefined && task.status !== last,
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
  history: StatusHistory;
}

/**
 * Every task of a project with what its status rows say, one query for the rows and one for the
 * tasks. The rows come through `{project, action, createdAt}`; a task with none is included, as
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
    db.Task.find({ project: projectId }, "taskNumber status createdAt").lean(),
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
    history: statusHistory(byTask.get(String(task._id)) ?? [], roleOf, {
      createdAt: task.createdAt,
      status: task.status,
    }),
  }));
}
