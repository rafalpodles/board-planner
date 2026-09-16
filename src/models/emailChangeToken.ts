import mongoose, { Schema, Model } from "mongoose";
import { IEmailChangeToken } from "@/types";

// An address waiting to be confirmed. The account keeps the address it has until the link sent to
// the new one is followed, so a typo or a stranger's inbox never becomes the recovery address.
const emailChangeTokenSchema = new Schema<IEmailChangeToken>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

emailChangeTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

export const EmailChangeToken: Model<IEmailChangeToken> =
  mongoose.models.EmailChangeToken ||
  mongoose.model<IEmailChangeToken>("EmailChangeToken", emailChangeTokenSchema);

if (!mongoose.models.EmailChangeToken || EmailChangeToken.listenerCount("index") === 0) {
  EmailChangeToken.on("index", (err: Error | undefined) => {
    if (err) console.error("Failed to build an index on emailchangetokens:", err.message);
  });
}
