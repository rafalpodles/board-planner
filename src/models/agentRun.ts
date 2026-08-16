import mongoose, { Schema, Model } from "mongoose";
import { AGENT_RUN_OUTCOMES, IAgentRun } from "@/types";

// A finished run used to leave nothing behind: execution.runId lives on the task and every exit
// clears it, so the only trace was prose in a comment. This is the durable half.
//
// The agent is stored by name as well as by reference, because an agent can be renamed or deleted
// and a record of what ran must not change when it is.
const agentRunSchema = new Schema<IAgentRun>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    task: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    taskKey: { type: String, required: true },
    worker: { type: Schema.Types.ObjectId, ref: "Worker", default: null },

    agent: { type: Schema.Types.ObjectId, ref: "Agent", default: null },
    agentName: { type: String, default: "" },

    outcome: { type: String, enum: AGENT_RUN_OUTCOMES, required: true },
    /** The block that refused, when one did. Its key, so it survives a rename. */
    refusedBy: { type: String, default: "" },
    detail: { type: String, default: "" },

    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, required: true },
    costUsd: { type: Number, default: 0 },
  },
  { timestamps: true }
);

agentRunSchema.index({ project: 1, finishedAt: -1 });
agentRunSchema.index({ task: 1 });

export const AgentRun: Model<IAgentRun> =
  mongoose.models.AgentRun || mongoose.model<IAgentRun>("AgentRun", agentRunSchema);
