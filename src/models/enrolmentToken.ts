import mongoose, { Schema, Model } from "mongoose";
import { IEnrolmentToken } from "@/types";

// A credential that can do exactly one thing: register one worker, once. It exists so the laptop
// never has to hold an instance-admin token — the agent runs at the same uid with Read, so anything
// on that disk is readable by it, and an admin token there would let it lift its own kill switch.
const enrolmentTokenSchema = new Schema<IEnrolmentToken>(
  {
    prefix: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    label: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
    // Set by the single atomic update that spends the token; a second attempt finds it non-null
    usedAt: { type: Date, default: null },
    usedByWorker: { type: Schema.Types.ObjectId, ref: "Worker", default: null },
  },
  { timestamps: true }
);

export const EnrolmentToken: Model<IEnrolmentToken> =
  mongoose.models.EnrolmentToken ||
  mongoose.model<IEnrolmentToken>("EnrolmentToken", enrolmentTokenSchema);
