import mongoose, { Schema, Model } from "mongoose";
import { IProject, DIFFICULTIES, DEFAULT_PROJECT_CATEGORIES, DEFAULT_PROJECT_COLUMNS, COLUMN_ROLES, WEBHOOK_EVENTS, NOTIFICATION_CHANNEL_TYPES, CUSTOM_FIELD_TYPES } from "@/types";

const labelSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    color: { type: String, required: true, default: "#3b82f6" },
  }
);

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
    difficulty: { type: String, enum: DIFFICULTIES, default: "M" },
    category: { type: String, default: "user-story" },
    component: { type: String, default: "" },
    acceptanceCriteria: { type: String, default: "" },
  }
);

const customFieldSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    fieldType: { type: String, enum: CUSTOM_FIELD_TYPES, required: true },
    options: { type: [String], default: [] },
    required: { type: Boolean, default: false },
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
    icon: {
      type: String,
      default: "",
      trim: true,
    },
    components: {
      type: [String],
      default: [],
    },
    labels: {
      type: [labelSchema],
      default: [],
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
    webhooks: {
      type: [{
        url: { type: String, required: true, trim: true },
        events: { type: [{ type: String, enum: WEBHOOK_EVENTS }], default: WEBHOOK_EVENTS },
        enabled: { type: Boolean, default: true },
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
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    admins: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
  },
  { timestamps: true }
);

export const Project: Model<IProject> =
  mongoose.models.Project ||
  mongoose.model<IProject>("Project", projectSchema);
