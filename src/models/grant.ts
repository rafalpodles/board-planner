import mongoose, { Schema, Model } from "mongoose";
import { IGrant, GRANT_RELATIONS } from "@/types";

const grantSchema = new Schema<IGrant>(
  {
    subject: { type: Schema.Types.ObjectId, ref: "User", required: true },
    relation: { type: String, enum: GRANT_RELATIONS, required: true },
    objectType: { type: String, enum: ["project"], required: true, default: "project" },
    object: { type: Schema.Types.ObjectId, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

grantSchema.index({ subject: 1, objectType: 1, object: 1 }, { unique: true });
grantSchema.index({ objectType: 1, object: 1 });

export const Grant: Model<IGrant> =
  mongoose.models.Grant || mongoose.model<IGrant>("Grant", grantSchema);
