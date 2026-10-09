import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_SAVED_VIEWS, MAX_SAVED_VIEWS_PER_PERSON } from "@/lib/identifiers";

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
let saveCalls: number;

/** A query that answers the same document whether it is awaited or read with select/lean */
function query(doc: unknown) {
  const q: Record<string, unknown> = {
    select: () => q,
    lean: () => Promise.resolve(doc),
    then: (resolve: (value: unknown) => unknown) => resolve(doc),
  };
  return q;
}

const board = () => ({ customFields: [], categories: [{ name: "bug" }] });

/**
 * The add is one atomic write whose filter carries the ceilings and the name. This applies that
 * filter the way the database would, one request at a time, so a stampede of them can be counted.
 */
function atomicPush(filter: Record<string, unknown>, update: { $push: { savedViews: Record<string, unknown> } }) {
  if (`savedViews.${MAX_SAVED_VIEWS - 1}` in filter && stored.length >= MAX_SAVED_VIEWS) return null;
  const expr = filter.$expr as { $lt: [unknown, number] } | undefined;
  const ownerOfPush = update.$push.savedViews.owner as { toString: () => string };
  if (expr && stored.filter((v) => v.owner.toString() === ownerOfPush.toString()).length >= expr.$lt[1]) return null;
  const taken = (filter.savedViews as { $not: { $elemMatch: { shared: boolean; owner?: unknown; name: { $regex: string } } } })
    .$not.$elemMatch;
  const nameRe = new RegExp(taken.name.$regex, "i");
  const clash = stored.some(
    (v) =>
      nameRe.test(v.name) &&
      v.shared === taken.shared &&
      (taken.owner === undefined || v.owner.toString() === String(taken.owner))
  );
  if (clash) return null;
  const added = { ...row("", ownerOfPush.toString()), ...update.$push.savedViews, _id: { toString: ((n) => () => vid(n))(++seq) } } as Row;
  stored = [...stored, added];
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
  saveCalls = 0;
  getAuthUser.mockResolvedValue({ _id: ME, role: "member" });
  check.mockImplementation(async (_db: unknown, _user: unknown, _id: unknown, level: string) => level === "access");
  projectFindOne.mockImplementation(() => {
    const doc = { _id: PROJECT_ID, ...board(), savedViews: stored, save: async () => void saveCalls++ };
    return query(doc);
  });
  projectFindOneAndUpdate.mockImplementation(async (filter: Record<string, unknown>, update: never) =>
    atomicPush(filter, update)
  );
  projectUpdateOne.mockImplementation(async (_filter: unknown, update: { $pull: { savedViews: { _id: { toString(): string } } } }) => {
    stored = stored.filter((v) => v._id.toString() !== update.$pull.savedViews._id.toString());
  });
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

  it("holds the project to its ceiling", async () => {
    stored = Array.from({ length: MAX_SAVED_VIEWS }, (_, i) => row(`View ${i}`, `owner-${i % 8}-${i}`));

    const res = await call(POST, "POST", { name: "One too many" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(String(MAX_SAVED_VIEWS));
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
    expect(saveCalls).toBe(1);
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
    expect(saveCalls).toBe(0);
  });

  it("refuses a member a change to a shared view that is not theirs", async () => {
    stored = [row("Team", OTHER, true)];

    expect((await call(PUT, "PUT", { viewId: vid(1), name: "Mine now" })).status).toBe(403);
    expect(saveCalls).toBe(0);
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
    expect(saveCalls).toBe(0);
  });

  it("refuses a bad id, name or flag", async () => {
    stored = [row("Mine", ME)];

    expect((await call(PUT, "PUT", { name: "x" })).status).toBe(400);
    expect((await call(PUT, "PUT", { viewId: "nope", name: "x" })).status).toBe(400);
    expect((await call(PUT, "PUT", { viewId: vid(1), name: " " })).status).toBe(400);
    expect((await call(PUT, "PUT", { viewId: vid(1), shared: 1 })).status).toBe(400);
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

  it("refuses a request with no usable id", async () => {
    expect((await call(DELETE, "DELETE", {})).status).toBe(400);
    expect((await call(DELETE, "DELETE", { viewId: 5 })).status).toBe(400);
  });
});
