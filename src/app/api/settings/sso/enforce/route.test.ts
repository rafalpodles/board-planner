import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getAuthUser = vi.fn();
const logInstanceAudit = vi.fn();
const getOrganisation = vi.fn();
let row: { sso?: Record<string, unknown> } | null = null;

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/organisation", () => ({ getOrganisation }));
vi.mock("@/lib/organisation-host", async (importOriginal) => {
  const { scopedToDefaultOrganisation } = await vi.importActual<typeof import("@/lib/db-scope")>("@/lib/db-scope");
  return {
    ...(await importOriginal<typeof import("@/lib/organisation-host")>()),
    organisationOfRequest: async () => ({ kind: "organisation", organisation: scopedToDefaultOrganisation().organisation }),
    originFor: async () => "https://acme.board.example",
  };
});
vi.mock("@/models/settings", () => ({
  Settings: {
    findOne: () => ({ lean: async () => row }),
    exists: async () => (row?.sso ? { _id: "s1" } : null),
    updateOne: async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
      if (row?.sso) row.sso.enforced = update.$set["sso.enforced"];
    },
  },
}));

const { PUT } = await import("./route");
const { encryptSecret } = await import("@/lib/encryption");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");

const ADMIN = { _id: "a1", username: "root", role: "admin", viaMachineCredential: false };
const ctx = () => ({ params: Promise.resolve({}) });
const call = (body: unknown) => PUT(new Request("http://x/api/settings/sso/enforce", { method: "PUT", body: JSON.stringify(body) }), ctx());
const plan = (over: Record<string, unknown> = {}) => getOrganisation.mockResolvedValue({ entitlements: { plan: "pro", features: [], source: "service", ...over } });
const stored = (over: Record<string, unknown> = {}) => ({
  issuer: "https://login.acme.example",
  clientId: "acme-app",
  clientSecret: encryptSecret("acme-secret-1234", scopedToDefaultOrganisation().organisation),
  clientSecretHint: "1234",
  label: "Acme login",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  row = { sso: stored() };
  getAuthUser.mockResolvedValue(ADMIN);
  plan();
  process.env.ORGANISATION_DOMAIN = "board.example";
  process.env.ORGANISATION_REQUESTS_PER_MINUTE = "0";
});
afterEach(() => {
  for (const name of ["ENCRYPTION_KEY", "ORGANISATION_DOMAIN", "ORGANISATION_REQUESTS_PER_MINUTE"]) delete process.env[name];
});

describe("PUT /api/settings/sso/enforce (BP-951)", () => {
  it("requires single sign-on, says so in the audit log, and answers with the page's view", async () => {
    const res = await call({ enforced: true });

    expect(res.status).toBe(200);
    expect(row?.sso?.enforced).toBe(true);
    expect(await res.json()).toMatchObject({ active: true, enforced: true });
    expect(logInstanceAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ detail: expect.stringContaining("required") }));
  });

  it("stops requiring it again", async () => {
    row = { sso: stored({ enforced: true }) };

    const res = await call({ enforced: false });

    expect(res.status).toBe(200);
    expect(row.sso?.enforced).toBe(false);
    expect(await res.json()).toMatchObject({ enforced: false });
  });

  it("turning it off is allowed on Free, where the provider is no longer offered: it is the way back", async () => {
    row = { sso: stored({ enforced: true }) };
    plan({ plan: "free" });

    expect((await call({ enforced: false })).status).toBe(200);
    expect(row.sso?.enforced).toBe(false);
  });

  it("turning it on is refused on Free with the 402 the page upsells on", async () => {
    plan({ plan: "free" });

    const res = await call({ enforced: true });

    expect(res.status).toBe(402);
    expect(row?.sso?.enforced).toBeUndefined();
  });

  it("is refused while no provider is set up", async () => {
    row = null;

    const res = await call({ enforced: true });

    expect(res.status).toBe(400);
  });

  it("is refused for a machine credential and for somebody who is not an administrator", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });
    expect((await call({ enforced: true })).status).toBe(403);

    getAuthUser.mockResolvedValue({ ...ADMIN, role: "member" });
    expect((await call({ enforced: true })).status).toBe(403);
    expect(row?.sso?.enforced).toBeUndefined();
  });

  it("wants a boolean", async () => {
    expect((await call({ enforced: "yes" })).status).toBe(400);
    expect((await call({})).status).toBe(400);
  });

  it("is a cloud setting", async () => {
    delete process.env.ORGANISATION_DOMAIN;

    expect((await call({ enforced: true })).status).toBe(404);
    expect(row?.sso?.enforced).toBeUndefined();
  });
});
