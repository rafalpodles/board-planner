import mongoose, { Schema, Model } from "mongoose";
import { IPmTrigger, PM_TRIGGER_STATES } from "@/types";

const pmTriggerSchema = new Schema<IPmTrigger>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    type: { type: String, enum: ["needs_human_review"], required: true },
    taskKey: { type: String, required: true },
    task: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    state: { type: String, enum: PM_TRIGGER_STATES, default: "pending" },
    active: { type: Boolean, default: true },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
  },
  { timestamps: true }
);

pmTriggerSchema.index({ state: 1, createdAt: 1 });
pmTriggerSchema.index(
  { project: 1, task: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);

export const PmTrigger: Model<IPmTrigger> =
  mongoose.models.PmTrigger || mongoose.model<IPmTrigger>("PmTrigger", pmTriggerSchema);
