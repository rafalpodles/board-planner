import mongoose, { Schema, Model } from "mongoose";
import { ITask, TASK_STATUSES, DIFFICULTIES, CATEGORIES } from "@/types";

const taskSchema = new Schema<ITask>(
  {
    project: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    taskNumber: {
      type: Number,
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    difficulty: {
      type: String,
      enum: DIFFICULTIES,
      default: "M",
    },
    component: {
      type: String,
      default: "",
    },
    category: {
      type: String,
      enum: CATEGORIES,
      default: "user-story",
    },
    status: {
      type: String,
      enum: TASK_STATUSES,
      default: "planned",
    },
    assignee: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    acceptanceCriteria: {
      type: String,
      default: "",
    },
    labels: {
      type: [{ type: Schema.Types.ObjectId }],
      default: [],
    },
    pinned: {
      type: Boolean,
      default: false,
    },
    blockedBy: {
      type: [{ type: Schema.Types.ObjectId, ref: "Task" }],
      default: [],
    },
    watchers: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    order: {
      type: Number,
      default: 0,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

taskSchema.index({ project: 1, taskNumber: 1 }, { unique: true });
taskSchema.index({ project: 1, status: 1 });

export const Task: Model<ITask> =
  mongoose.models.Task || mongoose.model<ITask>("Task", taskSchema);
