import mongoose, { Schema, Model } from "mongoose";
import { ISession } from "@/types";
import { withOrganisation } from "@/lib/organisation-field";

const sessionSchema = new Schema<ISession>(
  {
    tokenHash: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    expiresAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, required: true },
    userAgent: { type: String, default: "" },
    ip: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

withOrganisation(sessionSchema);

export const Session: Model<ISession> =
  mongoose.models.Session || mongoose.model<ISession>("Session", sessionSchema);
