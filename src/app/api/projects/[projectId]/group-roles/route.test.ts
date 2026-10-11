import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const logProjectAudit = vi.fn();
const getOrganisation = vi.fn();
const providersFor = vi.fn();
let row: { groupRoleMap?: { group: string; role: string }[] } | null = null;
const updateOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/grants", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/grants")>()), check, accessibleProjectIds: vi.fn() }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/lib/organisation", () => ({ getOrganisation }));
vi.mock("@/lib/oidc/providers", () => ({ providersFor }));
vi.mock("@/lib/organisation-host", async (importOriginal) => {
  const { scopedToDefaultOrganisation } = await vi.importActual<typeof import("@/lib/db-scope")>("@/lib/db-scope");
  return {
    ...(await importOriginal<typeof import("@/lib/organisation-host")>()),
    organisationOfRequest: async () => ({ kind: "organisation", organisation: scopedToDefaultOrganisation().organisation }),
  };
});
vi.mock("@/models/project", () => ({
  Project: {
    findById: () => ({ select: () => ({ lean: async () => row }) }),
    findOne: () => ({ select: () => ({ lean: async () => row }) }),
    updateOne: (...a: unknown[]) => updateOne(...a),
  },
}));

const { GET, PUT } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const params = Promise.resolve({ projectId: PROJECT });
const put = (body: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), { params });
const plan = (over: Record<string, unknown> = {}) => getOrganisation.mockResolvedValue({ entitlements: { plan: "pro", features: [], source: "service", ...over } });

beforeEach(() => {
  vi.clearAllMocks();
  row = { groupRoleMap: [] };
  getAuthUser.mockResolvedValue({ _id: "o1", role: "member", username: "olga" });
  check.mockResolvedValue(true);
  providersFor.mockResolvedValue([{ id: "oidc" }]);
  updateOne.mockResolvedValue({ matchedCount: 1 });
  plan();
  process.env.ORGANISATION_REQUESTS_PER_MINUTE = "0";
});
afterEach(() => {
  delete process.env.ORGANISATION_DOMAIN;
  delete process.env.ORGANISATION_REQUESTS_PER_MINUTE;
});

describe("GET /api/projects/:id/group-roles (BP-862)", () => {
  it("answers the mapping and whether there is a provider whose groups could be read", async () => {
    row = { groupRoleMap: [{ group: "staff", role: "member" }] };

    expect(await (await GET(new Request("http://x"), { params })).json()).toEqual({ map: [{ group: "staff", role: "member" }], hasProvider: true });

    providersFor.mockResolvedValue([{ id: "google" }]);
    expect((await (await GET(new Request("http://x"), { params })).json()).hasProvider).toBe(false);
  });

  it("is for an owner of the board", async () => {
    check.mockResolvedValue(false);

    expect((await GET(new Request("http://x"), { params })).status).toBe(403);
  });
});

describe("PUT /api/projects/:id/group-roles (BP-862)", () => {
  it("stores the mapping and records it in the board's log", async () => {
    const res = await put({ map: [{ group: "staff", role: "member" }, { group: "leads", role: "owner" }] });

    expect(res.status).toBe(200);
    expect(updateOne).toHaveBeenCalledWith({ _id: PROJECT, organisation: expect.anything() }, { $set: { groupRoleMap: [{ group: "staff", role: "member" }, { group: "leads", role: "owner" }] } });
    expect(logProjectAudit).toHaveBeenCalledWith(expect.anything(), PROJECT, "o1", "settings_updated", "Group roles: staff → member, leads → owner");
  });

  it("clears the mapping with an empty list, provider or not", async () => {
    providersFor.mockResolvedValue([]);

    expect((await put({ map: [] })).status).toBe(200);
    expect(logProjectAudit).toHaveBeenCalledWith(expect.anything(), PROJECT, "o1", "settings_updated", "Group roles: none");
  });

  it("refuses a mapping where there is no provider to read groups from", async () => {
    providersFor.mockResolvedValue([{ id: "google" }]);

    const res = await put({ map: [{ group: "staff", role: "member" }] });

    expect(res.status).toBe(400);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("refuses what the parser refuses", async () => {
    expect((await put({ map: [{ group: "staff", role: "admin" }] })).status).toBe(400);
    expect((await put({ map: [{ group: "a", role: "member" }, { group: "a", role: "owner" }] })).status).toBe(400);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("is refused for somebody who does not own the board", async () => {
    check.mockResolvedValue(false);

    expect((await put({ map: [] })).status).toBe(403);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("in the cloud is part of Pro: the 402 the page upsells on on Free, the mapping stored on Pro and the trial", async () => {
    process.env.ORGANISATION_DOMAIN = "board.example";
    plan({ plan: "free" });
    const refused = await put({ map: [{ group: "staff", role: "member" }] });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ feature: "identity.sso" });
    expect(updateOne).not.toHaveBeenCalled();

    plan();
    expect((await put({ map: [{ group: "staff", role: "member" }] })).status).toBe(200);
  });

  it("404s for a project that is gone", async () => {
    updateOne.mockResolvedValue({ matchedCount: 0 });

    expect((await put({ map: [] })).status).toBe(404);
  });
});
