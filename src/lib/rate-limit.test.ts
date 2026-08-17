import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inMemoryRateLimitModel } from "./rate-limit-test-store";

const store = inMemoryRateLimitModel();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", () => ({ RateLimit: store }));

const {
  isRateLimited,
  recordFailedAttempt,
  clearAttempts,
  clearAccountAttempts,
  resetRateLimits,
  withLockout,
  lockoutKey,
  sourceKey,
  SHARED_SOURCE_ATTEMPTS,
  ANONYMOUS_ACCOUNT_ATTEMPTS,
  ANONYMOUS_GLOBAL_ATTEMPTS,
  ANONYMOUS_GLOBAL_KEY,
} = await import("./rate-limit");

beforeEach(async () => {
  await resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the counter itself", () => {
  it("counts up to the threshold and then refuses", async () => {
    for (let i = 0; i < 10; i++) await recordFailedAttempt("k");

    expect(await isRateLimited("k", 10)).toBe(true);
    expect(await isRateLimited("k", 11)).toBe(false);
  });

  it("clears one key without touching another", async () => {
    await recordFailedAttempt("a");
    await recordFailedAttempt("b");
    await clearAttempts("a");

    expect(await isRateLimited("a", 1)).toBe(false);
    expect(await isRateLimited("b", 1)).toBe(true);
  });

  // The document outlives the window: Mongo's TTL reaper runs on its own schedule, up to a minute
  // late, so every read has to filter on resetAt rather than trust that the row is gone
  it("stops counting a window that has run out, before the reaper gets to it", async () => {
    vi.useFakeTimers();
    await recordFailedAttempt("k");
    expect(await isRateLimited("k", 1)).toBe(true);

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);

    expect(store.rows.has("k")).toBe(true);
    expect(await isRateLimited("k", 1)).toBe(false);
  });

  it("starts a fresh window rather than reviving the expired count", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 9; i++) await recordFailedAttempt("k");

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    await recordFailedAttempt("k");

    expect(await isRateLimited("k", 2)).toBe(false);
  });

  // A module-scope Map lost every counter on each deploy, and Railway redeploys from main
  it("survives the process that wrote it", async () => {
    for (let i = 0; i < 10; i++) await recordFailedAttempt("k");

    vi.resetModules();
    const fresh = await import("./rate-limit");

    expect(await fresh.isRateLimited("k", 10)).toBe(true);
  });
});

// BP-318: the account key interpolated the username, and Mongoose applies the schema's `trim` and
// `lowercase` to query filters — so " admin" and "admin" were one account and two buckets.
describe("the account key names the account the lookup will find", () => {
  it.each([" admin", "admin ", "\tadmin", "admin\n", "  admin  ", "ADMIN", "Admin"])(
    "gives %o the same bucket as admin",
    (typed) => {
      expect(lockoutKey("-", typed)).toBe(lockoutKey("-", "admin"));
    }
  );

  it("still separates two genuinely different accounts", () => {
    expect(lockoutKey("-", "admin")).not.toBe(lockoutKey("-", "administrator"));
  });

  // The key becomes an _id, and nothing bounds the length of a posted username
  it("is a bounded length whatever the caller sends", () => {
    const huge = lockoutKey("-", "a".repeat(1_000_000));

    expect(huge.length).toBeLessThan(80);
  });

  it("spends one budget however the caller spells the account", async () => {
    for (const spelling of ["admin", " admin", "ADMIN", "admin\t", "  Admin "]) {
      for (let i = 0; i < 10; i++) await recordFailedAttempt(lockoutKey("-", spelling));
    }

    expect(await isRateLimited(lockoutKey("-", "admin"), ANONYMOUS_ACCOUNT_ATTEMPTS)).toBe(true);
  });
});

describe("a caller with no identity still meets a ceiling across accounts", () => {
  it("counts failures from the anonymous path against one shared budget", async () => {
    for (let i = 0; i < ANONYMOUS_GLOBAL_ATTEMPTS; i++) {
      await withLockout(lockoutKey("-", `user${i}`), async () => null);
    }
    const verify = vi.fn();

    const { lockedOut } = await withLockout(lockoutKey("-", "someone-new"), verify);

    expect(lockedOut).toBe(true);
    // Refused before the credential check, so it bounds the bcrypt as well as the guessing
    expect(verify).not.toHaveBeenCalled();
  });

  it("leaves that budget alone when the caller has a real address", async () => {
    for (let i = 0; i < 60; i++) {
      await withLockout(lockoutKey("203.0.113.1", `user${i}`), async () => null, sourceKey("203.0.113.1"));
    }

    expect(await isRateLimited(ANONYMOUS_GLOBAL_KEY, ANONYMOUS_GLOBAL_ATTEMPTS)).toBe(false);
  });
});

// bcryptjs chunks through setImmediate, so concurrent compares finish in the same millisecond and
// arrive here together — the read-modify-write this replaced recorded 1 for 1000 of them
describe("counting under concurrency", () => {
  it("records every one of a simultaneous burst", async () => {
    await Promise.all(Array.from({ length: 50 }, () => recordFailedAttempt("burst")));

    expect(await isRateLimited("burst", 50)).toBe(true);
  });

  it("does not let the burst reset an established count", async () => {
    for (let i = 0; i < 5; i++) await recordFailedAttempt("k");

    await Promise.all(Array.from({ length: 20 }, () => recordFailedAttempt("k")));

    expect(await isRateLimited("k", 25)).toBe(true);
  });
});

describe("withLockout", () => {
  const key = lockoutKey("203.0.113.1", "admin");
  const source = sourceKey("203.0.113.1");

  it("returns the result and clears the account key on success", async () => {
    await recordFailedAttempt(key);

    const { lockedOut, result } = await withLockout(key, async () => "user", source);

    expect(lockedOut).toBe(false);
    expect(result).toBe("user");
    expect(await isRateLimited(key, 1)).toBe(false);
  });

  // Clearing the source on success would let anyone holding one valid login reset the budget and
  // guess forever, fifty tries per own login
  it("never clears the source budget, even on a correct credential", async () => {
    await recordFailedAttempt(source);

    await withLockout(key, async () => "user", source);

    expect(await isRateLimited(source, 1)).toBe(true);
  });

  it("refuses without calling verify once the account key is spent", async () => {
    for (let i = 0; i < 10; i++) await recordFailedAttempt(key);
    const verify = vi.fn();

    const { lockedOut } = await withLockout(key, verify, source);

    expect(lockedOut).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it("refuses on the source dimension even when no account counter has climbed", async () => {
    for (let i = 0; i < SHARED_SOURCE_ATTEMPTS; i++) await recordFailedAttempt(source);
    const verify = vi.fn();

    const { lockedOut } = await withLockout(lockoutKey("203.0.113.1", "someone-else"), verify, source);

    expect(lockedOut).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it("uses the raised threshold when there is no caller identity to key on", async () => {
    const anon = lockoutKey("-", "admin");
    for (let i = 0; i < 10; i++) await recordFailedAttempt(anon);

    const { lockedOut } = await withLockout(anon, async () => null);

    expect(lockedOut).toBe(false);
  });
});

describe("clearing an account's counters", () => {
  // The caller who filled the counter is not the one changing the password, and where there is no
  // client address the key they filled is the shared one. So a password change cannot delete "its"
  // key — it has to clear the account across every address (BP-353).
  it("forgets failures recorded from every address, not just one", async () => {
    const fromAttacker = lockoutKey("203.0.113.9", "rafal");
    const fromAnonymous = lockoutKey("-", "rafal");
    const fromElsewhere = lockoutKey("198.51.100.4", "rafal");
    for (const k of [fromAttacker, fromAnonymous, fromElsewhere]) {
      for (let i = 0; i < 10; i++) await recordFailedAttempt(k);
    }

    await clearAccountAttempts("rafal");

    expect(await isRateLimited(fromAttacker, 10)).toBe(false);
    expect(await isRateLimited(fromAnonymous, 10)).toBe(false);
    expect(await isRateLimited(fromElsewhere, 10)).toBe(false);
  });

  it("leaves another account's counters alone", async () => {
    const mine = lockoutKey("-", "rafal");
    const theirs = lockoutKey("-", "somebody-else");
    for (let i = 0; i < 10; i++) await recordFailedAttempt(theirs);
    for (let i = 0; i < 10; i++) await recordFailedAttempt(mine);

    await clearAccountAttempts("rafal");

    expect(await isRateLimited(theirs, 10)).toBe(true);
  });

  it("normalises the username the same way the key does", async () => {
    const key = lockoutKey("-", "rafal");
    for (let i = 0; i < 10; i++) await recordFailedAttempt(key);

    await clearAccountAttempts("  RAFAL  ");

    expect(await isRateLimited(key, 10)).toBe(false);
  });

  it("does not touch the source dimension, which no password change should reopen", async () => {
    const shared = sourceKey("203.0.113.9");
    for (let i = 0; i < SHARED_SOURCE_ATTEMPTS; i++) await recordFailedAttempt(shared);

    await clearAccountAttempts("rafal");

    expect(await isRateLimited(shared, SHARED_SOURCE_ATTEMPTS)).toBe(true);
  });

  it("stays within its own scope, so clearing a login lockout leaves the profile form's counter", async () => {
    const login = lockoutKey("-", "rafal");
    const profile = lockoutKey("-", "rafal", "password-change");
    for (let i = 0; i < 10; i++) await recordFailedAttempt(login);
    for (let i = 0; i < 10; i++) await recordFailedAttempt(profile);

    await clearAccountAttempts("rafal");

    expect(await isRateLimited(login, 10)).toBe(false);
    expect(await isRateLimited(profile, 10)).toBe(true);
  });
});
