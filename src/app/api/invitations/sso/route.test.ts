import { describe, it, expect, vi, beforeEach } from "vitest";

const heldAcceptance = vi.fn();
const spendAcceptance = vi.fn();
const claimInvitationByHash = vi.fn();
const releaseInvitation = vi.fn();
const completeAcceptance = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getClientIp: () => "203.0.113.9" }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/session", () => ({
  provenanceRefusal: () => null,
  readFlowCookie: () => "cpo_held",
  buildFlowCookie: (name: string, value: string) => `${name}=${value}`,
}));
vi.mock("@/lib/oidc/flow", () => ({ ACCEPT_COOKIE: "bp_oidc_accept", heldAcceptance, spendAcceptance }));
vi.mock("@/lib/oidc/providers", () => ({ providerById: () => ({ label: "Acme" }) }));
vi.mock("@/lib/invitations", () => ({ claimInvitationByHash, releaseInvitation }));
vi.mock("@/lib/invitation-acceptance", () => ({ completeAcceptance }));
vi.mock("@/lib/invitation-view", () => ({ toApiInvitations: vi.fn() }));
vi.mock("@/models/invitation", () => ({ Invitation: { findOne: vi.fn() } }));

const { POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

const HELD = { provider: "oidc", invitationTokenHash: "h1", claims: { subject: "s9", email: "ada@example.com" } };
const post = (body: unknown = { username: "Ada", fullName: "Ada Lovelace" }) =>
  POST(new Request("http://x/api/invitations/sso", { method: "POST", body: JSON.stringify(body) }));

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  heldAcceptance.mockResolvedValue(HELD);
  releaseInvitation.mockResolvedValue(undefined);
  claimInvitationByHash.mockResolvedValue({ ok: true, invitation: { _id: "inv-1", email: "ada@example.com" } });
  completeAcceptance.mockResolvedValue(new Response(JSON.stringify({ username: "ada" }), { status: 201 }));
});

describe("POST /api/invitations/sso", () => {
  it("makes a password-less account signing in with the identity the provider confirmed", async () => {
    const res = await post();

    expect(res.status).toBe(201);
    expect(claimInvitationByHash).toHaveBeenCalledWith("h1");
    expect(completeAcceptance.mock.calls[0][1]).toEqual({
      username: "ada",
      fullName: "Ada Lovelace",
      passwordHash: null,
      identity: { provider: "oidc", subject: "s9", email: "ada@example.com" },
    });
    expect(spendAcceptance).toHaveBeenCalledWith("cpo_held");
    expect(res.headers.get("set-cookie")).toContain("bp_oidc_accept=");
  });

  it("refuses when there is no verified sign-in held for this browser", async () => {
    heldAcceptance.mockResolvedValue(null);

    expect((await post()).status).toBe(400);
    expect(claimInvitationByHash).not.toHaveBeenCalled();
  });

  it("checks the username before spending the invitation", async () => {
    expect((await post({ username: "pm", fullName: "Nope" })).status).toBe(400);
    expect(claimInvitationByHash).not.toHaveBeenCalled();
  });

  it("gives the invitation back when it is not for the address the provider confirmed", async () => {
    claimInvitationByHash.mockResolvedValue({ ok: true, invitation: { _id: "inv-1", email: "other@example.com" } });

    const res = await post();

    expect(res.status).toBe(400);
    expect(releaseInvitation).toHaveBeenCalledWith("inv-1");
    expect(completeAcceptance).not.toHaveBeenCalled();
  });

  it("keeps the held sign-in when the account could not be made, so another username can be tried", async () => {
    completeAcceptance.mockResolvedValue(new Response(JSON.stringify({ error: "Username already exists" }), { status: 409 }));

    expect((await post()).status).toBe(409);
    expect(spendAcceptance).not.toHaveBeenCalled();
  });
});
