import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAuthUser, logInstanceAudit, getOrganisation, renameOrganisation, nameUnavailable, nameChecksSpent, organisationOrigin, memberLimitOf } = vi.hoisted(() => ({
  nameUnavailable: vi.fn(),
  nameChecksSpent: vi.fn(),
  memberLimitOf: vi.fn(),
  getAuthUser: vi.fn(),
  logInstanceAudit: vi.fn(),
  getOrganisation: vi.fn(),
  renameOrganisation: vi.fn(),
  organisationOrigin: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/member-limit", async (original) => ({ ...(await original<typeof import("@/lib/member-limit")>()), memberLimitOf }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/organisation", async (original) => ({
  ...(await original<typeof import("@/lib/organisation")>()),
  getOrganisation,
  renameOrganisation,
  nameUnavailable,
  nameChecksSpent,
}));
vi.mock("@/lib/organisation-host", async (original) => ({
  ...(await original<typeof import("@/lib/organisation-host")>()),
  organisationOrigin,
}));

const { GET, PUT } = await import("./route");
const { User } = await import("@/models/user");
const { Project } = await import("@/models/project");
const { Invitation } = await import("@/models/invitation");
const { DEFAULT_ORGANISATION_ID } = await import("@/lib/organisation-field");

const ADMIN = { _id: "admin-1", username: "root", role: "admin", viaMachineCredential: false };
const MEMBER = { _id: "member-1", username: "pat", role: "member", viaMachineCredential: false };

const call = (handler: typeof GET, method: string, body?: unknown) =>
  handler(
    new Request("http://localhost/api/organisation", {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );

let countUsers: { mock: unknown };
let countProjects: { mock: unknown };

beforeEach(() => {
  vi.clearAllMocks();
  organisationOrigin.mockResolvedValue("https://planner.example.org");
  getOrganisation.mockResolvedValue({ _id: DEFAULT_ORGANISATION_ID, name: "Acme", entitlements: { plan: "pro", features: [] } });
  countUsers = vi.spyOn(User, "countDocuments").mockResolvedValue(4 as never);
  countProjects = vi.spyOn(Project, "countDocuments").mockResolvedValue(2 as never);
  vi.spyOn(Invitation, "countDocuments").mockResolvedValue(3 as never);
  memberLimitOf.mockResolvedValue(null);
  nameUnavailable.mockResolvedValue(false);
  nameChecksSpent.mockResolvedValue(false);
});

describe("GET /api/organisation (BP-920)", () => {
  it("tells a member the name, address and plan, and counts nothing for them", async () => {
    getAuthUser.mockResolvedValue(MEMBER);

    const res = await call(GET, "GET");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Acme", named: true, cloud: false, address: "planner.example.org", plan: "pro", planEndsAt: null, trial: false, subscription: null });
    expect(countUsers).not.toHaveBeenCalled();
    expect(countProjects).not.toHaveBeenCalled();
  });

  it("tells everyone when a Pro licence ends, and nothing of the date on Free", async () => {
    getAuthUser.mockResolvedValue(MEMBER);
    const expiresAt = new Date("2026-11-05T23:59:59.000Z");
    getOrganisation.mockResolvedValue({ _id: DEFAULT_ORGANISATION_ID, name: "Acme", entitlements: { plan: "pro", features: [], expiresAt } });
    expect((await (await call(GET, "GET")).json()).planEndsAt).toBe("2026-11-05T23:59:59.000Z");

    getOrganisation.mockResolvedValue({ _id: DEFAULT_ORGANISATION_ID, name: "Acme", entitlements: { plan: "free", features: [], expiresAt } });
    expect((await (await call(GET, "GET")).json()).planEndsAt).toBeNull();
  });

  it("says a plan is a trial, so the badge shows no grace and the screen says what it is", async () => {
    getAuthUser.mockResolvedValue(MEMBER);
    const expiresAt = new Date("2026-11-05T23:59:59.000Z");
    getOrganisation.mockResolvedValue({ _id: DEFAULT_ORGANISATION_ID, name: "Acme", entitlements: { plan: "pro", features: [], expiresAt, trial: true } });
    expect((await (await call(GET, "GET")).json()).trial).toBe(true);

    getOrganisation.mockResolvedValue({ _id: DEFAULT_ORGANISATION_ID, name: "Acme", entitlements: { plan: "free", features: [], expiresAt, trial: true } });
    expect((await (await call(GET, "GET")).json()).trial).toBe(false);
  });

  // BP-983: the badge and the licence page read whether a subscription renews or was cancelled
  it("says whether a subscription renews or was cancelled, for Pro only", async () => {
    getAuthUser.mockResolvedValue(MEMBER);
    const expiresAt = new Date("2026-11-05T23:59:59.000Z");
    for (const subscription of ["renewing", "ending"] as const) {
      getOrganisation.mockResolvedValue({ _id: DEFAULT_ORGANISATION_ID, name: "Acme", entitlements: { plan: "pro", features: [], expiresAt, subscription } });
      expect((await (await call(GET, "GET")).json()).subscription).toBe(subscription);
    }

    getOrganisation.mockResolvedValue({ _id: DEFAULT_ORGANISATION_ID, name: "Acme", entitlements: { plan: "pro", features: [], expiresAt } });
    expect((await (await call(GET, "GET")).json()).subscription).toBeNull();
    getOrganisation.mockResolvedValue({ _id: DEFAULT_ORGANISATION_ID, name: "Acme", entitlements: { plan: "free", features: [], expiresAt, subscription: "renewing" } });
    expect((await (await call(GET, "GET")).json()).subscription).toBeNull();
  });

  it("gives an admin the people and boards, counted in their own organisation only", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const body = await (await call(GET, "GET")).json();

    expect(body).toMatchObject({ members: 4, projects: 2, memberLimit: null, invited: 3 });
    expect(countUsers).toHaveBeenCalledWith(expect.objectContaining({ organisation: DEFAULT_ORGANISATION_ID, kind: { $ne: "machine" }, deactivatedAt: null }));
    expect(countProjects).toHaveBeenCalledWith(expect.objectContaining({ organisation: DEFAULT_ORGANISATION_ID }));
  });

  // BP-948: the admin banner reads these; a member is told none of it
  it("tells an admin of a Free cloud organisation its member limit and how many are invited, and a member nothing of it", async () => {
    memberLimitOf.mockResolvedValue(10);

    getAuthUser.mockResolvedValue(ADMIN);
    expect(await (await call(GET, "GET")).json()).toMatchObject({ memberLimit: 10, invited: 3 });

    getAuthUser.mockResolvedValue(MEMBER);
    const asMember = await (await call(GET, "GET")).json();
    expect(asMember).not.toHaveProperty("memberLimit");
    expect(asMember).not.toHaveProperty("invited");
  });

  it("calls a self-hosted organisation nobody named unnamed", async () => {
    getAuthUser.mockResolvedValue(MEMBER);
    getOrganisation.mockResolvedValue({ _id: DEFAULT_ORGANISATION_ID, name: "default", entitlements: { plan: "free", features: [] } });

    expect(await (await call(GET, "GET")).json()).toMatchObject({ named: false, cloud: false, plan: "free" });
  });
});

describe("PUT /api/organisation (BP-920)", () => {
  it("renames the caller's organisation and records who did it, from what to what", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const res = await call(PUT, "PUT", { name: "  Acme Corp  " });

    expect(res.status).toBe(200);
    expect(renameOrganisation).toHaveBeenCalledWith(DEFAULT_ORGANISATION_ID, "Acme Corp");
    expect(logInstanceAudit).toHaveBeenCalledWith(expect.anything(), {
      action: "organisation_renamed",
      user: "admin-1",
      actorUsername: "root",
      detail: "Acme → Acme Corp",
    });
  });

  it("writes and records nothing when the name is the one it already has", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    expect((await call(PUT, "PUT", { name: "Acme" })).status).toBe(200);
    expect(renameOrganisation).not.toHaveBeenCalled();
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["a member", MEMBER, { name: "Mine now" }, 403],
    ["an admin's machine credential", { ...ADMIN, viaMachineCredential: true }, { name: "Mine now" }, 403],
    ["an empty name", ADMIN, { name: "   " }, 400],
    ["no name at all", ADMIN, {}, 400],
    ["a name that is not a string", ADMIN, { name: 7 }, 400],
    ["a name over 80 characters", ADMIN, { name: "x".repeat(81) }, 400],
  ])("refuses %s and renames nothing", async (_case, caller, body, status) => {
    getAuthUser.mockResolvedValue(caller);

    expect((await call(PUT, "PUT", body)).status).toBe(status);
    expect(renameOrganisation).not.toHaveBeenCalled();
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("refuses a name that is not available with 409, renames and records nothing, and asks about every organisation but its own (BP-1010)", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    nameUnavailable.mockResolvedValue(true);

    const res = await call(PUT, "PUT", { name: "  Globex " });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "That name is not available. Try another." });
    expect(nameUnavailable).toHaveBeenCalledWith("Globex", DEFAULT_ORGANISATION_ID);
    expect(renameOrganisation).not.toHaveBeenCalled();
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("answers 429 once an organisation has tried ten names in an hour, and neither looks up nor renames (BP-1010)", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    nameChecksSpent.mockResolvedValue(true);

    const res = await call(PUT, "PUT", { name: "Globex" });

    expect(res.status).toBe(429);
    expect(nameChecksSpent).toHaveBeenCalledWith(`organisation-rename:names:${DEFAULT_ORGANISATION_ID}`);
    expect(nameUnavailable).not.toHaveBeenCalled();
    expect(renameOrganisation).not.toHaveBeenCalled();
  });

  it("does not ask when the name is the one the organisation already has (BP-1010)", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    nameUnavailable.mockResolvedValue(true);

    expect((await call(PUT, "PUT", { name: "Acme" })).status).toBe(200);
    expect(nameUnavailable).not.toHaveBeenCalled();
    expect(nameChecksSpent).not.toHaveBeenCalled();
  });
});
