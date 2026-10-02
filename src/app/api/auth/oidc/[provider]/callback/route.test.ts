import { describe, it, expect, vi, beforeEach } from "vitest";

const finishFlow = vi.fn();
const holdForAcceptance = vi.fn();
const identityFindOne = vi.fn();
const identityCreate = vi.fn();
const identityUpdateOne = vi.fn();
const identityExists = vi.fn();
const userFindById = vi.fn();
const userFindOne = vi.fn();
const invitationFindOne = vi.fn();
const createSession = vi.fn();
const logInstanceAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getClientIp: () => "203.0.113.9" }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/session", () => ({
  selfOrigin: () => "https://planner.example",
  readFlowCookie: () => "cpo_binder",
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
vi.mock("@/models/identity", () => ({
  Identity: { findOne: identityFindOne, create: identityCreate, updateOne: identityUpdateOne, exists: identityExists },
}));
vi.mock("@/models/user", () => ({ User: { findById: userFindById, findOne: userFindOne } }));
vi.mock("@/models/invitation", () => ({ Invitation: { findOne: invitationFindOne } }));

const { GET } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

const ADA = { _id: "u1", username: "ada", kind: "human" };
const callback = (provider = "oidc") =>
  GET(new Request(`https://planner.example/api/auth/oidc/${provider}/callback?code=c&state=s`), {
    params: Promise.resolve({ provider }),
  });
const location = (res: Response) => new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search;

function signinWith(claims: Partial<{ subject: string; email: string; emailVerified: boolean }>) {
  finishFlow.mockResolvedValue({
    ok: true,
    intent: "signin",
    invitationTokenHash: null,
    claims: { subject: "s1", email: "ada@example.com", emailVerified: true, name: "", ...claims },
  });
}
const lean = (value: unknown) => ({ lean: () => Promise.resolve(value) });

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  identityFindOne.mockReturnValue(lean(null));
  userFindOne.mockResolvedValue(ADA);
  identityCreate.mockResolvedValue({});
  createSession.mockResolvedValue({ token: "cps_new", absoluteExpiresAt: new Date() });
});

describe("GET /api/auth/oidc/:provider/callback, signing in", () => {
  it("signs in the account an identity is already linked to, by subject", async () => {
    signinWith({ email: "somebody-else@example.com", emailVerified: false });
    identityFindOne.mockReturnValue(lean({ _id: "i1", user: "u1" }));
    userFindById.mockResolvedValue(ADA);

    const res = await callback();

    expect(location(res)).toBe("/projects");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
    expect(res.headers.get("set-cookie")).toContain("session=cps_new");
    expect(identityCreate).not.toHaveBeenCalled();
    expect(userFindOne).not.toHaveBeenCalled();
  });

  it("links an identity the first time, by the verified address, and records it", async () => {
    signinWith({});

    const res = await callback();

    expect(location(res)).toBe("/projects");
    expect(userFindOne).toHaveBeenCalledWith({ email: "ada@example.com", kind: { $ne: "machine" } });
    expect(identityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ user: "u1", provider: "oidc", subject: "s1", email: "ada@example.com" })
    );
    expect(logInstanceAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "identity_linked", target: "ada" }));
  });

  it("refuses an address the provider has not verified", async () => {
    signinWith({ emailVerified: false });

    const res = await callback();

    expect(location(res)).toBe("/login?sso=unverified");
    expect(userFindOne).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses an address no account uses, making none", async () => {
    signinWith({});
    userFindOne.mockResolvedValue(null);

    const res = await callback();

    expect(location(res)).toBe("/login?sso=no_account");
    expect(identityCreate).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("never signs a machine account in, even one linked already", async () => {
    signinWith({});
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

  it("refuses a provider that is not set up", async () => {
    const res = await callback("github");

    expect(location(res)).toBe("/login?sso=failed");
    expect(finishFlow).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/oidc/:provider/callback, accepting an invitation", () => {
  const INVITATION = { tokenHash: "h1", email: "ada@example.com", status: "pending" };

  function inviteWith(claims: Partial<{ email: string; emailVerified: boolean }>) {
    finishFlow.mockResolvedValue({
      ok: true,
      intent: "invite",
      invitationTokenHash: "h1",
      claims: { subject: "s9", email: "ada@example.com", emailVerified: true, name: "", ...claims },
    });
  }

  beforeEach(() => {
    invitationFindOne.mockReturnValue(lean(INVITATION));
    identityExists.mockResolvedValue(null);
    holdForAcceptance.mockResolvedValue("cpo_held");
  });

  it("holds the verified identity for the username form, without making an account", async () => {
    inviteWith({});

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
    inviteWith(claims);

    const res = await callback();

    expect(location(res)).toBe(`/invite/sso?error=${reason}`);
    expect(holdForAcceptance).not.toHaveBeenCalled();
  });

  it("refuses an invitation that is no longer pending", async () => {
    inviteWith({});
    invitationFindOne.mockReturnValue(lean(null));

    expect(location(await callback())).toBe("/invite/sso?error=invitation");
  });

  it("refuses an identity that already belongs to an account", async () => {
    inviteWith({});
    identityExists.mockResolvedValue({ _id: "i1" });

    expect(location(await callback())).toBe("/invite/sso?error=linked");
    expect(holdForAcceptance).not.toHaveBeenCalled();
  });
});
