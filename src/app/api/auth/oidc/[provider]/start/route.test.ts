import { describe, it, expect, vi, beforeEach } from "vitest";

const beginFlow = vi.fn();
const getAuthUser = vi.fn();
const userFindById = vi.fn();
const findInvitationByToken = vi.fn();
const compare = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getClientIp: () => "203.0.113.9", getAuthUser }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/session", () => ({
  provenanceRefusal: () => null,
  selfOrigin: () => "https://planner.example",
  buildFlowCookie: (name: string, value: string) => `${name}=${value}`,
}));
vi.mock("@/lib/oidc/providers", () => ({
  providerById: (id: string) => (id === "oidc" ? { id: "oidc", label: "Acme" } : null),
}));
vi.mock("@/lib/oidc/flow", () => ({ beginFlow, FLOW_COOKIE: "bp_oidc", FLOW_TTL_MS: 600_000 }));
vi.mock("@/lib/invitations", () => ({ findInvitationByToken }));
vi.mock("@/models/user", () => ({ User: { findById: userFindById } }));
vi.mock("bcryptjs", () => ({ default: { compare } }));

const { POST } = await import("./route");
const { isRateLimited, lockoutKey, resetRateLimits } = await import("@/lib/rate-limit");

const start = (body: unknown, provider = "oidc") =>
  POST(new Request(`http://x/api/auth/oidc/${provider}/start`, { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ provider }),
  });
const withPassword = (password?: string) =>
  userFindById.mockReturnValue({ select: () => Promise.resolve(password ? { password } : {}) });

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  beginFlow.mockResolvedValue({ url: "https://id.example.com/authorize?x", binder: "cpo_b" });
  getAuthUser.mockResolvedValue({ _id: "u1", username: "ada" });
  withPassword("$2a$10$hash");
  compare.mockResolvedValue(true);
});

describe("POST /api/auth/oidc/:provider/start", () => {
  it("starts a sign-in and hands the browser its binder", async () => {
    const res = await start({});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://id.example.com/authorize?x" });
    expect(res.headers.get("set-cookie")).toBe("bp_oidc=cpo_b");
    expect(beginFlow).toHaveBeenCalledWith(expect.objectContaining({ intent: "signin" }));
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
      expect(beginFlow).toHaveBeenCalledWith(expect.objectContaining({ intent: "link", userId: "u1" }));
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

    it("asks a password-less account for nothing: its session is all the proof it has", async () => {
      withPassword(undefined);

      expect((await start({ intent: "link" })).status).toBe(200);
      expect(compare).not.toHaveBeenCalled();
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
