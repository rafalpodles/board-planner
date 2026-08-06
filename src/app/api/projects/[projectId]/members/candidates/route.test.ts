import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const connectDB = vi.fn();
const grantFind = vi.fn();
const grantFindLean = vi.fn();
const userFind = vi.fn();
const userFindSort = vi.fn();
const userFindLimit = vi.fn();
const userFindLean = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/grants")>();
  return { ...actual, check, accessibleProjectIds: vi.fn() };
});
vi.mock("@/models/grant", () => ({
  Grant: {
    find: (...a: unknown[]) => (grantFind(...a), { select: () => ({ lean: grantFindLean }) }),
  },
}));
vi.mock("@/models/user", () => ({
  User: {
    find: (...a: unknown[]) =>
      (userFind(...a), {
        select: () => ({
          sort: (...b: unknown[]) => (
            userFindSort(...b),
            { limit: (...c: unknown[]) => (userFindLimit(...c), { lean: userFindLean }) }
          ),
        }),
      }),
  },
}));
vi.mock("@/models/project", () => ({ Project: { findOne: vi.fn() } }));
vi.mock("@/models/task", () => ({ Task: {} }));

const { GET } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const params = Promise.resolve({ projectId: PROJECT });

function req(q: string) {
  return new Request(
    `http://x/api/projects/${PROJECT}/members/candidates?q=${encodeURIComponent(q)}`
  );
}

function expectedFilter(over: { nin?: string[]; pattern?: RegExp } = {}) {
  const pattern = over.pattern ?? new RegExp("ann", "i");
  return {
    kind: { $ne: "machine" },
    _id: { $nin: over.nin ?? [] },
    $or: [{ username: pattern }, { fullName: pattern }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "o1", role: "member" });
  check.mockResolvedValue(true);
  grantFindLean.mockResolvedValue([]);
  userFindLean.mockResolvedValue([]);
});

describe("GET member candidates", () => {
  it("returns [] without touching the database when q is under 2 characters after trimming", async () => {
    const res = await GET(req(" a "), { params });
    expect(await res.json()).toEqual([]);
    expect(connectDB).not.toHaveBeenCalled();
    expect(grantFind).not.toHaveBeenCalled();
    expect(userFind).not.toHaveBeenCalled();
  });

  it("escapes regex metacharacters in q instead of treating them as wildcards", async () => {
    await GET(req(".*"), { params });
    const pattern = new RegExp("\\.\\*", "i");
    expect(userFind).toHaveBeenCalledWith(expectedFilter({ pattern }));
  });

  it("builds the match pattern from the trimmed query, not the raw input", async () => {
    await GET(req("  dee  "), { params });
    expect(userFind).toHaveBeenCalledWith(expectedFilter({ pattern: new RegExp("dee", "i") }));
  });

  it("excludes machine identities from candidates", async () => {
    await GET(req("ann"), { params });
    expect(userFind).toHaveBeenCalledWith(expectedFilter());
  });

  it("excludes users who already hold a grant on this project", async () => {
    grantFindLean.mockResolvedValue([{ subject: "u9" }]);
    await GET(req("ann"), { params });
    expect(userFind).toHaveBeenCalledWith(expectedFilter({ nin: ["u9"] }));
  });

  it("scopes the grant lookup used for exclusion to this project", async () => {
    await GET(req("ann"), { params });
    expect(grantFind).toHaveBeenCalledWith({ objectType: "project", object: PROJECT });
  });

  it("caps results at 10", async () => {
    await GET(req("ann"), { params });
    expect(userFindLimit).toHaveBeenCalledWith(10);
  });

  it("returns candidates as _id, username, fullName only — no relation or instanceAdmin", async () => {
    userFindLean.mockResolvedValue([{ _id: "u5", username: "dee", fullName: "Dee D" }]);
    const body = await (await GET(req("dee"), { params })).json();
    expect(body).toEqual([{ _id: "u5", username: "dee", fullName: "Dee D" }]);
  });

  it("checks owner-level access, not merely project membership", async () => {
    await GET(req("ann"), { params });
    expect(check).toHaveBeenCalledWith({ _id: "o1", role: "member" }, PROJECT, "admin");
  });

  it("refuses anyone who is not an owner of this project", async () => {
    check.mockResolvedValue(false);
    const res = await GET(req("ann"), { params });
    expect(res.status).toBe(403);
    expect(userFind).not.toHaveBeenCalled();
  });
});
