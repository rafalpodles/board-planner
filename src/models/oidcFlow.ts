import mongoose, { Schema, Model } from "mongoose";
import { IOidcFlow } from "@/types";

const claimsSchema = new Schema({ subject: String, email: String }, { _id: false });

// One row per sign-in in progress. Everything the round trip must prove lives here, keyed by the
// hash of a cookie the browser holds, so nothing the identity provider echoes back is trusted alone.
const oidcFlowSchema = new Schema<IOidcFlow>(
  {
    binderHash: { type: String, required: true, unique: true },
    provider: { type: String, required: true },
    state: { type: String, required: true },
    nonce: { type: String, required: true },
    codeVerifier: { type: String, required: true },
    intent: { type: String, enum: ["signin", "invite"], required: true },
    invitationTokenHash: { type: String, default: null },
    claims: { type: claimsSchema, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

oidcFlowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OidcFlow: Model<IOidcFlow> =
  mongoose.models.OidcFlow || mongoose.model<IOidcFlow>("OidcFlow", oidcFlowSchema);
