import { Types } from "mongoose";
import { connectDB } from "./db";
import { randomToken, sha256 } from "./oauth";
import { EmailChangeToken } from "@/models/emailChangeToken";

export const EMAIL_CHANGE_TOKEN_PREFIX = "cpe_";
export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

/** A new request replaces the one before it, so only the latest address can be confirmed. */
export async function issueEmailChange(
  userId: Types.ObjectId | string,
  email: string
): Promise<string> {
  await connectDB();
  const token = randomToken(EMAIL_CHANGE_TOKEN_PREFIX);
  await EmailChangeToken.deleteMany({ user: userId, usedAt: null });
  await EmailChangeToken.create({
    user: userId,
    email,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
  });
  return token;
}

export type EmailChangeOutcome =
  | { ok: true; userId: Types.ObjectId; email: string }
  | { ok: false; reason: "unknown" | "expired" | "used" };

/** Claimed atomically, like a reset link: two clicks arriving together cannot both win. */
export async function consumeEmailChange(token: string): Promise<EmailChangeOutcome> {
  await connectDB();
  const tokenHash = sha256(token);
  const now = new Date();

  const claimed = await EmailChangeToken.findOneAndUpdate(
    { tokenHash, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: "after" }
  );
  if (claimed) return { ok: true, userId: claimed.user as Types.ObjectId, email: claimed.email };

  const existing = await EmailChangeToken.findOne({ tokenHash }).lean();
  if (!existing) return { ok: false, reason: "unknown" };
  return { ok: false, reason: existing.usedAt ? "used" : "expired" };
}

export async function releaseEmailChange(token: string): Promise<void> {
  await connectDB();
  await EmailChangeToken.updateOne({ tokenHash: sha256(token) }, { $set: { usedAt: null } });
}

export async function pendingEmailChange(
  userId: Types.ObjectId | string
): Promise<{ email: string; expiresAt: Date } | null> {
  await connectDB();
  const pending = await EmailChangeToken.findOne({
    user: userId,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();
  return pending ? { email: pending.email, expiresAt: pending.expiresAt } : null;
}

export async function cancelEmailChange(userId: Types.ObjectId | string): Promise<void> {
  await connectDB();
  await EmailChangeToken.deleteMany({ user: userId, usedAt: null });
}
