import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const compare = vi.fn();
const userFindById = vi.fn();
const userFindByIdAndUpdate = vi.fn();
const invalidateResetTokens = vi.fn();
const logInstanceAudit = vi.fn();
const sendEmail = vi.fn();
const isEmailConfigured = vi.fn();

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
  ProvenanceError: class ProvenanceError extends Error {},
}));
vi.mock("@/lib/password-reset", () => ({ invalidateResetTokens }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return { ...actual, sendEmail, isEmailConfigured };
});
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("bcryptjs", () => ({ default: { compare } }));
vi.mock("@/models/user", () => ({
  User: { findById: userFindById, findByIdAndUpdate: userFindByIdAndUpdate },
}));

const { PUT } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

function signedIn(overrides: Record<string, unknown> = {}) {
  return {
    _id: "u1",
    username: "rafal",
    email: "old@example.com",
    role: "member",
    sessionId: "sess-1",
    ...overrides,
  };
}

function put(body: Record<string, unknown>) {
  return new Request("https://app.example.com/api/users/me", {
    method: "PUT",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({}) };

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  getAuthUser.mockResolvedValue(signedIn());
  userFindById.mockReturnValue({
    select: () => Promise.resolve({ _id: "u1", password: "stored-hash" }),
  });
  userFindByIdAndUpdate.mockResolvedValue({ _id: "u1", email: "new@example.com" });
  compare.mockResolvedValue(true);
  isEmailConfigured.mockReturnValue(true);
});

describe("PUT /api/users/me — changing the address that can reset the password", () => {
  it("refuses to move the address without the current password", async () => {
    const response = await PUT(put({ email: "new@example.com" }), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Your current password is required to change your email address",
    });
    expect(userFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a wrong current password", async () => {
    compare.mockResolvedValue(false);

    const response = await PUT(
      put({ email: "new@example.com", currentPassword: "not-it" }),
      context
    );

    expect(response.status).toBe(400);
    expect(userFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("moves the address when the password is right", async () => {
    const response = await PUT(
      put({ email: "new@example.com", currentPassword: "right" }),
      context
    );

    expect(response.status).toBe(200);
    expect(userFindByIdAndUpdate).toHaveBeenCalledWith(
      "u1",
      { $set: { email: "new@example.com" } },
      expect.anything()
    );
  });

  it("audits the change, because it signs nobody out and would otherwise leave no trace", async () => {
    await PUT(put({ email: "new@example.com", currentPassword: "right" }), context);

    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "user_email_changed",
        target: "rafal",
        detail: expect.stringContaining("old@example.com"),
      })
    );
  });

  it("tells the address that is losing the ability to recover the account", async () => {
    await PUT(put({ email: "new@example.com", currentPassword: "right" }), context);
    // The notification is deliberately not awaited by the handler
    await new Promise((resolve) => setImmediate(resolve));

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "old@example.com" })
    );
  });

  it("says nothing to anybody when the account had no address to lose", async () => {
    getAuthUser.mockResolvedValue(signedIn({ email: "" }));

    await PUT(put({ email: "new@example.com", currentPassword: "right" }), context);
    await new Promise((resolve) => setImmediate(resolve));

    expect(sendEmail).not.toHaveBeenCalled();
  });

  // The profile form submits the address alongside the notification toggle, so an unchanged value
  // arriving with every save must not put a password prompt in front of a checkbox
  it("does not demand a password when the address submitted is the one already stored", async () => {
    const response = await PUT(
      put({ email: "OLD@example.com", emailNotifications: true }),
      context
    );

    expect(response.status).toBe(200);
    expect(compare).not.toHaveBeenCalled();
    expect(userFindByIdAndUpdate).toHaveBeenCalledWith(
      "u1",
      { $set: { emailNotifications: true } },
      expect.anything()
    );
  });

  it("still refuses a machine credential outright, password or not", async () => {
    getAuthUser.mockResolvedValue(signedIn({ viaMachineCredential: true }));

    const response = await PUT(
      put({ email: "new@example.com", currentPassword: "right" }),
      context
    );

    expect(response.status).toBe(403);
    expect(compare).not.toHaveBeenCalled();
  });

  it("treats resubmitting the stored address on its own as a no-op, not a bad request", async () => {
    const response = await PUT(put({ email: "old@example.com" }), context);

    expect(response.status).toBe(200);
    expect(userFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("leaves the notification toggle alone — no password needed for a preference", async () => {
    const response = await PUT(put({ emailNotifications: false }), context);

    expect(response.status).toBe(200);
    expect(compare).not.toHaveBeenCalled();
  });
});
