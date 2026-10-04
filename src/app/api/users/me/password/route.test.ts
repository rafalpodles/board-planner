import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getAuthUser = vi.fn();
const compare = vi.fn();
const userFindOne = vi.fn();
const revokeUserCredentials = vi.fn();
const invalidateResetTokens = vi.fn();
const logInstanceAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});

vi.mock("@/lib/auth", () => ({
  getAuthUser,
  getClientIp: () => "203.0.113.9",
  PASSWORD_COST_FACTOR: 10,
  MIN_PASSWORD_LENGTH: 8,
}));
vi.mock("@/lib/session", () => ({
  revokeUserCredentials,
  ProvenanceError: class ProvenanceError extends Error {},
}));
vi.mock("@/lib/password-reset", () => ({ invalidateResetTokens }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("bcryptjs", () => ({ default: { compare, hash: vi.fn().mockResolvedValue("new-hash") } }));
vi.mock("@/models/user", () => ({ User: { findOne: userFindOne } }));

const { PUT } = await import("./route");
const { resetRateLimits, lockoutKey, recordFailedAttempt, isRateLimited, ANONYMOUS_ACCOUNT_ATTEMPTS } =
  await import("@/lib/rate-limit");

const SESSION_ID = "sess-1";

// Distinct ids: these stand for different people, and the throttle is now keyed on the account, so
// one shared _id made every case in this file share one counter.
function browserUser(username: string) {
  return { _id: `u1-${username}`, username, role: "member", sessionId: SESSION_ID };
}

function machineUser(username: string) {
  return { _id: `u1-${username}`, username, role: "member", viaMachineCredential: true };
}

function put(currentPassword = "current-pass") {
  return new Request("http://localhost/api/users/me/password", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword: "brand-new-pass" }),
  });
}

const ctx = () => ({ params: Promise.resolve({}) });

let record: { password: string; save: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  record = { password: "old-hash", save: vi.fn().mockResolvedValue(undefined) };
  userFindOne.mockReturnValue({ select: () => Promise.resolve(record) });
  getAuthUser.mockResolvedValue(browserUser("changer"));
  compare.mockResolvedValue(true);
  revokeUserCredentials.mockResolvedValue(0);
});

describe("PUT /api/users/me/password", () => {
  it("revokes the user's other sessions and spares the calling one", async () => {
    const res = await PUT(put(), ctx());

    expect(res.status).toBe(200);
    expect(record.save).toHaveBeenCalled();
    expect(revokeUserCredentials).toHaveBeenCalledWith("u1-changer", SESSION_ID);
  });

  it("records the providers the change unlinked", async () => {
    revokeUserCredentials.mockResolvedValue({ identitiesUnlinked: 1 });

    expect((await PUT(put(), ctx())).status).toBe(200);
    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "identity_unlinked", user: "u1-changer", target: "changer" })
    );
  });

  it("records no unlinking for an account that had no provider", async () => {
    revokeUserCredentials.mockResolvedValue({ identitiesUnlinked: 0 });

    await PUT(put(), ctx());

    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("revokes every session when the caller holds a machine token and has none", async () => {
    getAuthUser.mockResolvedValue(machineUser("machine-caller"));

    const res = await PUT(put(), ctx());

    expect(res.status).toBe(200);
    expect(revokeUserCredentials).toHaveBeenCalledWith("u1-machine-caller", undefined);
  });

  // Saved first, a failed revoke would leave the old tokens alive behind a password that changed
  it("keeps the old password when revoking the credentials fails", async () => {
    revokeUserCredentials.mockRejectedValue(new Error("db down"));

    await PUT(put(), ctx()).catch(() => undefined);

    expect(record.save).not.toHaveBeenCalled();
  });

  it("revokes nothing when the current password is wrong", async () => {
    getAuthUser.mockResolvedValue(browserUser("wrong-pass"));
    compare.mockResolvedValue(false);

    const res = await PUT(put(), ctx());

    expect(res.status).toBe(400);
    expect(record.save).not.toHaveBeenCalled();
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });

  it("stops comparing once the caller's own account has failed enough times", async () => {
    getAuthUser.mockResolvedValue(browserUser("locked-out"));
    compare.mockResolvedValue(false);

    // The threshold is crossed by the failure that reaches it, so that attempt already answers 429
    let refusals = 0;
    for (let i = 0; i < 10; i++) {
      if ((await PUT(put(), ctx())).status === 429) refusals++;
    }
    expect(refusals).toBeGreaterThan(0);
    expect(compare).toHaveBeenCalledTimes(10);

    // Refusal here is safe and stays a refusal: the request already proves possession of this
    // account's session, so nobody else can aim it
    compare.mockClear();
    compare.mockResolvedValue(true);
    const res = await PUT(put(), ctx());

    expect(res.status).toBe(429);
    expect(compare).not.toHaveBeenCalled();
    expect(record.save).not.toHaveBeenCalled();
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });

  // BP-353. Not the exit for somebody already locked out — a lockout means no session — but it is
  // one of the three password paths, and the sweep has to work from here too or the rule is only
  // partly true.
  it("lifts the account's login lockout, from every address it was filled from", async () => {
    const shared = lockoutKey("-", "changer");
    const fromElsewhere = lockoutKey("203.0.113.9", "changer");
    for (let i = 0; i < ANONYMOUS_ACCOUNT_ATTEMPTS; i++) {
      await recordFailedAttempt(shared);
      await recordFailedAttempt(fromElsewhere);
    }

    const response = await PUT(put(), ctx());

    expect(response.status).toBe(200);
    expect(await isRateLimited(shared, ANONYMOUS_ACCOUNT_ATTEMPTS)).toBe(false);
    expect(await isRateLimited(fromElsewhere, ANONYMOUS_ACCOUNT_ATTEMPTS)).toBe(false);
  });
});

describe("with password sign-in off (BP-830)", () => {
  beforeEach(() => {
    process.env.PASSWORD_SIGN_IN = "off";
  });
  afterEach(() => {
    delete process.env.PASSWORD_SIGN_IN;
  });
  it("changes no password", async () => {
    expect((await PUT(put(), ctx())).status).toBe(403);
    expect(revokeUserCredentials).not.toHaveBeenCalled();
  });
});
