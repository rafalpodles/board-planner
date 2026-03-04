import mongoose, { Schema, Model } from "mongoose";
import { INotification } from "@/types";

const notificationSchema = new Schema<INotification>(
  {
    recipient: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: {
      type: String,
      enum: ["task_assigned", "status_changed", "comment_added", "mentioned"],
      required: true,
    },
    task: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Compound index for efficient queries: user's unread notifications sorted by date
notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

export const Notification: Model<INotification> =
  mongoose.models.Notification || mongoose.model<INotification>("Notification", notificationSchema);
