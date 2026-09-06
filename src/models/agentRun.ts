import mongoose, { Schema, Model } from "mongoose";
import { AGENT_RUN_OUTCOMES, IAgentRun } from "@/types";

const agentRunSchema = new Schema<IAgentRun>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    task: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    taskKey: { type: String, required: true },
    worker: { type: Schema.Types.ObjectId, ref: "Worker", default: null },

    agent: { type: Schema.Types.ObjectId, ref: "Agent", default: null },
    agentName: { type: String, default: "" },

    outcome: { type: String, enum: AGENT_RUN_OUTCOMES, required: true },
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
agentRunSchema.index({ finishedAt: -1 });

export const AgentRun: Model<IAgentRun> =
  mongoose.models.AgentRun || mongoose.model<IAgentRun>("AgentRun", agentRunSchema);
