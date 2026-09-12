import mongoose, { Schema, Model } from "mongoose";
import { ITask, PRIORITIES, DEFAULT_PRIORITY, RECURRENCE_FREQUENCIES, TASK_DECISION_STATES } from "@/types";

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
    // Whose instruction the PM assigned this on, when the PM is the assigner. Null everywhere
    // else, including an unattended PM turn — and the claim pairs it with the assignee, so a PM
    // hand-over runs only on the machine of the person who asked for it (BP-419).
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
        // What CI said about `headSha`. Absent on every link stored before BP-443, which reads as
        // "nothing has run" until the next sync — the one state that claims nothing.
        ci: {
          type: String,
          enum: ["none", "running", "success", "failure", "unknown"],
          default: "none",
        },
        ciLabel: { type: String, default: null },
        headSha: { type: String, default: null },
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
        // Server-side only: which day of the month the series was set to, so a monthly rhythm a
        // short month has clamped climbs back to it. See BP-486.
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
    // A change the protected-paths gate refused, waiting on a person. `default: null` and nothing
    // else: unlike `execution` above, whose defaults make it serialise as a truthy object on every
    // task ever written, this must be absent until a gate actually refuses something — the panel
    // reads a truthy `decision` as "there is something to answer".
    //
    // Written only by POST /api/workers/:workerId/decisions, and deliberately not reachable from
    // `updateTask`'s field list, which is what keeps MCP, the edit form and the PM agent out of it.
    decision: {
      type: {
        gate: { type: String, required: true },
        // `select: false` like the patch, and for the same reason: nothing publishes this list any
        // more — the panel renders the COUNT and the subset that tripped the gate — so its only
        // remaining reader is the audit detail's fallback for records written before `fileCount`
        // existed, which asks for it by name. Up to five hundred paths otherwise ride along on any
        // future reader that takes the parent.
        files: { type: [String], default: [], select: false },
        // The true number, beside a list bounded for rendering — see ITaskDecision.files
        fileCount: { type: Number, default: 0 },
        // `select: false` alongside `files`, so the schema is the whole protection rather than a
        // list of the three call sites that currently remember to blank `decision`. Both readers
        // that render these name them explicitly, and an explicit inclusion overrides this.
        protectedFiles: { type: [String], default: [], select: false },
        protectedFileCount: { type: Number, default: 0 },
        // `select: false` on both, and it is load-bearing rather than tidy. A task document is
        // spread into a response by a dozen readers — the search, My Tasks, the release and claim
        // routes, every writer that echoes a task back — and each one would otherwise carry up to
        // 220 KB of patch and the machine's own digest to whoever asked. Stripping it reader by
        // reader is a list that goes stale the first time somebody adds a thirteenth; not sending
        // it unless asked is the same decision made once. The two places that need it say so:
        // the task-detail GET selects `+decision.patch`, and `decisionsForWorker` names
        // `decision.patchSha256` in its own projection.
        patch: { type: String, default: "", select: false },
        patchTruncated: { type: Boolean, default: false },
        patchSha256: { type: String, default: "", select: false },
        commit: { type: String, required: true },
        workerId: { type: String, required: true },
        taskKey: { type: String, default: "" },
        title: { type: String, default: "" },
        acceptable: { type: Boolean, default: false },
        unacceptableReason: { type: String, default: "" },
        state: { type: String, enum: TASK_DECISION_STATES, default: "pending" },
        decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
        decidedAt: { type: Date, default: null },
        prUrl: { type: String, default: "" },
        error: { type: String, default: "" },
        // Bookkeeping, like the digest above: how many times the machine has tried to settle this.
        attempts: { type: Number, default: 0, select: false },
        createdAt: { type: Date, default: Date.now },
      },
      default: null,
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
// The worker asks "what is waiting on me" on every refresh, and the answer is nearly always
// nothing — unindexed, that question is a scan of every task in every project on each poll
taskSchema.index({ "decision.workerId": 1 });
// Closing a recurring task asks whether it already has a successor; unindexed that is a scan of
// every task in every project, and the usual answer — no — is the one that scans to the end
taskSchema.index({ recurringParentId: 1 });

export const Task: Model<ITask> =
  mongoose.models.Task || mongoose.model<ITask>("Task", taskSchema);
