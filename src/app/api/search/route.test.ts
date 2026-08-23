import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const accessibleProjectIds = vi.fn();
const taskFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ accessibleProjectIds }));
vi.mock("@/models/task", () => ({ Task: { find: taskFind } }));
vi.mock("@/models/project", () => ({ Project: {} }));

const { GET } = await import("./route");

const MEMBER = { _id: "u1", role: "member" };
const ADMIN = { _id: "a1", role: "admin" };
const ALLOWED = ["p1", "p2"];

const ctx = () => ({ params: Promise.resolve({}) });
const search = (q: string) =>
  GET(new Request(`http://localhost/api/search?q=${encodeURIComponent(q)}`), ctx());

/**
 * Records what reached the database rather than what came back, because the question these tests
 * answer is where the narrowing happens — not whether the answer looks right for a corpus of five.
 */
let lastQuery: { filter: unknown; limit?: number; sorted?: unknown };

function chain(rows: unknown[]) {
  const self = {
    populate: () => self,
    sort: (spec: unknown) => {
      lastQuery.sorted = spec;
      return self;
    },
    limit: (n: number) => {
      lastQuery.limit = n;
      return self;
    },
    lean: () => Promise.resolve(rows),
  };
  return self;
}

beforeEach(() => {
  vi.clearAllMocks();
  lastQuery = { filter: undefined };
  getAuthUser.mockResolvedValue(MEMBER);
  accessibleProjectIds.mockResolvedValue(ALLOWED);
  taskFind.mockImplementation((filter: unknown) => {
    lastQuery.filter = filter;
    return chain([]);
  });
});

describe("GET /api/search", () => {
  it("refuses a query below the floor without asking the database", async () => {
    const response = await search("z");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(taskFind).not.toHaveBeenCalled();
  });

  it("narrows a member to their own projects", async () => {
    await search("zeppelin");

    expect(lastQuery.filter).toMatchObject({ project: { $in: ALLOWED } });
  });

  it("leaves an instance admin unfiltered", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    await search("zeppelin");

    expect(lastQuery.filter).not.toHaveProperty("project");
    expect(accessibleProjectIds).not.toHaveBeenCalled();
  });

  /**
   * A member whose grants resolve to nothing must match nothing. The `?? []` in the route is what
   * makes that true: an undefined project filter would be no filter at all, which is the whole
   * instance.
   */
  it("gives a member with no accessible projects an empty set, not every project", async () => {
    accessibleProjectIds.mockResolvedValue(null);

    await search("zeppelin");

    expect(lastQuery.filter).toMatchObject({ project: { $in: [] } });
  });

  /**
   * The 50-row cap is only safe because the grant filter is inside the same query: the database
   * narrows first and spends the fifty slots on rows this reader may see. Move the filtering into
   * a `.filter()` after the query — a refactor that looks harmless — and the cap starts being
   * spent on other people's tasks, silently truncating the reader's own. No corpus small enough
   * to run in an e2e can show that, which is why it is asserted here instead.
   */
  it("applies the cap to the already-narrowed query", async () => {
    await search("zeppelin");

    expect(lastQuery.limit).toBe(50);
    expect(lastQuery.filter).toMatchObject({ project: { $in: ALLOWED } });
    expect(taskFind).toHaveBeenCalledTimes(1);
  });

  it("carries the same filter into the task-key branch", async () => {
    await search("TP-10");

    expect(lastQuery.filter).toMatchObject({ project: { $in: ALLOWED }, taskNumber: 10 });
  });

  it("keeps a task whose number matches but whose project key does not", async () => {
    taskFind.mockImplementation((filter: unknown) => {
      lastQuery.filter = filter;
      return chain([
        { _id: "t1", taskNumber: 1, priority: "high", project: { key: "TP", name: "Ours" } },
        { _id: "t2", taskNumber: 1, priority: "high", project: { key: "SB", name: "Theirs" } },
      ]);
    });

    const body = await (await search("TP-1")).json();

    expect(body).toHaveLength(1);
    expect(body[0]._id).toBe("t1");
  });

  it("escapes regex metacharacters instead of running them", async () => {
    await search(".*");

    const filter = lastQuery.filter as { $or: { title: { $regex: string } }[] };
    expect(filter.$or[0].title.$regex).toBe("\\.\\*");
  });

  it("applies the priority default a lean read skips", async () => {
    taskFind.mockImplementation(() =>
      chain([{ _id: "t1", taskNumber: 1, project: { key: "TP", name: "Ours" } }])
    );

    const body = await (await search("zeppelin")).json();

    expect(body[0].priority).toBe("medium");
  });
});
