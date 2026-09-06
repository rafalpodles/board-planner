import mongoose, { Schema, Model } from "mongoose";
import { INotification } from "@/types";

const notificationSchema = new Schema<INotification>(
  {
    recipient: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: {
      type: String,
      enum: ["task_assigned", "status_changed", "comment_added", "mentioned", "task_created"],
      required: true,
    },
    task: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    read: { type: Boolean, default: false, index: true },
    inApp: { type: Boolean, default: true },
    hiddenAt: { type: Date, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, partialFilterExpression: { read: true } }
);

notificationSchema.index({ hiddenAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

notificationSchema.on("index", (err) => {
  if (err) console.error("Notification index build failed:", err);
});

export const Notification: Model<INotification> =
  mongoose.models.Notification || mongoose.model<INotification>("Notification", notificationSchema);
