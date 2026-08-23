import mongoose, { Schema, Model } from "mongoose";
import { IOAuthConsent } from "@/types";

const oauthConsentSchema = new Schema<IOAuthConsent>(
  {
    ticketHash: { type: String, required: true, unique: true, index: true },
    clientId: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // The browser session this was issued to, so a later visitor to the same browser cannot
    // redeem it. Null for a ticket earned by typing a password, which no session backs (BP-383).
    session: { type: Schema.Types.ObjectId, ref: "Session", default: null },
    redirectUri: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    state: { type: String, default: "" },
    scope: { type: String, default: "mcp" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

oauthConsentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OAuthConsent: Model<IOAuthConsent> =
  mongoose.models.OAuthConsent || mongoose.model<IOAuthConsent>("OAuthConsent", oauthConsentSchema);
