import mongoose, { Schema, Model } from "mongoose";

export interface IRateLimit {
  _id: string;
  count: number;
  resetAt: Date;
}

const rateLimitSchema = new Schema<IRateLimit>({
  _id: { type: String },
  count: { type: Number, required: true, default: 0 },
  resetAt: { type: Date, required: true },
});

rateLimitSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimit: Model<IRateLimit> =
  mongoose.models.RateLimit || mongoose.model<IRateLimit>("RateLimit", rateLimitSchema);
