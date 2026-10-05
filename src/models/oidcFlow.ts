import mongoose, { Schema, Model } from "mongoose";
import { IOidcFlow } from "@/types";
import { withOrganisation } from "@/lib/organisation-field";

const claimsSchema = new Schema(
  { issuer: String, subject: String, email: String, name: String, groups: [String] },
  { _id: false }
);
const bootstrapSchema = new Schema({ username: String, fullName: String }, { _id: false });

// One row per sign-in in progress. Everything the round trip must prove lives here, keyed by the
// hash of a cookie the browser holds, so nothing the identity provider echoes back is trusted alone.
const oidcFlowSchema = new Schema<IOidcFlow>(
  {
    binderHash: { type: String, required: true, unique: true },
    provider: { type: String, required: true },
    state: { type: String, required: true },
    // The redirect_uri sent to the provider, which the code exchange must repeat
    redirectUri: { type: String, default: null },
    nonce: { type: String, required: true },
    codeVerifier: { type: String, required: true },
    intent: { type: String, enum: ["signin", "invite", "link", "bootstrap", "signup"], required: true },
    // The account a "link" flow attaches to, so the callback can insist it is still the one signed in
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    invitationTokenHash: { type: String, default: null },
    next: { type: String, default: null },
    bootstrap: { type: bootstrapSchema, default: null },
    claims: { type: claimsSchema, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

oidcFlowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
oidcFlowSchema.index({ state: 1 });

withOrganisation(oidcFlowSchema);

export const OidcFlow: Model<IOidcFlow> =
  mongoose.models.OidcFlow || mongoose.model<IOidcFlow>("OidcFlow", oidcFlowSchema);
