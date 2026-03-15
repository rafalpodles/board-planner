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
  role: {
    type: String,
    enum: ["admin", "member"],
    default: "member",
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
