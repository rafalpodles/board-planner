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

// Unique among the accounts that have one, and many may have none. `$gt: ""` rather than the
// `$ne: ""` this carried until BP-281: MongoDB refuses $ne in a partial index, Mongoose swallows
// the CannotCreateIndex, and the index nobody built enforced nothing — two accounts could hold one
// address, which is the lookup a password reset by email depends on.
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
User.on("index", (err: Error | undefined) => {
  if (err) console.error("Failed to build an index on users:", err.message);
});
