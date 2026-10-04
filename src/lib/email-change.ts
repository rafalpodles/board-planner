import { Types } from "mongoose";
import { connectDB } from "./db";
import { randomToken, sha256 } from "./oauth";
import type { ScopedDb } from "@/lib/db-scope";

export const EMAIL_CHANGE_TOKEN_PREFIX = "cpe_";
export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

/** A new request replaces the one before it, so only the latest address can be confirmed. */
export async function issueEmailChange(
  db: ScopedDb,
  userId: Types.ObjectId | string,
  email: string
): Promise<string> {
  await connectDB();
  const token = randomToken(EMAIL_CHANGE_TOKEN_PREFIX);
  await db.EmailChangeToken.deleteMany({ user: userId, usedAt: null });
  await db.EmailChangeToken.create({
    user: userId,
    email,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
  });
  return token;
}

export type EmailChangeOutcome =
  | { ok: true; userId: Types.ObjectId; email: string; claimedAt: Date }
  | { ok: false; reason: "unknown" | "expired" | "used" };

/** Claimed atomically, like a reset link: two clicks arriving together cannot both win. */
export async function consumeEmailChange(db: ScopedDb, token: string): Promise<EmailChangeOutcome> {
  await connectDB();
  const tokenHash = sha256(token);
  const now = new Date();

  const claimed = await db.EmailChangeToken.findOneAndUpdate(
    { tokenHash, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: "after" }
  );
  if (claimed) return { ok: true, userId: claimed.user as Types.ObjectId, email: claimed.email, claimedAt: now };

  const existing = await db.EmailChangeToken.findOne({ tokenHash }).lean();
  if (!existing) return { ok: false, reason: "unknown" };
  return { ok: false, reason: existing.usedAt ? "used" : "expired" };
}

/** Gives back only this request's own claim: a link cancelled or replaced meanwhile stays gone */
export async function releaseEmailChange(db: ScopedDb, token: string, claimedAt: Date): Promise<void> {
  await connectDB();
  await db.EmailChangeToken.updateOne({ tokenHash: sha256(token), usedAt: claimedAt }, { $set: { usedAt: null } });
}

export async function pendingEmailChange(
  db: ScopedDb,
  userId: Types.ObjectId | string
): Promise<{ email: string; expiresAt: Date } | null> {
  await connectDB();
  const pending = await db.EmailChangeToken.findOne({
    user: userId,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();
  return pending ? { email: pending.email, expiresAt: pending.expiresAt } : null;
}

export async function cancelEmailChange(db: ScopedDb, userId: Types.ObjectId | string): Promise<void> {
  await connectDB();
  await db.EmailChangeToken.deleteMany({ user: userId, usedAt: null });
}
