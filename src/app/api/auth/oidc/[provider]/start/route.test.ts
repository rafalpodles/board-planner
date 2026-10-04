import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const beginFlow = vi.fn();
const getAuthUser = vi.fn();
const userFindOne = vi.fn();
const findInvitationByToken = vi.fn();
const compare = vi.fn();
const userCount = vi.fn();
const refuseSetupCode = vi.fn();
const signedInRecently = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
let clientIp: string | null = "203.0.113.9";
vi.mock("@/lib/auth", () => ({ getClientIp: () => clientIp, getAuthUser }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/session", () => ({
  provenanceRefusal: () => null,
  selfOrigin: () => "https://planner.example",
  buildFlowCookie: (name: string, value: string) => `${name}=${value}`,
  signedInRecently,
  RECENT_SIGN_IN_REQUIRED: "sign in again",
}));
vi.mock("@/lib/oidc/providers", () => ({
  providerById: (id: string) => (id === "oidc" ? { id: "oidc", label: "Acme" } : null),
}));
vi.mock("@/lib/oidc/flow", () => ({ beginFlow, FLOW_COOKIE: "bp_oidc", FLOW_TTL_MS: 600_000 }));
vi.mock("@/lib/invitations", () => ({ findInvitationByToken }));
vi.mock("@/models/user", () => ({ User: { findOne: userFindOne, countDocuments: userCount } }));
vi.mock("@/lib/setup-code", () => ({ refuseSetupCode }));
vi.mock("bcryptjs", () => ({ default: { compare } }));

const { POST } = await import("./route");
const { scopedToDefaultTenant } = await import("@/lib/db-scope");
const { isRateLimited, lockoutKey, resetRateLimits } = await import("@/lib/rate-limit");

const start = (body: unknown, provider = "oidc") =>
  POST(new Request(`http://x/api/auth/oidc/${provider}/start`, { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ provider }),
  });
const withPassword = (password?: string) =>
  userFindOne.mockReturnValue({ select: () => Promise.resolve(password ? { password } : {}) });

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  clientIp = "203.0.113.9";
  beginFlow.mockResolvedValue({ url: "https://id.example.com/authorize?x", binder: "cpo_b" });
  getAuthUser.mockResolvedValue({ _id: "u1", username: "ada" });
  withPassword("$2a$10$hash");
  compare.mockResolvedValue(true);
  userCount.mockResolvedValue(0);
  refuseSetupCode.mockResolvedValue(null);
  signedInRecently.mockResolvedValue(true);
});

describe("POST /api/auth/oidc/:provider/start", () => {
  it("starts a sign-in and hands the browser its binder", async () => {
    const res = await start({});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://id.example.com/authorize?x" });
    expect(res.headers.get("set-cookie")).toBe("bp_oidc=cpo_b");
    expect(beginFlow).toHaveBeenCalledWith(scopedToDefaultTenant(), expect.objectContaining({ intent: "signin" }));
  });

  // BP-840
  it("throttles a known address", async () => {
    for (let i = 0; i < 30; i++) expect((await start({})).status).toBe(200);

    expect((await start({})).status).toBe(429);
  });

  it("never throttles callers whose address is unknown, who would all share one bucket", async () => {
    clientIp = null;

    for (let i = 0; i < 650; i++) await start({});

    expect((await start({})).status).toBe(200);
  });

  it("refuses a provider that is not set up", async () => {
    expect((await start({}, "github")).status).toBe(404);
    expect(beginFlow).not.toHaveBeenCalled();
  });

  it("starts an acceptance only for an invitation that can still be used", async () => {
    findInvitationByToken.mockResolvedValue({ ok: false, reason: "expired" });

    expect((await start({ intent: "invite", invitationToken: "cpi_x" })).status).toBe(400);
    expect(beginFlow).not.toHaveBeenCalled();
  });

  // A borrowed session must not be enough to add a standing way into the account
  describe("linking", () => {
    it("needs the current password of an account that has one", async () => {
      const res = await start({ intent: "link" });

      expect(res.status).toBe(400);
      expect(beginFlow).not.toHaveBeenCalled();
    });

    it("refuses a wrong password", async () => {
      compare.mockResolvedValue(false);

      expect((await start({ intent: "link", currentPassword: "wrong" })).status).toBe(400);
      expect(beginFlow).not.toHaveBeenCalled();
    });

    it("starts a link tied to the signed-in account once the password matches", async () => {
      const res = await start({ intent: "link", currentPassword: "right" });

      expect(res.status).toBe(200);
      expect(compare).toHaveBeenCalledWith("right", "$2a$10$hash");
      expect(beginFlow).toHaveBeenCalledWith(scopedToDefaultTenant(), expect.objectContaining({ intent: "link", userId: "u1" }));
    });

    describe("guessing the password", () => {
      beforeEach(() => compare.mockImplementation(async (typed: string) => typed === "right"));
      const guess = (currentPassword: string) => start({ intent: "link", currentPassword });

      it("locks out after ten wrong guesses, even the right password", async () => {
        for (let i = 0; i < 9; i++) expect((await guess("wrong")).status).toBe(400);

        expect((await guess("wrong")).status).toBe(429);
        expect((await guess("right")).status).toBe(429);
        expect(beginFlow).not.toHaveBeenCalled();
      });

      it("counts in its own family, not the e-mail change's", async () => {
        for (let i = 0; i < 10; i++) await guess("wrong");

        expect(await isRateLimited(lockoutKey("203.0.113.9", "ada", "link-provider"))).toBe(true);
        expect(await isRateLimited(lockoutKey("203.0.113.9", "ada", "email-change"))).toBe(false);
      });

      it("forgets the session's failures once the password matches", async () => {
        for (let i = 0; i < 9; i++) await guess("wrong");
        expect((await guess("right")).status).toBe(200);

        expect((await guess("wrong")).status).toBe(400);
        expect((await guess("right")).status).toBe(200);
      });
    });

    it("asks a password-less account for no password, only a sign-in made minutes ago", async () => {
      withPassword(undefined);

      expect((await start({ intent: "link" })).status).toBe(200);
      expect(compare).not.toHaveBeenCalled();
      expect(signedInRecently).toHaveBeenCalled();
    });

    // A borrowed session is not the owner: with no password to ask, an old one must not add a way in
    it("refuses a password-less account whose sign-in is not recent", async () => {
      withPassword(undefined);
      signedInRecently.mockResolvedValue(false);

      expect((await start({ intent: "link" })).status).toBe(403);
      expect(beginFlow).not.toHaveBeenCalled();
    });

    it("refuses without a session, and from a machine credential", async () => {
      getAuthUser.mockResolvedValueOnce(null);
      expect((await start({ intent: "link", currentPassword: "right" })).status).toBe(401);

      getAuthUser.mockResolvedValueOnce({ _id: "u1", username: "ada", viaMachineCredential: true });
      expect((await start({ intent: "link", currentPassword: "right" })).status).toBe(401);
      expect(beginFlow).not.toHaveBeenCalled();
    });
  });
});

describe("returning to where sign-in was asked for", () => {
  it("keeps a same-origin path for after the sign-in", async () => {
    await start({ next: "/oauth/authorize?client_id=c1" });

    expect(beginFlow).toHaveBeenCalledWith(scopedToDefaultTenant(), expect.objectContaining({ next: "/oauth/authorize?client_id=c1" }));
  });

  it("turns an address elsewhere into the default", async () => {
    await start({ next: "https://evil.example/x" });

    expect(beginFlow).toHaveBeenCalledWith(scopedToDefaultTenant(), expect.objectContaining({ next: "/projects" }));
  });
});

describe("setting up an empty instance (BP-830)", () => {
  const SETUP = { intent: "bootstrap", setupCode: "code", username: "Ada", fullName: "Ada Lovelace" };
  beforeEach(() => {
    process.env.PASSWORD_SIGN_IN = "off";
  });
  afterEach(() => {
    delete process.env.PASSWORD_SIGN_IN;
  });

  it("is only for an instance without passwords: with them, the first account takes one", async () => {
    delete process.env.PASSWORD_SIGN_IN;

    expect((await start(SETUP)).status).toBe(400);
    expect(refuseSetupCode).not.toHaveBeenCalled();
  });

  it("starts once the setup code and the profile check out, carrying the profile", async () => {
    const res = await start(SETUP);

    expect(res.status).toBe(200);
    expect(refuseSetupCode).toHaveBeenCalledWith("203.0.113.9", "code");
    expect(beginFlow).toHaveBeenCalledWith(
      scopedToDefaultTenant(),
      expect.objectContaining({ intent: "bootstrap", bootstrap: { username: "ada", fullName: "Ada Lovelace" } })
    );
  });

  it("refuses an instance that already has an account", async () => {
    userCount.mockResolvedValue(1);

    expect((await start(SETUP)).status).toBe(409);
    expect(beginFlow).not.toHaveBeenCalled();
  });

  it("refuses a wrong setup code, as the gate answers", async () => {
    refuseSetupCode.mockResolvedValue(new Response(null, { status: 403 }));

    expect((await start(SETUP)).status).toBe(403);
    expect(beginFlow).not.toHaveBeenCalled();
  });

  it("refuses a username the rules do not allow", async () => {
    expect((await start({ ...SETUP, username: "no spaces allowed" })).status).toBe(400);
    expect(beginFlow).not.toHaveBeenCalled();
  });
});

describe("linking with password sign-in off (BP-830)", () => {
  afterEach(() => {
    delete process.env.PASSWORD_SIGN_IN;
  });

  // A password is no credential once passwords sign nobody in; the session is the proof, as for an
  // account that never had one
  it("asks an account that has a password for a recent sign-in instead", async () => {
    process.env.PASSWORD_SIGN_IN = "off";

    expect((await start({ intent: "link" })).status).toBe(200);
    expect(compare).not.toHaveBeenCalled();

    signedInRecently.mockResolvedValue(false);
    expect((await start({ intent: "link" })).status).toBe(403);
  });
});
