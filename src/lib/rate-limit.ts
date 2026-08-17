/**
 * The throttle for the endpoints that verify a password.
 *
 * Two dimensions, on opposite sides of the credential check. The source key — one address across
 * *all* usernames — is refused *before* the credential is read, which is what bounds the work an
 * attacker can make the server do, and it catches spraying one password at fifty accounts even
 * though no account counter ever climbs. The account key is consulted only after a verification
 * has already failed, so it throttles guessing without ever refusing the owner their own password.
 *
 * That ordering is the whole point and it was the other way round until BP-353. The account key
 * contains a caller-supplied username, so where there is no client identity to put beside it —
 * the documented docker-compose deployment, where the app port is published directly — every
 * caller shares one key per account. Consulting it before the credential meant fifty requests
 * could deny a named person their own correct password for a quarter of an hour, renewably, with
 * no way for an administrator to lift it.
 *
 * Two rules the obvious implementation gets wrong, both found in review:
 *
 * - A success clears only the account key, never the source. Clearing the source would let anyone
 *   holding one valid login reset the budget and guess forever, fifty tries per own login.
 * - The source key applies even with no client identity, under a shared name at a far higher
 *   threshold. Skipping it there leaves the work bound with nothing holding it at all.
 *
 * The counters live in Mongo. In a module-scope Map they were per-replica, they were wiped by every
 * deploy, and they grew by one entry for every key anybody asked about — and since the key contains
 * a caller-supplied username, an anonymous caller could grow them without bound (BP-318).
 */
import { connectDB } from "./db";
import { sha256 } from "./oauth";
import { RateLimit } from "@/models/rateLimit";

const MAX_ATTEMPTS = 10;
// A source key aggregates every account tried from one address, and addresses are shared — office
// NAT, mobile carrier. At the per-account threshold one colleague's ten typos would refuse the
// whole building, so the source dimension needs room for honest traffic before it bites.
// Two thresholds because two kinds of source identity. An IP is shared; an authenticated account
// is not, so it can be refused as tightly as the account dimension without hitting a bystander.
export const SHARED_SOURCE_ATTEMPTS = 50;
export const EXCLUSIVE_SOURCE_ATTEMPTS = MAX_ATTEMPTS;
// Without a client identity every caller shares the account key, so what it counts is "failures
// against this username from anywhere". Since BP-353 it can no longer refuse a correct password,
// so sharing it costs an attacker's guesses rather than the owner's access; the raised threshold
// remains because the shared key aggregates honest typos from every caller too.
export const ANONYMOUS_ACCOUNT_ATTEMPTS = 50;
/**
 * The ceiling on failed credential checks from callers with no identity at all, across every
 * username. Without it the account dimension bounds guessing at *one* account and nothing bounds
 * the instance: a password sprayed at a thousand usernames is a thousand requests, each landing on
 * a bucket at count 1 — and since BP-318 made the miss path pay for bcrypt to close a timing
 * oracle, each of those is ~100 ms of main-thread work an anonymous caller can spend (BP-318
 * review).
 *
 * It is deliberately far above anything honest use produces, because it is reachable: an attacker
 * who spends it denies login to everyone for the rest of the window. That is a worse afternoon
 * than a locked account and a better one than unbounded guessing — and an attacker able to send
 * 500 requests could pin the CPU anyway.
 */
export const ANONYMOUS_GLOBAL_ATTEMPTS = 500;
export const ANONYMOUS_GLOBAL_KEY = "login:source:-";
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

/**
 * One operation, because two are not enough.
 *
 * The obvious shape — try to `$inc` a live window, else upsert a fresh one — is a read-modify-write
 * whose second step has no `resetAt` guard, so every caller that missed the first step writes
 * `count: 1` over whatever landed in between. That is not a rare interleaving: `bcryptjs` chunks
 * its work through `setImmediate`, so concurrent `compare` calls finish in the same millisecond and
 * arrive here together. Measured on the pre-fix code, 1000 concurrent failed logins recorded a
 * count of **1** (BP-318 review).
 *
 * An update pipeline decides both fields from the stored document in a single atomic write. Mongo
 * 4.2+, and this project targets 4.4+. Note the explicit `$gt` on the date rather than anything
 * that leans on truthiness, and that a pipeline turns off Mongoose casting — every value here is
 * already a native Date or number.
 */
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
    // updatePipeline, because the update above is an aggregation pipeline and mongoose 9 refuses an
    // array without it. Without this every failed login threw, answered 500, and recorded nothing —
    // the counter BP-318 exists to keep. The in-memory model the unit tests use never runs this
    // call, so only a request against a real database shows it.
    { upsert: true, updatePipeline: true }
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

/**
 * Scoped so that fumbling your current password in the profile form cannot lock you out of logging
 * in — different doors, different counters.
 *
 * The username is hashed rather than interpolated, for two reasons found in review:
 *
 * - It has to be the *same* account the lookup will find. Mongoose applies `trim` and `lowercase`
 *   from the schema to query filters as well as to saved documents, so `" admin"` and `"admin"` are
 *   one account and used to be two buckets — an unbounded supply of fresh counters against a named
 *   user, reached through the one caller-chosen field the throttle still interpolated.
 * - It ends up as an `_id`, and nothing bounds the length of a posted username. A megabyte of it
 *   became a megabyte of index entry, which moved the unbounded growth from memory to disk rather
 *   than removing it.
 */
export function lockoutKey(clientIp: string, username: string, scope = "login"): string {
  return `${scope}:${clientIp}:${accountDigest(username)}`;
}

/** Exactly what Mongoose will do to the filter before it looks the user up. */
export function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

function accountDigest(username: string): string {
  return sha256(normaliseUsername(username)).slice(0, 32);
}

/** The source dimension: one key per caller, regardless of which account it is guessing at. */
export function sourceKey(clientIp: string, scope = "login"): string {
  return `${scope}:source:${clientIp}`;
}

/**
 * A per-address ceiling collapses into a per-*instance* ceiling when there is no address, and the
 * two want very different numbers. At the per-address figure, one anonymous caller sending ten
 * requests per quarter hour permanently denies OAuth client registration — and with it the
 * documented MCP onboarding — to everybody (BP-318 review).
 *
 * So a caller with no identity gets its own, much larger budget. It still bounds the work; it is
 * just not a lever an idle attacker can hold down.
 */
export function anonymousMultiplier(clientIp: string | null, perAddress: number): number {
  return clientIp ? perAddress : perAddress * 20;
}

/**
 * `key` is the account dimension, `source` the caller. A correct credential always wins: the
 * account counter is consulted only after a *failed* verification, so it can throttle guessing
 * without ever denying the real owner their login — which is what an account-keyed refusal becomes
 * the moment an attacker can aim it, and on a proxy-less deployment every caller can.
 *
 * The two counters answer different questions and therefore sit on different sides of verify().
 * The source counter bounds the *work*: it stands before the credential is read, because the miss
 * path pays for bcrypt and an unbounded stream of attempts is an unbounded stream of ~100 ms of
 * CPU. The account counter bounds the *guessing*, and guessing is only established by a failed
 * verification — so consulting it first bought a per-account slice of the same CPU bound at the
 * price of letting anyone who can name a username deny that person their own password. The source
 * counter still bounds the CPU; what an attacker gains is the ability to spend the shared budget
 * against one account instead of being cut off sooner, and what the owner gains is their login.
 */
export async function withLockout<T>(
  key: string,
  verify: () => Promise<T | null>,
  source?: string,
  sourceThreshold: number = SHARED_SOURCE_ATTEMPTS
): Promise<{ lockedOut: boolean; result: T | null }> {
  const accountThreshold = source ? MAX_ATTEMPTS : ANONYMOUS_ACCOUNT_ATTEMPTS;
  // With no identity the source dimension would otherwise not exist at all, and it is the one that
  // catches spraying across accounts — on the deployment the README documents, that is the default.
  const effectiveSource = source ?? ANONYMOUS_GLOBAL_KEY;
  const effectiveSourceThreshold = source ? sourceThreshold : ANONYMOUS_GLOBAL_ATTEMPTS;

  if (await isRateLimited(effectiveSource, effectiveSourceThreshold)) {
    return { lockedOut: true, result: null };
  }

  const result = await verify();
  if (result) {
    // Only this account's counter. Clearing the source here would hand anyone with one valid
    // credential an unlimited guessing budget against every other account.
    //
    // Swallowed: this is a database write on the success path, and a counter that fails to clear is
    // harmless where a correct login turned into a 500 is not.
    await clearAttempts(key).catch(() => {});
    return { lockedOut: false, result };
  }

  await recordFailedAttempt(key);
  await recordFailedAttempt(effectiveSource);

  return { lockedOut: await isRateLimited(key, accountThreshold), result: null };
}
