import mongoose, { Schema, Model } from "mongoose";
import { ITask, PRIORITIES, DEFAULT_PRIORITY } from "@/types";

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
    priority: {
      type: String,
      enum: PRIORITIES,
      default: DEFAULT_PRIORITY,
    },
    category: {
      type: String,
      default: "user-story",
    },
    status: {
      type: String,
      default: "planned",
    },
    assignee: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    dueDate: {
      type: Date,
      default: null,
    },
    checklist: {
      type: [{
        text: { type: String, required: true },
        done: { type: Boolean, default: false },
      }],
      default: [],
    },
    linkedPRs: {
      type: [{
        provider: { type: String, enum: ["github", "gitlab"], default: "github" },
        number: { type: Number, required: true },
        title: { type: String, required: true },
        state: { type: String, enum: ["open", "closed", "merged"], default: "open" },
        url: { type: String, required: true },
        mergedAt: { type: Date, default: null },
        updatedAt: { type: Date, default: Date.now },
      }],
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
    relations: {
      type: [
        {
          task: { type: Schema.Types.ObjectId, ref: "Task", required: true },
          type: { type: String, enum: ["relates", "duplicates", "parent_of"], required: true },
        },
      ],
      default: [],
    },
    watchers: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    sprint: {
      type: Schema.Types.ObjectId,
      ref: "Sprint",
      default: null,
    },
    customFieldValues: {
      type: Map,
      of: Schema.Types.Mixed,
      default: () => new Map(),
    },
    recurrence: {
      type: {
        frequency: { type: String, enum: ["daily", "weekly", "monthly"], required: true },
        interval: { type: Number, required: true, min: 1 },
      },
      default: null,
    },
    recurringParentId: {
      type: Schema.Types.ObjectId,
      ref: "Task",
      default: null,
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
  // customFieldValues is a Map, and JSON.stringify turns a Map into {} — every
  // custom field value was silently absent from every API response without this
  { timestamps: true, toJSON: { flattenMaps: true }, toObject: { flattenMaps: true } }
);

taskSchema.index({ project: 1, taskNumber: 1 }, { unique: true });
taskSchema.index({ project: 1, status: 1 });
taskSchema.index({ assignee: 1 });
taskSchema.index({ sprint: 1 });

export const Task: Model<ITask> =
  mongoose.models.Task || mongoose.model<ITask>("Task", taskSchema);
