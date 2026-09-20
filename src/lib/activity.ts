import { Types } from "mongoose";
import { ActivityLog } from "@/models/activityLog";
import { ActivityAction } from "@/types";

/**
 * Several rows from one act, in one write.
 *
 * `insertMany` is ordered by default, so the documents are inserted — and their ids minted — in
 * the order given. That matters because a reader breaks a `createdAt` tie on `_id`: one request
 * can write four rows inside a millisecond, and without an order they render in an arbitrary one.
 * Doing it as N awaited `create` calls buys the same guarantee for N round-trips.
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
  } catch {
    // Same contract as logActivity: a history row must never break the write it describes
    console.warn("Failed to log activity");
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
