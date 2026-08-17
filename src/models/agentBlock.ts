import mongoose, { Schema, Model } from "mongoose";
import { BLOCK_KINDS, IAgentBlock, STEP_CAPABILITIES } from "@/types";

// A block is a named configuration of something the worker implements, never new executable code.
// `key` is the contract with the worker: it resolves the key against its own source, so an ObjectId
// would be meaningless there and reseeding a database would invalidate every agent ever composed.
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
    // Deliberately not a tool list: a prompt composed with the tools it may use is a capability, and
    // a field for it would let whoever writes a step run anything on the machine.
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
