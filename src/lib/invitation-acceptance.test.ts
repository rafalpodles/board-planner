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
const applyAdminGroup = vi.fn();
vi.mock("@/lib/oidc/admin-group", () => ({ applyAdminGroup }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit: vi.fn() }));
vi.mock("@/models/grant", () => ({ Grant: { findOneAndUpdate: vi.fn() } }));
vi.mock("@/models/identity", () => ({ Identity: { create: identityCreate, deleteMany: identityDeleteMany } }));
vi.mock("@/models/user", () => ({ User: { create: userCreate, deleteOne: userDeleteOne } }));

const { completeAcceptance } = await import("./invitation-acceptance");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { DEFAULT_ORGANISATION_ID } = await import("@/lib/organisation-field");

const INVITATION = { _id: "inv-1", email: "ada@example.com", role: "member", boards: [], deliveredAs: "link" };
const IDENTITY = { provider: "oidc", issuer: "https://id.example.com", subject: "s9", email: "ada@example.com" };
const accept = (identity?: typeof IDENTITY, providerProvesAddress = true, deliveredAs = "link") =>
  completeAcceptance(
    scopedToDefaultOrganisation(),
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

// BP-843. A claim tied to nothing yet must not be left holding the link
describe("an acceptance that fails part way", () => {
  it("gives the link back when the authority cannot be read", async () => {
    authorityAtAcceptance.mockRejectedValue(new Error("db blip"));

    await expect(accept(IDENTITY)).rejects.toThrow("db blip");
    expect(releaseInvitation).toHaveBeenCalledWith(scopedToDefaultOrganisation(), "inv-1");
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("records the acceptance a second time when the first write fails", async () => {
    recordAcceptance.mockRejectedValueOnce(new Error("db blip")).mockResolvedValueOnce(true);

    expect((await accept(IDENTITY)).status).toBe(201);
    expect(recordAcceptance).toHaveBeenCalledTimes(2);
  });

  it("undoes the account when the second recording finds the claim gone", async () => {
    recordAcceptance.mockRejectedValueOnce(new Error("db blip")).mockResolvedValueOnce(false);

    expect((await accept(IDENTITY)).status).toBe(400);
    expect(userDeleteOne).toHaveBeenCalledWith({ _id: "u-new", organisation: DEFAULT_ORGANISATION_ID });
  });
});

describe("completing an acceptance through a sign-in provider", () => {
  it("lets the provider's groups decide the role before the session is made (BP-833)", async () => {
    applyAdminGroup.mockImplementationOnce(async () => expect(createSession).not.toHaveBeenCalled());

    await completeAcceptance(
      scopedToDefaultOrganisation(),
      INVITATION as never,
      { username: "ada", fullName: "Ada", passwordHash: null, identity: IDENTITY, providerProvesAddress: true, groups: ["admins"] },
      new Request("http://x"),
      null
    );

    expect(applyAdminGroup).toHaveBeenCalledWith(scopedToDefaultOrganisation(), expect.objectContaining({ _id: "u-new" }), "oidc", ["admins"]);
    expect(createSession).toHaveBeenCalled();
  });

  it("asks no group anything for a password acceptance", async () => {
    await accept();

    expect(applyAdminGroup).not.toHaveBeenCalled();
  });

  it("makes a password-less account whose address the provider proved, and links the identity", async () => {
    const res = await accept(IDENTITY);

    expect(res.status).toBe(201);
    const doc = userCreate.mock.calls[0][0];
    expect(doc.password).toBeUndefined();
    expect(doc.emailVerifiedAt).toBeInstanceOf(Date);
    expect(identityCreate).toHaveBeenCalledWith(expect.objectContaining({ user: "u-new", ...IDENTITY, organisation: DEFAULT_ORGANISATION_ID }));
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
    expect(userDeleteOne).toHaveBeenCalledWith({ _id: "u-new", organisation: DEFAULT_ORGANISATION_ID });
    expect(releaseInvitation).toHaveBeenCalledWith(scopedToDefaultOrganisation(), "inv-1");
  });

  it("takes the identity with the account when the invitation was revoked meanwhile", async () => {
    recordAcceptance.mockResolvedValue(false);

    const res = await accept(IDENTITY);

    expect(res.status).toBe(400);
    expect(identityDeleteMany).toHaveBeenCalledWith({ user: "u-new", organisation: DEFAULT_ORGANISATION_ID });
    expect(userDeleteOne).toHaveBeenCalledWith({ _id: "u-new", organisation: DEFAULT_ORGANISATION_ID });
  });
});
