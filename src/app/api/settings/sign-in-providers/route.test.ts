import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getAuthUser = vi.fn();
const logInstanceAudit = vi.fn();
const getOrganisation = vi.fn();
const membersOnlyThrough = vi.fn();
const warnIfAdminsLockedOut = vi.fn();
let row: Record<string, unknown> | null = null;

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/organisation", () => ({ getOrganisation }));
vi.mock("@/lib/password-sign-in", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/password-sign-in")>()), warnIfAdminsLockedOut }));
vi.mock("@/lib/oidc/provider-switch", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/oidc/provider-switch")>()), membersOnlyThrough }));
vi.mock("@/lib/organisation-host", async (importOriginal) => {
  const { scopedToDefaultOrganisation } = await vi.importActual<typeof import("@/lib/db-scope")>("@/lib/db-scope");
  return {
    ...(await importOriginal<typeof import("@/lib/organisation-host")>()),
    organisationOfRequest: async () => ({ kind: "organisation", organisation: scopedToDefaultOrganisation().organisation }),
  };
});
vi.mock("@/models/settings", () => {
  const apply = async (update: { $addToSet?: { disabledProviders?: string }; $pull?: { disabledProviders?: string } }) => {
    const list = ((row?.disabledProviders as string[] | undefined) ?? []).slice();
    const added = update.$addToSet?.disabledProviders;
    const pulled = update.$pull?.disabledProviders;
    if (added && !list.includes(added)) list.push(added);
    row = { ...(row ?? {}), disabledProviders: pulled ? list.filter((id) => id !== pulled) : list };
    return row;
  };
  return {
    Settings: { findOne: () => ({ lean: async () => row }), findOneAndUpdate: (_filter: unknown, update: Parameters<typeof apply>[0]) => apply(update) },
  };
});

const { GET, PUT } = await import("./route");

const ADMIN = { _id: "a1", username: "root", role: "admin", viaMachineCredential: false };
const ctx = () => ({ params: Promise.resolve({}) });
const get = () => GET(new Request("http://x/api/settings/sign-in-providers"), ctx());
const put = (body: unknown) => PUT(new Request("http://x/api/settings/sign-in-providers", { method: "PUT", body: JSON.stringify(body) }), ctx());
const ENV = ["ORGANISATION_DOMAIN", "ORGANISATION_REQUESTS_PER_MINUTE", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET", "PASSWORD_SIGN_IN"];

beforeEach(() => {
  vi.clearAllMocks();
  row = null;
  getAuthUser.mockResolvedValue(ADMIN);
  getOrganisation.mockResolvedValue({ entitlements: { plan: "pro", features: [], source: "service" } });
  membersOnlyThrough.mockResolvedValue(0);
  Object.assign(process.env, {
    ORGANISATION_DOMAIN: "board.example",
    ORGANISATION_REQUESTS_PER_MINUTE: "0",
    GOOGLE_CLIENT_ID: "g",
    GOOGLE_CLIENT_SECRET: "gs",
    GITHUB_OAUTH_CLIENT_ID: "gh",
    GITHUB_OAUTH_CLIENT_SECRET: "ghs",
  });
});
afterEach(() => ENV.forEach((key) => delete process.env[key]));

describe("GET /api/settings/sign-in-providers", () => {
  it("lists the providers the operator set up, each on while nothing is stored", async () => {
    const body = await (await get()).json();

    expect(body).toEqual({
      hosted: true,
      enforced: false,
      passwordSignIn: true,
      providers: [
        { id: "google", label: "Google", enabled: true },
        { id: "github", label: "GitHub", enabled: true },
      ],
    });
  });

  it("lists only what the operator set up", async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;

    expect((await (await get()).json()).providers.map((p: { id: string }) => p.id)).toEqual(["google"]);
  });

  it("says it is not for an instance where one organisation is the whole instance", async () => {
    delete process.env.ORGANISATION_DOMAIN;

    expect(await (await get()).json()).toEqual({ hosted: false });
  });

  it("is for administrators", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, role: "member" });

    expect((await get()).status).toBe(403);
  });
});

describe("PUT /api/settings/sign-in-providers", () => {
  it("switches a provider off for the organisation, and logs who did", async () => {
    const res = await put({ provider: "google", enabled: false });

    expect(res.status).toBe(200);
    expect(row?.disabledProviders).toEqual(["google"]);
    expect((await res.json()).providers).toEqual([
      { id: "google", label: "Google", enabled: false },
      { id: "github", label: "GitHub", enabled: true },
    ]);
    expect(logInstanceAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "instance_settings_changed", detail: "sign-in with Google: turned off" }));
  });

  it("switches it back on", async () => {
    row = { disabledProviders: ["google", "github"] };

    const res = await put({ provider: "google", enabled: true });

    expect(row?.disabledProviders).toEqual(["github"]);
    expect((await res.json()).providers[0]).toMatchObject({ id: "google", enabled: true });
    expect(logInstanceAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ detail: "sign-in with Google: turned on" }));
  });

  it("changes and logs nothing when the provider is already as asked", async () => {
    row = { disabledProviders: ["google"] };

    expect((await put({ provider: "google", enabled: false })).status).toBe(200);
    expect((await put({ provider: "github", enabled: true })).status).toBe(200);

    expect(row?.disabledProviders).toEqual(["google"]);
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("asks first when members would be left with no way in, naming how many, and changes nothing", async () => {
    membersOnlyThrough.mockResolvedValue(3);

    const res = await put({ provider: "github", enabled: false });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "3 members sign in only through GitHub. They cannot sign in while it is off.", affected: 3 });
    expect(row).toBeNull();
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("says member, not members, for one", async () => {
    membersOnlyThrough.mockResolvedValue(1);

    expect((await (await put({ provider: "github", enabled: false })).json()).error).toMatch(/^1 member signs in only through GitHub/);
  });

  it("switches it off once the administrator has confirmed", async () => {
    membersOnlyThrough.mockResolvedValue(3);

    const res = await put({ provider: "github", enabled: false, confirm: true });

    expect(res.status).toBe(200);
    expect(row?.disabledProviders).toEqual(["github"]);
  });

  it("never asks about members when switching a provider on", async () => {
    row = { disabledProviders: ["github"] };
    membersOnlyThrough.mockResolvedValue(5);

    expect((await put({ provider: "github", enabled: true })).status).toBe(200);
    expect(membersOnlyThrough).not.toHaveBeenCalled();
  });

  it("refuses a provider that cannot be switched: the organisation's own, an unknown one, one the operator never set up", async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;

    for (const provider of ["oidc", "gitlab", "github", undefined, 7]) {
      expect((await put({ provider, enabled: false })).status).toBe(400);
    }
    expect(row).toBeNull();
  });

  it("wants true or false", async () => {
    expect((await put({ provider: "google", enabled: "no" })).status).toBe(400);
    expect((await put({ provider: "google" })).status).toBe(400);
  });

  it("is never changed by a token, which is not a person at the screen", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });

    expect((await put({ provider: "google", enabled: false })).status).toBe(403);
    expect(row).toBeNull();
  });

  it("is not for an instance where one organisation is the whole instance", async () => {
    delete process.env.ORGANISATION_DOMAIN;

    expect((await put({ provider: "google", enabled: false })).status).toBe(404);
    expect(row).toBeNull();
  });

  it("is not for a member", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, role: "member" });

    expect((await put({ provider: "google", enabled: false })).status).toBe(403);
    expect(row).toBeNull();
  });

  it("takes only a true confirm as one, never the string", async () => {
    membersOnlyThrough.mockResolvedValue(2);

    expect((await put({ provider: "google", enabled: false, confirm: "true" })).status).toBe(409);
    expect(row).toBeNull();
  });

  it("says the instance's administrators may now be locked out, after the write that switched a provider off, and not after one that switched it on", async () => {
    await put({ provider: "google", enabled: false });
    expect(warnIfAdminsLockedOut).toHaveBeenCalledTimes(1);

    await put({ provider: "google", enabled: true });
    expect(warnIfAdminsLockedOut).toHaveBeenCalledTimes(1);
  });
});

describe("PUT /api/settings/sign-in-providers where passwords do not sign in", () => {
  beforeEach(() => {
    process.env.PASSWORD_SIGN_IN = "off";
  });

  it("refuses to switch off the last provider that is offered, however it is confirmed, and writes nothing", async () => {
    row = { disabledProviders: ["github"] };

    for (const confirm of [undefined, true]) {
      const res = await put({ provider: "google", enabled: false, confirm });

      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain("Google is the only way in");
    }
    expect(row).toEqual({ disabledProviders: ["github"] });
    expect(membersOnlyThrough).not.toHaveBeenCalled();
    expect(warnIfAdminsLockedOut).not.toHaveBeenCalled();
  });

  it("lets one go while another stays", async () => {
    const res = await put({ provider: "google", enabled: false });

    expect(res.status).toBe(200);
    expect(row?.disabledProviders).toEqual(["google"]);
  });

  it("lets the last one be switched on, which is the way back", async () => {
    row = { disabledProviders: ["google", "github"] };

    expect((await put({ provider: "google", enabled: true })).status).toBe(200);
    expect(row?.disabledProviders).toEqual(["github"]);
  });

  it("puts a provider back when somebody else switched off the other between the check and the write, so the last way in is never lost", async () => {
    membersOnlyThrough.mockImplementation(async () => {
      row = { disabledProviders: ["github"] };
      return 0;
    });

    const res = await put({ provider: "google", enabled: false });

    expect(res.status).toBe(409);
    expect(row).toEqual({ disabledProviders: ["github"] });
    expect(logInstanceAudit).not.toHaveBeenCalled();
    expect(warnIfAdminsLockedOut).not.toHaveBeenCalled();
  });
});

describe("PUT /api/settings/sign-in-providers where passwords sign in", () => {
  it("lets the last provider be switched off, since people can still use a password", async () => {
    row = { disabledProviders: ["github"] };

    const res = await put({ provider: "google", enabled: false });

    expect(res.status).toBe(200);
    expect(row?.disabledProviders).toEqual(["github", "google"]);
  });
});

describe("GET /api/settings/sign-in-providers, what the card is told", () => {
  it("says whether passwords sign in", async () => {
    process.env.PASSWORD_SIGN_IN = "off";

    expect((await (await get()).json()).passwordSignIn).toBe(false);
  });
});
