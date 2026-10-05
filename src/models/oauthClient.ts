import mongoose, { Schema, Model } from "mongoose";
import { IOAuthClient } from "@/types";
import { withOrganisation } from "@/lib/organisation-field";

const oauthClientSchema = new Schema<IOAuthClient>(
  {
    clientId: { type: String, required: true, unique: true, index: true },
    clientName: { type: String, default: "" },
    redirectUris: { type: [String], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

withOrganisation(oauthClientSchema);

export const OAuthClient: Model<IOAuthClient> =
  mongoose.models.OAuthClient || mongoose.model<IOAuthClient>("OAuthClient", oauthClientSchema);
