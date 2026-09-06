import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const mintEnrolmentToken = vi.fn();

const logInstanceAudit = vi.fn();
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check, accessibleProjectIds: vi.fn() }));
vi.mock("@/lib/enrolment", () => ({ mintEnrolmentToken }));
const isRateLimited = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  isRateLimited,
  recordFailedAttempt: vi.fn(),
  sourceKey: (a: string, b: string) => `${b}:${a}`,
}));

const { POST } = await import("./route");

const SESSION_ADMIN = { _id: "admin-1", role: "admin" };
const UNSCOPED_ADMIN_TOKEN = {
  _id: "admin-1",
  role: "admin",
  viaMachineCredential: true,
};
const MEMBER = { _id: "member-1", role: "member" };

function request(body: unknown = {}) {
  return new Request("http://localhost/api/workers/enrolment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  check.mockResolvedValue(false);
  isRateLimited.mockResolvedValue(false);
  mintEnrolmentToken.mockResolvedValue({
    token: "cpe_secret",
    expiresAt: new Date("2026-08-03T13:00:00.000Z"),
  });
});

describe("POST /api/workers/enrolment", () => {
  it("mints for a person at a keyboard, returning the token exactly once", async () => {
    getAuthUser.mockResolvedValue(SESSION_ADMIN);

    const response = await POST(request({ label: "rig laptop" }), { params: Promise.resolve({}) });

    expect(response.status).toBe(201);
    expect((await response.json()).token).toBe("cpe_secret");
    expect(mintEnrolmentToken).toHaveBeenCalledWith("admin-1", "rig laptop");
  });

  it("records the minting, and never the token itself", async () => {
    getAuthUser.mockResolvedValue(SESSION_ADMIN);

    await POST(request({ label: "rig laptop" }), { params: Promise.resolve({}) });

    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "enrolment_token_minted",
        target: "rig laptop",
        user: "admin-1",
      })
    );
    expect(JSON.stringify(logInstanceAudit.mock.calls[0][0])).not.toContain("cpe_secret");
  });

  it("records nothing when the mint is refused", async () => {
    getAuthUser.mockResolvedValue(UNSCOPED_ADMIN_TOKEN);

    await POST(request(), { params: Promise.resolve({}) });

    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("refuses an API token, even an unscoped admin one", async () => {
    getAuthUser.mockResolvedValue(UNSCOPED_ADMIN_TOKEN);

    const response = await POST(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(403);
    expect(mintEnrolmentToken).not.toHaveBeenCalled();
  });

  it("mints for an ordinary member, naming them as the token's creator", async () => {
    getAuthUser.mockResolvedValue(MEMBER);

    const response = await POST(request({ label: "my laptop" }), { params: Promise.resolve({}) });

    expect(response.status).toBe(201);
    expect(mintEnrolmentToken).toHaveBeenCalledWith("member-1", "my laptop");
  });

  it("throttles minting, per account", async () => {
    getAuthUser.mockResolvedValue(MEMBER);
    isRateLimited.mockResolvedValue(true);

    const response = await POST(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(429);
    expect(mintEnrolmentToken).not.toHaveBeenCalled();
    expect(isRateLimited).toHaveBeenCalledWith("enrolment_token_mint:member-1", 10);
  });

  it("refuses a member's own API token", async () => {
    getAuthUser.mockResolvedValue({ ...MEMBER, viaMachineCredential: true });

    expect((await POST(request(), { params: Promise.resolve({}) })).status).toBe(403);
    expect(mintEnrolmentToken).not.toHaveBeenCalled();
  });
});
