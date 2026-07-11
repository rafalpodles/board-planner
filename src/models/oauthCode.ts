import mongoose, { Schema, Model } from "mongoose";
import { IOAuthCode } from "@/types";

const oauthCodeSchema = new Schema<IOAuthCode>(
  {
    codeHash: { type: String, required: true, unique: true, index: true },
    clientId: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    redirectUri: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    scope: { type: String, default: "mcp" },
    allowedProjects: {
      type: [{ type: Schema.Types.ObjectId, ref: "Project" }],
      default: [],
    },
    used: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

oauthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OAuthCode: Model<IOAuthCode> =
  mongoose.models.OAuthCode || mongoose.model<IOAuthCode>("OAuthCode", oauthCodeSchema);
