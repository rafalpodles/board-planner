import { describe, it, expect, vi, beforeEach } from "vitest";

const finishFlow = vi.fn();
const holdForAcceptance = vi.fn();
const identityFindOne = vi.fn();
const identityCreate = vi.fn();
const identityUpdateOne = vi.fn();
const identityDeleteOne = vi.fn();
const userFindById = vi.fn();
const userFindOne = vi.fn();
const invitationFindOne = vi.fn();
const createSession = vi.fn();
const getAuthUser = vi.fn();
const logInstanceAudit = vi.fn();
const notifyIdentityLinked = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getClientIp: () => "203.0.113.9", getAuthUser }));
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
  providerById: (id: string) => (id === "oidc" ? { id: "oidc", label: "Acme" } : null),
}));
vi.mock("@/lib/oidc/flow", () => ({
  FLOW_COOKIE: "bp_oidc",
  ACCEPT_COOKIE: "bp_oidc_accept",
  ACCEPT_TTL_MS: 900_000,
  finishFlow,
  holdForAcceptance,
}));
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
vi.mock("@/models/user", () => ({ User: { findById: userFindById, findOne: userFindOne } }));
vi.mock("@/models/invitation", () => ({ Invitation: { findOne: invitationFindOne } }));

const { GET } = await import("./route");
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

function finishes(intent: "signin" | "invite" | "link", claims: Record<string, unknown> = {}, extra = {}) {
  finishFlow.mockResolvedValue({
    ok: true,
    intent,
    invitationTokenHash: intent === "invite" ? "h1" : null,
    userId: intent === "link" ? "u1" : null,
    claims: { issuer: ISSUER, subject: "s1", email: "ada@example.com", emailVerified: true, name: "", ...claims },
    ...extra,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  identityFindOne.mockReturnValue(lean(null));
  userFindOne.mockResolvedValue(ADA);
  userFindById.mockResolvedValue(ADA);
  identityCreate.mockResolvedValue({});
  createSession.mockResolvedValue({ token: "cps_new", absoluteExpiresAt: new Date() });
});

describe("GET /api/auth/oidc/:provider/callback, signing in", () => {
  it("signs in the account an identity is already linked to, found by issuer and subject", async () => {
    finishes("signin", { email: "somebody-else@example.com", emailVerified: false });
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "u1" }));

    const res = await callback();

    expect(identityFindOne).toHaveBeenCalledWith({ issuer: ISSUER, subject: "s1" });
    expect(location(res)).toBe("/projects");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
    expect(res.headers.get("set-cookie")).toContain("session=cps_new");
    expect(identityCreate).not.toHaveBeenCalled();
  });

  it("links an identity the first time to the account whose address was proven, and tells its mailbox", async () => {
    finishes("signin");

    const res = await callback();

    expect(location(res)).toBe("/projects");
    expect(userFindOne).toHaveBeenCalledWith({ email: "ada@example.com", kind: { $ne: "machine" } });
    expect(identityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ user: "u1", provider: "oidc", issuer: ISSUER, subject: "s1" })
    );
    expect(logInstanceAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "identity_linked", target: "ada" }));
    expect(notifyIdentityLinked).toHaveBeenCalledWith(expect.objectContaining({ email: "ada@example.com", provider: "Acme" }));
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
    userFindById.mockResolvedValue(null);
    userFindOne.mockResolvedValue(null);

    const res = await callback();

    expect(identityDeleteOne).toHaveBeenCalledWith({ _id: "i-dead" });
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
    userFindById.mockResolvedValue({ _id: "m1", username: "pm", kind: "machine" });

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

    expect(finishFlow).toHaveBeenCalledWith(expect.objectContaining({ binder: "cpo_binder" }));
  });

  it("refuses a provider that is not set up", async () => {
    const res = await callback("github");

    expect(location(res)).toBe("/login?sso=failed");
    expect(finishFlow).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/oidc/:provider/callback, linking from settings", () => {
  beforeEach(() => getAuthUser.mockResolvedValue({ _id: "u1", username: "ada" }));

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

  it("refuses an identity that already belongs to another account", async () => {
    finishes("link");
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "u9" }));
    userFindById.mockResolvedValue({ _id: "u9", username: "someone" });

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

  it("refuses an invitation that is no longer pending", async () => {
    finishes("invite");
    invitationFindOne.mockReturnValue(lean(null));

    expect(location(await callback())).toBe("/invite/sso?error=invitation");
  });

  it("refuses an identity that already belongs to an account", async () => {
    finishes("invite");
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "u1" }));

    expect(location(await callback())).toBe("/invite/sso?error=linked");
    expect(identityFindOne).toHaveBeenCalledWith({ issuer: ISSUER, subject: "s1" });
    expect(holdForAcceptance).not.toHaveBeenCalled();
  });
});
