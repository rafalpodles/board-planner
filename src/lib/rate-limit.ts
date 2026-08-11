/**
 * In-memory throttle for the endpoints that verify a password.
 *
 * Two dimensions, answered differently. A caller identified by IP is refused before its credential
 * is looked at — it is the one guessing, and refusing it costs nobody else.
 *
 * The account dimension is never consulted before verification, only after a failure. Guessing is
 * still throttled, but a correct password always wins, so the counter cannot be used to shut a real
 * user out of their own account. That mattered because the account key is the one an attacker can
 * aim at somebody else, and on a deployment with no proxy every caller shares one identity, which
 * made a targeted lockout trivial.
 *
 * Delaying the response instead was considered and rejected: holding a request open is a throttle
 * an attacker can turn around, opening many at once to exhaust the server.
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
  if (source && isRateLimited(source, sourceThreshold)) {
    return { lockedOut: true, result: null };
  }

  const result = await verify();
  if (result) {
    clearAttempts(key);
    if (source) clearAttempts(source);
    return { lockedOut: false, result };
  }

  recordFailedAttempt(key);
  if (source) recordFailedAttempt(source);

  return { lockedOut: isRateLimited(key), result: null };
}
