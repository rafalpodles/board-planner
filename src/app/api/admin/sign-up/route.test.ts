import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getAuthUser = vi.fn();
const updateSettings = vi.fn();
const logInstanceAudit = vi.fn();
let stored: string[] = [];

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/models/settings", () => ({ getSettings: async () => ({ signUpDomains: stored }), updateSettings }));
const OIDC = { id: "oidc", label: "Acme SSO", linksByAddress: true };
const GITHUB = { id: "github", label: "GitHub", linksByAddress: false };
let providers = [OIDC, GITHUB];
vi.mock("@/lib/oidc/providers", () => ({ configuredProviders: () => providers }));

const { GET, PUT } = await import("./route");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");

const ADMIN = { _id: "a1", username: "root", role: "admin", viaMachineCredential: false };
const ctx = () => ({ params: Promise.resolve({}) });
const put = (body: unknown) =>
  PUT(new Request("http://x/api/admin/sign-up", { method: "PUT", body: JSON.stringify(body) }), ctx());

beforeEach(() => {
  vi.clearAllMocks();
  stored = ["old.example"];
  providers = [OIDC, GITHUB];
  getAuthUser.mockResolvedValue(ADMIN);
  updateSettings.mockImplementation(async (_db: unknown, update: { $set: { signUpDomains: string[] } }) => ({
    signUpDomains: update.$set.signUpDomains,
  }));
  process.env.OIDC_ADMIN_GROUP = "planner-admins";
});

afterEach(() => {
  delete process.env.OIDC_ADMIN_GROUP;
});

describe("GET /api/admin/sign-up", () => {
  it("lists the domains, the providers that can open them — never GitHub — and the admin group", async () => {
    const res = await GET(new Request("http://x/api/admin/sign-up"), ctx());

    expect(await res.json()).toEqual({
      domains: ["old.example"],
      providers: ["Acme SSO"],
      adminGroup: { group: "planner-admins", provider: "Acme SSO" },
    });
  });

  it("names no admin group while it is not set", async () => {
    delete process.env.OIDC_ADMIN_GROUP;

    expect((await (await GET(new Request("http://x/api/admin/sign-up"), ctx())).json()).adminGroup).toBeNull();
  });

  it("names no admin group without the OpenID Connect provider it is read from", async () => {
    providers = [{ id: "google", label: "Google", linksByAddress: true }, GITHUB];

    expect((await (await GET(new Request("http://x/api/admin/sign-up"), ctx())).json()).adminGroup).toBeNull();
  });

  it("answers no member", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, role: "member" });

    expect((await GET(new Request("http://x/api/admin/sign-up"), ctx())).status).toBe(403);
  });
});

describe("PUT /api/admin/sign-up", () => {
  it("stores the domains as parsed, and records the change from and to", async () => {
    const res = await put({ domains: ["Corp.Example", "@corp.example", "lab.example"] });

    expect(res.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith(scopedToDefaultOrganisation(), { $set: { signUpDomains: ["corp.example", "lab.example"] } });
    expect((await res.json()).domains).toEqual(["corp.example", "lab.example"]);
    expect(logInstanceAudit).toHaveBeenCalledWith(
      scopedToDefaultOrganisation(),
      expect.objectContaining({
        action: "instance_settings_changed",
        detail: "sign-up domains: old.example → corp.example, lab.example",
      })
    );
  });

  it("closes sign-up with an empty list", async () => {
    await put({ domains: [] });

    expect(updateSettings).toHaveBeenCalledWith(scopedToDefaultOrganisation(), { $set: { signUpDomains: [] } });
    expect(logInstanceAudit.mock.calls[0][1].detail).toBe("sign-up domains: old.example → none");
  });

  it("refuses something that is not a domain, storing nothing", async () => {
    const res = await put({ domains: ["corp.example", "*.corp.example"] });

    expect(res.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("refuses a machine credential, even an admin's", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });

    expect((await put({ domains: ["corp.example"] })).status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("refuses a member", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, role: "member" });

    expect((await put({ domains: ["corp.example"] })).status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
