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
const { resetRateLimits } = await import("@/lib/rate-limit");

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
  it("sets the password, ends every session, and leaves a trace", async () => {
    const res = await POST(post());

    expect(res.status).toBe(200);
    expect(hash).toHaveBeenCalledWith("a-brand-new-password", 10);
    expect(userUpdateOne).toHaveBeenCalledWith(
      { _id: "u1" },
      { $set: { password: "new-hash" } }
    );
    // Whoever knew the old password is signed out — usually the reason somebody is resetting
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

  // Spending the link on a password the server was always going to refuse would send somebody
  // back to their inbox for a second one
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

  // A worker identity has a random hash precisely so nobody can sign in as it
  it("refuses to sign in a machine account", async () => {
    accountIs({ _id: "u1", username: "worker-1", kind: "machine" });

    const res = await POST(post());

    expect(res.status).toBe(400);
    expect(userUpdateOne).not.toHaveBeenCalled();
  });
});
