import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const accessibleProjectIds = vi.fn();
const taskFind = vi.fn();
const projectFindOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ accessibleProjectIds }));
vi.mock("@/models/task", () => ({ Task: { find: taskFind } }));
vi.mock("@/models/project", () => ({ Project: { findOne: projectFindOne } }));

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
/** What the key branch asked the projects collection, and what it was told */
let lastProjectQuery: unknown;
let foundProject: { _id: string } | null;

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
  lastProjectQuery = undefined;
  foundProject = { _id: "p1" };
  getAuthUser.mockResolvedValue(MEMBER);
  accessibleProjectIds.mockResolvedValue(ALLOWED);
  projectFindOne.mockImplementation((filter: unknown) => {
    lastProjectQuery = filter;
    return {
      select: () => ({ lean: () => Promise.resolve(foundProject) }),
    };
  });
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

  it("scopes the key branch to the board the key resolves to", async () => {
    await search("TP-10");

    expect(lastQuery.filter).toMatchObject({ project: "p1", taskNumber: 10 });
  });

  // BP-573. A key may hold digits, hyphens and underscores and run to twenty characters — the
  // search regex allowed letters only, and ten. Each of these used to fall through to the text
  // search, which cannot match a key at all: the key is never stored, it is built for display.
  it.each([
    ["digits", "BP2-14", "BP2"],
    ["a hyphen", "BP-2-14", "BP-2"],
    ["an underscore", "BP_2-14", "BP_2"],
    ["more than ten characters", "PLATFORM_TEAM-14", "PLATFORM_TEAM"],
  ])("recognises a key with %s", async (_label, query, key) => {
    await search(query);

    expect(lastQuery.filter).toMatchObject({ project: "p1", taskNumber: 14 });
    const asked = lastProjectQuery as { $or: [{ key: RegExp }, { formerKeys: RegExp }] };
    expect(asked.$or[0].key.test(key), `the board was looked up by ${key}`).toBe(true);
  });

  it("finds a task by a key the board used to answer to", async () => {
    await search("CP-250");

    const asked = lastProjectQuery as { $or: { key?: RegExp; formerKeys?: RegExp }[] };
    expect(asked.$or.map((clause) => Object.keys(clause)[0])).toEqual(["key", "formerKeys"]);
    expect(asked.$or[1].formerKeys!.test("cp")).toBe(true);
    expect(lastQuery.filter).toMatchObject({ project: "p1", taskNumber: 250 });
  });

  // The key branch names the project directly, which would otherwise replace the access filter
  it("finds nothing when the key resolves to a board the reader cannot see", async () => {
    foundProject = { _id: "p9" };

    const body = await (await search("SB-1")).json();

    expect(body).toEqual([]);
    expect(taskFind).not.toHaveBeenCalled();
  });

  it("leaves an admin's key search unscoped by grants", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    foundProject = { _id: "p9" };

    await search("SB-1");

    expect(lastQuery.filter).toMatchObject({ project: "p9", taskNumber: 1 });
  });

  // The control: what is not a key must still be searched as words
  it.each([
    ["a key-shaped string naming no board", "ZZ-1"],
    ["a prefix the rule does not allow", "9BP-1"],
    ["a number with no key", "-14"],
  ])("falls back to the text search for %s", async (_label, query) => {
    foundProject = null;

    await search(query);

    expect(lastQuery.filter).toHaveProperty("$or");
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
