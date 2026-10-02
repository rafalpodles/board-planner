import { describe, it, expect, vi, beforeEach } from "vitest";

const claimInvitation = vi.fn();
const releaseInvitation = vi.fn();
const recordAcceptance = vi.fn();
const markInvitationRevoked = vi.fn();
const authorityAtAcceptance = vi.fn();
const userCreate = vi.fn();
const grantUpsert = vi.fn();
const createSession = vi.fn();
const logInstanceAudit = vi.fn();
const logProjectAudit = vi.fn();
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
vi.mock("@/lib/session", () => ({
  provenanceRefusal: () => null,
  createSession,
  buildSessionCookie: (token: string) => `cps=${token}`,
  legacySessionCookies: () => [],
}));
vi.mock("@/lib/invitations", () => ({
  claimInvitation,
  releaseInvitation,
  recordAcceptance,
  markInvitationRevoked,
}));
vi.mock("@/lib/invitation-authority", () => ({ authorityAtAcceptance }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/models/user", () => ({ User: { create: userCreate } }));
vi.mock("@/models/grant", () => ({ Grant: { findOneAndUpdate: grantUpsert } }));
vi.mock("bcryptjs", () => ({ default: { hash } }));

const { POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

const INVITATION = {
  _id: "inv-1",
  email: "ada@example.com",
  role: "member",
  invitedBy: "admin-1",
  boards: [{ project: "p1", relation: "owner", addedBy: "admin-1" }],
};

const FIELDS = { token: "cpi_good", username: "Ada", fullName: "Ada Lovelace", password: "a-long-password" };

function post(body: unknown = FIELDS) {
  return new Request("http://x/api/invitations/accept", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  hash.mockResolvedValue("hashed");
  claimInvitation.mockResolvedValue({ ok: true, invitation: INVITATION });
  authorityAtAcceptance.mockResolvedValue({ role: "member", boards: INVITATION.boards });
  userCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ _id: "u-new", ...doc }));
  grantUpsert.mockResolvedValue({});
  releaseInvitation.mockResolvedValue(undefined);
  createSession.mockResolvedValue({ token: "cps_new", absoluteExpiresAt: new Date() });
});

describe("POST /api/invitations/accept", () => {
  it("creates the account at the invited address, grants its boards and signs it in", async () => {
    const res = await POST(post());

    expect(res.status).toBe(201);
    expect(userCreate).toHaveBeenCalledWith({
      username: "ada",
      password: "hashed",
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      role: "member",
    });
    expect(grantUpsert).toHaveBeenCalledWith(
      { subject: "u-new", objectType: "project", object: "p1" },
      { $set: { relation: "owner" }, $setOnInsert: { createdBy: "admin-1" } },
      { upsert: true }
    );
    expect(recordAcceptance).toHaveBeenCalledWith("inv-1", "u-new");
    expect(res.headers.get("set-cookie")).toContain("cps_new");
    expect(await res.json()).toEqual({ username: "ada", landing: "p1" });
  });

  // The address is the one the link was sent to; whatever the form carries is not
  it("ignores an email in the body", async () => {
    await POST(post({ ...FIELDS, email: "someone-else@example.com" }));

    expect(userCreate.mock.calls[0][0].email).toBe("ada@example.com");
  });

  it("takes the role from what the invitation may still grant, not from what it said", async () => {
    claimInvitation.mockResolvedValue({ ok: true, invitation: { ...INVITATION, role: "admin" } });
    authorityAtAcceptance.mockResolvedValue({ role: "member", boards: [] });

    await POST(post());

    expect(userCreate.mock.calls[0][0].role).toBe("member");
    expect(grantUpsert).not.toHaveBeenCalled();
  });

  it("checks the fields before spending the link", async () => {
    const res = await POST(post({ ...FIELDS, password: "short" }));

    expect(res.status).toBe(400);
    expect(claimInvitation).not.toHaveBeenCalled();
  });

  it.each([["used"], ["expired"], ["revoked"], ["unknown"]])(
    "refuses a link that is %s",
    async (reason) => {
      claimInvitation.mockResolvedValue({ ok: false, reason });

      const res = await POST(post());

      expect(res.status).toBe(400);
      expect(userCreate).not.toHaveBeenCalled();
    }
  );

  it("refuses, and withdraws, an invitation nobody still stands behind", async () => {
    authorityAtAcceptance.mockResolvedValue(null);

    const res = await POST(post());

    expect(res.status).toBe(400);
    expect(markInvitationRevoked).toHaveBeenCalledWith("inv-1");
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("gives the link back when the username is taken, so another can be tried", async () => {
    userCreate.mockRejectedValue(
      Object.assign(new Error("E11000"), { code: 11000, keyPattern: { username: 1 } })
    );

    const res = await POST(post());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Username already exists");
    expect(releaseInvitation).toHaveBeenCalledWith("inv-1");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("says so when the address got an account in the meantime", async () => {
    userCreate.mockRejectedValue(
      Object.assign(new Error("E11000"), { code: 11000, keyPattern: { email: 1 } })
    );

    const res = await POST(post());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already has an account");
  });

  it("is throttled per source", async () => {
    for (let i = 0; i < 20; i++) await POST(post({ ...FIELDS, password: "short" }));

    const res = await POST(post());

    expect(res.status).toBe(429);
  });
});
