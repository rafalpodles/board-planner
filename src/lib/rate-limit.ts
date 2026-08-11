/**
 * In-memory throttle for the endpoints that verify a password.
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
 */
const attempts = new Map<string, { count: number; resetAt: number }>();

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

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of attempts) {
    if (val.resetAt <= now) attempts.delete(key);
  }
}, 60_000);

function countFor(key: string): number {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= Date.now()) return 0;
  return entry.count;
}

export function isRateLimited(key: string, threshold = MAX_ATTEMPTS): boolean {
  return countFor(key) >= threshold;
}

export function recordFailedAttempt(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}

/**
 * Drops every counter. For tests: clearing individual keys means spelling out the key shape, which
 * silently stops matching the moment that shape changes and leaks a counter into an unrelated case.
 */
export function resetRateLimits(): void {
  attempts.clear();
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

  if (isRateLimited(key, accountThreshold)) return { lockedOut: true, result: null };
  if (source && isRateLimited(source, sourceThreshold)) {
    return { lockedOut: true, result: null };
  }

  const result = await verify();
  if (result) {
    // Only this account's counter. Clearing the source here would hand anyone with one valid
    // credential an unlimited guessing budget against every other account.
    clearAttempts(key);
    return { lockedOut: false, result };
  }

  recordFailedAttempt(key);
  if (source) recordFailedAttempt(source);

  return { lockedOut: isRateLimited(key, accountThreshold), result: null };
}
