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
  },
  fullName: {
    type: String,
    required: true,
    trim: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Remove password from JSON output
userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const { password: _, ...rest } = ret;
    return rest;
  },
});

export const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>("User", userSchema);
