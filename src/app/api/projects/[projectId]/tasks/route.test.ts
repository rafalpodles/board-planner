import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";

const getAuthUser = vi.fn();
const check = vi.fn();
const taskFind = vi.fn();
const taskFindOne = vi.fn();
const taskCount = vi.fn();
// Whether any task on this board is sitting in the asked-for status — what tells an orphaned
// column id apart from a typo (BP-514)
const taskExists = vi.fn();
const workerFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/task", () => ({
  Task: { find: taskFind, exists: taskExists, findOne: taskFindOne, countDocuments: taskCount },
}));
vi.mock("@/models/worker", () => ({ Worker: { find: workerFind } }));
const userFindOne = vi.fn();
vi.mock("@/models/user", () => ({ User: { findOne: userFindOne } }));
const projectFindOne = vi.fn();
vi.mock("@/models/project", () => ({ Project: { findOne: projectFindOne } }));
// Partial, so `taskPopulateFields` is the REAL list this route hands to populate. Stubbing it here
// would make the assertion below about the stub, which is exactly the drift that let three copies
// of that list disagree.
vi.mock("@/lib/task-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/task-service")>()),
  createTask: vi.fn(),
  toApiExecution: vi.fn(() => undefined),
}));

// The counting itself is epics.test.ts's job; here the route only has to hand it this page and attach the answer
const epicProgressFor = vi.fn(async () => new Map());
vi.mock("@/lib/epics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epics")>()),
  epicProgressFor,
}));

const { GET, POST } = await import("./route");
const { createTask } = await import("@/lib/task-service");

// A real ObjectId shape resolves without hitting Project.findOne, so the project gate
// itself needs no mocking here — only the `check` grant it calls
const PROJECT_ID = "507f1f77bcf86cd799439011";
const USER = { _id: "u1", role: "member" };

function request(query = "") {
  return new Request(`http://localhost/api/projects/CP/tasks${query}`);
}

const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });
const populated: unknown[] = [];
const parentDocs: unknown[] = [];
let listed: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  taskExists.mockResolvedValue(null);
  getAuthUser.mockResolvedValue(USER);
  check.mockResolvedValue(true);
  populated.length = 0;
  listed = [];
  parentDocs.length = 0;
  // Two different reads go through Task.find here: the list itself, and parentsOf resolving each
  // card's parent from the far end. Only the second passes a projection, which is what tells them
  // apart — a single shape serving both is how the list's own mock silently answered for it.
  taskFind.mockImplementation((_filter: unknown, projection?: unknown) =>
    projection === undefined
      ? {
          sort: () => ({
            populate: (fields: unknown) => {
              populated.push(fields);
              return Promise.resolve(listed);
            },
          }),
        }
      : { lean: async () => parentDocs }
  );
  workerFind.mockReturnValue({ select: () => Promise.resolve([]) });
  userFindOne.mockReturnValue({ lean: async () => null });
  projectFindOne.mockReturnValue({ lean: async () => ({ categories: [{ name: "bug" }, { name: "doc" }] }) });
});

/** The filter the route actually handed Mongoose */
const filterUsed = () => taskFind.mock.calls[0]?.[0] as Record<string, unknown> | undefined;

// BP-904: how a caller holding "BP-12" gets that task without downloading the board
describe("GET /api/projects/:projectId/tasks — taskNumber filter", () => {
  it("narrows to one task by its number", async () => {
    const response = await GET(request("?taskNumber=12"), ctx());

    expect(response.status).toBe(200);
    expect(taskFind).toHaveBeenCalledWith(expect.objectContaining({ taskNumber: 12 }));
  });

  it("takes several numbers, comma-separated", async () => {
    await GET(request("?taskNumber=3,%205,9"), ctx());

    expect(filterUsed()).toMatchObject({ taskNumber: { $in: [3, 5, 9] } });
  });

  it("stays inside the board the path names", async () => {
    await GET(request("?taskNumber=12"), ctx());

    expect(filterUsed()).toMatchObject({ project: PROJECT_ID, taskNumber: 12 });
  });

  it.each(["0", "-1", "abc", "1,,2", "1.5", "1234567890", "1;2", `${Array.from({ length: 101 }, (_, i) => i + 1)}`])(
    "refuses %j with 400 rather than asking Mongoose",
    async (value) => {
      const response = await GET(request(`?taskNumber=${encodeURIComponent(value)}`), ctx());

      expect(response.status).toBe(400);
      expect(taskFind).not.toHaveBeenCalled();
    }
  );

  it("leaves the filter unscoped when no number is given", async () => {
    await GET(request(), ctx());

    expect(filterUsed()).not.toHaveProperty("taskNumber");
  });
});

/**
 * BP-906. A listing a model reads has to fit in its context: paging and a short view, and filters
 * that run in the database rather than over a board already loaded.
 */
describe("GET /api/projects/:projectId/tasks — paging, the summary view and the narrower filters", () => {
  const SELECT_FIELDS = "taskNumber title status priority assignee dueDate sprint order updatedAt";
  // The scoped db wraps `populate` on the query it is handed, so the spy lives outside that object
  let query: Record<"sort" | "select" | "skip" | "limit" | "populate", ReturnType<typeof vi.fn>>;
  let populateSpy: ReturnType<typeof vi.fn>;
  const FIELD_ID = "507f1f77bcf86cd799439a01";
  const NUMBER_ID = "507f1f77bcf86cd799439a02";
  const CHECK_ID = "507f1f77bcf86cd799439a03";
  const DATE_ID = "507f1f77bcf86cd799439a04";
  const TEXT_ID = "507f1f77bcf86cd799439a05";
  const OPTION_ID = "opt-large";

  beforeEach(() => {
    query = {
      sort: vi.fn(() => query),
      select: vi.fn(() => query),
      skip: vi.fn(() => query),
      limit: vi.fn(() => query),
      populate: (...args: unknown[]) => populateSpy(...args),
    } as typeof query;
    populateSpy = vi.fn(async () => listed);
    taskFind.mockImplementation((_filter: unknown, projection?: unknown) =>
      projection === undefined ? query : { lean: async () => parentDocs }
    );
    taskCount.mockResolvedValue(57);
    projectFindOne.mockReturnValue({
      lean: async () => ({
        categories: [{ name: "bug" }],
        customFields: [
          { _id: FIELD_ID, name: "Size", fieldType: "dropdown", options: [{ id: OPTION_ID, value: "L" }] },
          { _id: NUMBER_ID, name: "Points", fieldType: "number" },
          { _id: CHECK_ID, name: "Flagged", fieldType: "checkbox" },
          { _id: DATE_ID, name: "Due-ish", fieldType: "date" },
          { _id: TEXT_ID, name: "Notes", fieldType: "text" },
        ],
      }),
    });
  });

  const clauses = () => (filterUsed() as { $and?: unknown[] }).$and;

  describe("paging", () => {
    it("answers a bare array, as the board has always read it, when no page is asked for", async () => {
      listed = [{ _id: "a", taskNumber: 1 }];
      const body = await (await GET(request(), ctx())).json();

      expect(Array.isArray(body)).toBe(true);
      expect(query.skip).not.toHaveBeenCalled();
      expect(taskCount).not.toHaveBeenCalled();
    });

    it("skips and limits in the query, and says what the filter matches in all", async () => {
      listed = [{ _id: "a", taskNumber: 21 }];
      const response = await GET(request("?limit=10&offset=20"), ctx());
      const body = await response.json();

      expect(query.skip).toHaveBeenCalledWith(20);
      expect(query.limit).toHaveBeenCalledWith(10);
      expect(body).toMatchObject({ total: 57, limit: 10, offset: 20, tasks: [{ taskNumber: 21 }] });

      // The total is of what the filters match, not of the board: asked again with a filter, the
      // count is handed the narrowed one
      taskCount.mockClear();
      taskFind.mockClear();
      await GET(request("?limit=10&blocked=true"), ctx());
      expect(filterUsed()).toMatchObject({ $and: [{ "blockedBy.0": { $exists: true } }] });
      expect(taskCount).toHaveBeenCalledWith(filterUsed());
    });

    it("breaks ties on the id, so a page boundary falls in the same place every time", async () => {
      await GET(request("?limit=10"), ctx());

      expect(query.sort).toHaveBeenCalledWith({ order: 1, createdAt: -1, _id: 1 });
    });

    it("pages from the default size when only an offset is given", async () => {
      const body = await (await GET(request("?offset=5"), ctx())).json();

      expect(query.limit).toHaveBeenCalledWith(50);
      expect(body.limit).toBe(50);
    });

    it.each(["0", "201", "abc", "1.5", "-3", ""])("refuses limit=%j with 400", async (limit) => {
      const response = await GET(request(`?limit=${limit}`), ctx());

      expect(response.status).toBe(400);
      expect(taskFind).not.toHaveBeenCalled();
    });

    it.each(["-1", "abc", "2.5"])("refuses offset=%j with 400", async (offset) => {
      const response = await GET(request(`?limit=10&offset=${offset}`), ctx());

      expect(response.status).toBe(400);
      expect(taskFind).not.toHaveBeenCalled();
    });
  });

  describe("the summary view", () => {
    it("reads only the fields a listing shows, and names the people and sprints it points at", async () => {
      await GET(request("?view=summary"), ctx());

      expect(query.select).toHaveBeenCalledWith(SELECT_FIELDS);
      expect(populateSpy).toHaveBeenCalledWith([
        { path: "assignee", select: "username fullName" },
        { path: "sprint", select: "name" },
      ]);
    });

    it("leaves the whole task alone without it", async () => {
      await GET(request(), ctx());

      expect(query.select).not.toHaveBeenCalled();
    });

    it("refuses a view it does not have", async () => {
      expect((await GET(request("?view=everything"), ctx())).status).toBe(400);
    });
  });

  describe("due dates, updates and blockers", () => {
    it("takes a due date range as whole days, the end day included", async () => {
      await GET(request("?dueAfter=2026-10-01&dueBefore=2026-10-10"), ctx());

      expect(clauses()).toEqual([
        { dueDate: { $lte: new Date("2026-10-10T23:59:59.999Z") } },
        { dueDate: { $gte: new Date("2026-10-01T00:00:00.000Z") } },
      ]);
    });

    it.each(["dueBefore=10/10/2026", "dueAfter=2026-13-45", "dueBefore=tomorrow", "updatedSince=yesterday"])(
      "refuses %s with 400",
      async (param) => {
        expect((await GET(request(`?${param}`), ctx())).status).toBe(400);
        expect(taskFind).not.toHaveBeenCalled();
      }
    );

    it("takes updatedSince as a day or a timestamp", async () => {
      await GET(request("?updatedSince=2026-10-01T08:30:00Z"), ctx());

      expect(clauses()).toEqual([{ updatedAt: { $gte: new Date("2026-10-01T08:30:00Z") } }]);
    });

    it("asks for tasks that have a blocker, or have none", async () => {
      await GET(request("?blocked=true"), ctx());
      expect(clauses()).toEqual([{ "blockedBy.0": { $exists: true } }]);

      taskFind.mockClear();
      await GET(request("?blocked=false"), ctx());
      expect(clauses()).toEqual([{ $or: [{ blockedBy: { $exists: false } }, { blockedBy: { $size: 0 } }] }]);
    });

    it("refuses a blocked it cannot read", async () => {
      expect((await GET(request("?blocked=maybe"), ctx())).status).toBe(400);
    });

    // blocked=false is the one clause that is itself an $or, and the one that could overwrite the search's
    it("keeps the text search it was combined with", async () => {
      await GET(request("?search=login&blocked=false"), ctx());

      expect(filterUsed()).toMatchObject({
        $or: [{ title: expect.anything() }, { description: expect.anything() }],
        $and: [{ $or: [{ blockedBy: { $exists: false } }, { blockedBy: { $size: 0 } }] }],
      });
    });

    it("refuses a day that does not exist rather than moving the range into the next month", async () => {
      for (const param of ["dueBefore=2026-02-31", "dueAfter=2026-04-31", "updatedSince=2026-02-30"]) {
        taskFind.mockClear();
        expect((await GET(request(`?${param}`), ctx())).status).toBe(400);
        expect(taskFind).not.toHaveBeenCalled();
      }
    });
  });

  describe("the children of one task", () => {
    const PARENT = "507f1f77bcf86cd799439b01";

    it("reads them from the parent's parent_of links, and only those", async () => {
      taskFindOne.mockReturnValue({
        lean: async () => ({
          relations: [
            { type: "parent_of", task: "c1" },
            { type: "relates", task: "other" },
            { type: "parent_of", task: "c2" },
          ],
        }),
      });
      await GET(request(`?parent=${PARENT}`), ctx());

      expect(taskFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: PARENT, project: PROJECT_ID }),
        "relations"
      );
      expect(clauses()).toEqual([{ _id: { $in: ["c1", "c2"] } }]);
    });

    it("refuses a parent that is not an id, or is not on this board", async () => {
      expect((await GET(request("?parent=BP-1"), ctx())).status).toBe(400);

      taskFindOne.mockReturnValue({ lean: async () => null });
      expect((await GET(request(`?parent=${PARENT}`), ctx())).status).toBe(400);
      expect(taskFind).not.toHaveBeenCalled();
    });
  });

  describe("tasks that have children", () => {
    it("hasChildren=true asks for a parent_of link and nothing else", async () => {
      const response = await GET(request("?hasChildren=true"), ctx());

      expect(response.status).toBe(200);
      expect(clauses()).toEqual([{ relations: { $elemMatch: { type: "parent_of" } } }]);
    });

    it("hasChildren=false asks for tasks with none", async () => {
      await GET(request("?hasChildren=false"), ctx());

      expect(clauses()).toEqual([{ relations: { $not: { $elemMatch: { type: "parent_of" } } } }]);
    });

    it("leaves the filter off when not asked", async () => {
      await GET(request(), ctx());

      expect(clauses()).toBeUndefined();
    });

    it("refuses a value that is not true or false, rather than listing the whole board", async () => {
      const response = await GET(request("?hasChildren=yes"), ctx());

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("true or false");
      expect(taskFind).not.toHaveBeenCalled();
    });

    it("sits beside the other conditions instead of replacing them", async () => {
      taskFindOne.mockReturnValue({ lean: async () => ({ relations: [{ type: "parent_of", task: "c1" }] }) });
      await GET(request("?hasChildren=true&blocked=true&parent=507f1f77bcf86cd799439b01"), ctx());

      expect(clauses()).toHaveLength(3);
    });
  });

  describe("project fields", () => {
    it("matches a dropdown on its option id", async () => {
      await GET(request(`?field=${FIELD_ID}:${OPTION_ID}`), ctx());

      expect(clauses()).toEqual([{ [`customFieldValues.${FIELD_ID}`]: OPTION_ID }]);
    });

    // The board shows a checkbox nobody touched as "No", so "No" has to find it
    it("finds a checkbox nobody touched when asked for unticked", async () => {
      await GET(request(`?field=${CHECK_ID}:false`), ctx());

      expect(clauses()).toEqual([{ [`customFieldValues.${CHECK_ID}`]: { $ne: true } }]);
    });

    it("matches a text field the way the board does: containing, in any case", async () => {
      projectFindOne.mockReturnValue({
        lean: async () => ({ customFields: [{ _id: FIELD_ID, name: "Notes", fieldType: "text" }] }),
      });
      await GET(request(`?field=${FIELD_ID}:Log.in`), ctx());

      expect(clauses()).toEqual([{ [`customFieldValues.${FIELD_ID}`]: { $regex: "Log\\.in", $options: "i" } }]);
    });

    it("reads a number as a number and a checkbox as a boolean", async () => {
      await GET(request(`?field=${NUMBER_ID}:5&field=${CHECK_ID}:true`), ctx());

      expect(clauses()).toEqual([
        { [`customFieldValues.${NUMBER_ID}`]: 5 },
        { [`customFieldValues.${CHECK_ID}`]: true },
      ]);
    });

    it.each([
      ["a field this board does not have", "507f1f77bcf86cd799439aff:x"],
      ["no value part", "nonsense"],
      ["an option the field does not offer", `${FIELD_ID}:nope`],
      ["a number that is not one", `${NUMBER_ID}:five`],
      ["a checkbox that is neither true nor false", `${CHECK_ID}:yes`],
      ["a type that cannot be filtered", `${DATE_ID}:2026-10-10`],
      ["an empty value for a text field", `${TEXT_ID}:`],
    ])("refuses %s", async (_what, value) => {
      const response = await GET(request(`?field=${value}`), ctx());

      expect(response.status).toBe(400);
      expect(taskFind).not.toHaveBeenCalled();
    });

    it("refuses more field filters than it will combine", async () => {
      const many = Array.from({ length: 11 }, () => `field=${FIELD_ID}:${OPTION_ID}`).join("&");

      expect((await GET(request(`?${many}`), ctx())).status).toBe(400);
    });
  });
});

// A stale bookmark or a link to a deleted sprint used to reach Mongoose as a raw string
// and crash with a CastError 500 — this is every caller's protection, not just the board's
describe("GET /api/projects/:projectId/tasks — sprint filter", () => {
  it("answers a malformed sprint id with 400, not a crash", async () => {
    const response = await GET(request("?sprint=not-an-id"), ctx());

    expect(response.status).toBe(400);
    expect(taskFind).not.toHaveBeenCalled();
  });

  it("still treats backlog as the no-sprint sentinel", async () => {
    const response = await GET(request("?sprint=backlog"), ctx());

    expect(response.status).toBe(200);
    expect(taskFind).toHaveBeenCalledWith(expect.objectContaining({ sprint: null }));
  });

  it("accepts a well-formed sprint id", async () => {
    const sprintId = "69a52e3b399b27d3cbb2c5a5";
    const response = await GET(request(`?sprint=${sprintId}`), ctx());

    expect(response.status).toBe(200);
    expect(taskFind).toHaveBeenCalledWith(expect.objectContaining({ sprint: sprintId }));
  });

  it("leaves the filter unscoped when no sprint is given", async () => {
    const response = await GET(request(), ctx());

    expect(response.status).toBe(200);
    const filter = taskFind.mock.calls[0][0];
    expect(filter).not.toHaveProperty("sprint");
  });
});

/**
 * BP-358: `assignedBy` is what says whether a machine may act on a task, and the Agent row reads it
 * to name whoever handed the task over. Left unpopulated it serialises as a bare ObjectId, so
 * "Krzysiek assigned it" degrades to "Somebody else assigned it" — with nothing failing anywhere,
 * because the component's own tests pass an already-populated fixture.
 */
describe("GET /api/projects/:projectId/tasks — what it names", () => {
  it("asks for the assigner by name, alongside the assignee", async () => {
    await GET(request(), ctx());

    expect(populated[0]).toContainEqual({ path: "assignedBy", select: "username fullName" });
    expect(populated[0]).toContainEqual({ path: "assignee", select: "username fullName" });
  });
});

/**
 * BP-502. `?assignee=owner` went straight into `filter.assignee`, which is an ObjectId on the model,
 * so Mongoose threw a CastError and the route answered **500** — reproduced over the hosted MCP
 * endpoint, which is this parameter's only caller and its only documentation. The browser never
 * sends it, which is why it stood.
 *
 * Validation alone would have been the wrong fix: the parameter is documented as a username, and an
 * ObjectId appears in no MCP response, so demanding one leaves the filter unreachable from a
 * conversation.
 */
describe("GET /api/projects/:projectId/tasks — assignee filter", () => {
  it("resolves a username to the id the model stores", async () => {
    userFindOne.mockReturnValue({ lean: async () => ({ _id: "u7" }) });

    const res = await GET(request("?assignee=owner"), ctx());

    expect(res.status).toBe(200);
    expect(userFindOne).toHaveBeenCalledWith({ username: "owner", organisation: DEFAULT_ORGANISATION_ID }, "_id");
    expect(filterUsed()?.assignee).toBe("u7");
  });

  it("matches a username whatever case it arrives in", async () => {
    userFindOne.mockReturnValue({ lean: async () => ({ _id: "u7" }) });

    await GET(request("?assignee=OwNeR"), ctx());

    expect(userFindOne).toHaveBeenCalledWith({ username: "owner", organisation: DEFAULT_ORGANISATION_ID }, "_id");
  });

  // The whole point of refusing: an empty list and a typo read identically to whoever asked
  it("refuses a username nobody holds rather than answering an empty list", async () => {
    const res = await GET(request("?assignee=nobody"), ctx());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No account named "@nobody"/);
    expect(taskFind).not.toHaveBeenCalled();
  });

  // It always worked, and this route is public REST — but only after no account claims the value
  it("still takes an id, once no account answers to it", async () => {
    const res = await GET(request("?assignee=507f1f77bcf86cd799439099"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.assignee).toBe("507f1f77bcf86cd799439099");
  });

  /**
   * `USERNAME_PATTERN` is `^[a-z0-9][a-z0-9._-]{1,31}$`, so 24 hex characters is a name somebody
   * may hold. Looking the id up first would answer their tasks with the silent empty list this
   * whole change exists to remove.
   */
  it("prefers the person over the id when the name looks like one", async () => {
    userFindOne.mockReturnValue({ lean: async () => ({ _id: "u9" }) });

    await GET(request("?assignee=507f1f77bcf86cd799439099"), ctx());

    expect(filterUsed()?.assignee).toBe("u9");
  });

  // An empty parameter is falsy, so the filter is skipped entirely — the same as every other
  // parameter here, and one character away from meaning "assigned to nobody"
  it("ignores an empty assignee rather than filtering on it", async () => {
    const res = await GET(request("?assignee="), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()).not.toHaveProperty("assignee");
  });

  // The message reaches a model as a tool result, so it is not a place to echo an unbounded value
  it("does not echo an unbounded parameter back", async () => {
    const res = await GET(request(`?assignee=${"x".repeat(500)}`), ctx());

    expect(res.status).toBe(400);
    expect((await res.json()).error.length).toBeLessThan(150);
  });

  // The control: without a parameter the filter must not mention the field at all, or every list
  // silently becomes "assigned to nobody"
  it("does not filter by assignee when none was asked for", async () => {
    const res = await GET(request(), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()).not.toHaveProperty("assignee");
  });
});

/**
 * The same question asked of the three neighbouring filters, and answered differently for each.
 * `status` is the one that is comma-separated, so it refuses only when NONE of the ids it was given
 * exists — see the block below.
 */
describe("GET /api/projects/:projectId/tasks — category and priority", () => {
  it("refuses a category this project does not define, naming the ones it does", async () => {
    const res = await GET(request("?category=nonsense"), ctx());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/project categories: bug, doc/);
  });

  it("takes one it does", async () => {
    const res = await GET(request("?category=bug"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.category).toBe("bug");
  });

  it("refuses a priority outside the enum, which could only ever match nothing", async () => {
    const res = await GET(request("?priority=urgentish"), ctx());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/one of: low, medium, high, urgent/);
  });

  it("still widens the default priority to the tasks that predate the field", async () => {
    const res = await GET(request("?priority=medium"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.priority).toEqual({ $in: ["medium", null] });
  });

  // The escape both writers have, copied faithfully: a project that defines no categories at all
  // must not have every category filter refused
  it("lets any category through on a project that defines none", async () => {
    projectFindOne.mockReturnValue({ lean: async () => ({ categories: [] }) });

    const res = await GET(request("?category=anything"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.category).toBe("anything");
  });

});

/**
 * BP-511. Both MCP tools described the seeded column ids as a closed list, while columns have been
 * project-defined since CP-128 — so an agent on a renamed board asked for `todo`, was answered
 * `200 []`, and reported that there was nothing to do.
 *
 * Refused only when none of the given ids exists. The filter is comma-separated, so one unknown id
 * beside a real one is a narrower request rather than a typo, and refusing the whole of it would
 * cost more than the empty list it prevents.
 */
describe("GET /api/projects/:projectId/tasks — the status filter", () => {
  const COLUMNS = [
    { id: "backlog", label: "Backlog", role: "backlog", order: 0 },
    { id: "doing", label: "Doing", role: "active", order: 1 },
  ];

  /**
   * Projection-aware, and that is the whole point of it. A mock that answers the same document
   * whatever it was asked for cannot see the route forgetting to LOAD `columns` — and that fails
   * in the worst direction: `getColumnIds` then falls back to the built-in seven, so a board that
   * renamed its columns is refused its own real ids. The e2e board cannot see it either, because
   * its seeded columns are byte-identical to those defaults.
   */
  beforeEach(() => {
    projectFindOne.mockImplementation((_filter: { _id: unknown }, projection?: string) => ({
      lean: async () => ({
        categories: [{ name: "bug" }],
        ...(String(projection).split(/\s+/).includes("columns") ? { columns: COLUMNS } : {}),
      }),
    }));
  });

  it("refuses an id this board has no column for, naming the ones it has", async () => {
    const res = await GET(request("?status=in_progress"), ctx());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/project columns: backlog, doing/);
    expect(taskFind).not.toHaveBeenCalled();
  });

  /**
   * BP-514. A column deleted out from under its tasks leaves them holding a status no column has.
   * They are drawn by no board and reachable by no other query, so refusing the one id that finds
   * them made the state unseeable — while BP-311's rule is to refuse the act that creates the
   * problem, never the board that already has it.
   */
  it("takes an id no column has when tasks are actually sitting in it", async () => {
    taskExists.mockResolvedValue({ _id: "t1" });

    const res = await GET(request("?status=in_progress"), ctx());

    expect(res.status).toBe(200);
    expect(taskFind).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $in: ["in_progress"] } })
    );
    // Scoped to this board. Without the project clause the probe answers "does any task anywhere
    // hold this status", which is a different question and one this caller may not ask
    expect(taskExists).toHaveBeenCalledWith({
      project: PROJECT_ID,
      status: { $in: ["in_progress"] },
      organisation: DEFAULT_ORGANISATION_ID,
    });
  });

  // The filter is comma-separated, so the probe has to ask about all of them: an orphan in the
  // second id is as real as one in the first
  it("takes a list where only a later id has orphaned tasks", async () => {
    taskExists.mockResolvedValue({ _id: "t1" });

    const res = await GET(request("?status=nonesuch,in_progress"), ctx());

    expect(res.status).toBe(200);
    expect(taskExists).toHaveBeenCalledWith({
      project: PROJECT_ID,
      status: { $in: ["nonesuch", "in_progress"] },
      organisation: DEFAULT_ORGANISATION_ID,
    });
  });

  // The control: the same request against an id the board does define still filters
  it("takes one it does define", async () => {
    const res = await GET(request("?status=doing"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.status).toEqual({ $in: ["doing"] });
  });

  /**
   * One unknown id among real ones is left alone on purpose. A caller listing several columns is
   * narrowing, and refusing the whole request over the one that has since been renamed would
   * answer a smaller mistake with a bigger one.
   */
  it("takes a list where at least one id exists, unknown ids and all", async () => {
    const res = await GET(request("?status=doing,in_progress"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.status).toEqual({ $in: ["doing", "in_progress"] });
  });

  // A comma list is what a caller types, and a space after the comma is the likeliest form of the
  // mistake — it used to pass the gate on the first id and silently match nothing for the rest
  it("trims the ids it was given", async () => {
    const res = await GET(request("?status=doing,%20backlog"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.status).toEqual({ $in: ["doing", "backlog"] });
  });

  // It reaches a model as a tool result, so the refusal is not a place to echo the parameter back
  it("does not echo an unbounded status back into the refusal", async () => {
    const res = await GET(request(`?status=${"x".repeat(5000)}`), ctx());

    expect(res.status).toBe(400);
    expect((await res.json()).error.length).toBeLessThan(500);
  });

  // A board predating the seeding migration stores no columns and runs on the built-in seven, so
  // the seeded ids are what it must still answer to
  it("judges a board with no stored columns by the built-in ones", async () => {
    projectFindOne.mockReturnValue({ lean: async () => ({ categories: [], columns: [] }) });

    const seeded = await GET(request("?status=in_progress"), ctx());
    expect(seeded.status).toBe(200);

    const invented = await GET(request("?status=no-such-column"), ctx());
    expect(invented.status).toBe(400);
  });
});

// BP-326: the board list must not publish a run id or a refused change's patch
describe("GET /api/projects/:projectId/tasks — what a card publishes", () => {
  it("projects execution and drops decision on every task", async () => {
    const stored = {
      _id: "t1",
      title: "Held by a run",
      execution: { runId: "run-secret-123", workerId: "w1", attempts: 2, phaseSeq: 9, lastError: "boom" },
      decision: { patchSha256: "patch-hash-abc" },
    };
    listed = [{ ...stored, toObject: () => ({ ...stored }) }];
    workerFind.mockReturnValue({ select: () => ({ lean: async () => [{ _id: "w1", name: "mac" }] }) });

    const text = await (await GET(request(), ctx())).text();

    expect(text).toContain("Held by a run");
    expect(text).not.toContain("run-secret-123");
    expect(text).not.toContain("patch-hash-abc");
  });
});

/**
 * The parent is the one fact on a card that its own document does not hold: a parent_of link lives
 * on the parent. So the list has to resolve it from the far end, and a card whose parent is
 * somebody else's child must not inherit it.
 */
describe("GET /api/projects/:projectId/tasks — the parent each card belongs to", () => {
  const child = { _id: "child", title: "A slice", toObject: () => ({ _id: "child", title: "A slice" }) };

  it("attaches the parent that names this task", async () => {
    listed = [child];
    parentDocs.push({
      _id: "epic",
      taskNumber: 644,
      title: "Epic: Phase 1",
      status: "todo",
      relations: [{ task: "child", type: "parent_of" }],
    });

    const body = JSON.parse(await (await GET(request(), ctx())).text());

    expect(body[0].parent).toEqual({
      _id: "epic",
      taskNumber: 644,
      title: "Epic: Phase 1",
      status: "todo",
    });
  });

  it("answers null rather than leaving the field off, so a card need not guess", async () => {
    listed = [child];

    const body = JSON.parse(await (await GET(request(), ctx())).text());

    expect(body[0].parent).toBeNull();
  });

  it("does not give one task's parent to another", async () => {
    const stranger = { _id: "stranger", title: "Unrelated", toObject: () => ({ _id: "stranger" }) };
    listed = [child, stranger];
    parentDocs.push({
      _id: "epic",
      taskNumber: 644,
      title: "Epic: Phase 1",
      status: "todo",
      relations: [{ task: "child", type: "parent_of" }],
    });

    const body = JSON.parse(await (await GET(request(), ctx())).text());

    expect(body[0].parent?.taskNumber).toBe(644);
    expect(body[1].parent).toBeNull();
  });
});

describe("GET /api/projects/:projectId/tasks — the progress of an epic on the page", () => {
  const progress = { total: 4, done: 1, byStatus: { done: 1, todo: 3 } };
  const epic = { _id: "epic", title: "Epic", toObject: () => ({ _id: "epic", title: "Epic" }) };
  const plain = { _id: "plain", title: "Plain", toObject: () => ({ _id: "plain", title: "Plain" }) };

  it("is attached to the task that has children and to no other", async () => {
    listed = [epic, plain];
    epicProgressFor.mockResolvedValueOnce(new Map([["epic", progress]]));

    const body = await (await GET(request(), ctx())).json();

    expect(body[0].progress).toEqual(progress);
    expect(body[1]).not.toHaveProperty("progress");
  });

  it("is counted for the ids this response carries, not for the board", async () => {
    listed = [epic, plain];

    await GET(request(), ctx());

    expect(epicProgressFor).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, ["epic", "plain"]);
  });

  it("is attached in the summary view and a page too", async () => {
    taskFind.mockImplementation((_filter: unknown, projection?: unknown) => {
      const query: Record<string, unknown> = {};
      for (const step of ["sort", "select", "skip", "limit"]) query[step] = () => query;
      query.populate = async () => listed;
      return projection === undefined ? query : { lean: async () => parentDocs };
    });
    taskCount.mockResolvedValue(1);
    listed = [epic];
    epicProgressFor.mockResolvedValueOnce(new Map([["epic", progress]]));

    const body = await (await GET(request("?view=summary&limit=10"), ctx())).json();

    expect(body.tasks[0].progress).toEqual(progress);
  });
});

describe("POST /api/projects/:projectId/tasks — what the created task publishes", () => {
  it("projects execution and drops decision", async () => {
    vi.mocked(createTask).mockResolvedValue({
      ok: true,
      data: {
        _id: "t2",
        title: "Just created",
        execution: { runId: "run-secret-456", workerId: "w1", attempts: 0, phaseSeq: 0 },
        decision: { patchSha256: "patch-hash-def" },
      },
    } as never);
    workerFind.mockReturnValue({ select: () => ({ lean: async () => [{ _id: "w1", name: "mac" }] }) });

    const res = await POST(
      new Request("http://localhost/api/projects/CP/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Just created" }),
      }),
      ctx()
    );
    const text = await res.text();

    expect(res.status).toBe(201);
    expect(text).toContain("Just created");
    expect(text).not.toContain("run-secret-456");
    expect(text).not.toContain("patch-hash-def");
  });
});
