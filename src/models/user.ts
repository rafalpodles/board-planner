import mongoose, { Schema, Model } from "mongoose";
import { IUser, NOTIFICATION_TYPES, PERSONAL_CHAT_KINDS } from "@/types";

const notificationMatrixSchema = new Schema(
  Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [
      type,
      {
        inApp: { type: Boolean, default: false },
        email: { type: Boolean, default: false },
        chat: { type: Boolean, default: false },
      },
    ])
  ),
  { _id: false }
);

const userSchema = new Schema<IUser>({
  username: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
    select: false,
  },
  fullName: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    default: "",
    trim: true,
    lowercase: true,
  },
  emailNotifications: {
    type: Boolean,
    default: false,
  },
  notifications: {
    defaults: { type: notificationMatrixSchema, default: undefined },
    projects: {
      type: [
        {
          project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
          matrix: { type: notificationMatrixSchema, required: true },
        },
      ],
      default: [],
    },
    chat: {
      kind: { type: String, enum: [...PERSONAL_CHAT_KINDS, ""], default: "" },
      webhookUrl: { type: String, default: "" },
    },
  },
  emailDigest: {
    type: Boolean,
    default: false,
  },
  lastDigestDay: {
    type: String,
    default: "",
  },
  collapseEmptyColumns: {
    type: Boolean,
    default: true,
  },
  role: {
    type: String,
    enum: ["admin", "member"],
    default: "member",
  },
  kind: {
    type: String,
    enum: ["human", "machine"],
    default: "human",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $gt: "" } } });

userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const { password: _, ...rest } = ret as unknown as Record<string, unknown> & {
      notifications?: { chat?: { webhookUrl?: string } };
    };
    if (rest.notifications?.chat) {
      const { webhookUrl: _url, ...chat } = rest.notifications.chat;
      rest.notifications = { ...rest.notifications, chat };
    }
    return rest;
  },
});

export const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>("User", userSchema);

if (!mongoose.models.User || User.listenerCount("index") === 0) {
  User.on("index", (err: Error | undefined) => {
    if (err) console.error("Failed to build an index on users:", err.message);
  });
}
