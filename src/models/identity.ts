import mongoose, { Schema, Model } from "mongoose";
import { IIdentity } from "@/types";
import { withTenant } from "@/lib/tenant-field";

const identitySchema = new Schema<IIdentity>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    provider: { type: String, required: true },
    // The ID token's validated `iss`: a subject is only unique within the issuer that minted it,
    // and pointing a provider at a different issuer must not resolve the old one's subjects
    issuer: { type: String, required: true },
    subject: { type: String, required: true },
    email: { type: String, default: "" },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: "linkedAt", updatedAt: false } }
);

identitySchema.index({ issuer: 1, subject: 1, tenant: 1 }, { unique: true });

withTenant(identitySchema);

export const Identity: Model<IIdentity> =
  mongoose.models.Identity || mongoose.model<IIdentity>("Identity", identitySchema);
