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
    // Whether the bell shows this row. The document is written either way: the digest is built
    // from these, so letting the in-app switch stop the write would empty tomorrow's mail too.
    inApp: { type: Boolean, default: true },
    // Only set on rows the bell hides. They can never be marked read — the list never renders one
    // and mark-all-read skips them on purpose — so the read-based TTL below would never collect
    // them and the collection would grow for as long as somebody keeps the bell off.
    hiddenAt: { type: Date, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Compound index for efficient queries: user's unread notifications sorted by date
notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

// Read notifications expire after 90 days; unread ones are kept forever
notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, partialFilterExpression: { read: true } }
);

// A hidden row is only ever wanted by the digest, which looks back one day. A week is generous
// margin, and it bounds what muting the bell can accumulate. A second TTL is allowed because it
// keys on a different field.
notificationSchema.index({ hiddenAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

// Mongoose builds indexes in the background and keeps the failure to itself, which is how BP-281's
// uniqueness rule enforced nothing for months. A TTL that never gets built is the same shape of
// silence: the collection simply grows.
notificationSchema.on("index", (err) => {
  if (err) console.error("Notification index build failed:", err);
});

export const Notification: Model<INotification> =
  mongoose.models.Notification || mongoose.model<INotification>("Notification", notificationSchema);
