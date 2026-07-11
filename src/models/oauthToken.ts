import mongoose, { Schema, Model } from "mongoose";
import { IOAuthToken } from "@/types";

const oauthTokenSchema = new Schema<IOAuthToken>(
  {
    accessTokenHash: { type: String, required: true, index: true },
    refreshTokenHash: { type: String, required: true, index: true },
    clientId: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    scope: { type: String, default: "mcp" },
    allowedProjects: {
      type: [{ type: Schema.Types.ObjectId, ref: "Project" }],
      default: [],
    },
    accessExpiresAt: { type: Date, required: true },
    refreshExpiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

oauthTokenSchema.index({ refreshExpiresAt: 1 }, { expireAfterSeconds: 0 });

export const OAuthToken: Model<IOAuthToken> =
  mongoose.models.OAuthToken || mongoose.model<IOAuthToken>("OAuthToken", oauthTokenSchema);
