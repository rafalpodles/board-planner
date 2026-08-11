/**
 * Simple in-memory rate limiter for auth endpoints.
 * Tracks failed attempts per IP and blocks after threshold.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of attempts) {
    if (val.resetAt <= now) attempts.delete(key);
  }
}, 60_000);

export function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);

  if (!entry || entry.resetAt <= now) return false;
  return entry.count >= MAX_ATTEMPTS;
}

export function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = attempts.get(ip);

  if (!entry || entry.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

export function clearAttempts(ip: string): void {
  attempts.delete(ip);
}

export function lockoutKey(clientIp: string, username: string): string {
  return `${clientIp}:${username.toLowerCase()}`;
}

export async function withLockout<T>(
  key: string,
  verify: () => Promise<T | null>
): Promise<{ lockedOut: boolean; result: T | null }> {
  if (isRateLimited(key)) return { lockedOut: true, result: null };

  const result = await verify();
  if (result) {
    clearAttempts(key);
  } else {
    recordFailedAttempt(key);
  }
  return { lockedOut: false, result };
}
