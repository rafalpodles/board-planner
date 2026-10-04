import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_TENANT_ID } from "@/lib/tenant-field";

const findInvitationByToken = vi.fn();
const userExists = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
let clientIp: string | null = "203.0.113.9";
vi.mock("@/lib/auth", () => ({ getClientIp: () => clientIp }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/session", () => ({ provenanceRefusal: () => null }));
vi.mock("@/lib/invitations", () => ({ findInvitationByToken }));
vi.mock("@/lib/invitation-view", () => ({
  toApiInvitations: async (rows: { email: string }[]) =>
    rows.map((r) => ({
      email: r.email,
      role: "member",
      boards: [{ project: "p1", key: "TP", name: "Test", relation: "owner" }],
      invitedBy: { _id: "a1", username: "owner", fullName: "Grace" },
      expiresAt: "2026-10-09T00:00:00.000Z",
    })),
}));
vi.mock("@/models/user", () => ({ User: { exists: userExists } }));

const { POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");
const { INVITATION_REFUSALS } = await import("@/lib/invitation-refusals");

const lookup = (body: unknown = { token: "cpi_good" }) =>
  POST(new Request("http://x/api/invitations/lookup", { method: "POST", body: JSON.stringify(body) }));

beforeEach(async () => {
  clientIp = "203.0.113.9";
  vi.clearAllMocks();
  await resetRateLimits();
  findInvitationByToken.mockResolvedValue({
    ok: true,
    invitation: { _id: "inv-1", email: "ada@example.com" },
  });
  userExists.mockResolvedValue(null);
});

describe("POST /api/invitations/lookup", () => {
  it("describes an open invitation without spending it", async () => {
    const res = await lookup();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: "ada@example.com",
      role: "member",
      boards: [{ name: "Test", relation: "owner" }],
      invitedBy: "Grace",
      expiresAt: "2026-10-09T00:00:00.000Z",
    });
  });

  it("says why a link cannot be used, and names nobody", async () => {
    findInvitationByToken.mockResolvedValue({ ok: false, reason: "expired" });

    const res = await lookup();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: INVITATION_REFUSALS.expired, reason: "expired" });
  });

  it("refuses an invitation whose address is held by an account", async () => {
    userExists.mockResolvedValue({ _id: "u2" });

    const res = await lookup();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: INVITATION_REFUSALS.used, reason: "used" });
    expect(userExists).toHaveBeenCalledWith({ email: "ada@example.com", tenant: DEFAULT_TENANT_ID });
  });

  it("refuses a request with no token", async () => {
    expect((await lookup({})).status).toBe(400);
    expect(findInvitationByToken).not.toHaveBeenCalled();
  });

  it("is throttled per source, after sixty lookups", async () => {
    for (let i = 0; i < 59; i++) await lookup();
    expect((await lookup()).status).toBe(200);

    expect((await lookup()).status).toBe(429);
  });
});

// BP-840. The token is the secret; a bucket shared by every caller with no address would let anybody
// stop every invitation being looked up
describe("with no client address", () => {
  it("throttles nobody, where one bucket would be everybody's", async () => {
    clientIp = null;
    for (let i = 0; i < 1250; i++) await lookup();

    expect((await lookup()).status).not.toBe(429);
  });
});
