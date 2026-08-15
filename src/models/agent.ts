import mongoose, { Schema, Model } from "mongoose";
import { AGENT_SCOPES, IAgent } from "@/types";

// One position in the sequence. The key says which block; params override that block's own, for
// this position only — which is what lets one agent carry two Size gates with different limits
// without two rows in the catalog.
const entrySchema = new Schema(
  {
    key: { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: undefined },
  },
  { _id: false }
);

// Buckets stay separate arrays rather than one list so a bucket's meaning survives an empty one:
// an agent with nothing in analysis still says where analysis would go.
const compositionSchema = new Schema(
  {
    analysis: { type: [entrySchema], default: [] },
    implementation: { type: [entrySchema], default: [] },
    verification: { type: [entrySchema], default: [] },
    delivery: { type: [entrySchema], default: [] },
  },
  { _id: false }
);

const agentSchema = new Schema<IAgent>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    scope: { type: String, enum: AGENT_SCOPES, required: true },
    // Exactly one of these is set, by scope: a user agent has an owner, a project agent a project,
    // a global one neither.
    owner: { type: Schema.Types.ObjectId, ref: "User", default: null },
    project: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    composition: { type: compositionSchema, default: () => ({}) },
    builtIn: { type: Boolean, default: false },
  },
  { timestamps: true }
);

agentSchema.index({ scope: 1, owner: 1 });
agentSchema.index({ scope: 1, project: 1 });

export const Agent: Model<IAgent> =
  mongoose.models.Agent || mongoose.model<IAgent>("Agent", agentSchema);
