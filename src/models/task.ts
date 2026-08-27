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
    // Who set the assignee. A machine runs its owner's work, and "I assigned this to myself" has to
    // be distinguishable from "somebody handed this to my machine".
    assignedBy: {
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
    // Overrides the project's default for this one task. Null means nobody takes the task.
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
        // No `max` here, deliberately. The bound is enforced by `normaliseRecurrence`, which is the
        // only way a client reaches this field. Putting it on the schema as well breaks the tasks
        // stored back when a pasted 400 was accepted end to end: `createNextRecurrence` copies the
        // parent's recurrence verbatim into `Task.create`, full-document validation refuses it, and
        // the whole call is fire-and-forget — so the series would end with nothing on screen and
        // nothing in the log. That is the exact failure BP-463 exists to remove.
        interval: { type: Number, required: true, min: 1 },
        endDate: { type: Date, default: null },
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
      // No default: absent means the claim set the assignee, which is what every task claimed
      // before this field existed did — see CLEAR_WORKER_ASSIGNEE in task-service.ts
      assignedByRun: { type: Boolean },
      startedAt: { type: Date, default: null },
      lastError: { type: String, default: "" },
      // No defaults: the phase trio is written by a live run and unset when it ends, so a task
      // that is not running carries no phase fields at all
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
  // customFieldValues is a Map, and JSON.stringify turns a Map into {} — every
  // custom field value was silently absent from every API response without this
  { timestamps: true, toJSON: { flattenMaps: true }, toObject: { flattenMaps: true } }
);

taskSchema.index({ project: 1, taskNumber: 1 }, { unique: true });
taskSchema.index({ project: 1, status: 1 });
taskSchema.index({ assignee: 1 });
taskSchema.index({ sprint: 1 });
// Same shape as the two above, and the only thing the agent refusal has to ask: without it both
// the count and the candidate read are collection scans (BP-482 review).
taskSchema.index({ agent: 1 });
// The fleet console polls the worker join every 5s; unindexed, each poll scans the collection
taskSchema.index({ "execution.workerId": 1 });
// Closing a recurring task asks whether it already has a successor; unindexed that is a scan of
// every task in every project, and the usual answer — no — is the one that scans to the end
taskSchema.index({ recurringParentId: 1 });

export const Task: Model<ITask> =
  mongoose.models.Task || mongoose.model<ITask>("Task", taskSchema);
