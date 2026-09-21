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

/** How long one person's consecutive edits to one field count as a single change. */
export const EDIT_SESSION_MS = 10 * 60_000;

/**
 * Records a change to a field that saves while it is being typed into.
 *
 * The description autosaves on every pause in typing, so logging each save wrote a row per pause —
 * dozens for one paragraph, each carrying the whole text twice, pushing the task's older history
 * out of the hundred rows the panel reads. One person's edits to one field within
 * `EDIT_SESSION_MS` are one change: the task's latest row is extended while it is that same edit,
 * keeping what the field said before the session began. A session that ends where it started
 * changed nothing, and leaves no row.
 */
export async function logEditSession(
  taskId: Types.ObjectId | string,
  userId: Types.ObjectId | string,
  field: string,
  oldValue: string,
  newValue: string
): Promise<void> {
  try {
    const latest = await ActivityLog.findOne({ task: taskId })
      .sort({ createdAt: -1, _id: -1 })
      .select("user action field oldValue createdAt")
      .lean<{ _id: Types.ObjectId; user: unknown; action: string; field: string; oldValue: string; createdAt: Date }>();

    const sameSession =
      !!latest &&
      latest.action === "updated" &&
      latest.field === field &&
      String(latest.user) === String(userId) &&
      Date.now() - new Date(latest.createdAt).getTime() < EDIT_SESSION_MS;

    if (sameSession && latest) {
      if (latest.oldValue === newValue) await ActivityLog.deleteOne({ _id: latest._id });
      else await ActivityLog.updateOne({ _id: latest._id }, { $set: { newValue } });
      return;
    }

    await ActivityLog.create({ task: taskId, user: userId, action: "updated", field, oldValue, newValue });
  } catch {
    console.warn("Failed to log activity");
  }
}
