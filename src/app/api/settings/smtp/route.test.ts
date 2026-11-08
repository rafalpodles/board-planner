import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getAuthUser = vi.fn();
const logInstanceAudit = vi.fn();
const getOrganisation = vi.fn();
const ownMailTransport = vi.fn();
const forgetMailRoute = vi.fn();
const verify = vi.fn();
const close = vi.fn();
const countInLiveWindow = vi.fn();
const recordFailedAttempt = vi.fn();
let row: Record<string, unknown> | null = null;

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/organisation", () => ({ getOrganisation }));
vi.mock("@/lib/organisation-smtp", () => ({ ownMailTransport, forgetMailRoute }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/rate-limit")>()), countInLiveWindow, recordFailedAttempt }));
vi.mock("@/lib/organisation-host", async (importOriginal) => {
  const { scopedToDefaultOrganisation } = await vi.importActual<typeof import("@/lib/db-scope")>("@/lib/db-scope");
  return {
    ...(await importOriginal<typeof import("@/lib/organisation-host")>()),
    organisationOfRequest: async () => ({ kind: "organisation", organisation: scopedToDefaultOrganisation().organisation }),
  };
});
vi.mock("@/models/settings", () => {
  const apply = async (update: { $set?: Record<string, unknown>; $unset?: Record<string, 1> }) => {
    for (const [key, value] of Object.entries(update.$set ?? {})) row = { ...(row ?? {}), [key]: value };
    for (const key of Object.keys(update.$unset ?? {})) if (row) delete row[key];
    return row;
  };
  return {
    Settings: { findOne: () => ({ lean: async () => row }), findOneAndUpdate: (_filter: unknown, update: Parameters<typeof apply>[0]) => apply(update) },
  };
});

const { GET, PUT, DELETE } = await import("./route");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { decryptSecret, encryptSecret } = await import("@/lib/encryption");
const { BlockedDestinationError, UnresolvedDestinationError } = await import("@/lib/safe-fetch");

const ADMIN = { _id: "a1", username: "root", role: "admin", viaMachineCredential: false };
const ORGANISATION = () => scopedToDefaultOrganisation().organisation;
const ctx = () => ({ params: Promise.resolve({}) });
const call = (method: "PUT" | "DELETE" | "GET", body?: unknown) => {
  const request = new Request("http://x/api/settings/smtp", { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { GET, PUT, DELETE }[method](request, ctx());
};
const FORM = { host: "smtp.acme.example", port: 587, user: "mailer@acme.example", password: "smtp-pass-1234", fromAddress: "boards@acme.example", fromName: "Acme boards" };
const plan = (over: Record<string, unknown> = {}) => getOrganisation.mockResolvedValue({ entitlements: { plan: "pro", features: [], source: "service", ...over } });
const stored = () => row?.smtp as { host: string; port: number; user: string; password: string; fromAddress: string; fromName: string } | undefined;
const storeServer = (over: Record<string, unknown> = {}) => {
  row = { smtp: { ...FORM, password: encryptSecret(FORM.password, ORGANISATION()), ...over } };
};

beforeEach(() => {
  vi.clearAllMocks();
  row = null;
  getAuthUser.mockResolvedValue(ADMIN);
  verify.mockResolvedValue(true);
  ownMailTransport.mockResolvedValue({ verify, close });
  countInLiveWindow.mockResolvedValue(1);
  recordFailedAttempt.mockResolvedValue(undefined);
  plan();
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  process.env.ORGANISATION_DOMAIN = "board.example";
  process.env.ORGANISATION_REQUESTS_PER_MINUTE = "0";
});
afterEach(() => {
  for (const name of ["ENCRYPTION_KEY", "ORGANISATION_DOMAIN", "ORGANISATION_REQUESTS_PER_MINUTE"]) delete process.env[name];
});

describe("PUT /api/settings/smtp (BP-899)", () => {
  it("signs in to the server first, then seals the password under the organisation and never says it again", async () => {
    const res = await call("PUT", FORM);

    expect(res.status).toBe(200);
    expect(ownMailTransport).toHaveBeenCalledWith(expect.objectContaining({ host: FORM.host, port: 587, user: FORM.user, password: FORM.password }));
    expect(verify).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(stored()?.password).toMatch(/^enc:v3:/);
    expect(decryptSecret(stored()!.password, ORGANISATION())).toBe(FORM.password);
    expect(forgetMailRoute).toHaveBeenCalledWith(ORGANISATION());
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(FORM.password);
    expect(JSON.parse(text)).toMatchObject({ set: true, active: true, host: FORM.host, port: 587, fromAddress: FORM.fromAddress, fromName: "Acme boards" });
  });

  it("stores nothing when the server refuses the sign-in, and says what it said", async () => {
    verify.mockRejectedValue(new Error("Invalid login: 535 5.7.8 Authentication failed\nAUTH PLAIN AHVzZXIAc2VjcmV0"));

    const res = await call("PUT", FORM);

    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain("535 5.7.8 Authentication failed");
    expect(error).not.toContain("AUTH PLAIN");
    expect(row).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("refuses an address inside the platform's network before anything is stored", async () => {
    ownMailTransport.mockRejectedValue(new BlockedDestinationError("smtp.acme.example resolves to the private address 10.0.0.5"));

    const res = await call("PUT", FORM);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not one this server may call/);
    expect(row).toBeNull();
  });

  it("says a host name that does not resolve is a typo to check, not an internal address", async () => {
    ownMailTransport.mockRejectedValue(new UnresolvedDestinationError("smtp.acme.exmaple"));

    const res = await call("PUT", { ...FORM, host: "smtp.acme.exmaple" });

    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain("No mail server answers to smtp.acme.exmaple");
    expect(error).not.toMatch(/may call/);
    expect(row).toBeNull();
  });

  it("keeps the stored password when it is left blank and the server is the same", async () => {
    storeServer();

    const res = await call("PUT", { ...FORM, password: "", fromName: "Acme" });

    expect(res.status).toBe(200);
    expect(ownMailTransport).toHaveBeenCalledWith(expect.objectContaining({ password: FORM.password }));
    expect(stored()?.fromName).toBe("Acme");
  });

  it.each([
    ["host", { host: "smtp.attacker.example" }],
    ["port", { port: 2525 }],
    ["username", { user: "someone-else" }],
  ])("never sends the stored password to a server whose %s changed", async (_field, change) => {
    storeServer();

    const res = await call("PUT", { ...FORM, ...change, password: "" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Enter the password/);
    expect(ownMailTransport).not.toHaveBeenCalled();
    expect(stored()?.host).toBe(FORM.host);
  });

  it("is a trial's too", async () => {
    plan({ trial: true, expiresAt: new Date(Date.now() + 86_400_000) });

    expect((await call("PUT", FORM)).status).toBe(200);
  });

  it("is refused on Free with the 402 the page upsells on, and connects to nothing", async () => {
    plan({ plan: "free" });

    const res = await call("PUT", FORM);

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ feature: "email.smtp", plan: "free" });
    expect(ownMailTransport).not.toHaveBeenCalled();
    expect(row).toBeNull();
  });

  it("is refused for a machine credential and for somebody who is not an administrator", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });
    expect((await call("PUT", FORM)).status).toBe(403);

    getAuthUser.mockResolvedValue({ ...ADMIN, role: "member" });
    expect((await call("PUT", FORM)).status).toBe(403);
    expect(ownMailTransport).not.toHaveBeenCalled();
  });

  it("does not exist on a self-hosted instance, whose mail server is the environment's", async () => {
    delete process.env.ORGANISATION_DOMAIN;

    expect((await call("PUT", FORM)).status).toBe(404);
    expect(await (await call("GET")).json()).toEqual({ hosted: false });
    expect(ownMailTransport).not.toHaveBeenCalled();
  });

  it("is throttled per organisation, before any connection", async () => {
    countInLiveWindow.mockResolvedValue(11);

    expect((await call("PUT", FORM)).status).toBe(429);
    expect(ownMailTransport).not.toHaveBeenCalled();
  });

  it("refuses what is not a host, a port or an address", async () => {
    for (const body of [
      { ...FORM, host: "smtp://smtp.acme.example" },
      { ...FORM, host: "smtp.acme.example:587" },
      { ...FORM, port: 0 },
      { ...FORM, port: 70000 },
      { ...FORM, fromAddress: "not an address" },
      { ...FORM, fromName: "Acme\r\nBcc: victim@example.com" },
    ]) {
      expect((await call("PUT", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(ownMailTransport).not.toHaveBeenCalled();
  });
});

describe("GET and DELETE /api/settings/smtp", () => {
  it("says the stored server is not used once the plan no longer includes it, and keeps it", async () => {
    storeServer();
    plan({ plan: "free" });

    expect(await (await call("GET")).json()).toMatchObject({ set: true, available: false, active: false, host: FORM.host });
  });

  it("says a password sealed under a key the server no longer has cannot be read", async () => {
    storeServer({ password: "enc:v3:garbage" });

    expect(await (await call("GET")).json()).toMatchObject({ set: true, unreadable: true, active: false });
  });

  it("removes it only for an administrator at the screen, and only in the cloud", async () => {
    storeServer();
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });
    expect((await call("DELETE")).status).toBe(403);

    getAuthUser.mockResolvedValue(ADMIN);
    delete process.env.ORGANISATION_DOMAIN;
    expect((await call("DELETE")).status).toBe(404);
    expect(stored()?.host).toBe(FORM.host);
  });

  it("removes it on any plan, and forgets the route at once", async () => {
    storeServer();
    plan({ plan: "free" });

    const res = await call("DELETE");

    expect(res.status).toBe(200);
    expect(stored()).toBeUndefined();
    expect(forgetMailRoute).toHaveBeenCalledWith(ORGANISATION());
    expect(await res.json()).toMatchObject({ set: false, active: false });
  });
});
