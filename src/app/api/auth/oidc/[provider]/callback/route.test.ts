import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_TENANT_ID } from "@/lib/tenant-field";

const finishFlow = vi.fn();
const holdForAcceptance = vi.fn();
const holdForSignUp = vi.fn();
const signUpOpenTo = vi.fn();
const applyAdminGroup = vi.fn();
const identityFindOne = vi.fn();
const identityCreate = vi.fn();
const identityUpdateOne = vi.fn();
const identityDeleteOne = vi.fn();
const userFindOneById = vi.fn();
const userFindOne = vi.fn();
const userCount = vi.fn();
const userCreate = vi.fn();
const userDeleteOne = vi.fn();
const invitationFindOne = vi.fn();
const createSession = vi.fn();
const getAuthUser = vi.fn();
const logInstanceAudit = vi.fn();
const notifyIdentityLinked = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
let clientIp: string | null = "203.0.113.9";
vi.mock("@/lib/auth", () => ({ getClientIp: () => clientIp, getAuthUser }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/session", () => ({
  selfOrigin: () => "https://planner.example",
  readFlowCookie: (_request: Request, name: string) => (name === "bp_oidc" ? "cpo_binder" : null),
  buildFlowCookie: (name: string, value: string) => `${name}=${value}`,
  buildSessionCookie: (token: string) => `session=${token}`,
  legacySessionCookies: () => [],
  createSession,
}));
vi.mock("@/lib/oidc/providers", () => ({
  providerById: (id: string) =>
    id === "oidc"
      ? { id: "oidc", label: "Acme", linksByAddress: true }
      : id === "github"
        ? { id: "github", label: "GitHub", linksByAddress: false }
        : null,
}));
vi.mock("@/lib/oidc/flow", () => ({
  FLOW_COOKIE: "bp_oidc",
  ACCEPT_COOKIE: "bp_oidc_accept",
  ACCEPT_TTL_MS: 900_000,
  JOIN_COOKIE: "bp_oidc_join",
  finishFlow,
  holdForAcceptance,
  holdForSignUp,
}));
vi.mock("@/lib/sign-up-domains", () => ({ signUpOpenTo }));
vi.mock("@/lib/oidc/admin-group", () => ({ applyAdminGroup }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/security-mail", () => ({ notifyIdentityLinked }));
vi.mock("@/models/identity", () => ({
  Identity: {
    findOne: identityFindOne,
    create: identityCreate,
    updateOne: identityUpdateOne,
    deleteOne: identityDeleteOne,
  },
}));
const sessionExists = vi.fn();
vi.mock("@/models/session", () => ({ Session: { exists: sessionExists } }));
vi.mock("@/models/user", () => ({
  User: {
    findOne: (filter: { _id?: unknown }, ...rest: unknown[]) =>
      ("_id" in filter ? userFindOneById : userFindOne)(filter, ...rest),
    countDocuments: userCount,
    create: userCreate,
    deleteOne: userDeleteOne,
  },
}));
vi.mock("@/models/invitation", () => ({ Invitation: { findOne: invitationFindOne } }));

const { GET } = await import("./route");
const { scopedToDefaultTenant } = await import("@/lib/db-scope");
const { resetRateLimits } = await import("@/lib/rate-limit");

const ISSUER = "https://id.example.com";
const ADA = { _id: "u1", username: "ada", email: "ada@example.com", kind: "human", emailVerifiedAt: new Date() };
const callback = (provider = "oidc") =>
  GET(new Request(`https://planner.example/api/auth/oidc/${provider}/callback?code=c&state=s`), {
    params: Promise.resolve({ provider }),
  });
const location = (res: Response) => {
  const url = new URL(res.headers.get("location")!);
  return url.pathname + url.search;
};
const lean = (value: unknown) => ({ lean: () => Promise.resolve(value) });

function finishes(intent: "signin" | "invite" | "link" | "bootstrap", claims: Record<string, unknown> = {}, extra = {}) {
  const person = { issuer: ISSUER, subject: "s1", email: "ada@example.com", emailVerified: true, name: "", groups: [], ...claims };
  finishFlow.mockResolvedValue({
    ok: true,
    intent,
    invitationTokenHash: intent === "invite" ? "h1" : null,
    userId: intent === "link" ? "u1" : null,
    claims: { verifiedEmails: person.emailVerified ? [person.email] : [], ...person },
    ...extra,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  clientIp = "203.0.113.9";
  identityFindOne.mockReturnValue(lean(null));
  userFindOne.mockResolvedValue(ADA);
  userFindOneById.mockResolvedValue(ADA);
  identityCreate.mockResolvedValue({});
  createSession.mockResolvedValue({ token: "cps_new", absoluteExpiresAt: new Date() });
  signUpOpenTo.mockResolvedValue(false);
  holdForSignUp.mockResolvedValue("cpo_join");
  invitationFindOne.mockReturnValue(lean(null));
});

describe("GET /api/auth/oidc/:provider/callback, signing in", () => {
  it("signs in the account an identity is already linked to, found by issuer and subject", async () => {
    finishes("signin", { email: "somebody-else@example.com", emailVerified: false });
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "u1" }));

    const res = await callback();

    expect(identityFindOne).toHaveBeenCalledWith({ issuer: ISSUER, subject: "s1", tenant: DEFAULT_TENANT_ID });
    expect(location(res)).toBe("/projects");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
    expect(res.headers.get("set-cookie")).toContain("session=cps_new");
    expect(identityCreate).not.toHaveBeenCalled();
  });

  it("links an identity the first time to the account whose address was proven, and tells its mailbox", async () => {
    finishes("signin");

    const res = await callback();

    expect(location(res)).toBe("/projects");
    expect(userFindOne).toHaveBeenCalledWith({
      email: "ada@example.com",
      kind: { $ne: "machine" },
      tenant: DEFAULT_TENANT_ID,
    });
    expect(identityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ user: "u1", provider: "oidc", issuer: ISSUER, subject: "s1" })
    );
    expect(logInstanceAudit).toHaveBeenCalledWith(scopedToDefaultTenant(), expect.objectContaining({ action: "identity_linked", target: "ada" }));
    expect(notifyIdentityLinked).toHaveBeenCalledWith(expect.objectContaining({ email: "ada@example.com", provider: "Acme" }));
  });

  it("signs in as whichever account a racing sign-in linked the identity to", async () => {
    finishes("signin");
    const winner = { ...ADA, _id: "u2", username: "grace" };
    identityCreate.mockRejectedValue(Object.assign(new Error("E11000"), { code: 11000 }));
    identityFindOne.mockReturnValueOnce(lean(null)).mockReturnValue(lean({ _id: "i9", user: "u2" }));
    userFindOneById.mockImplementation(async (filter: { _id: unknown }) => (filter._id === "u2" ? winner : null));

    const res = await callback();

    expect(location(res)).toBe("/projects");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: "u2" }));
    expect(createSession).not.toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
  });

  // BP-845
  it("refuses when the account a racing sign-in linked to is deactivated", async () => {
    finishes("signin");
    identityCreate.mockRejectedValue(Object.assign(new Error("E11000"), { code: 11000 }));
    identityFindOne.mockReturnValueOnce(lean(null)).mockReturnValue(lean({ _id: "i9", user: "u2" }));
    userFindOneById.mockImplementation(async (filter: { _id: unknown }) =>
      filter._id === "u2" ? { ...ADA, _id: "u2", username: "grace", deactivatedAt: new Date() } : null
    );

    expect(location(await callback())).toBe("/login?sso=deactivated");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses when the account a racing sign-in linked to is gone", async () => {
    finishes("signin");
    identityCreate.mockRejectedValue(Object.assign(new Error("E11000"), { code: 11000 }));
    identityFindOne.mockReturnValueOnce(lean(null)).mockReturnValue(lean({ _id: "i9", user: "u2" }));
    userFindOneById.mockResolvedValue(null);

    expect(location(await callback())).toBe("/login?sso=no_account");
    expect(createSession).not.toHaveBeenCalled();
  });

  // An address an administrator typed, or one set without confirmation, is a claim: linking by it
  // would hand the account to whoever holds that mailbox at the provider
  it("refuses to link by an address that was never proven", async () => {
    finishes("signin");
    userFindOne.mockResolvedValue({ ...ADA, emailVerifiedAt: null });

    const res = await callback();

    expect(location(res)).toBe("/login?sso=unproven");
    expect(identityCreate).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("forgets a link whose account is gone, and does not sign in through it", async () => {
    finishes("signin");
    identityFindOne.mockReturnValue(lean({ _id: "i-dead", user: "u-gone" }));
    userFindOneById.mockResolvedValue(null);
    userFindOne.mockResolvedValue(null);

    const res = await callback();

    expect(identityDeleteOne).toHaveBeenCalledWith({ _id: "i-dead", tenant: DEFAULT_TENANT_ID });
    expect(location(res)).toBe("/login?sso=no_account");
  });

  it("refuses an address the provider has not verified", async () => {
    finishes("signin", { emailVerified: false });

    const res = await callback();

    expect(location(res)).toBe("/login?sso=unverified");
    expect(userFindOne).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses an address no account uses, making none", async () => {
    finishes("signin");
    userFindOne.mockResolvedValue(null);

    const res = await callback();

    expect(location(res)).toBe("/login?sso=no_account");
    expect(identityCreate).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("never signs a machine account in, even one linked already", async () => {
    finishes("signin");
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "m1" }));
    userFindOneById.mockResolvedValue({ _id: "m1", username: "pm", kind: "machine" });

    const res = await callback();

    expect(location(res)).toBe("/login?sso=no_account");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("sends back to sign-in when the round trip did not check out, and clears the cookie", async () => {
    finishFlow.mockResolvedValue({ ok: false, reason: "rejected" });

    const res = await callback();

    expect(location(res)).toBe("/login?sso=failed");
    expect(res.headers.get("set-cookie")).toContain("bp_oidc=");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("reads the flow from its own cookie", async () => {
    finishes("signin");

    await callback();

    expect(finishFlow).toHaveBeenCalledWith(scopedToDefaultTenant(), expect.objectContaining({ binder: "cpo_binder" }));
  });

  // GitHub's `verified` is one click, long ago, by whoever held the mailbox then
  it("never links a GitHub identity by address, however verified and proven", async () => {
    finishes("signin");

    const res = await callback("github");

    expect(location(res)).toBe("/login?sso=not_linked");
    expect(userFindOne).not.toHaveBeenCalled();
    expect(identityCreate).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("signs a GitHub identity into the account it was linked to", async () => {
    finishes("signin");
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "u1" }));

    expect(location(await callback("github"))).toBe("/projects");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
  });

  it("refuses a provider that is not set up", async () => {
    const res = await callback("gitlab");

    expect(location(res)).toBe("/login?sso=failed");
    expect(finishFlow).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/oidc/:provider/callback, signing up in an allowed domain (BP-833)", () => {
  beforeEach(() => {
    userFindOne.mockResolvedValue(null);
    signUpOpenTo.mockResolvedValue(true);
    invitationFindOne.mockReturnValue(lean(null));
  });

  it("holds a verified newcomer in an allowed domain for the username form, making no account", async () => {
    finishes("signin", { email: "grace@corp.example", groups: ["staff"] });

    const res = await callback();

    expect(signUpOpenTo).toHaveBeenCalledWith("grace@corp.example");
    expect(holdForSignUp.mock.calls[0][1].claims).toMatchObject({ email: "grace@corp.example", groups: ["staff"] });
    expect(location(res)).toBe("/join/sso");
    expect(res.headers.get("set-cookie")).toContain("bp_oidc_join=cpo_join");
    expect(userCreate).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("sends a newcomer with a pending invitation to accept it, keeping its role and boards", async () => {
    finishes("signin", { email: "grace@corp.example" });
    invitationFindOne.mockReturnValue(lean({ _id: "inv-1", email: "grace@corp.example", tokenHash: "h-grace" }));
    holdForAcceptance.mockResolvedValue("cpo_accept");

    const res = await callback();

    expect(invitationFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ email: "grace@corp.example", status: "pending", expiresAt: { $gt: expect.any(Date) } })
    );
    expect(holdForAcceptance).toHaveBeenCalledWith(scopedToDefaultTenant(), expect.objectContaining({ invitationTokenHash: "h-grace" }));
    expect(holdForSignUp).not.toHaveBeenCalled();
    expect(location(res)).toBe("/invite/sso");
    expect(res.headers.get("set-cookie")).toContain("bp_oidc_accept=cpo_accept");
  });

  // BP-839. The provider proving the invited mailbox stands in for the link, open domain or not
  it("sends an invitee whose domain is not open into the invitation, rather than telling them to ask for one", async () => {
    finishes("signin", { email: "grace@closed.example" });
    signUpOpenTo.mockResolvedValue(false);
    invitationFindOne.mockReturnValue(lean({ _id: "inv-1", email: "grace@closed.example", tokenHash: "h-grace" }));
    holdForAcceptance.mockResolvedValue("cpo_accept");

    const res = await callback();

    expect(location(res)).toBe("/invite/sso");
    expect(holdForAcceptance).toHaveBeenCalledWith(scopedToDefaultTenant(), expect.objectContaining({ invitationTokenHash: "h-grace" }));
    expect(holdForSignUp).not.toHaveBeenCalled();
  });

  it("never routes GitHub into an invitation by address", async () => {
    finishes("signin", { email: "grace@closed.example" });
    invitationFindOne.mockReturnValue(lean({ _id: "inv-1", email: "grace@closed.example", tokenHash: "h-grace" }));

    expect(location(await callback("github"))).toBe("/login?sso=not_linked");
    expect(holdForAcceptance).not.toHaveBeenCalled();
  });

  it("refuses a newcomer whose domain is not open", async () => {
    finishes("signin", { email: "grace@elsewhere.example" });
    signUpOpenTo.mockResolvedValue(false);

    expect(location(await callback())).toBe("/login?sso=no_account");
    expect(holdForSignUp).not.toHaveBeenCalled();
  });

  it("never opens sign-up to an address the provider has not verified", async () => {
    finishes("signin", { email: "grace@corp.example", emailVerified: false });

    expect(location(await callback())).toBe("/login?sso=unverified");
    expect(holdForSignUp).not.toHaveBeenCalled();
  });

  it("never opens sign-up through GitHub, whose verified proves no domain", async () => {
    finishes("signin", { email: "grace@corp.example" });

    expect(location(await callback("github"))).toBe("/login?sso=not_linked");
    expect(holdForSignUp).not.toHaveBeenCalled();
  });

  it("does not sign up an address an account already holds unproven", async () => {
    finishes("signin", { email: "ada@example.com" });
    userFindOne.mockResolvedValue({ ...ADA, emailVerifiedAt: null });

    expect(location(await callback())).toBe("/login?sso=unproven");
    expect(holdForSignUp).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/oidc/:provider/callback, the admin group (BP-833)", () => {
  it("hands the provider's groups to the role mapping before the session is made", async () => {
    finishes("signin", { groups: ["admins"] });
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "u1" }));
    applyAdminGroup.mockImplementationOnce(async () => expect(createSession).not.toHaveBeenCalled());

    await callback();

    expect(applyAdminGroup).toHaveBeenCalledWith(scopedToDefaultTenant(), ADA, "oidc", ["admins"]);
    expect(createSession).toHaveBeenCalled();
  });
});

describe("GET /api/auth/oidc/:provider/callback, a round trip that failed (BP-843)", () => {
  it.each([
    ["link", "/settings/security?link=failed"],
    ["invite", "/invite/sso?error=failed"],
    ["signin", "/login?sso=failed"],
    ["bootstrap", "/login?sso=failed"],
  ])("sends a refused %s back to where it began", async (intent, path) => {
    finishFlow.mockResolvedValue({ ok: false, reason: "rejected", intent });

    expect(location(await callback())).toBe(path);
  });

  it("sends a browser with no flow at all to sign in", async () => {
    finishFlow.mockResolvedValue({ ok: false, reason: "no_flow" });

    expect(location(await callback())).toBe("/login?sso=failed");
  });
});

describe("GET /api/auth/oidc/:provider/callback, the throttle (BP-840)", () => {
  const rejected = () => finishFlow.mockResolvedValue({ ok: false, reason: "rejected" });

  it("throttles a known address after its failed round trips", async () => {
    rejected();
    for (let i = 0; i < 60; i++) expect(location(await callback())).toBe("/login?sso=failed");

    expect(location(await callback())).toBe("/login?sso=throttled");
  });

  it("counts no successful sign-in against the address it came from", async () => {
    finishes("signin");
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "u1" }));
    for (let i = 0; i < 70; i++) await callback();

    expect(location(await callback())).toBe("/projects");
  });

  it("never throttles callbacks whose address is unknown, which would all share one bucket", async () => {
    clientIp = null;
    rejected();
    for (let i = 0; i < 1250; i++) await callback();

    expect(location(await callback())).toBe("/login?sso=failed");
  });
});

describe("GET /api/auth/oidc/:provider/callback, linking from settings", () => {
  beforeEach(() => {
    getAuthUser.mockResolvedValue({ _id: "u1", username: "ada", sessionId: "s-1" });
    sessionExists.mockResolvedValue({ _id: "s-1" });
  });

  // BP-842. A password change or Sign out everywhere landed between the session check and the link
  it("takes the link back when the session that made it ended meanwhile", async () => {
    finishes("link");
    sessionExists.mockResolvedValue(null);

    const res = await callback();

    expect(identityCreate).toHaveBeenCalled();
    expect(sessionExists).toHaveBeenCalledWith({ _id: "s-1", tenant: DEFAULT_TENANT_ID });
    expect(identityDeleteOne).toHaveBeenCalledWith({
      issuer: ISSUER,
      subject: "s1",
      user: "u1",
      tenant: DEFAULT_TENANT_ID,
    });
    expect(location(res)).toBe("/settings/security?link=failed");
    expect(logInstanceAudit).toHaveBeenLastCalledWith(scopedToDefaultTenant(), expect.objectContaining({ action: "identity_unlinked" }));
  });

  it("keeps the link while the session that made it is still there", async () => {
    finishes("link");

    expect(location(await callback())).toBe("/settings/security?link=linked");
    expect(identityDeleteOne).not.toHaveBeenCalled();
  });

  it("links the identity to the account that started it, whatever its address", async () => {
    finishes("link", { email: "ada.personal@example.com" });

    const res = await callback();

    expect(location(res)).toBe("/settings/security?link=linked");
    expect(identityCreate).toHaveBeenCalledWith(expect.objectContaining({ user: "u1", issuer: ISSUER, subject: "s1" }));
    expect(createSession).not.toHaveBeenCalled();
  });

  // Started by one account, finished in a browser now signed in as another: never link across
  it("refuses when the browser is no longer signed in as the account that started it", async () => {
    finishes("link");
    getAuthUser.mockResolvedValue({ _id: "u2", username: "bob" });

    expect(location(await callback())).toBe("/settings/security?link=failed");
    expect(identityCreate).not.toHaveBeenCalled();
  });

  it("says taken when a racing sign-in linked the identity first", async () => {
    finishes("link");
    identityCreate.mockRejectedValue(Object.assign(new Error("E11000"), { code: 11000 }));

    expect(location(await callback())).toBe("/settings/security?link=taken");
  });

  it("moves lastUsedAt only on a sign-in, never on a refusal", async () => {
    finishes("invite");
    invitationFindOne.mockReturnValue(lean({ tokenHash: "h1", email: "ada@example.com" }));
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "u1" }));

    await callback();

    expect(identityUpdateOne).not.toHaveBeenCalled();
  });

  // A browser navigation cannot carry a bearer token, but the guard does not rely on that
  it("refuses to link from a machine credential", async () => {
    finishes("link");
    getAuthUser.mockResolvedValue({ _id: "u1", username: "ada", viaMachineCredential: true });

    expect(location(await callback())).toBe("/settings/security?link=failed");
    expect(identityCreate).not.toHaveBeenCalled();
  });

  it("refuses an identity that already belongs to another account", async () => {
    finishes("link");
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "u9" }));
    userFindOneById.mockResolvedValue({ _id: "u9", username: "someone" });

    expect(location(await callback())).toBe("/settings/security?link=taken");
    expect(identityCreate).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/oidc/:provider/callback, accepting an invitation", () => {
  const INVITATION = { tokenHash: "h1", email: "ada@example.com", status: "pending" };

  beforeEach(() => {
    invitationFindOne.mockReturnValue(lean(INVITATION));
    holdForAcceptance.mockResolvedValue("cpo_held");
  });

  it("holds the verified identity for the username form, without making an account", async () => {
    finishes("invite");

    const res = await callback();

    expect(location(res)).toBe("/invite/sso");
    expect(res.headers.get("set-cookie")).toContain("bp_oidc_accept=cpo_held");
    expect(invitationFindOne).toHaveBeenCalledWith({
      tokenHash: "h1",
      status: "pending",
      expiresAt: { $gt: expect.any(Date) },
      tenant: DEFAULT_TENANT_ID,
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each([
    ["mismatch", { email: "someone-else@example.com" }],
    ["unverified", { emailVerified: false }],
  ])("refuses as %s", async (reason, claims) => {
    finishes("invite", claims);

    expect(location(await callback())).toBe(`/invite/sso?error=${reason}`);
    expect(holdForAcceptance).not.toHaveBeenCalled();
  });

  it("accepts by any address the provider vouches for, and holds the invited one", async () => {
    finishes("invite", { email: "ada@personal.example", verifiedEmails: ["ada@personal.example", "ada@example.com"] });

    expect(location(await callback("github"))).toBe("/invite/sso");
    expect(holdForAcceptance).toHaveBeenCalledWith(
      scopedToDefaultTenant(),
      expect.objectContaining({ claims: expect.objectContaining({ email: "ada@example.com" }) })
    );
  });

  it("refuses an invited address the provider lists but has not verified", async () => {
    finishes("invite", { email: "ada@example.com", emailVerified: false, verifiedEmails: ["ada@personal.example"] });

    expect(location(await callback("github"))).toBe("/invite/sso?error=mismatch");
    expect(holdForAcceptance).not.toHaveBeenCalled();
  });

  it("refuses an invitation that is no longer pending", async () => {
    finishes("invite");
    invitationFindOne.mockReturnValue(lean(null));

    expect(location(await callback())).toBe("/invite/sso?error=invitation");
  });

  it("refuses an identity that already belongs to an account", async () => {
    finishes("invite");
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "u1" }));

    expect(location(await callback())).toBe("/invite/sso?error=linked");
    expect(identityFindOne).toHaveBeenCalledWith({ issuer: ISSUER, subject: "s1", tenant: DEFAULT_TENANT_ID });
    expect(holdForAcceptance).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/oidc/:provider/callback, signing in to go somewhere", () => {
  it("lands where the sign-in was asked for", async () => {
    finishes("signin", {}, { next: "/oauth/authorize?client_id=c1" });
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "u1" }));

    expect(location(await callback())).toBe("/oauth/authorize?client_id=c1");
  });
});

describe("GET /api/auth/oidc/:provider/callback, setting up an empty instance (BP-830)", () => {
  const PROFILE = { username: "ada", fullName: "Ada Lovelace" };

  beforeEach(() => {
    userCount.mockResolvedValue(0);
    userCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ _id: "u-first", ...doc }));
    userDeleteOne.mockResolvedValue({});
  });

  it("makes the first administrator, linked to the provider, and signs them in", async () => {
    finishes("bootstrap", {}, { bootstrap: PROFILE });

    const res = await callback();

    expect(location(res)).toBe("/projects");
    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({ username: "ada", fullName: "Ada Lovelace", email: "ada@example.com", role: "admin" })
    );
    expect(userCreate.mock.calls[0][0].emailVerifiedAt).toBeInstanceOf(Date);
    expect(identityCreate).toHaveBeenCalledWith(expect.objectContaining({ user: "u-first", issuer: ISSUER, subject: "s1" }));
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-first" }));
    expect(logInstanceAudit).toHaveBeenCalledWith(scopedToDefaultTenant(), expect.objectContaining({ action: "user_created", target: "ada" }));
  });

  it("proves no address on a provider whose word is not proof", async () => {
    finishes("bootstrap", {}, { bootstrap: PROFILE });

    await callback("github");

    expect(userCreate.mock.calls[0][0].emailVerifiedAt).toBeNull();
  });

  it("refuses once the instance has an account, making none", async () => {
    finishes("bootstrap", {}, { bootstrap: PROFILE });
    userCount.mockResolvedValue(1);

    expect(location(await callback())).toBe("/login?sso=claimed");
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("reports a failure to make the account rather than calling the instance claimed", async () => {
    finishes("bootstrap", {}, { bootstrap: PROFILE });
    userCreate.mockRejectedValue(new Error("mongo is having a moment"));

    await expect(callback()).rejects.toThrow("mongo is having a moment");
  });

  it("calls it claimed when another account took the name meanwhile", async () => {
    finishes("bootstrap", {}, { bootstrap: PROFILE });
    userCreate.mockRejectedValue(Object.assign(new Error("E11000"), { code: 11000, keyPattern: { username: 1 } }));

    expect(location(await callback())).toBe("/login?sso=claimed");
  });

  it("refuses a provider that gives no address", async () => {
    finishes("bootstrap", { email: "", emailVerified: false }, { bootstrap: PROFILE });

    expect(location(await callback())).toBe("/login?sso=no_email");
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("undoes the account when the identity is already linked elsewhere", async () => {
    finishes("bootstrap", {}, { bootstrap: PROFILE });
    identityCreate.mockRejectedValue(Object.assign(new Error("E11000"), { code: 11000 }));

    expect(location(await callback())).toBe("/login?sso=linked");
    expect(userDeleteOne).toHaveBeenCalledWith({ _id: "u-first", tenant: DEFAULT_TENANT_ID });
    expect(createSession).not.toHaveBeenCalled();
  });

  // An administrator with no way in would leave the instance claimed and nobody able to enter
  it("undoes the account when linking fails some other way", async () => {
    finishes("bootstrap", {}, { bootstrap: PROFILE });
    identityCreate.mockRejectedValue(new Error("mongo is having a moment"));

    await expect(callback()).rejects.toThrow("mongo is having a moment");
    expect(userDeleteOne).toHaveBeenCalledWith({ _id: "u-first", tenant: DEFAULT_TENANT_ID });
  });
});

describe("GET /api/auth/oidc/:provider/callback, a deactivated account (BP-832)", () => {
  it("signs nobody in through a linked identity", async () => {
    finishes("signin");
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "u1" }));
    userFindOneById.mockResolvedValue({ ...ADA, deactivatedAt: new Date() });

    expect(location(await callback())).toBe("/login?sso=deactivated");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("links nothing to it by its address", async () => {
    finishes("signin");
    userFindOne.mockResolvedValue({ ...ADA, deactivatedAt: new Date() });

    expect(location(await callback())).toBe("/login?sso=deactivated");
    expect(identityCreate).not.toHaveBeenCalled();
  });
});
