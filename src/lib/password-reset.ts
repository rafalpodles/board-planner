import { Types } from "mongoose";
import { connectDB } from "./db";
import { randomToken, sha256 } from "./oauth";
import { PasswordResetToken } from "@/models/passwordResetToken";

export const RESET_TOKEN_PREFIX = "cpr_";
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export async function issueResetToken(userId: Types.ObjectId | string): Promise<string> {
  await connectDB();
  const token = randomToken(RESET_TOKEN_PREFIX);

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

  const existing = await PasswordResetToken.findOne({ tokenHash }).lean();
  if (!existing) return { ok: false, reason: "unknown" };
  return { ok: false, reason: existing.usedAt ? "used" : "expired" };
}

export async function releaseResetToken(token: string): Promise<void> {
  await connectDB();
  await PasswordResetToken.updateOne({ tokenHash: sha256(token) }, { $set: { usedAt: null } });
}

export async function invalidateResetTokens(userId: Types.ObjectId | string): Promise<void> {
  await connectDB();
  await PasswordResetToken.deleteMany({ user: userId, usedAt: null });
}
