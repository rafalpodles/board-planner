import mongoose, { Schema, Model } from "mongoose";
import { IUser } from "@/types";

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

// Remove password from JSON output
userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const { password: _, ...rest } = ret;
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
