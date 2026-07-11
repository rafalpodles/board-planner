import mongoose, { Schema, Model } from "mongoose";
import { IOAuthClient } from "@/types";

const oauthClientSchema = new Schema<IOAuthClient>(
  {
    clientId: { type: String, required: true, unique: true, index: true },
    clientName: { type: String, default: "" },
    redirectUris: { type: [String], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const OAuthClient: Model<IOAuthClient> =
  mongoose.models.OAuthClient || mongoose.model<IOAuthClient>("OAuthClient", oauthClientSchema);
