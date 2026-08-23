import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const notificationFind = vi.fn();
const grantFind = vi.fn();

const READER = "507f1f77bcf86cd799439011";
const REACHABLE = "69a52e3b399b27d3cbb2c5a5";
const LOST = "69a52e3b399b27d3cbb2c5a6";

let grantedProjects: string[] = [];

vi.mock("@/lib/auth", () => ({ getAuthUser }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/grant", () => ({
  Grant: {
    find: (...a: unknown[]) => {
      grantFind(...a);
      return { select: () => ({ lean: async () => grantedProjects.map((id) => ({ object: id })) }) };
    },
  },
}));
vi.mock("@/models/user", () => ({ User: { find: () => ({ select: () => ({ lean: async () => [] }) }) } }));
vi.mock("@/models/notification", () => ({
  Notification: { find: (...a: unknown[]) => (notificationFind(...a), chain(ROWS)) },
}));

const ROWS = [{ _id: "n1", title: "New comment on BP-142" }];

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  for (const method of ["sort", "limit", "populate"]) c[method] = () => c;
  return c;
}

const { GET } = await import("./route");

const request = () => new Request("https://app.example.com/api/notifications");
const noParams = { params: Promise.resolve({}) };

function filterUsed() {
  return notificationFind.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

// BP-328. The rows were written before the grant was revoked, so filtering only the write path
// leaves everything already banked readable through a session that is still valid.
describe("GET /api/notifications", () => {
  beforeEach(() => {
    getAuthUser.mockReset();
    notificationFind.mockClear();
    grantFind.mockClear();
    grantedProjects = [REACHABLE];
    getAuthUser.mockImplementation(async () => ({ _id: READER, role: "member" }));
  });

  it("constrains the feed to the projects the reader can still reach", async () => {
    grantedProjects = [REACHABLE];

    const res = await GET(request(), noParams);

    expect(res.status).toBe(200);
    expect(filterUsed().project).toEqual({ $in: [REACHABLE] });
  });

  it("does not offer a project whose grant is gone", async () => {
    grantedProjects = [REACHABLE];

    await GET(request(), noParams);

    expect((filterUsed().project as { $in: string[] }).$in).not.toContain(LOST);
  });

  it("returns an empty feed to a reader who holds no grant anywhere", async () => {
    grantedProjects = [];

    const res = await GET(request(), noParams);

    expect(await res.json()).toEqual([]);
  });

  it("leaves an instance admin's feed unconstrained, since they reach every board", async () => {
    getAuthUser.mockImplementation(async () => ({ _id: READER, role: "admin" }));

    await GET(request(), noParams);

    expect(filterUsed()).not.toHaveProperty("project");
  });

  it("still keys the feed on the reader", async () => {
    await GET(request(), noParams);

    expect(filterUsed().recipient).toBe(READER);
  });
});
