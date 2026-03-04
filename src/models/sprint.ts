import mongoose, { Schema, Model } from "mongoose";
import { ISprint, SPRINT_STATUSES } from "@/types";

const sprintSchema = new Schema<ISprint>(
  {
    project: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    goal: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: SPRINT_STATUSES,
      default: "planned",
    },
  },
  { timestamps: true }
);

sprintSchema.index({ project: 1, status: 1 });

export const Sprint: Model<ISprint> =
  mongoose.models.Sprint || mongoose.model<ISprint>("Sprint", sprintSchema);
