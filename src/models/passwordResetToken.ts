import mongoose, { Schema, Model } from "mongoose";
import { IPasswordResetToken } from "@/types";

// Only the hash is stored, like sessions and API tokens: a database dump, a backup or a stray log
// must not contain anything that can be spent. The raw token exists once, in one email.
const passwordResetTokenSchema = new Schema<IPasswordResetToken>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    // Set once, by an atomic update that also matches on it being null — that match is what makes
    // the link single-use, rather than a read followed by a write two requests can interleave
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Swept a day after expiry rather than at it, so an expired link can still be told apart from one
// that never existed. Both answers look the same to the person asking; the difference is that the
// server can say "ask for a new one" instead of implying the link was forged.
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

export const PasswordResetToken: Model<IPasswordResetToken> =
  mongoose.models.PasswordResetToken ||
  mongoose.model<IPasswordResetToken>("PasswordResetToken", passwordResetTokenSchema);

// Same guard as the user model: mongoose builds indexes in the background and keeps a failure to
// itself, which is how a TTL that never took hold would go unnoticed until links outlived their day
if (!mongoose.models.PasswordResetToken || PasswordResetToken.listenerCount("index") === 0) {
  PasswordResetToken.on("index", (err: Error | undefined) => {
    if (err) console.error("Failed to build an index on passwordresettokens:", err.message);
  });
}
