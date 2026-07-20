import mongoose, { Schema, Model } from "mongoose";
import { IPmOauthState } from "@/types";

const pmOauthStateSchema = new Schema<IPmOauthState>(
  {
    state: { type: String, required: true, unique: true },
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    serverName: { type: String, required: true },
    codeVerifier: { type: String, required: true },
    initiatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Pending authorizations expire after 10 minutes
pmOauthStateSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

export const PmOauthState: Model<IPmOauthState> =
  mongoose.models.PmOauthState || mongoose.model<IPmOauthState>("PmOauthState", pmOauthStateSchema);
