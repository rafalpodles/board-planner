import mongoose, { Schema, Model } from "mongoose";
import { IProject } from "@/types";

const labelSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    color: { type: String, required: true, default: "#3b82f6" },
  }
);

const projectSchema = new Schema<IProject>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    key: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    components: {
      type: [String],
      default: [],
    },
    labels: {
      type: [labelSchema],
      default: [],
    },
    githubRepo: {
      type: String,
      default: "",
      trim: true,
    },
    taskCounter: {
      type: Number,
      default: 0,
    },
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

export const Project: Model<IProject> =
  mongoose.models.Project ||
  mongoose.model<IProject>("Project", projectSchema);
