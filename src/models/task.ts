import mongoose, { Schema, Model } from "mongoose";
import { ITask, PRIORITIES, DEFAULT_PRIORITY, RECURRENCE_FREQUENCIES } from "@/types";

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
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    pmAssignedFor: {
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
    agent: {
      type: Schema.Types.ObjectId,
      ref: "Agent",
      default: null,
    },
    customFieldValues: {
      type: Map,
      of: Schema.Types.Mixed,
      default: () => new Map(),
    },
    recurrence: {
      type: {
        frequency: { type: String, enum: RECURRENCE_FREQUENCIES, required: true },
        interval: { type: Number, required: true, min: 1 },
        endDate: { type: Date, default: null },
        anchorDay: { type: Number, min: 1, max: 31, default: null },
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
    execution: {
      runId: { type: String, default: "" },
      workerId: { type: String, default: "" },
      attempts: { type: Number, default: 0 },
      assignedByRun: { type: Boolean },
      startedAt: { type: Date, default: null },
      lastError: { type: String, default: "" },
      phase: { type: String },
      phaseAt: { type: Date },
      phaseSeq: { type: Number },
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true, toJSON: { flattenMaps: true }, toObject: { flattenMaps: true } }
);

taskSchema.index({ project: 1, taskNumber: 1 }, { unique: true });
taskSchema.index({ project: 1, status: 1 });
taskSchema.index({ assignee: 1 });
taskSchema.index({ sprint: 1 });
taskSchema.index({ agent: 1 });
taskSchema.index({ "execution.workerId": 1 });
taskSchema.index({ recurringParentId: 1 });

export const Task: Model<ITask> =
  mongoose.models.Task || mongoose.model<ITask>("Task", taskSchema);
