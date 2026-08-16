import { Types } from "mongoose";
import { connectDB } from "./db";
import { randomToken, sha256 } from "./oauth";
import { PasswordResetToken } from "@/models/passwordResetToken";

export const RESET_TOKEN_PREFIX = "cpr_";
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Returns the raw token, which is the only time it exists in this process. Everything stored is a
 * hash, so nothing that survives this call can be spent.
 */
export async function issueResetToken(userId: Types.ObjectId | string): Promise<string> {
  await connectDB();
  const token = randomToken(RESET_TOKEN_PREFIX);

  // Any link already sent for this account stops working the moment a new one is asked for. Two
  // live links means the older one is still spendable by whoever intercepted it, and the person
  // who asked twice has no way of knowing that.
  await PasswordResetToken.deleteMany({ user: userId, usedAt: null });

  await PasswordResetToken.create({
    user: userId,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  });

  return token;
}

export type ResetTokenOutcome =
  | { ok: true; userId: Types.ObjectId }
  | { ok: false; reason: "unknown" | "expired" | "used" };

/**
 * Spends the token, or explains why it cannot be spent. The claim and the marking are one atomic
 * update: `usedAt: null` in the filter is what stops two requests arriving together from both
 * being told they won, which a read-then-write cannot do however carefully it is written.
 */
export async function consumeResetToken(token: string): Promise<ResetTokenOutcome> {
  await connectDB();
  const tokenHash = sha256(token);
  const now = new Date();

  const claimed = await PasswordResetToken.findOneAndUpdate(
    { tokenHash, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: "after" }
  );

  if (claimed) return { ok: true, userId: claimed.user as Types.ObjectId };

  // Nothing was claimed. Naming which of the three it was costs nothing — the token is 32 random
  // bytes, so an attacker learns only that they guessed one that once existed, while the person
  // who clicked an old link in their inbox learns to ask for a new one instead of hunting a typo.
  const existing = await PasswordResetToken.findOne({ tokenHash }).lean();
  if (!existing) return { ok: false, reason: "unknown" };
  return { ok: false, reason: existing.usedAt ? "used" : "expired" };
}

/**
 * Puts a claimed token back, for the one caller that spent it and then could not finish. Without
 * this a failed write costs somebody their only link as well as every session they had.
 */
export async function releaseResetToken(token: string): Promise<void> {
  await connectDB();
  await PasswordResetToken.updateOne({ tokenHash: sha256(token) }, { $set: { usedAt: null } });
}

/**
 * Every outstanding link for this account stops working. A link already spent is left where it is,
 * because it is already unspendable and its row is the only thing that can tell somebody clicking a
 * second time that they have used it, rather than that it was never real. The TTL sweeps it a day
 * after expiry, which is the same reason the index waits.
 */
export async function invalidateResetTokens(userId: Types.ObjectId | string): Promise<void> {
  await connectDB();
  await PasswordResetToken.deleteMany({ user: userId, usedAt: null });
}
