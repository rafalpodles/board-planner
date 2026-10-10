import mongoose, { Schema, Model, Types } from "mongoose";
import { withOrganisation } from "@/lib/organisation-field";

export const AI_USAGE_SOURCES = ["pm", "assist"] as const;
export const AI_KEY_SOURCES = ["own", "instance", "managed"] as const;

export interface IAiUsage {
  _id: Types.ObjectId;
  project?: Types.ObjectId;
  user?: Types.ObjectId;
  source: (typeof AI_USAGE_SOURCES)[number];
  keySource: (typeof AI_KEY_SOURCES)[number];
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  cacheWriteTokens: number;
  createdAt: Date;
}

const aiUsageSchema = new Schema<IAiUsage>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project" },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    source: { type: String, enum: AI_USAGE_SOURCES, required: true },
    keySource: { type: String, enum: AI_KEY_SOURCES, required: true },
    model: { type: String, default: "" },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    cachedPromptTokens: { type: Number, default: 0 },
    cacheWriteTokens: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

aiUsageSchema.index({ organisation: 1, createdAt: -1 });
aiUsageSchema.index({ project: 1, createdAt: -1 });

withOrganisation(aiUsageSchema);

export const AiUsage: Model<IAiUsage> = mongoose.models.AiUsage || mongoose.model<IAiUsage>("AiUsage", aiUsageSchema);
