import { describe, it, expect, vi, beforeEach } from "vitest";

const consumeEmailChange = vi.fn();
const releaseEmailChange = vi.fn();
const invalidateResetTokens = vi.fn();
const logInstanceAudit = vi.fn();
const notifyAddressChanged = vi.fn();
const userFindById = vi.fn();
const userUpdateOne = vi.fn();
const userExists = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getClientIp: () => "203.0.113.9" }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/email-change", () => ({ consumeEmailChange, releaseEmailChange }));
vi.mock("@/lib/password-reset", () => ({ invalidateResetTokens }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/security-mail", () => ({ notifyAddressChanged }));
vi.mock("@/lib/session", () => ({ provenanceRefusal: () => null }));
vi.mock("@/models/user", () => ({
  User: { findById: userFindById, updateOne: userUpdateOne, exists: userExists },
}));

const { POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

function post(body: unknown = { token: "cpe_good" }) {
  return new Request("http://x/api/auth/confirm-email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  consumeEmailChange.mockResolvedValue({ ok: true, userId: "u1", email: "new@example.com" });
  userFindById.mockReturnValue({
    select: () => Promise.resolve({ _id: "u1", username: "owner", kind: "human", email: "old@example.com" }),
  });
  userExists.mockResolvedValue(null);
  userUpdateOne.mockResolvedValue({});
  releaseEmailChange.mockResolvedValue(undefined);
});

// BP-359: the address moves only once the inbox it names has followed the link
describe("POST /api/auth/confirm-email", () => {
  it("moves the address the link was issued for", async () => {
    const response = await POST(post());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, email: "new@example.com" });
    expect(userUpdateOne).toHaveBeenCalledWith({ _id: "u1" }, { $set: { email: "new@example.com" } });
    expect(invalidateResetTokens).toHaveBeenCalledWith("u1");
  });

  it("audits the change and tells the address that no longer recovers the account", async () => {
    await POST(post());

    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "user_email_changed_self",
        target: "owner",
        detail: "old@example.com → new@example.com",
      })
    );
    expect(notifyAddressChanged).toHaveBeenCalledWith({
      previousEmail: "old@example.com",
      username: "owner",
      newEmail: "new@example.com",
    });
  });

  it("refuses a link that was used, expired or never issued, and changes nothing", async () => {
    for (const reason of ["used", "expired", "unknown"]) {
      consumeEmailChange.mockResolvedValue({ ok: false, reason });

      const response = await POST(post());

      expect(response.status, reason).toBe(400);
    }
    expect(userUpdateOne).not.toHaveBeenCalled();
    expect(notifyAddressChanged).not.toHaveBeenCalled();
  });

  it("answers 409 when another account took the address meanwhile", async () => {
    userExists.mockResolvedValue({ _id: "somebody-else" });

    const response = await POST(post());

    expect(response.status).toBe(409);
    expect(userUpdateOne).not.toHaveBeenCalled();
    expect(invalidateResetTokens).not.toHaveBeenCalled();
  });

  it("gives the link back when the write fails, so the person is not left with a dead one", async () => {
    userUpdateOne.mockRejectedValue(new Error("db down"));

    await expect(POST(post())).rejects.toThrow("db down");
    expect(releaseEmailChange).toHaveBeenCalledWith("cpe_good");
  });

  it("refuses a machine account", async () => {
    userFindById.mockReturnValue({
      select: () => Promise.resolve({ _id: "u1", username: "worker-x", kind: "machine", email: "" }),
    });

    const response = await POST(post());

    expect(response.status).toBe(400);
    expect(userUpdateOne).not.toHaveBeenCalled();
  });

  it("asks for the token", async () => {
    const response = await POST(post({}));

    expect(response.status).toBe(400);
    expect(consumeEmailChange).not.toHaveBeenCalled();
  });
});
