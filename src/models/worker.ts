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
    repos: {
      type: [{
        remote: { type: String, required: true, trim: true },
        path: { type: String, required: true, trim: true },
      }],
      default: [],
    },
    owner: { type: Schema.Types.ObjectId, ref: "User", default: null },
    policy: {
      pollIntervalMs: { type: Number, default: 30_000 },
    },
    policyOverrides: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    lockedByInstance: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: null },
    desiredProjects: { type: [{ type: Schema.Types.ObjectId, ref: "Project" }], default: undefined },
    identity: { type: Schema.Types.ObjectId, ref: "User", default: null },
    bindingError: { type: String, default: "" },
    preflight: {
      type: new Schema(
        {
          ok: { type: Boolean, required: true },
          account: { type: String, default: "" },
          checks: {
            type: [
              new Schema(
                {
                  name: { type: String, required: true, trim: true },
                  ok: { type: Boolean, required: true },
                  detail: { type: String, default: "", trim: true },
                },
                { _id: false }
              ),
            ],
            default: [],
          },
          reportedAt: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    command: { type: String, enum: ["", "pause", "resume", "stop"], default: "" },
    commandIssuedAt: { type: Date, default: null },
    commandAckedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

workerSchema.index({ name: 1, host: 1 }, { unique: true });

export const Worker: Model<IWorker> =
  mongoose.models.Worker || mongoose.model<IWorker>("Worker", workerSchema);
