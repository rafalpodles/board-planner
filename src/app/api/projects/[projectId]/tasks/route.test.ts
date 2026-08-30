import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const taskFind = vi.fn();
const workerFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/models/task", () => ({ Task: { find: taskFind } }));
vi.mock("@/models/worker", () => ({ Worker: { find: workerFind } }));
const userFindOne = vi.fn();
vi.mock("@/models/user", () => ({ User: { findOne: userFindOne } }));
const projectFindById = vi.fn();
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
// Partial, so `taskPopulateFields` is the REAL list this route hands to populate. Stubbing it here
// would make the assertion below about the stub, which is exactly the drift that let three copies
// of that list disagree.
vi.mock("@/lib/task-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/task-service")>()),
  createTask: vi.fn(),
  toApiExecution: vi.fn(() => undefined),
}));

const { GET } = await import("./route");

// A real ObjectId shape resolves without hitting Project.findOne, so the project gate
// itself needs no mocking here — only the `check` grant it calls
const PROJECT_ID = "507f1f77bcf86cd799439011";
const USER = { _id: "u1", role: "member" };

function request(query = "") {
  return new Request(`http://localhost/api/projects/CP/tasks${query}`);
}

const ctx = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });
const populated: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(USER);
  check.mockResolvedValue(true);
  populated.length = 0;
  taskFind.mockReturnValue({
    sort: () => ({
      populate: (fields: unknown) => {
        populated.push(fields);
        return Promise.resolve([]);
      },
    }),
  });
  workerFind.mockReturnValue({ select: () => Promise.resolve([]) });
  userFindOne.mockReturnValue({ lean: async () => null });
  projectFindById.mockReturnValue({ lean: async () => ({ categories: [{ name: "bug" }, { name: "doc" }] }) });
});

/** The filter the route actually handed Mongoose */
const filterUsed = () => taskFind.mock.calls[0]?.[0] as Record<string, unknown> | undefined;

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
 * BP-502. `?assignee=rpo` went straight into `filter.assignee`, which is an ObjectId on the model,
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

    const res = await GET(request("?assignee=rafal"), ctx());

    expect(res.status).toBe(200);
    expect(userFindOne).toHaveBeenCalledWith({ username: "rafal" }, "_id");
    expect(filterUsed()?.assignee).toBe("u7");
  });

  it("matches a username whatever case it arrives in", async () => {
    userFindOne.mockReturnValue({ lean: async () => ({ _id: "u7" }) });

    await GET(request("?assignee=RaFaL"), ctx());

    expect(userFindOne).toHaveBeenCalledWith({ username: "rafal" }, "_id");
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
 * The same question asked of the two neighbouring filters, and answered differently for each.
 * `status` keeps matching nothing — it is comma-separated and its ids are project-defined, so
 * refusing the whole request over one unknown id of several is harsher than the answer is worth.
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
    projectFindById.mockReturnValue({ lean: async () => ({ categories: [] }) });

    const res = await GET(request("?category=anything"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.category).toBe("anything");
  });

  it("leaves an unknown status matching nothing, which is the older decision", async () => {
    const res = await GET(request("?status=no-such-column"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.status).toEqual({ $in: ["no-such-column"] });
  });
});
