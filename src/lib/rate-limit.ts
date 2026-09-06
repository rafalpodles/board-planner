import { connectDB } from "./db";
import { sha256 } from "./oauth";
import { RateLimit } from "@/models/rateLimit";

const MAX_ATTEMPTS = 10;
export const SHARED_SOURCE_ATTEMPTS = 50;
export const EXCLUSIVE_SOURCE_ATTEMPTS = MAX_ATTEMPTS;
export const ANONYMOUS_ACCOUNT_ATTEMPTS = 50;
export const ANONYMOUS_GLOBAL_ATTEMPTS = 500;
export const ANONYMOUS_GLOBAL_KEY = "login:source:-";
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export async function isRateLimited(key: string, threshold = MAX_ATTEMPTS): Promise<boolean> {
  await connectDB();
  const entry = await RateLimit.findOne({ _id: key, resetAt: { $gt: new Date() } })
    .select("count")
    .lean();
  return (entry?.count ?? 0) >= threshold;
}

export async function recordFailedAttempt(key: string): Promise<void> {
  await connectDB();
  const now = new Date();
  const fresh = new Date(now.getTime() + WINDOW_MS);

  await RateLimit.updateOne(
    { _id: key },
    [
      {
        $set: {
          count: {
            $cond: [{ $gt: ["$resetAt", now] }, { $add: [{ $ifNull: ["$count", 0] }, 1] }, 1],
          },
          resetAt: { $cond: [{ $gt: ["$resetAt", now] }, "$resetAt", fresh] },
        },
      },
    ],
    { upsert: true, updatePipeline: true }
  );
}

export async function clearAttempts(key: string): Promise<void> {
  await connectDB();
  await RateLimit.deleteOne({ _id: key });
}

export async function resetRateLimits(): Promise<void> {
  await connectDB();
  await RateLimit.deleteMany({});
}

export function lockoutKey(clientIp: string, username: string, scope = "login"): string {
  return `${accountPrefix(username, scope)}${clientIp}`;
}

function accountPrefix(username: string, scope: string): string {
  return `${scope}:${accountDigest(username)}:`;
}

export async function clearAccountAttempts(username: string, scope = "login"): Promise<void> {
  await connectDB();
  const prefix = accountPrefix(username, scope);
  const last = prefix.codePointAt(prefix.length - 1)!;
  const afterPrefix = prefix.slice(0, -1) + String.fromCodePoint(last + 1);
  await RateLimit.deleteMany({ _id: { $gte: prefix, $lt: afterPrefix } });
}

export function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

function accountDigest(username: string): string {
  return sha256(normaliseUsername(username)).slice(0, 32);
}

export function sourceKey(clientIp: string, scope = "login"): string {
  return `${scope}:source:${clientIp}`;
}

export function anonymousMultiplier(clientIp: string | null, perAddress: number): number {
  return clientIp ? perAddress : perAddress * 20;
}

export async function withLockout<T>(
  key: string,
  verify: () => Promise<T | null>,
  source?: string,
  sourceThreshold: number = SHARED_SOURCE_ATTEMPTS
): Promise<{ lockedOut: boolean; result: T | null }> {
  const accountThreshold = source ? MAX_ATTEMPTS : ANONYMOUS_ACCOUNT_ATTEMPTS;
  const effectiveSource = source ?? ANONYMOUS_GLOBAL_KEY;
  const effectiveSourceThreshold = source ? sourceThreshold : ANONYMOUS_GLOBAL_ATTEMPTS;

  if (await isRateLimited(key, accountThreshold)) return { lockedOut: true, result: null };
  if (await isRateLimited(effectiveSource, effectiveSourceThreshold)) {
    return { lockedOut: true, result: null };
  }

  const result = await verify();
  if (result) {
    await clearAttempts(key).catch(() => {});
    return { lockedOut: false, result };
  }

  await recordFailedAttempt(key);
  await recordFailedAttempt(effectiveSource);

  return { lockedOut: await isRateLimited(key, accountThreshold), result: null };
}
