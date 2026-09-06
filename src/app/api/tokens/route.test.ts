import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const accessibleProjectIds = vi.fn();
const projectFind = vi.fn();
const apiTokenCreate = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ accessibleProjectIds, check: vi.fn() }));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn().mockResolvedValue("bcrypt-hash") } }));
vi.mock("@/models/project", () => ({ Project: { find: projectFind } }));
vi.mock("@/models/apiToken", () => ({ ApiToken: { create: apiTokenCreate, find: vi.fn() } }));

const { POST } = await import("./route");

const EVERY_PROJECT = [{ _id: "p1" }, { _id: "p2" }];

function matching(filter: { _id?: { $in?: string[] } }) {
  const wanted = filter?._id?.$in;
  if (wanted === undefined) return EVERY_PROJECT;
  return EVERY_PROJECT.filter((p) => (wanted ?? []).includes(p._id));
}

const SCOPED_TO_P1 = {
  _id: "u1",
  role: "member",
  tokenScoped: true,
  tokenScope: ["p1"],
};
const INSTANCE_ADMIN = { _id: "a1", role: "admin" };

function request(body: unknown) {
  return new Request("http://localhost/api/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(SCOPED_TO_P1);
  accessibleProjectIds.mockResolvedValue(["p1"]);
  projectFind.mockImplementation((filter) => ({
    select: () => ({ lean: () => Promise.resolve(matching(filter)) }),
  }));
  apiTokenCreate.mockImplementation((doc) => Promise.resolve({ _id: "t1", createdAt: new Date(), ...doc }));
});

describe("POST /api/tokens", () => {
  it("refuses a scope reaching past what the grant layer allows", async () => {
    const response = await POST(request({ name: "ci", allowedProjects: ["p2"] }), ctx());

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/don't have access/);
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });

  it("mints a token for a project the grant layer allows", async () => {
    const response = await POST(request({ name: "ci", allowedProjects: ["p1"] }), ctx());

    expect(response.status).toBe(201);
    expect(apiTokenCreate.mock.calls[0][0].allowedProjects).toEqual(["p1"]);
  });

  it("lets an unrestricted principal scope to any project", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
    accessibleProjectIds.mockResolvedValue(null);

    const response = await POST(request({ name: "ci", allowedProjects: ["p2"] }), ctx());

    expect(response.status).toBe(201);
    expect(projectFind).toHaveBeenCalledWith({});
  });
});
