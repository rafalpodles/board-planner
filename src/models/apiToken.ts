import mongoose, { Schema, Model } from "mongoose";
import { IApiToken } from "@/types";

const apiTokenSchema = new Schema<IApiToken>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true },
    tokenHash: { type: String, required: true },
    prefix: { type: String, required: true },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const ApiToken: Model<IApiToken> =
  mongoose.models.ApiToken || mongoose.model<IApiToken>("ApiToken", apiTokenSchema);
