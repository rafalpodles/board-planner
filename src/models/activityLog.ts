import mongoose, { Schema, Model } from "mongoose";
import { IActivityLog } from "@/types";

const ACTIONS = [
  "created",
  "updated",
  "status_changed",
  "comment_added",
  "comment_edited",
  "comment_deleted",
  "pr_linked",
  "pr_unlinked",
  "link_added",
  "link_removed",
];

const activityLogSchema = new Schema<IActivityLog>(
  {
    task: {
      type: Schema.Types.ObjectId,
      ref: "Task",
      required: true,
    },
    // Optional, and only for the two `pr_*` actions: a scheduled sync has nobody to name, and a
    // borrowed name would be a history row that cannot be asked about (BP-628).
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    action: {
      type: String,
      enum: ACTIONS,
      required: true,
    },
    field: {
      type: String,
      default: "",
    },
    oldValue: {
      type: String,
      default: "",
    },
    newValue: {
      type: String,
      default: "",
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

activityLogSchema.index({ task: 1, createdAt: -1 });

export const ActivityLog: Model<IActivityLog> =
  mongoose.models.ActivityLog ||
  mongoose.model<IActivityLog>("ActivityLog", activityLogSchema);
