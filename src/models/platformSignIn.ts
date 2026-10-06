import mongoose, { Schema, Model, Types } from "mongoose";

export interface IPlatformSignIn {
  _id: Types.ObjectId;
  binderHash: string;
  email: string;
  codeHash: string;
  attempts: number;
  verifiedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

const platformSignInSchema = new Schema<IPlatformSignIn>(
  {
    binderHash: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, required: true, default: 0 },
    verifiedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

platformSignInSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PlatformSignIn: Model<IPlatformSignIn> =
  mongoose.models.PlatformSignIn || mongoose.model<IPlatformSignIn>("PlatformSignIn", platformSignInSchema);
