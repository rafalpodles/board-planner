import mongoose, { Schema, Model } from "mongoose";
import { IProject, DEFAULT_PROJECT_CATEGORIES, DEFAULT_PROJECT_COLUMNS, COLUMN_ROLES, WEBHOOK_EVENTS, NOTIFICATION_CHANNEL_TYPES, CUSTOM_FIELD_TYPES } from "@/types";

const categorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    color: { type: String, required: true, default: "#3b82f6" },
  }
);

const columnSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    color: { type: String, required: true, default: "#6b7280" },
    role: { type: String, enum: COLUMN_ROLES, required: true },
    order: { type: Number, required: true },
    triggersPmReview: { type: Boolean, default: false },
  }
);

const taskTemplateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    category: { type: String, default: "user-story" },
    acceptanceCriteria: { type: String, default: "" },
  }
);

const customFieldSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    fieldType: { type: String, enum: CUSTOM_FIELD_TYPES, required: true },
    // Mixed, not a subdocument schema: options stored before CP-211 are plain
    // strings, and casting them to the new shape silently discards them. Shape is
    // enforced in lib/custom-fields.ts, which also converts the legacy form.
    options: { type: [Schema.Types.Mixed], default: [] },
    required: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    showOnCard: { type: Boolean, default: false },
    showInList: { type: Boolean, default: false },
    filterable: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
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
    // Every key this project has answered to. A task key is built from the current one, so
    // renaming it renames all of them at once — while the branches and pull requests that
    // already exist keep the old prefix forever. Matching those needs the old key kept.
    formerKeys: {
      type: [String],
      default: [],
    },
    description: {
      type: String,
      default: "",
    },
    icon: {
      type: String,
      default: "",
      trim: true,
    },
    categories: {
      type: [categorySchema],
      default: () =>
        DEFAULT_PROJECT_CATEGORIES.map((c) => ({ ...c })) as unknown as IProject["categories"],
    },
    columns: {
      type: [columnSchema],
      default: () =>
        DEFAULT_PROJECT_COLUMNS.map((c) => ({ ...c })) as unknown as IProject["columns"],
    },
    taskTemplates: {
      type: [taskTemplateSchema],
      default: [],
    },
    customFields: {
      type: [customFieldSchema],
      default: [],
    },
    // Which custom field's numeric value sums as this project's estimate; "" means it
    // doesn't. Kept in sync by the custom-fields route when that field is archived or deleted.
    estimateFieldId: {
      type: String,
      default: "",
    },
    webhooks: {
      type: [{
        url: { type: String, required: true, trim: true },
        events: { type: [{ type: String, enum: WEBHOOK_EVENTS }], default: WEBHOOK_EVENTS },
        enabled: { type: Boolean, default: true },
        // Single-shot delivery, deliberately (BP-407) — the same fire-and-forget choice the
        // activity log and dispatchNotifications already make, so the outcome of the one attempt
        // has to be visible somewhere rather than retried. No default on lastStatus/lastError:
        // absent means never attempted, which reads correctly as blank rather than as "ok".
        lastAttemptAt: { type: Date, default: null },
        lastStatus: { type: String, enum: ["ok", "failed"] },
        lastError: { type: String, default: "" },
      }],
      default: [],
    },
    notificationChannels: {
      type: [{
        type: { type: String, enum: NOTIFICATION_CHANNEL_TYPES, required: true },
        name: { type: String, required: true, trim: true },
        webhookUrl: { type: String, required: true, trim: true },
        events: { type: [{ type: String, enum: WEBHOOK_EVENTS }], default: WEBHOOK_EVENTS },
        enabled: { type: Boolean, default: true },
      }],
      default: [],
    },
    pm: {
      enabled: { type: Boolean, default: false },
      // Instance-admin kill switch: overrides `enabled` and cannot be cleared from project settings
      lockedByInstance: { type: Boolean, default: false },
      model: { type: String, default: "" },
      contextNotes: { type: String, default: "" },
      dailyTurnCap: { type: Number, default: 0 },
      autonomy: {
        dailyReview: { type: Boolean, default: false },
        reviewHour: { type: Number, default: 9, min: 0, max: 23 },
        reviewIntervalHours: { type: Number, default: 24, min: 1, max: 24 },
        timezone: { type: String, default: "Europe/Warsaw" },
        handleNeedsHumanReview: { type: Boolean, default: false },
        lastReviewSlot: { type: String, default: "" },
      },
      links: {
        type: [{
          label: { type: String, required: true, trim: true },
          url: { type: String, required: true, trim: true },
        }],
        default: [],
      },
      mcpServers: {
        type: [{
          name: { type: String, required: true, trim: true },
          url: { type: String, required: true, trim: true },
          authType: { type: String, enum: ["none", "bearer", "oauth"], default: "none" },
          authToken: { type: String, default: "" },
          oauth: {
            type: {
              clientId: { type: String, default: "" },
              clientSecret: { type: String, default: "" },
              authorizationEndpoint: { type: String, default: "" },
              tokenEndpoint: { type: String, default: "" },
              registrationEndpoint: { type: String, default: "" },
              redirectUri: { type: String, default: "" },
              scopes: { type: [String], default: [] },
              tokenAuthMethod: { type: String, default: "none" },
              accessToken: { type: String, default: "" },
              refreshToken: { type: String, default: "" },
              expiresAt: { type: Date, default: null },
              status: { type: String, enum: ["unconfigured", "connected", "needs_reauth"], default: "unconfigured" },
            },
            default: undefined,
            _id: false,
          },
          allowWrites: { type: Boolean, default: false },
          toolAllowlist: { type: [String], default: [] },
          enabled: { type: Boolean, default: true },
        }],
        default: [],
      },
    },
    // Whether workers may run this project, and how. The repository path is deliberately absent:
    // a worker reports the checkouts it has and matches this project by its remote, so the server
    // never names a directory on someone else's machine.
    worker: {
      enabled: { type: Boolean, default: false },
      policy: {
        autoMerge: { type: Boolean, default: false },
        reviewGate: { type: Boolean, default: true },
        baseBranch: { type: String, default: "main" },
        taskTimeoutMs: { type: Number, default: 1_800_000 },
        maxDiffLines: { type: Number, default: 400 },
        maxDiffFiles: { type: Number, default: 10 },
        model: { type: String, default: "opus" },
        fallbackModel: { type: String, default: "sonnet" },
        reviewModel: { type: String, default: "opus" },
      },
      // A plain field, not a policy one, and since BP-358 not a fallback either: an agent travels
      // on the claim response resolved from the TASK, and this is only the one the task picker
      // offers first. A task naming no agent is one a person is doing.
      agent: { type: Schema.Types.ObjectId, ref: "Agent", default: null },
      policyOverrides: { type: [String], default: [] },
    },
    // The one place a project names its repository, whoever hosts it. The provider is derived from
    // the host — see src/lib/repository.ts.
    repositoryUrl: {
      type: String,
      default: "",
      trim: true,
    },
    // Superseded by repositoryUrl and no longer read or written by the app; kept so the migration
    // is reversible until scripts/migrate-repository-url.ts has run everywhere.
    githubRepo: {
      type: String,
      default: "",
      trim: true,
    },
    githubToken: {
      type: String,
      default: "",
    },
    gitlabRepo: {
      type: String,
      default: "",
      trim: true,
    },
    gitlabHost: {
      type: String,
      default: "https://gitlab.com",
      trim: true,
    },
    gitlabToken: {
      type: String,
      default: "",
    },
    codaHost: {
      type: String,
      default: "https://coda.io",
      trim: true,
    },
    codaDocId: {
      type: String,
      default: "",
      trim: true,
    },
    codaTableId: {
      type: String,
      default: "",
      trim: true,
    },
    codaToken: {
      type: String,
      default: "",
    },
    taskCounter: {
      type: Number,
      default: 0,
    },
    // Sparse ordering: reordering rewrites only the projects that moved
    sortOrder: {
      type: Number,
      default: 0,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

export const Project: Model<IProject> =
  mongoose.models.Project ||
  mongoose.model<IProject>("Project", projectSchema);
