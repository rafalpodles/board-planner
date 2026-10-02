import { describe, it, expect, vi, beforeEach } from "vitest";

const authorityAtAcceptance = vi.fn();
const recordAcceptance = vi.fn();
const releaseInvitation = vi.fn();
const revokeClaimedInvitation = vi.fn();
const revokePendingInvitationsFor = vi.fn();
const userCreate = vi.fn();
const userDeleteOne = vi.fn();
const identityCreate = vi.fn();
const identityDeleteMany = vi.fn();
const createSession = vi.fn();

vi.mock("@/lib/session", () => ({
  createSession,
  buildSessionCookie: () => "session=x",
  legacySessionCookies: () => [],
}));
vi.mock("@/lib/invitations", () => ({
  recordAcceptance,
  releaseInvitation,
  revokeClaimedInvitation,
  revokePendingInvitationsFor,
}));
vi.mock("@/lib/invitation-authority", () => ({ authorityAtAcceptance }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit: vi.fn() }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit: vi.fn() }));
vi.mock("@/models/grant", () => ({ Grant: { findOneAndUpdate: vi.fn() } }));
vi.mock("@/models/identity", () => ({ Identity: { create: identityCreate, deleteMany: identityDeleteMany } }));
vi.mock("@/models/user", () => ({ User: { create: userCreate, deleteOne: userDeleteOne } }));

const { completeAcceptance } = await import("./invitation-acceptance");

const INVITATION = { _id: "inv-1", email: "ada@example.com", role: "member", boards: [], deliveredAs: "link" };
const IDENTITY = { provider: "oidc", issuer: "https://id.example.com", subject: "s9", email: "ada@example.com" };
const accept = (identity?: typeof IDENTITY, providerProvesAddress = true, deliveredAs = "link") =>
  completeAcceptance(
    { ...INVITATION, deliveredAs } as never,
    { username: "ada", fullName: "Ada", passwordHash: identity ? null : "hash", identity, providerProvesAddress },
    new Request("http://x"),
    null
  );

beforeEach(() => {
  vi.clearAllMocks();
  authorityAtAcceptance.mockResolvedValue({ role: "member", boards: [] });
  userCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ _id: "u-new", ...doc }));
  recordAcceptance.mockResolvedValue(true);
  identityCreate.mockResolvedValue({});
  identityDeleteMany.mockResolvedValue({});
  userDeleteOne.mockResolvedValue({});
  releaseInvitation.mockResolvedValue(undefined);
  createSession.mockResolvedValue({ token: "cps_new", absoluteExpiresAt: new Date() });
});

describe("completing an acceptance through a sign-in provider", () => {
  it("makes a password-less account whose address the provider proved, and links the identity", async () => {
    const res = await accept(IDENTITY);

    expect(res.status).toBe(201);
    const doc = userCreate.mock.calls[0][0];
    expect(doc.password).toBeUndefined();
    expect(doc.emailVerifiedAt).toBeInstanceOf(Date);
    expect(identityCreate).toHaveBeenCalledWith(expect.objectContaining({ user: "u-new", ...IDENTITY }));
  });

  // GitHub's `verified` is no proof of the mailbox today, so it must not make one either: a later
  // Google or OIDC sign-in would link by that address
  it("leaves an address unproven when the link was handed over and only GitHub vouched", async () => {
    await accept({ ...IDENTITY, provider: "github" }, false);

    expect(userCreate.mock.calls[0][0].emailVerifiedAt).toBeNull();
  });

  it("proves a mailed invitation's address whichever provider accepted it", async () => {
    await accept({ ...IDENTITY, provider: "github" }, false, "email");

    expect(userCreate.mock.calls[0][0].emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("leaves an address unproven when the link was handed over and no provider vouched", async () => {
    await accept();

    expect(userCreate.mock.calls[0][0].emailVerifiedAt).toBeNull();
  });

  // Linked first, recorded second: a conflict can still give the invitation back
  it("links before recording the acceptance, and undoes both on a conflict", async () => {
    identityCreate.mockRejectedValue(Object.assign(new Error("E11000"), { code: 11000, keyPattern: { issuer: 1 } }));

    const res = await accept(IDENTITY);

    expect(res.status).toBe(409);
    expect(recordAcceptance).not.toHaveBeenCalled();
    expect(userDeleteOne).toHaveBeenCalledWith({ _id: "u-new" });
    expect(releaseInvitation).toHaveBeenCalledWith("inv-1");
  });

  it("takes the identity with the account when the invitation was revoked meanwhile", async () => {
    recordAcceptance.mockResolvedValue(false);

    const res = await accept(IDENTITY);

    expect(res.status).toBe(400);
    expect(identityDeleteMany).toHaveBeenCalledWith({ user: "u-new" });
    expect(userDeleteOne).toHaveBeenCalledWith({ _id: "u-new" });
  });
});
