import mongoose, { Schema, Model } from "mongoose";
import { IWorker } from "@/types";

const workerSchema = new Schema<IWorker>(
  {
    name: { type: String, required: true, trim: true },
    host: { type: String, default: "" },
    platform: { type: String, default: "" },
    version: { type: String, default: "" },
    protocolVersion: { type: Number, required: true },
    credentialHash: { type: String, required: true, select: false },
    assignments: {
      type: [
        {
          project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
          proposedPath: { type: String, default: "" },
        },
      ],
      default: [],
    },
    policy: {
      baseBranch: { type: String, default: "main" },
      pollIntervalMs: { type: Number, default: 30_000 },
      taskTimeoutMs: { type: Number, default: 1_800_000 },
      maxDiffLines: { type: Number, default: 400 },
      maxDiffFiles: { type: Number, default: 10 },
      model: { type: String, default: "opus" },
      fallbackModel: { type: String, default: "sonnet" },
      reviewModel: { type: String, default: "opus" },
    },
    enabled: { type: Boolean, default: true },
    lockedByInstance: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: null },
    bindingError: { type: String, default: "" },
    command: { type: String, enum: ["", "pause", "resume", "stop"], default: "" },
    commandIssuedAt: { type: Date, default: null },
    commandAckedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

workerSchema.index({ "assignments.project": 1 });
workerSchema.index({ name: 1, host: 1 }, { unique: true });

export const Worker: Model<IWorker> =
  mongoose.models.Worker || mongoose.model<IWorker>("Worker", workerSchema);
