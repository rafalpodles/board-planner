import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_SAVED_VIEWS, MAX_SAVED_VIEWS_PER_PERSON, MAX_SHARED_VIEWS } from "@/lib/identifiers";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectFindOne = vi.fn();
const projectFindOneAndUpdate = vi.fn();
const projectUpdateOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/project", () => ({
  Project: { findOne: projectFindOne, findOneAndUpdate: projectFindOneAndUpdate, updateOne: projectUpdateOne },
}));

const { GET, POST, PUT, DELETE } = await import("./route");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const ME = "507f1f77bcf86cd799439021";
const OTHER = "507f1f77bcf86cd799439022";
const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });

interface Row {
  _id: { toString: () => string };
  name: string;
  owner: { toString: () => string };
  shared: boolean;
  [key: string]: unknown;
}

let seq = 0;
const vid = (n: number) => `507f1f77bcf86cd7994390${String(n).padStart(2, "0")}`;
const row = (name: string, owner: string, shared = false): Row => ({
  _id: { toString: ((n) => () => vid(n))(++seq) },
  name,
  owner: { toString: () => owner },
  shared,
  filters: {},
  search: "",
  sortField: "manual",
  sortDir: "asc",
  viewMode: "board",
  groupBy: "",
  sprintScope: "all",
  hiddenColumns: [],
});

let stored: Row[];

/** A query that answers the same document whether it is awaited or read with select/lean */
function query(doc: unknown) {
  const q: Record<string, unknown> = {
    select: () => q,
    lean: () => Promise.resolve(doc),
    then: (resolve: (value: unknown) => unknown) => resolve(doc),
  };
  return q;
}

// The ids come back from a lean read as ObjectIds, not strings
const board = () => ({
  customFields: [
    {
      _id: { toString: () => "f-size" },
      name: "Size",
      fieldType: "dropdown",
      filterable: true,
      showInList: true,
      archived: false,
      options: [{ id: "s", value: "S", order: 0 }],
    },
  ],
  categories: [{ name: "bug" }],
});

type Id = { toString: () => string };
type Elem = { _id?: Id; owner?: Id; shared?: boolean; name?: { $regex: string }; [key: string]: unknown };

const sameId = (a: Id | undefined, b: Id | undefined) => !!a && !!b && a.toString() === b.toString();

function elemMatches(v: Row, cond: Elem): boolean {
  if (cond._id && "$ne" in (cond._id as object)) {
    if (sameId(v._id, (cond._id as unknown as { $ne: Id }).$ne)) return false;
  } else if (cond._id && !sameId(v._id, cond._id)) return false;
  if (cond.owner && !sameId(v.owner, cond.owner)) return false;
  if (cond.shared !== undefined && v.shared !== cond.shared) return false;
  if (cond.name && !new RegExp(cond.name.$regex, "i").test(v.name)) return false;
  return true;
}

/** Applies the conditions on `savedViews` the way the database would: an $elemMatch, or its negation */
function savedViewsCondition(cond: { $elemMatch?: Elem; $not?: { $elemMatch: Elem } }): boolean {
  if (cond.$elemMatch) return stored.some((v) => elemMatches(v, cond.$elemMatch!));
  if (cond.$not) return !stored.some((v) => elemMatches(v, cond.$not!.$elemMatch));
  return true;
}

/** `$lt: [ {$size: {$filter: {cond}}}, limit ]`, counted over the stored views */
function ceilingHolds(lt: [{ $size: { $filter: { cond: { $eq: [string, unknown] } } } }, number]): boolean {
  const [path, wanted] = lt[0].$size.$filter.cond.$eq;
  const count = stored.filter((v) =>
    path === "$$view.owner" ? sameId(v.owner, wanted as Id) : v.shared === wanted
  ).length;
  return count < lt[1];
}

/**
 * Every write on a view is one atomic update whose filter carries the ceilings, the name and the
 * view's identity. This applies that filter the way the database would, one request at a time, so
 * a stampede of them can be counted and a write that lands after the list shifted can be checked.
 */
function atomicPush(filter: Record<string, unknown>, update: { $push: { savedViews: Record<string, unknown> } }) {
  if (`savedViews.${MAX_SAVED_VIEWS - 1}` in filter && stored.length >= MAX_SAVED_VIEWS) return null;
  const expr = filter.$expr as { $and: { $lt: never }[] };
  if (!expr.$and.every((c) => ceilingHolds(c.$lt))) return null;
  if (!savedViewsCondition(filter.savedViews as never)) return null;
  const pushed = update.$push.savedViews;
  const added = { ...row("", String((pushed.owner as Id).toString())), ...pushed, _id: { toString: ((n) => () => vid(n))(++seq) } } as Row;
  stored = [...stored, added];
  return { savedViews: stored };
}

let beforeWrite: (() => void) | null = null;

function atomicSet(
  filter: { $and: { savedViews: never }[] },
  update: { $set: Record<string, unknown> },
  options: { arrayFilters: { "view._id": Id }[] }
) {
  beforeWrite?.();
  beforeWrite = null;
  if (!filter.$and.every((c) => savedViewsCondition(c.savedViews))) return null;
  const target = options.arrayFilters[0]["view._id"];
  for (const v of stored) {
    if (!sameId(v._id, target)) continue;
    for (const [path, value] of Object.entries(update.$set)) v[path.replace("savedViews.$[view].", "")] = value;
  }
  return { savedViews: stored };
}

function call(verb: typeof POST, method: string, body?: unknown) {
  return verb(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/views`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ctx()
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  stored = [];
  getAuthUser.mockResolvedValue({ _id: ME, role: "member" });
  check.mockImplementation(async (_db: unknown, _user: unknown, _id: unknown, level: string) => level === "access");
  projectFindOne.mockImplementation(() => {
    const doc = { _id: PROJECT_ID, ...board(), savedViews: stored, save: async () => {} };
    return query(doc);
  });
  beforeWrite = null;
  projectFindOneAndUpdate.mockImplementation(async (filter: Record<string, unknown>, update: never, options: never) =>
    "$push" in (update as object) ? atomicPush(filter, update) : atomicSet(filter as never, update, options)
  );
  projectUpdateOne.mockImplementation(
    async (_filter: unknown, update: { $pull: { savedViews: Elem & { $or?: Elem[] } } }) => {
      const cond = update.$pull.savedViews;
      stored = stored.filter((v) => {
        const hit = cond.$or ? cond.$or.some((c) => elemMatches(v, c)) : true;
        return !(sameId(v._id, cond._id) && hit && elemMatches(v, { owner: cond.owner }));
      });
    }
  );
});

const asOwner = () => check.mockResolvedValue(true);

describe("GET /views", () => {
  it("lists the reader's personal views and every shared one, and nobody else's personal ones", async () => {
    stored = [row("Mine", ME), row("Theirs", OTHER), row("Team", OTHER, true)];

    const body = (await (await call(GET, "GET")).json()) as { name: string; mine: boolean; canEdit: boolean }[];

    expect(body.map((v) => v.name)).toEqual(["Mine", "Team"]);
    expect(body.find((v) => v.name === "Team")).toMatchObject({ mine: false, canEdit: false });
    expect(body.find((v) => v.name === "Mine")).toMatchObject({ mine: true, canEdit: true });
  });

  it("lets a project owner change a shared view that is not theirs", async () => {
    asOwner();
    stored = [row("Team", OTHER, true), row("Theirs", OTHER)];

    const body = (await (await call(GET, "GET")).json()) as { name: string; canEdit: boolean }[];

    expect(body).toEqual([expect.objectContaining({ name: "Team", canEdit: true })]);
  });
});

describe("POST /views", () => {
  it("saves a personal view for a member and answers with it", async () => {
    const res = await call(POST, "POST", { name: " Stale bugs ", filters: { priority: "high" }, viewMode: "list" });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      name: "Stale bugs",
      shared: false,
      mine: true,
      viewMode: "list",
      filters: expect.objectContaining({ priority: "high" }),
    });
    expect(stored).toHaveLength(1);
  });

  it("keeps a member from sharing, and lets a project owner", async () => {
    const refused = await call(POST, "POST", { name: "For all", shared: true });
    expect(refused.status).toBe(403);
    expect(stored).toHaveLength(0);

    asOwner();
    const allowed = await call(POST, "POST", { name: "For all", shared: true });
    expect(allowed.status).toBe(201);
    expect(stored[0].shared).toBe(true);
  });

  it("refuses a name that is blank, over-long, not text, or a shared flag that is not a boolean", async () => {
    expect((await call(POST, "POST", {})).status).toBe(400);
    expect((await call(POST, "POST", { name: "  " })).status).toBe(400);
    expect((await call(POST, "POST", { name: "x".repeat(101) })).status).toBe(400);
    expect((await call(POST, "POST", { name: "ok", shared: "yes" })).status).toBe(400);
    expect((await call(POST, "POST", { name: "ok", viewMode: "gantt" })).status).toBe(400);
    expect(stored).toHaveLength(0);
  });

  it("refuses a second personal view with the same name, whatever the case, but not another person's", async () => {
    stored = [row("Mine", ME), row("Shared name", OTHER)];

    expect((await call(POST, "POST", { name: "mine" })).status).toBe(409);
    expect((await call(POST, "POST", { name: "shared name" })).status).toBe(201);
  });

  it("refuses a second shared view with the same name", async () => {
    asOwner();
    stored = [row("Team", OTHER, true)];

    expect((await call(POST, "POST", { name: "team", shared: true })).status).toBe(409);
  });

  it("holds a person to their own ceiling and says so", async () => {
    stored = Array.from({ length: MAX_SAVED_VIEWS_PER_PERSON }, (_, i) => row(`View ${i}`, ME));

    const res = await call(POST, "POST", { name: "One too many" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most/);
    expect((await call(POST, "POST", { name: "Someone else may still" })).status).toBe(400);
  });

  it("holds the project to its ceiling for personal views", async () => {
    stored = Array.from({ length: MAX_SAVED_VIEWS }, (_, i) => row(`View ${i}`, `owner-${i}`));

    const res = await call(POST, "POST", { name: "One too many" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(String(MAX_SAVED_VIEWS));
  });

  it("keeps a ceiling of its own for shared views, which personal ones cannot use up", async () => {
    asOwner();
    stored = Array.from({ length: MAX_SAVED_VIEWS - 1 }, (_, i) => row(`Personal ${i}`, `owner-${i}`));
    expect((await call(POST, "POST", { name: "Shared still fits", shared: true })).status).toBe(201);

    stored = Array.from({ length: MAX_SHARED_VIEWS }, (_, i) => row(`Shared ${i}`, `owner-${i % 5}-${i}`, true));
    const res = await call(POST, "POST", { name: "One shared too many", shared: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(String(MAX_SHARED_VIEWS));
  });

  // The count is in the write's own filter, so many saves at once cannot all see room
  it("lets exactly the ceiling through when a person saves many at once", async () => {
    const results = await Promise.all(
      Array.from({ length: MAX_SAVED_VIEWS_PER_PERSON + 15 }, (_, i) => call(POST, "POST", { name: `Race ${i}` }))
    );

    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBe(MAX_SAVED_VIEWS_PER_PERSON);
    expect(stored).toHaveLength(MAX_SAVED_VIEWS_PER_PERSON);
  });

  it("puts the ceilings and the name in the write's own filter", async () => {
    await call(POST, "POST", { name: "Mine" });

    const [filter] = projectFindOneAndUpdate.mock.calls[0];
    expect(filter).toHaveProperty(`savedViews.${MAX_SAVED_VIEWS - 1}`);
    expect(filter).toHaveProperty("$expr");
    expect(filter).toHaveProperty("savedViews.$not.$elemMatch");
  });

  it("scopes the name to the person's own views, or to the shared ones", async () => {
    await call(POST, "POST", { name: "Mine" });
    expect(projectFindOneAndUpdate.mock.calls[0][0].savedViews.$not.$elemMatch).toMatchObject({ shared: false, owner: expect.anything() });

    asOwner();
    await call(POST, "POST", { name: "Team", shared: true });
    const scope = projectFindOneAndUpdate.mock.calls[1][0].savedViews.$not.$elemMatch;
    expect(scope).toMatchObject({ shared: true });
    expect(scope).not.toHaveProperty("owner");
  });

  it("keeps a filter, a grouping and a hidden column that name one of the project's fields", async () => {
    const body = await (
      await call(POST, "POST", {
        name: "By size",
        groupBy: "field:f-size",
        hiddenColumns: ["f-size"],
        filters: { fields: { "f-size": { value: "s" }, ghost: { value: "x" } } },
      })
    ).json();

    expect(body.filters.fields).toEqual({ "f-size": { value: "s" } });
    expect(body.groupBy).toBe("field:f-size");
    expect(body.hiddenColumns).toEqual(["f-size"]);
  });

  it("drops a filter on a category the project does not have", async () => {
    const body = await (await call(POST, "POST", { name: "Old", filters: { category: "gone", priority: "low" } })).json();

    expect(body.filters).toMatchObject({ category: "", priority: "low" });
  });
});

describe("PUT /views", () => {
  it("renames the reader's own view", async () => {
    stored = [row("Mine", ME)];

    const res = await call(PUT, "PUT", { viewId: vid(1), name: "Renamed" });

    expect(res.status).toBe(200);
    expect(stored[0].name).toBe("Renamed");
    expect(projectFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("replaces the stored state when a snapshot comes with it, and leaves it alone otherwise", async () => {
    stored = [row("Mine", ME)];

    await call(PUT, "PUT", { viewId: vid(1), name: "Mine" });
    expect(stored[0].viewMode).toBe("board");

    await call(PUT, "PUT", { viewId: vid(1), filters: { priority: "urgent" }, viewMode: "list" });
    expect(stored[0]).toMatchObject({ viewMode: "list", filters: expect.objectContaining({ priority: "urgent" }) });
  });

  it("answers 404 for another person's personal view, as for one that does not exist", async () => {
    stored = [row("Theirs", OTHER)];

    expect((await call(PUT, "PUT", { viewId: vid(1), name: "Mine now" })).status).toBe(404);
    expect((await call(PUT, "PUT", { viewId: "507f1f77bcf86cd799439099", name: "x" })).status).toBe(404);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a member a change to a shared view that is not theirs", async () => {
    stored = [row("Team", OTHER, true)];

    expect((await call(PUT, "PUT", { viewId: vid(1), name: "Mine now" })).status).toBe(403);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("lets only a project owner share or unshare", async () => {
    stored = [row("Mine", ME)];
    expect((await call(PUT, "PUT", { viewId: vid(1), shared: true })).status).toBe(403);
    expect(stored[0].shared).toBe(false);

    asOwner();
    expect((await call(PUT, "PUT", { viewId: vid(1), shared: true })).status).toBe(200);
    expect(stored[0].shared).toBe(true);
  });

  it("lets a project owner rename a shared view that is somebody else's", async () => {
    asOwner();
    stored = [row("Team", OTHER, true)];

    expect((await call(PUT, "PUT", { viewId: vid(1), name: "Whole team" })).status).toBe(200);
    expect(stored[0].name).toBe("Whole team");
  });

  it("refuses a name another of the same kind already has", async () => {
    stored = [row("A", ME), row("B", ME)];

    expect((await call(PUT, "PUT", { viewId: vid(2), name: "a" })).status).toBe(409);
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a bad id, name or flag", async () => {
    stored = [row("Mine", ME)];

    expect((await call(PUT, "PUT", { name: "x" })).status).toBe(400);
    expect((await call(PUT, "PUT", { viewId: "nope", name: "x" })).status).toBe(400);
    expect((await call(PUT, "PUT", { viewId: vid(1), name: " " })).status).toBe(400);
    expect((await call(PUT, "PUT", { viewId: vid(1), shared: 1 })).status).toBe(400);
  });
});

describe("PUT /views, as one write on the view's own id", () => {
  it("writes by the view's id with an array filter, never by its position", async () => {
    stored = [row("Mine", ME)];

    await call(PUT, "PUT", { viewId: vid(1), name: "Renamed", filters: { priority: "low" } });

    const [filter, update, options] = projectFindOneAndUpdate.mock.calls[0];
    expect(options.arrayFilters).toEqual([{ "view._id": expect.anything() }]);
    expect(Object.keys(update.$set).every((path) => path.startsWith("savedViews.$[view]."))).toBe(true);
    expect(filter.$and[0].savedViews.$elemMatch).toMatchObject({ _id: expect.anything(), owner: expect.anything() });
  });

  // The list can shift between the read and the write; a positional update would land on a neighbour
  it("still changes the right view when another one is removed between the read and the write", async () => {
    stored = [row("Somebody's", OTHER, true), row("Mine", ME), row("Theirs", OTHER)];
    beforeWrite = () => {
      stored = stored.slice(1);
    };

    const res = await call(PUT, "PUT", { viewId: vid(2), name: "Renamed" });

    expect(res.status).toBe(200);
    expect(stored.map((v) => [v.name, v.shared])).toEqual([["Renamed", false], ["Theirs", false]]);
  });

  it("answers 409 when the view was handed over or un-shared while the request was out", async () => {
    asOwner();
    stored = [row("Mine", ME)];
    beforeWrite = () => {
      stored[0].shared = true;
    };

    const res = await call(PUT, "PUT", { viewId: vid(1), name: "Renamed" });

    expect(res.status).toBe(409);
    expect(stored[0].name).toBe("Mine");
  });

  it("answers 409 for a name taken by another request in the meantime", async () => {
    stored = [row("Mine", ME)];
    beforeWrite = () => {
      stored.push(row("Renamed", ME));
    };

    expect((await call(PUT, "PUT", { viewId: vid(1), name: "Renamed" })).status).toBe(409);
    expect(stored[0].name).toBe("Mine");
  });

  it("does not let a project owner move somebody else's shared view back to personal", async () => {
    asOwner();
    stored = [row("Team", OTHER, true)];

    const res = await call(PUT, "PUT", { viewId: vid(1), shared: false });

    expect(res.status).toBe(403);
    expect(stored[0].shared).toBe(true);
  });
});

describe("DELETE /views", () => {
  it("removes the reader's own view", async () => {
    stored = [row("Mine", ME), row("Other", ME)];

    expect((await call(DELETE, "DELETE", { viewId: vid(1) })).status).toBe(200);
    expect(stored.map((v) => v.name)).toEqual(["Other"]);
  });

  it("keeps another person's views, whether personal (404) or shared and not the reader's (403)", async () => {
    stored = [row("Theirs", OTHER), row("Team", OTHER, true)];

    expect((await call(DELETE, "DELETE", { viewId: vid(1) })).status).toBe(404);
    expect((await call(DELETE, "DELETE", { viewId: vid(2) })).status).toBe(403);
    expect(stored).toHaveLength(2);
  });

  it("lets a project owner remove a shared view, but not somebody's personal one", async () => {
    asOwner();
    stored = [row("Team", OTHER, true), row("Theirs", OTHER)];

    expect((await call(DELETE, "DELETE", { viewId: vid(1) })).status).toBe(200);
    expect((await call(DELETE, "DELETE", { viewId: vid(2) })).status).toBe(404);
    expect(stored.map((v) => v.name)).toEqual(["Theirs"]);
  });

  it("puts the permission in the pull's own condition", async () => {
    stored = [row("Mine", ME)];
    await call(DELETE, "DELETE", { viewId: vid(1) });
    expect(projectUpdateOne.mock.calls[0][1].$pull.savedViews).toMatchObject({ owner: expect.anything() });
    expect(projectUpdateOne.mock.calls[0][1].$pull.savedViews).not.toHaveProperty("$or");

    asOwner();
    stored = [row("Team", OTHER, true)];
    await call(DELETE, "DELETE", { viewId: vid(2) });
    expect(projectUpdateOne.mock.calls[1][1].$pull.savedViews.$or).toEqual([
      { owner: expect.anything() },
      { shared: true },
    ]);
  });

  it("refuses a request with no usable id", async () => {
    expect((await call(DELETE, "DELETE", {})).status).toBe(400);
    expect((await call(DELETE, "DELETE", { viewId: 5 })).status).toBe(400);
  });
});
