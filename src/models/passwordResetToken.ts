import mongoose, { Schema, Model } from "mongoose";
import { IPasswordResetToken } from "@/types";

const passwordResetTokenSchema = new Schema<IPasswordResetToken>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

export const PasswordResetToken: Model<IPasswordResetToken> =
  mongoose.models.PasswordResetToken ||
  mongoose.model<IPasswordResetToken>("PasswordResetToken", passwordResetTokenSchema);

if (!mongoose.models.PasswordResetToken || PasswordResetToken.listenerCount("index") === 0) {
  PasswordResetToken.on("index", (err: Error | undefined) => {
    if (err) console.error("Failed to build an index on passwordresettokens:", err.message);
  });
}
