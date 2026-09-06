import mongoose, { Schema, Model } from "mongoose";
import { BLOCK_KINDS, IAgentBlock, STEP_CAPABILITIES } from "@/types";

const agentBlockSchema = new Schema<IAgentBlock>(
  {
    key: { type: String, required: true, unique: true, trim: true },
    kind: { type: String, enum: BLOCK_KINDS, required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    builtIn: { type: Boolean, default: false },

    gateKind: { type: String, default: "" },
    params: { type: Schema.Types.Mixed, default: {} },

    prompt: { type: String, default: "" },
    capability: { type: String, enum: STEP_CAPABILITIES, default: "read-only" },
    model: { type: String, default: "" },
    fallbackModel: { type: String, default: "" },
    deterministic: { type: Boolean, default: false },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

agentBlockSchema.index({ kind: 1 });

export const AgentBlock: Model<IAgentBlock> =
  mongoose.models.AgentBlock || mongoose.model<IAgentBlock>("AgentBlock", agentBlockSchema);
