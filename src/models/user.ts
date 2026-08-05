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
  allowedProjects: {
    type: [{ type: Schema.Types.ObjectId, ref: "Project" }],
    default: [],
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Ensure email uniqueness (but allow multiple empty strings)
userSchema.index(
  { email: 1 },
  { unique: true, sparse: true, partialFilterExpression: { email: { $ne: "" } } }
);

// Remove password from JSON output
userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const { password: _, ...rest } = ret;
    return rest;
  },
});

export const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>("User", userSchema);
