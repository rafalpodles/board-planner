import { Types } from "mongoose";
import { ActivityLog } from "@/models/activityLog";
import { ActivityAction } from "@/types";

/**
 * Several rows from one act, in one write.
 *
 * What gives a reader the order is that Mongoose mints each `_id` while casting, in array order,
 * before anything is sent — `ordered: true` is what keeps the SERVER from reordering them. Both
 * matter, because a reader breaks a `createdAt` tie on `_id` and one request can write four rows
 * inside a millisecond. Doing it as N awaited `create` calls buys the same guarantee for N
 * round-trips.
 *
 * `ordered` also decides what a failure leaves behind: a validation error rejects the whole batch
 * before anything is sent, while a server error part-way through keeps the rows before it. Ordered
 * is kept anyway, because the alternative trades the guarantee above for a partial write in a
 * different shape — and the catch below says which happened rather than leaving it to be guessed.
 */
export async function logActivities(
  rows: {
    taskId: Types.ObjectId | string;
    userId: Types.ObjectId | string | null;
    action: ActivityAction;
    field?: string;
    oldValue?: string;
    newValue?: string;
    customField?: boolean;
  }[]
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await ActivityLog.insertMany(
      rows.map((row) => ({
        task: row.taskId,
        user: row.userId,
        action: row.action,
        field: row.field || "",
        oldValue: row.oldValue || "",
        newValue: row.newValue || "",
        ...(row.customField && { customField: true }),
      }))
    );
  } catch (err) {
    // Same contract as logActivity: a history row must never break the write it describes. But an
    // ORDERED bulk stops at the first failure and keeps what went before it, and `rows` is built
    // losses-first — so a truncated batch is a timeline saying a task lost its parent and never
    // gained one, which is the false impression these rows exist to prevent. Mongoose hands the
    // count back on the error; a bare warning would hide exactly the case worth knowing about.
    const written = (err as { insertedDocs?: unknown[] })?.insertedDocs?.length ?? 0;
    console.warn(`Failed to log activity: wrote ${written} of ${rows.length} rows`);
  }
}

export async function logActivity(
  taskId: Types.ObjectId | string,
  // Null is a sync writing about what GitHub said, which no person authored (BP-628)
  userId: Types.ObjectId | string | null,
  action: ActivityAction,
  field?: string,
  oldValue?: string,
  newValue?: string
): Promise<void> {
  try {
    await ActivityLog.create({
      task: taskId,
      user: userId,
      action,
      field: field || "",
      oldValue: oldValue || "",
      newValue: newValue || "",
    });
  } catch {
    // Activity logging should never break the main operation
    console.warn("Failed to log activity");
  }
}

export const EDIT_SESSION_MS = 10 * 60_000;

const TYPED_FIELDS = new Set(["title", "description"]);

export interface ActivityHeader {
  _id: Types.ObjectId;
  user: unknown;
  action: string;
  field: string;
  customField?: boolean;
  createdAt: Date;
}

export interface EditSession<T extends ActivityHeader = ActivityHeader> {
  newest: T;
  oldest: T;
}

function typedEdit(row: ActivityHeader) {
  return row.action === "updated" && (row.customField === true || TYPED_FIELDS.has(row.field));
}

function sameEdit(a: ActivityHeader, b: ActivityHeader) {
  return (
    a.field === b.field &&
    !!a.customField === !!b.customField &&
    String(a.user) === String(b.user) &&
    Math.abs(a.createdAt.getTime() - b.createdAt.getTime()) < EDIT_SESSION_MS
  );
}

export function editSessions<T extends ActivityHeader>(newestFirst: T[]): EditSession<T>[] {
  const sessions: EditSession<T>[] = [];
  for (const row of newestFirst) {
    const open = sessions.at(-1);
    if (open && typedEdit(row) && typedEdit(open.oldest) && sameEdit(open.oldest, row)) open.oldest = row;
    else sessions.push({ newest: row, oldest: row });
  }
  return sessions;
}

export function presentSessions<R extends { _id: unknown; field: string; customField?: boolean; oldValue: string; newValue: string }>(
  sessions: EditSession[],
  rows: R[]
): R[] {
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  return sessions.flatMap(({ newest, oldest }) => {
    const last = byId.get(String(newest._id));
    const first = byId.get(String(oldest._id));
    if (!last || !first) return [];
    if (first !== last && first.oldValue === last.newValue) return [];
    const row = { ...last, oldValue: first.oldValue };
    return row.field === "description" && !row.customField ? [{ ...row, newValue: "" }] : [row];
  });
}
