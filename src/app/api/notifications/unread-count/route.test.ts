import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const countDocuments = vi.fn(async (_filter?: unknown) => 3);
const grantFind = vi.fn();

const READER = "507f1f77bcf86cd799439011";
const REACHABLE = "69a52e3b399b27d3cbb2c5a5";
const ALSO_REACHABLE = "69a52e3b399b27d3cbb2c5a7";

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
  Notification: { countDocuments: (filter: unknown) => countDocuments(filter) },
}));

const { GET } = await import("./route");

const request = () => new Request("https://app.example.com/api/notifications/unread-count");
const noParams = { params: Promise.resolve({}) };

function filterUsed() {
  return countDocuments.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("GET /api/notifications/unread-count", () => {
  beforeEach(() => {
    getAuthUser.mockReset();
    countDocuments.mockClear();
    grantedProjects = [REACHABLE, ALSO_REACHABLE];
    getAuthUser.mockImplementation(async () => ({ _id: READER, role: "member" }));
  });

  it("counts every project the reader can still reach, not just one", async () => {
    const res = await GET(request(), noParams);

    expect(res.status).toBe(200);
    expect(filterUsed().project).toEqual({ $in: [REACHABLE, ALSO_REACHABLE] });
  });

  it("counts nothing for a reader who holds no grant anywhere", async () => {
    grantedProjects = [];

    const res = await GET(request(), noParams);

    expect(await res.json()).toEqual({ count: 0 });
    expect(countDocuments).not.toHaveBeenCalled();
  });

  it("leaves an instance admin's count unconstrained", async () => {
    getAuthUser.mockImplementation(async () => ({ _id: READER, role: "admin" }));

    await GET(request(), noParams);

    expect(filterUsed()).not.toHaveProperty("project");
  });

  it("still counts only unread rows addressed to the reader", async () => {
    await GET(request(), noParams);

    expect(filterUsed().recipient).toBe(READER);
    expect(filterUsed().read).toBe(false);
  });
});
