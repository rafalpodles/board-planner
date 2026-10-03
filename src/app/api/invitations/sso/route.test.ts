import { describe, it, expect, vi, beforeEach } from "vitest";

const heldAcceptance = vi.fn();
const spendAcceptance = vi.fn();
const claimInvitationByHash = vi.fn();
const releaseInvitation = vi.fn();
const completeAcceptance = vi.fn();
const provenanceRefusal = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getClientIp: () => "203.0.113.9" }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/session", () => ({
  provenanceRefusal,
  readFlowCookie: (_request: Request, name: string) => (name === "bp_oidc_accept" ? "cpo_held" : null),
  buildFlowCookie: (name: string, value: string) => `${name}=${value}`,
}));
vi.mock("@/lib/oidc/flow", () => ({ ACCEPT_COOKIE: "bp_oidc_accept", heldAcceptance, spendAcceptance }));
const providerById = vi.fn();
vi.mock("@/lib/oidc/providers", () => ({ providerById }));
vi.mock("@/lib/invitations", () => ({ claimInvitationByHash, releaseInvitation }));
vi.mock("@/lib/invitation-acceptance", () => ({ completeAcceptance }));
vi.mock("@/lib/invitation-view", () => ({ toApiInvitations: vi.fn() }));
vi.mock("@/models/invitation", () => ({ Invitation: { findOne: vi.fn() } }));

const { POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

const HELD = {
  provider: "oidc",
  invitationTokenHash: "h1",
  claims: { issuer: "https://id.example.com", subject: "s9", email: "ada@example.com" },
};
const post = (body: unknown = { username: "Ada", fullName: "Ada Lovelace" }) =>
  POST(new Request("http://x/api/invitations/sso", { method: "POST", body: JSON.stringify(body) }));

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  heldAcceptance.mockResolvedValue(HELD);
  provenanceRefusal.mockReturnValue(null);
  releaseInvitation.mockResolvedValue(undefined);
  claimInvitationByHash.mockResolvedValue({ ok: true, invitation: { _id: "inv-1", email: "ada@example.com" } });
  completeAcceptance.mockResolvedValue(new Response(JSON.stringify({ username: "ada" }), { status: 201 }));
  providerById.mockReturnValue({ label: "Acme", linksByAddress: true });
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
      identity: { provider: "oidc", issuer: "https://id.example.com", subject: "s9", email: "ada@example.com" },
      providerProvesAddress: true,
    });
    expect(spendAcceptance).toHaveBeenCalledWith("cpo_held");
    expect(res.headers.get("set-cookie")).toContain("bp_oidc_accept=");
  });

  it.each([
    ["GitHub, whose word is no proof of the mailbox", { label: "GitHub", linksByAddress: false }],
    ["a provider no longer configured", null],
  ])("does not count %s as proving the address", async (_label, provider) => {
    providerById.mockReturnValue(provider);

    await post();

    expect(completeAcceptance.mock.calls[0][1].providerProvesAddress).toBe(false);
  });

  it("reads the held sign-in from its own cookie", async () => {
    await post();

    expect(heldAcceptance).toHaveBeenCalledWith("cpo_held");
  });

  it("refuses a request from another site", async () => {
    provenanceRefusal.mockReturnValue(new Response(null, { status: 403 }));

    expect((await post()).status).toBe(403);
    expect(claimInvitationByHash).not.toHaveBeenCalled();
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
