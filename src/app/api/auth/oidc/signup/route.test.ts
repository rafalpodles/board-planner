import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";

const heldSignUp = vi.fn();
const spendAcceptance = vi.fn();
const provenanceRefusal = vi.fn();
const signUpOpenTo = vi.fn();
const applyAdminGroup = vi.fn();
const revokePendingInvitationsFor = vi.fn();
const logInstanceAudit = vi.fn();
const createSession = vi.fn();
const userCreate = vi.fn();
const userDeleteOne = vi.fn();
const identityCreate = vi.fn();
const providerById = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
let clientIp: string | null = "203.0.113.9";
vi.mock("@/lib/auth", () => ({ getClientIp: () => clientIp }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/session", () => ({
  provenanceRefusal,
  readFlowCookie: (_request: Request, name: string) => (name === "bp_oidc_join" ? "cpo_join" : null),
  buildFlowCookie: (name: string, value: string) => `${name}=${value}`,
  buildSessionCookie: (token: string) => `session=${token}`,
  legacySessionCookies: () => [],
  createSession,
}));
vi.mock("@/lib/oidc/flow", () => ({ JOIN_COOKIE: "bp_oidc_join", heldSignUp, spendAcceptance }));
vi.mock("@/lib/oidc/providers", () => ({ providerById }));
vi.mock("@/lib/oidc/admin-group", () => ({ applyAdminGroup }));
vi.mock("@/lib/sign-up-domains", () => ({ signUpOpenTo }));
vi.mock("@/lib/invitations", () => ({ revokePendingInvitationsFor }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/models/user", () => ({ User: { create: userCreate, deleteOne: userDeleteOne } }));
vi.mock("@/models/identity", () => ({ Identity: { create: identityCreate } }));

const { GET, POST } = await import("./route");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { resetRateLimits } = await import("@/lib/rate-limit");

const HELD = {
  provider: "oidc",
  claims: { issuer: "https://id.example.com", subject: "s9", email: "grace@corp.example", name: "Grace Hopper", groups: ["staff"] },
};
const GRACE = { _id: "u9", username: "grace", email: "grace@corp.example", role: "member" };
const post = (body: unknown = { username: "Grace", fullName: "Grace Hopper" }) =>
  POST(new Request("http://x/api/auth/oidc/signup", { method: "POST", body: JSON.stringify(body) }));
const duplicate = (field: string) => Object.assign(new Error("dup"), { code: 11000, keyPattern: { [field]: 1 } });

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  clientIp = "203.0.113.9";
  heldSignUp.mockResolvedValue(HELD);
  provenanceRefusal.mockReturnValue(null);
  signUpOpenTo.mockResolvedValue(true);
  providerById.mockReturnValue({ id: "oidc", label: "Acme", linksByAddress: true });
  userCreate.mockResolvedValue(GRACE);
  identityCreate.mockResolvedValue({});
  userDeleteOne.mockResolvedValue({});
  createSession.mockResolvedValue({ token: "cps_new", absoluteExpiresAt: new Date() });
});

describe("GET /api/auth/oidc/signup", () => {
  it("says who the held sign-in is, by address, name and provider", async () => {
    const res = await GET(new Request("http://x/api/auth/oidc/signup"));

    expect(await res.json()).toEqual({ email: "grace@corp.example", name: "Grace Hopper", provider: "Acme" });
  });

  it("says it expired when nothing is held", async () => {
    heldSignUp.mockResolvedValue(null);

    expect((await GET(new Request("http://x/api/auth/oidc/signup"))).status).toBe(400);
  });
});

describe("POST /api/auth/oidc/signup", () => {
  it("makes a member with a proven address, no password, the identity linked, and signs it in", async () => {
    const res = await post();

    expect(res.status).toBe(201);
    expect(userCreate).toHaveBeenCalledWith({
      username: "grace",
      fullName: "Grace Hopper",
      email: "grace@corp.example",
      emailVerifiedAt: expect.any(Date),
      role: "member",
      organisation: DEFAULT_ORGANISATION_ID,
    });
    expect(identityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ user: "u9", provider: "oidc", issuer: "https://id.example.com", subject: "s9" })
    );
    expect(spendAcceptance).toHaveBeenCalledWith(scopedToDefaultOrganisation(), "cpo_join");
    expect(revokePendingInvitationsFor).toHaveBeenCalledWith(scopedToDefaultOrganisation(), "grace@corp.example");
    expect(logInstanceAudit).toHaveBeenCalledWith(scopedToDefaultOrganisation(), expect.objectContaining({ action: "user_created", target: "grace" }));
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: "u9" }));
    const cookies = res.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("session=cps_new");
    expect(cookies).toContain("bp_oidc_join=");
  });

  it("hands the held groups to the role mapping before the session is made", async () => {
    applyAdminGroup.mockImplementationOnce(async () => expect(createSession).not.toHaveBeenCalled());

    await post();

    expect(applyAdminGroup).toHaveBeenCalledWith(scopedToDefaultOrganisation(), GRACE, "oidc", ["staff"]);
  });

  it("refuses once the domain is no longer open, making nothing", async () => {
    signUpOpenTo.mockResolvedValue(false);

    const res = await post();

    expect(res.status).toBe(403);
    expect(signUpOpenTo).toHaveBeenCalledWith((await import("@/lib/db-scope")).scopedToDefaultOrganisation(), "grace@corp.example");
    expect(userCreate).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each([
    ["no longer configured", null],
    ["one whose word proves no mailbox", { id: "github", label: "GitHub", linksByAddress: false }],
  ])("refuses a provider %s", async (_label, provider) => {
    providerById.mockReturnValue(provider);

    expect((await post()).status).toBe(403);
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("refuses with nothing held", async () => {
    heldSignUp.mockResolvedValue(null);

    expect((await post()).status).toBe(400);
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request before anything else", async () => {
    provenanceRefusal.mockReturnValue(new Response(null, { status: 403 }));

    expect((await post()).status).toBe(403);
    expect(heldSignUp).not.toHaveBeenCalled();
  });

  it("refuses a username the rules refuse", async () => {
    expect((await post({ username: "a b", fullName: "Grace" })).status).toBe(400);
    expect(userCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["email", "That address already has an account. Sign in instead."],
    ["username", "Username already exists"],
  ])("says which is taken when the %s is", async (field, message) => {
    userCreate.mockRejectedValue(duplicate(field));

    const res = await post();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(message);
    expect(spendAcceptance).not.toHaveBeenCalled();
  });

  it("takes the account back when the identity was linked elsewhere meanwhile", async () => {
    identityCreate.mockRejectedValue(duplicate("issuer"));

    const res = await post();

    expect(res.status).toBe(409);
    expect(userDeleteOne).toHaveBeenCalledWith({ _id: "u9", organisation: DEFAULT_ORGANISATION_ID });
    expect(createSession).not.toHaveBeenCalled();
  });

  // BP-840
  it("throttles a known address", async () => {
    heldSignUp.mockResolvedValue(null);
    for (let i = 0; i < 20; i++) expect((await post()).status).toBe(400);

    expect((await post()).status).toBe(429);
  });

  it("never throttles callers whose address is unknown, who would all share one bucket", async () => {
    clientIp = null;
    heldSignUp.mockResolvedValue(null);
    for (let i = 0; i < 450; i++) await post();

    expect((await post()).status).toBe(400);
  });
});
