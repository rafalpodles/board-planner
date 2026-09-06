import mongoose, { Schema, Model } from "mongoose";
import { IEnrolmentToken } from "@/types";

const enrolmentTokenSchema = new Schema<IEnrolmentToken>(
  {
    prefix: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    label: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    usedByWorker: { type: Schema.Types.ObjectId, ref: "Worker", default: null },
  },
  { timestamps: true }
);

export const EnrolmentToken: Model<IEnrolmentToken> =
  mongoose.models.EnrolmentToken ||
  mongoose.model<IEnrolmentToken>("EnrolmentToken", enrolmentTokenSchema);
