import mongoose, { Schema, Model } from "mongoose";
import { IActivityLog } from "@/types";

const ACTIONS = [
  "created",
  "updated",
  "status_changed",
  "comment_added",
  "comment_edited",
  "comment_deleted",
];

const activityLogSchema = new Schema<IActivityLog>(
  {
    task: {
      type: Schema.Types.ObjectId,
      ref: "Task",
      required: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
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
