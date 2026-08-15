/**
 * The throttle for the endpoints that verify a password.
 *
 * Two dimensions. The account key — caller identity plus username — is refused *before* the
 * credential is read, which is what bounds the work an attacker can make the server do. The source
 * key counts failures from one address across *all* usernames, so spraying one password at fifty
 * accounts is caught even though no account counter ever climbs.
 *
 * Two rules the obvious implementation gets wrong, both found in review:
 *
 * - A success clears only the account key, never the source. Clearing the source would let anyone
 *   holding one valid login reset the budget and guess forever, fifty tries per own login.
 * - With no client identity available the account key still applies, at a higher threshold. Skipping
 *   the check there leaves login entirely unthrottled, which is the shape the documented
 *   docker-compose deployment runs in.
 *
 * The counters live in Mongo. In a module-scope Map they were per-replica, they were wiped by every
 * deploy, and they grew by one entry for every key anybody asked about — and since the key contains
 * a caller-supplied username, an anonymous caller could grow them without bound (BP-318).
 */
import { connectDB } from "./db";
import { RateLimit } from "@/models/rateLimit";

const MAX_ATTEMPTS = 10;
// A source key aggregates every account tried from one address, and addresses are shared — office
// NAT, mobile carrier. At the per-account threshold one colleague's ten typos would refuse the
// whole building, so the source dimension needs room for honest traffic before it bites.
// Two thresholds because two kinds of source identity. An IP is shared; an authenticated account
// is not, so it can be refused as tightly as the account dimension without hitting a bystander.
export const SHARED_SOURCE_ATTEMPTS = 50;
export const EXCLUSIVE_SOURCE_ATTEMPTS = MAX_ATTEMPTS;
// Without a client identity every caller shares the account key, so a refusal there can be aimed at
// somebody else. Bounding the work still matters more than the denial: the threshold is raised so
// aiming it costs five times what it did, and it lapses with the window.
export const ANONYMOUS_ACCOUNT_ATTEMPTS = 50;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * A window that has run out is not a counter — Mongo's TTL reaper runs on its own schedule (up to a
 * minute late), so every read filters on `resetAt` rather than trusting the document's existence.
 */
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

  // Bump a live window in one atomic operation. The filter carries `resetAt` so an expired
  // document is not incremented: a counter that survived its window would make one burst of
  // guesses lock the key out for as long as anybody kept trying.
  const bumped = await RateLimit.updateOne(
    { _id: key, resetAt: { $gt: now } },
    { $inc: { count: 1 } }
  );
  if (bumped.matchedCount > 0) return;

  // No live window: start one. Two callers racing here both write count 1 rather than 2, which
  // costs the throttle a single attempt and is the direction to err in.
  await RateLimit.updateOne(
    { _id: key },
    { $set: { count: 1, resetAt: new Date(now.getTime() + WINDOW_MS) } },
    { upsert: true }
  );
}

export async function clearAttempts(key: string): Promise<void> {
  await connectDB();
  await RateLimit.deleteOne({ _id: key });
}

/**
 * Drops every counter. For tests: clearing individual keys means spelling out the key shape, which
 * silently stops matching the moment that shape changes and leaks a counter into an unrelated case.
 */
export async function resetRateLimits(): Promise<void> {
  await connectDB();
  await RateLimit.deleteMany({});
}

// Scoped so that fumbling your current password in the profile form cannot lock you out of logging
// in — different doors, different counters
export function lockoutKey(clientIp: string, username: string, scope = "login"): string {
  return `${scope}:${clientIp}:${username.toLowerCase()}`;
}

/** The source dimension: one key per caller, regardless of which account it is guessing at. */
export function sourceKey(clientIp: string, scope = "login"): string {
  return `${scope}:source:${clientIp}`;
}

/**
 * `key` is the account dimension, `source` the caller. A correct credential always wins: the
 * account counter is consulted only after a *failed* verification, so it can throttle guessing
 * without ever denying the real owner their login — which is what an account-keyed refusal becomes
 * the moment an attacker can aim it, and on a proxy-less deployment every caller can.
 */
export async function withLockout<T>(
  key: string,
  verify: () => Promise<T | null>,
  source?: string,
  sourceThreshold: number = SHARED_SOURCE_ATTEMPTS
): Promise<{ lockedOut: boolean; result: T | null }> {
  const accountThreshold = source ? MAX_ATTEMPTS : ANONYMOUS_ACCOUNT_ATTEMPTS;

  if (await isRateLimited(key, accountThreshold)) return { lockedOut: true, result: null };
  if (source && (await isRateLimited(source, sourceThreshold))) {
    return { lockedOut: true, result: null };
  }

  const result = await verify();
  if (result) {
    // Only this account's counter. Clearing the source here would hand anyone with one valid
    // credential an unlimited guessing budget against every other account.
    await clearAttempts(key);
    return { lockedOut: false, result };
  }

  await recordFailedAttempt(key);
  if (source) await recordFailedAttempt(source);

  return { lockedOut: await isRateLimited(key, accountThreshold), result: null };
}
