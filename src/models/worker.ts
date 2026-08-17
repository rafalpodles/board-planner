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
    // Reported by the worker, never set from the server: this is what that machine says it has
    // on disk. The path is here only so an operator can see which checkout was used.
    repos: {
      type: [{
        remote: { type: String, required: true, trim: true },
        path: { type: String, required: true, trim: true },
      }],
      default: [],
    },
    // What an admin approved this machine for. Written at approval and read on every claim: the
    // repos the worker reports narrow this set, they do not define it. A worker with none claims
    // nothing, which is what an enrolment predating BP-305 means.
    approvedProjects: { type: [{ type: Schema.Types.ObjectId, ref: "Project" }], default: [] },
    // The person this machine belongs to, set from the account that approved its enrolment. Distinct
    // from `identity` below: identity is which machine acted, owner is whose machine it is.
    owner: { type: Schema.Types.ObjectId, ref: "User", default: null },
    policy: {
      pollIntervalMs: { type: Number, default: 30_000 },
    },
    // Which policy fields an operator actually set. The schema materialises a default into every
    // other field at creation, so this list is the only record of intent.
    policyOverrides: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    lockedByInstance: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: null },
    // The user record this machine acts as: comment author, assignee, and the name in history.
    // Null only for a worker registered before CP-241 and not seen since.
    identity: { type: Schema.Types.ObjectId, ref: "User", default: null },
    bindingError: { type: String, default: "" },
    // Null, not an empty pass: a worker too old to report this has not told us it is fine, and a
    // console that showed it green would be the exact "healthy, fails every task" this closes.
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

workerSchema.index({ "assignments.project": 1 });
workerSchema.index({ name: 1, host: 1 }, { unique: true });

export const Worker: Model<IWorker> =
  mongoose.models.Worker || mongoose.model<IWorker>("Worker", workerSchema);
