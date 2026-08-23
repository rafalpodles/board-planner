import mongoose, { Schema, Model } from "mongoose";
import { IUser, NOTIFICATION_TYPES, PERSONAL_CHAT_KINDS } from "@/types";

// One sub-schema reused by the global grid and by every project override, so a row cannot mean
// one thing in one place and something else in the other. `_id: false` keeps Mongoose from
// stamping an id onto each cell.
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
  // Superseded by `notifications` below. Still read for accounts that predate the grid, which is
  // why nothing migrates them: this field IS their stored preference until they save the screen.
  emailNotifications: {
    type: Boolean,
    default: false,
  },
  notifications: {
    // Absent means "never opened the screen" — resolveChannels falls back to emailNotifications.
    // A blank grid and an absent one are different answers, so this has no default.
    defaults: { type: notificationMatrixSchema, default: undefined },
    // A row here is the override switch for that project. There is no separate flag, so the two
    // cannot disagree; clearing the switch removes the row.
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
      // Encrypted at rest, like every other credential this instance stores
      webhookUrl: { type: String, default: "" },
    },
  },
  // One roll-up in the morning instead of a mail per event. Off by default: a digest is silence
  // for most of the day, and nobody should be moved into it without asking.
  emailDigest: {
    type: Boolean,
    default: false,
  },
  // The day a digest was last sent, in the instance's digest timezone, so a second app instance
  // ticking at the same minute cannot send it twice
  lastDigestDay: {
    type: String,
    default: "",
  },
  // true keeps the board's existing behaviour for everyone who never touches it
  collapseEmptyColumns: {
    type: Boolean,
    default: true,
  },
  role: {
    type: String,
    enum: ["admin", "member"],
    default: "member",
  },
  // Everything that existed before this field is a person, which is what the default has to say
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

// Unique among the accounts that have one, and many may have none. Until BP-281 this asked for
// `sparse` together with `partialFilterExpression: { email: { $ne: "" } }`, which MongoDB refuses
// twice over — the two options cannot be combined, and $ne is not a supported partial expression.
// Mongoose swallows the CannotCreateIndex, so the index nobody built enforced nothing: two
// accounts could hold one address, the lookup a password reset by email depends on.
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $gt: "" } } });

// Remove the credentials from JSON output. The webhook is encrypted at rest, but it rides on the
// user document, and three routes serialise a whole user — the admin list, the admin single fetch
// and the caller's own PUT — so without this an admin's user list would carry every colleague's
// stored chat destination. Projects strip theirs the same way, in sanitizeProjectSecrets.
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

// Mongoose builds indexes in the background and keeps the failure to itself, which is how a
// uniqueness rule can be declared here and enforce nothing for months. Say so instead.
// Attached only when this module compiled the model, or a dev server's hot reloads pile listeners
// on the cached one until Node warns about a leak
if (!mongoose.models.User || User.listenerCount("index") === 0) {
  User.on("index", (err: Error | undefined) => {
    if (err) console.error("Failed to build an index on users:", err.message);
  });
}
