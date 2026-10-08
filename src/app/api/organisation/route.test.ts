import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAuthUser, logInstanceAudit, getOrganisation, renameOrganisation, organisationOrigin } = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  logInstanceAudit: vi.fn(),
  getOrganisation: vi.fn(),
  renameOrganisation: vi.fn(),
  organisationOrigin: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/organisation", async (original) => ({
  ...(await original<typeof import("@/lib/organisation")>()),
  getOrganisation,
  renameOrganisation,
}));
vi.mock("@/lib/organisation-host", async (original) => ({
  ...(await original<typeof import("@/lib/organisation-host")>()),
  organisationOrigin,
}));

const { GET, PUT } = await import("./route");
const { User } = await import("@/models/user");
const { Project } = await import("@/models/project");
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
});

describe("GET /api/organisation (BP-920)", () => {
  it("tells a member the name, address and plan, and counts nothing for them", async () => {
    getAuthUser.mockResolvedValue(MEMBER);

    const res = await call(GET, "GET");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Acme", named: true, cloud: false, address: "planner.example.org", plan: "pro", planEndsAt: null, trial: false });
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

  it("gives an admin the people and boards, counted in their own organisation only", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const body = await (await call(GET, "GET")).json();

    expect(body).toMatchObject({ members: 4, projects: 2 });
    expect(countUsers).toHaveBeenCalledWith(expect.objectContaining({ organisation: DEFAULT_ORGANISATION_ID, kind: { $ne: "machine" }, deactivatedAt: null }));
    expect(countProjects).toHaveBeenCalledWith(expect.objectContaining({ organisation: DEFAULT_ORGANISATION_ID }));
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
});
