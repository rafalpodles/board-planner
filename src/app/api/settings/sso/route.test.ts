import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getAuthUser = vi.fn();
const logInstanceAudit = vi.fn();
const getOrganisation = vi.fn();
const discoverProvider = vi.fn();
let row: Record<string, unknown> | null = null;

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/organisation", () => ({ getOrganisation }));
vi.mock("@/lib/oidc/flow", () => ({
  discoverProvider,
  returnAddress: (provider: { id: string }, origin: string) => `${origin}/api/auth/oidc/${provider.id}/callback`,
}));
vi.mock("@/lib/organisation-host", async (importOriginal) => {
  const { scopedToDefaultOrganisation } = await vi.importActual<typeof import("@/lib/db-scope")>("@/lib/db-scope");
  return {
    ...(await importOriginal<typeof import("@/lib/organisation-host")>()),
    organisationOfRequest: async () => ({ kind: "organisation", organisation: scopedToDefaultOrganisation().organisation }),
    originFor: async () => "https://acme.board.example",
  };
});
vi.mock("@/models/settings", () => {
  const apply = async (update: { $set?: Record<string, unknown>; $unset?: Record<string, 1> }) => {
    row = { ...(row ?? {}), ...(update.$set ?? {}) };
    for (const field of Object.keys(update.$unset ?? {})) delete row[field];
    return row;
  };
  return {
    Settings: { findOne: () => ({ lean: async () => row }), findOneAndUpdate: (_filter: unknown, update: Parameters<typeof apply>[0]) => apply(update) },
    updateSettings: (_db: unknown, update: Parameters<typeof apply>[0]) => apply(update),
  };
});

const { GET, PUT, DELETE } = await import("./route");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { decryptSecret } = await import("@/lib/encryption");
const { BlockedDestinationError } = await import("@/lib/safe-fetch");

const ADMIN = { _id: "a1", username: "root", role: "admin", viaMachineCredential: false };
const ctx = () => ({ params: Promise.resolve({}) });
const call = (method: "PUT" | "DELETE" | "GET", body?: unknown) => {
  const request = new Request("http://x/api/settings/sso", { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { GET, PUT, DELETE }[method](request, ctx());
};
const FORM = { issuer: "https://login.acme.example", clientId: "acme-app", clientSecret: "s3cret-value-1234", label: "Acme login" };
const plan = (over: Record<string, unknown> = {}) => getOrganisation.mockResolvedValue({ entitlements: { plan: "pro", features: [], source: "service", ...over } });
const sealed = () => (row?.sso as { clientSecret: string }).clientSecret;

beforeEach(() => {
  vi.clearAllMocks();
  row = null;
  getAuthUser.mockResolvedValue(ADMIN);
  discoverProvider.mockResolvedValue(undefined);
  plan();
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  process.env.ORGANISATION_DOMAIN = "board.example";
  // The cloud counts requests per organisation in the database; this suite has none
  process.env.ORGANISATION_REQUESTS_PER_MINUTE = "0";
});
afterEach(() => {
  for (const name of ["ENCRYPTION_KEY", "ORGANISATION_DOMAIN", "ORGANISATION_REQUESTS_PER_MINUTE"]) delete process.env[name];
});

describe("PUT /api/settings/sso (BP-951)", () => {
  it("seals the secret under the organisation, reads the provider's discovery document first, and never says the secret again", async () => {
    const res = await call("PUT", FORM);

    expect(res.status).toBe(200);
    expect(discoverProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "oidc", issuer: FORM.issuer, clientId: "acme-app", clientSecret: FORM.clientSecret, own: true }));
    expect(sealed()).toMatch(/^enc:v3:/);
    expect(decryptSecret(sealed(), scopedToDefaultOrganisation().organisation)).toBe(FORM.clientSecret);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(FORM.clientSecret);
    expect(JSON.parse(text)).toMatchObject({ set: true, active: true, issuer: FORM.issuer, secretHint: "1234", label: "Acme login", redirectUri: "https://acme.board.example/api/auth/oidc/oidc/callback" });
  });

  it("is a trial's too", async () => {
    plan({ trial: true, expiresAt: new Date(Date.now() + 86_400_000) });

    expect((await call("PUT", FORM)).status).toBe(200);
  });

  it("is refused on Free with the 402 the page upsells on, and stores nothing", async () => {
    plan({ plan: "free" });

    const res = await call("PUT", FORM);

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ feature: "identity.sso", plan: "free" });
    expect(row).toBeNull();
    expect(discoverProvider).not.toHaveBeenCalled();
  });

  it("is refused for a machine credential and for somebody who is not an administrator", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });
    expect((await call("PUT", FORM)).status).toBe(403);

    getAuthUser.mockResolvedValue({ ...ADMIN, role: "member" });
    expect((await call("PUT", FORM)).status).toBe(403);
    expect(row).toBeNull();
  });

  it("is a cloud setting: where one organisation is the instance the environment decides", async () => {
    delete process.env.ORGANISATION_DOMAIN;

    expect((await call("PUT", FORM)).status).toBe(404);
    expect(await (await call("GET")).json()).toEqual({ hosted: false });
  });

  it.each([
    ["an http issuer", { issuer: "http://login.acme.example" }],
    ["an issuer with credentials", { issuer: "https://user:pw@login.acme.example" }],
    ["an issuer with a query", { issuer: "https://login.acme.example/?a=1" }],
    ["no issuer", { issuer: "" }],
    ["a client id with a space", { clientId: "acme app" }],
    ["a short secret", { clientSecret: "short" }],
    ["a button name with markup", { label: "<b>Acme</b>" }],
    ["a button name that is too long", { label: "x".repeat(41) }],
  ])("refuses %s", async (_name, over) => {
    const res = await call("PUT", { ...FORM, ...over });

    expect(res.status).toBe(400);
    expect(row).toBeNull();
    expect(discoverProvider).not.toHaveBeenCalled();
  });

  it("refuses an address the server may not call, and one whose discovery document it cannot read, storing neither", async () => {
    discoverProvider.mockRejectedValueOnce(new BlockedDestinationError("internal"));
    const blocked = await call("PUT", FORM);
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toContain("not one this server may call");

    discoverProvider.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const unreadable = await call("PUT", FORM);
    expect(unreadable.status).toBe(400);
    expect((await unreadable.json()).error).toContain("discovery document");
    expect(row).toBeNull();
  });

  it("keeps the stored secret when the form leaves it blank for the same issuer and client", async () => {
    await call("PUT", FORM);
    const before = sealed();

    const res = await call("PUT", { ...FORM, clientSecret: "", label: "Acme SSO" });

    expect(res.status).toBe(200);
    expect(discoverProvider).toHaveBeenLastCalledWith(expect.objectContaining({ clientSecret: FORM.clientSecret }));
    expect(decryptSecret(sealed(), scopedToDefaultOrganisation().organisation)).toBe(FORM.clientSecret);
    expect(row?.sso).toMatchObject({ label: "Acme SSO" });
    expect(before).toMatch(/^enc:v3:/);
  });

  it("asks for the secret again when the issuer or the client changes, so the old one is never sent to a new address", async () => {
    await call("PUT", FORM);
    discoverProvider.mockClear();

    const issuerChanged = await call("PUT", { ...FORM, clientSecret: "", issuer: "https://elsewhere.example" });
    const clientChanged = await call("PUT", { ...FORM, clientSecret: "", clientId: "other" });

    expect(issuerChanged.status).toBe(400);
    expect(clientChanged.status).toBe(400);
    expect(discoverProvider).not.toHaveBeenCalled();
    expect(row?.sso).toMatchObject({ issuer: FORM.issuer, clientId: "acme-app" });
  });

  it("records that it was set and where, never the secret", async () => {
    await call("PUT", FORM);

    const detail = logInstanceAudit.mock.calls[0][1].detail as string;
    expect(detail).toContain(FORM.issuer);
    expect(detail).not.toContain(FORM.clientSecret);
  });
});

describe("GET and DELETE /api/settings/sso", () => {
  it("keeps the setup on Free but says it is not offered, and says it is back with the next plan", async () => {
    await call("PUT", FORM);

    plan({ plan: "free" });
    expect(await (await call("GET")).json()).toMatchObject({ set: true, available: false, active: false, issuer: FORM.issuer });

    plan();
    expect(await (await call("GET")).json()).toMatchObject({ set: true, available: true, active: true });
  });

  it("says a secret sealed under a key the server no longer has has to be entered again", async () => {
    row = { sso: { issuer: FORM.issuer, clientId: "acme-app", clientSecret: "enc:v3:not-a-real-secret", clientSecretHint: "1234", label: "Acme" } };

    expect(await (await call("GET")).json()).toMatchObject({ set: true, unreadable: true, active: false });
  });

  it("removes the setup on any plan", async () => {
    await call("PUT", FORM);
    plan({ plan: "free" });

    const res = await call("DELETE");

    expect(res.status).toBe(200);
    expect(row?.sso).toBeUndefined();
    expect(await res.json()).toMatchObject({ set: false });
    expect(logInstanceAudit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ detail: "single sign-on: removed" }));
  });
});
