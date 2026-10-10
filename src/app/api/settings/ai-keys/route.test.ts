import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getAuthUser = vi.fn();
const logInstanceAudit = vi.fn();
const getOrganisation = vi.fn();
let row: Record<string, string> | null = null;

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/organisation", () => ({ getOrganisation }));
const USAGE = { scope: "month", used: 0, limit: null, resetsAt: null, today: 0, dailyCeiling: null, ownTokens: 0, locked: false };
vi.mock("@/lib/ai-gateway/summary", () => ({ aiUsageSummary: async () => USAGE }));
// The host check reads the database in the cloud; the request here always comes from the organisation's own host
vi.mock("@/lib/organisation-host", async (importOriginal) => {
  const { scopedToDefaultOrganisation } = await vi.importActual<typeof import("@/lib/db-scope")>("@/lib/db-scope");
  return {
    ...(await importOriginal<typeof import("@/lib/organisation-host")>()),
    organisationOfRequest: async () => ({ kind: "organisation", organisation: scopedToDefaultOrganisation().organisation }),
  };
});
vi.mock("@/models/settings", () => ({
  Settings: {
    findOne: () => ({ lean: async () => row }),
    findOneAndUpdate: async (_filter: unknown, update: { $set?: Record<string, string>; $unset?: Record<string, 1> }) => {
      row = { ...(row ?? {}), ...(update.$set ?? {}) };
      for (const field of Object.keys(update.$unset ?? {})) delete row[field];
      return row;
    },
  },
}));

const { GET, PUT } = await import("./route");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { decryptSecret } = await import("@/lib/encryption");

const ADMIN = { _id: "a1", username: "root", role: "admin", viaMachineCredential: false };
const ctx = () => ({ params: Promise.resolve({}) });
const put = (body: unknown) =>
  PUT(new Request("http://x/api/settings/ai-keys", { method: "PUT", body: JSON.stringify(body) }), ctx());
const get = () => GET(new Request("http://x/api/settings/ai-keys"), ctx());

const KEY = "sk-or-v1-0123456789abcdef";

beforeEach(() => {
  vi.clearAllMocks();
  row = null;
  getAuthUser.mockResolvedValue(ADMIN);
  getOrganisation.mockResolvedValue({ entitlements: { plan: "free", features: [], source: "none" } });
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
});

afterEach(() => {
  for (const name of ["ENCRYPTION_KEY", "ORGANISATION_DOMAIN", "ORGANISATION_REQUESTS_PER_MINUTE", "OPENROUTER_API_KEY"]) {
    delete process.env[name];
  }
});

describe("PUT /api/settings/ai-keys", () => {
  it("seals the key under the organisation, and never says it again", async () => {
    const res = await put({ openrouterKey: KEY });

    expect(res.status).toBe(200);
    expect(row?.openrouterKey).toMatch(/^enc:v3:/);
    expect(row?.openrouterKey).not.toContain(KEY);
    expect(decryptSecret(row!.openrouterKey, scopedToDefaultOrganisation().organisation)).toBe(KEY);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({ set: true, hint: KEY.slice(-4), unreadable: false });
  });

  it("records that a key was set, not what it is", async () => {
    await put({ openrouterKey: KEY });

    const entry = logInstanceAudit.mock.calls[0][1];
    expect(entry).toMatchObject({ action: "instance_settings_changed", actorUsername: "root" });
    expect(entry.detail).toBe("openrouterKey: set");
    expect(JSON.stringify(entry)).not.toContain(KEY);
  });

  it("removes a key, and its hint with it, when given null or an empty string", async () => {
    await put({ openrouterKey: KEY });

    await put({ openrouterKey: null });

    expect(row).toEqual({});
    expect(logInstanceAudit.mock.calls[1][1].detail).toBe("openrouterKey: removed");

    await put({ openrouterKey: KEY });
    await put({ openrouterKey: "" });
    expect(row).toEqual({});
  });

  it.each([
    ["too short", "sk-1"],
    ["too short to hide behind four visible characters", "sk-or-v1-0123456"],
    ["with a space in it", "sk-or-v1 0123456789abcdef"],
    ["with a newline in it", "sk-or-v1-0123\n456789abcdef"],
    ["with a zero-width space in it, which a header cannot carry", "sk-or-v1-0123\u200b456789abcdef"],
    ["with an accent in it", "sk-or-v1-0123é456789abcdef"],
    ["longer than any key is", "k".repeat(301)],
    ["not a string", 12345678],
  ])("refuses a key %s and stores nothing", async (_why, bad) => {
    const res = await put({ openrouterKey: bad });

    expect(res.status).toBe(400);
    expect(row).toBeNull();
  });

  it("refuses a body that names nothing to change", async () => {
    expect((await put({})).status).toBe(400);
  });

  it.each([["null", null], ["an array", []], ["a string", "sk-or-v1-0123456789abcdef"]])("refuses a body that is %s, rather than failing", async (_what, body) => {
    const res = await put(body);

    expect(res.status).toBe(400);
    expect(row).toBeNull();
  });

  it("cannot store a key without ENCRYPTION_KEY, and says why", async () => {
    delete process.env.ENCRYPTION_KEY;

    const res = await put({ openrouterKey: KEY });

    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/ENCRYPTION_KEY/);
    expect(row).toBeNull();
  });

  it("does not count an OpenAI key as the instance's key", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-0123456789abcdef";

    expect((await (await get()).json()).included).toBe(false);
    delete process.env.OPENAI_API_KEY;
  });

  it("answers no member", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, role: "member" });

    expect((await put({ openrouterKey: KEY })).status).toBe(403);
    expect(row).toBeNull();
  });

  it("answers no machine credential, even an admin's", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });

    expect((await put({ openrouterKey: KEY })).status).toBe(403);
    expect(row).toBeNull();
  });
});

describe("GET /api/settings/ai-keys", () => {
  it("says a stored key that can no longer be opened is unreadable, and never shows what it was", async () => {
    const { encryptSecret } = await import("@/lib/encryption");
    row = { openrouterKey: encryptSecret("sk-someone-elses-0123456789", new (await import("mongoose")).Types.ObjectId()), openrouterKeyHint: "6789" };

    const body = await (await get()).json();

    expect(body).toMatchObject({ set: true, unreadable: true });
    expect(JSON.stringify(body)).not.toContain("enc:v3");
  });

  it("says a key it can open is readable", async () => {
    await put({ openrouterKey: KEY });

    expect((await (await get()).json())).toMatchObject({ set: true, unreadable: false });
  });

  it("carries what the organisation has used of its AI allowance, on the read and on the answer to a save", async () => {
    expect((await (await get()).json()).usage).toEqual(USAGE);
    expect((await (await put({ openrouterKey: KEY })).json()).usage).toEqual(USAGE);
  });

  it("answers no member", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, role: "member" });

    expect((await get()).status).toBe(403);
  });

  it("says what the instance offers when nothing is stored: its own key where self-hosted", async () => {
    process.env.OPENROUTER_API_KEY = "sk-instance";

    const body = await (await get()).json();

    expect(body).toMatchObject({ hosted: false, plan: "free" });
    expect(body).toMatchObject({ set: false, included: true });
  });

  it("offers the operator's key in the cloud only to a plan that includes managed AI", async () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.test";
    // The cloud's per-organisation request budget counts in the database, which this test has none of
    process.env.ORGANISATION_REQUESTS_PER_MINUTE = "0";
    process.env.OPENROUTER_API_KEY = "sk-operators";

    expect((await (await get()).json()).included).toBe(false);

    getOrganisation.mockResolvedValue({ entitlements: { plan: "pro", features: [], source: "service" } });
    expect((await (await get()).json()).included).toBe(true);
  });
});
