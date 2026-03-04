import mongoose, { Schema, Model } from "mongoose";
import { IProject, DIFFICULTIES, CATEGORIES, WEBHOOK_EVENTS, NOTIFICATION_CHANNEL_TYPES } from "@/types";

const labelSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    color: { type: String, required: true, default: "#3b82f6" },
  }
);

const taskTemplateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    difficulty: { type: String, enum: DIFFICULTIES, default: "M" },
    category: { type: String, enum: CATEGORIES, default: "user-story" },
    component: { type: String, default: "" },
    acceptanceCriteria: { type: String, default: "" },
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
    taskTemplates: {
      type: [taskTemplateSchema],
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
    githubRepo: {
      type: String,
      default: "",
      trim: true,
    },
    githubToken: {
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
  },
  { timestamps: true }
);

export const Project: Model<IProject> =
  mongoose.models.Project ||
  mongoose.model<IProject>("Project", projectSchema);
