import { Types } from "mongoose";
import { ActivityLog } from "@/models/activityLog";
import { ActivityAction } from "@/types";

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
