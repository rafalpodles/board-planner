import mongoose, { Schema, Model } from "mongoose";
import { IOAuthClient } from "@/types";
import { withOrganisation } from "@/lib/organisation-field";

const oauthClientSchema = new Schema<IOAuthClient>(
  {
    clientId: { type: String, required: true, unique: true, index: true },
    clientName: { type: String, default: "" },
    redirectUris: { type: [String], default: [] },
    // Set at registration and cleared when a person approves the client; the TTL reaps one nobody did
    expiresAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

oauthClientSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

withOrganisation(oauthClientSchema);

export const OAuthClient: Model<IOAuthClient> =
  mongoose.models.OAuthClient || mongoose.model<IOAuthClient>("OAuthClient", oauthClientSchema);
