import mongoose, { Schema, Model } from "mongoose";
import { AGENT_BUCKETS, AGENT_SCOPES, IAgent } from "@/types";

const entrySchema = new Schema(
  {
    key: { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: undefined },
  },
  { _id: false }
);

const compositionSchema = new Schema(
  {
    analysis: { type: [entrySchema], default: [] },
    implementation: { type: [entrySchema], default: [] },
    verification: { type: [entrySchema], default: [] },
    delivery: { type: [entrySchema], default: [] },
  },
  { _id: false }
);

export const agentSchema = new Schema<IAgent>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    scope: { type: String, enum: AGENT_SCOPES, required: true },
    owner: { type: Schema.Types.ObjectId, ref: "User", default: null },
    project: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    composition: { type: compositionSchema, default: () => ({}) },
    builtIn: { type: Boolean, default: false },
  },
  { timestamps: true }
);

agentSchema.pre("init", function (raw: Record<string, unknown>) {
  const composition = raw?.composition as Record<string, unknown> | undefined;
  if (!composition) return;
  for (const bucket of AGENT_BUCKETS) {
    const entries = composition[bucket];
    if (!Array.isArray(entries)) continue;
    composition[bucket] = entries.map((entry) => (typeof entry === "string" ? { key: entry } : entry));
  }
});

agentSchema.index({ scope: 1, owner: 1 });
agentSchema.index({ scope: 1, project: 1 });

export const Agent: Model<IAgent> =
  mongoose.models.Agent || mongoose.model<IAgent>("Agent", agentSchema);
