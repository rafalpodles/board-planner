import { describe, it, expect, vi, beforeEach } from "vitest";

const consumeResetToken = vi.fn();
const invalidateResetTokens = vi.fn();
const releaseResetToken = vi.fn();
const revokeUserSessions = vi.fn();
const logInstanceAudit = vi.fn();
const userFindById = vi.fn();
const userUpdateOne = vi.fn();
const hash = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  MIN_PASSWORD_LENGTH: 8,
  PASSWORD_COST_FACTOR: 10,
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/password-reset", () => ({
  consumeResetToken,
  invalidateResetTokens,
  releaseResetToken,
}));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/session", () => ({ provenanceRefusal: () => null, revokeUserSessions }));
vi.mock("bcryptjs", () => ({ default: { hash } }));
vi.mock("@/models/user", () => ({
  User: { findById: userFindById, updateOne: userUpdateOne },
}));

const { POST } = await import("./route");
const { resetRateLimits, lockoutKey, recordFailedAttempt, isRateLimited, ANONYMOUS_ACCOUNT_ATTEMPTS } =
  await import("@/lib/rate-limit");

function post(body: unknown = { token: "cpr_good", newPassword: "a-brand-new-password" }) {
  return new Request("http://x/api/auth/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function accountIs(user: unknown) {
  userFindById.mockReturnValue({ select: () => Promise.resolve(user) });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  consumeResetToken.mockResolvedValue({ ok: true, userId: "u1" });
  accountIs({ _id: "u1", username: "rafal", kind: "human" });
  hash.mockResolvedValue("new-hash");
  userUpdateOne.mockResolvedValue({});
});

describe("POST /api/auth/reset", () => {
  it("lifts a login lockout, including one filled from an address the resetter never used", async () => {
    const fromSomebodyElse = lockoutKey("203.0.113.9", "rafal");
    const shared = lockoutKey("-", "rafal");
    for (let i = 0; i < ANONYMOUS_ACCOUNT_ATTEMPTS; i++) {
      await recordFailedAttempt(fromSomebodyElse);
      await recordFailedAttempt(shared);
    }

    const res = await POST(post());

    expect(res.status).toBe(200);
    expect(await isRateLimited(fromSomebodyElse, ANONYMOUS_ACCOUNT_ATTEMPTS)).toBe(false);
    expect(await isRateLimited(shared, ANONYMOUS_ACCOUNT_ATTEMPTS)).toBe(false);
  });

  it("leaves another account's lockout in place", async () => {
    const somebodyElse = lockoutKey("-", "different-person");
    for (let i = 0; i < ANONYMOUS_ACCOUNT_ATTEMPTS; i++) await recordFailedAttempt(somebodyElse);

    await POST(post());

    expect(await isRateLimited(somebodyElse, ANONYMOUS_ACCOUNT_ATTEMPTS)).toBe(true);
  });

  it("does not lift a lockout when the token was refused", async () => {
    consumeResetToken.mockResolvedValue({ ok: false, reason: "expired" });
    const shared = lockoutKey("-", "rafal");
    for (let i = 0; i < ANONYMOUS_ACCOUNT_ATTEMPTS; i++) await recordFailedAttempt(shared);

    const res = await POST(post());

    expect(res.status).toBe(400);
    expect(await isRateLimited(shared, ANONYMOUS_ACCOUNT_ATTEMPTS)).toBe(true);
  });

  it("sets the password, ends every session, and leaves a trace", async () => {
    const res = await POST(post());

    expect(res.status).toBe(200);
    expect(hash).toHaveBeenCalledWith("a-brand-new-password", 10);
    expect(userUpdateOne).toHaveBeenCalledWith(
      { _id: "u1" },
      { $set: { password: "new-hash" } }
    );
    expect(revokeUserSessions).toHaveBeenCalledWith("u1");
    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user_password_reset_by_email", target: "rafal" })
    );
  });

  it.each([
    ["unknown", "not valid"],
    ["expired", "expired"],
    ["used", "already been used"],
  ])("refuses a %s token and changes nothing", async (reason, wording) => {
    consumeResetToken.mockResolvedValue({ ok: false, reason });

    const res = await POST(post());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(wording);
    expect(userUpdateOne).not.toHaveBeenCalled();
    expect(revokeUserSessions).not.toHaveBeenCalled();
  });

  it("checks the password before the token is spent", async () => {
    const res = await POST(post({ token: "cpr_good", newPassword: "short" }));

    expect(res.status).toBe(400);
    expect(consumeResetToken).not.toHaveBeenCalled();
  });

  it("refuses a body that is not two strings", async () => {
    expect((await POST(post({ token: 1, newPassword: "a-brand-new-password" }))).status).toBe(400);
    expect((await POST(post({ token: "cpr_good" }))).status).toBe(400);
    expect(consumeResetToken).not.toHaveBeenCalled();
  });

  it("refuses when the account went away after the link was sent", async () => {
    accountIs(null);

    const res = await POST(post());

    expect(res.status).toBe(400);
    expect(userUpdateOne).not.toHaveBeenCalled();
  });

  it("refuses to sign in a machine account", async () => {
    accountIs({ _id: "u1", username: "worker-1", kind: "machine" });

    const res = await POST(post());

    expect(res.status).toBe(400);
    expect(userUpdateOne).not.toHaveBeenCalled();
  });
});
