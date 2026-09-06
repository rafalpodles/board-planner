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
vi.mock("@/lib/task-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/task-service")>()),
  createTask: vi.fn(),
  toApiExecution: vi.fn(() => undefined),
}));

const { GET } = await import("./route");

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

const filterUsed = () => taskFind.mock.calls[0]?.[0] as Record<string, unknown> | undefined;

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

describe("GET /api/projects/:projectId/tasks — what it names", () => {
  it("asks for the assigner by name, alongside the assignee", async () => {
    await GET(request(), ctx());

    expect(populated[0]).toContainEqual({ path: "assignedBy", select: "username fullName" });
    expect(populated[0]).toContainEqual({ path: "assignee", select: "username fullName" });
  });
});

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

  it("refuses a username nobody holds rather than answering an empty list", async () => {
    const res = await GET(request("?assignee=nobody"), ctx());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No account named "@nobody"/);
    expect(taskFind).not.toHaveBeenCalled();
  });

  it("still takes an id, once no account answers to it", async () => {
    const res = await GET(request("?assignee=507f1f77bcf86cd799439099"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.assignee).toBe("507f1f77bcf86cd799439099");
  });

  it("prefers the person over the id when the name looks like one", async () => {
    userFindOne.mockReturnValue({ lean: async () => ({ _id: "u9" }) });

    await GET(request("?assignee=507f1f77bcf86cd799439099"), ctx());

    expect(filterUsed()?.assignee).toBe("u9");
  });

  it("ignores an empty assignee rather than filtering on it", async () => {
    const res = await GET(request("?assignee="), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()).not.toHaveProperty("assignee");
  });

  it("does not echo an unbounded parameter back", async () => {
    const res = await GET(request(`?assignee=${"x".repeat(500)}`), ctx());

    expect(res.status).toBe(400);
    expect((await res.json()).error.length).toBeLessThan(150);
  });

  it("does not filter by assignee when none was asked for", async () => {
    const res = await GET(request(), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()).not.toHaveProperty("assignee");
  });
});

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

  it("lets any category through on a project that defines none", async () => {
    projectFindById.mockReturnValue({ lean: async () => ({ categories: [] }) });

    const res = await GET(request("?category=anything"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.category).toBe("anything");
  });

});

describe("GET /api/projects/:projectId/tasks — the status filter", () => {
  const COLUMNS = [
    { id: "backlog", label: "Backlog", role: "backlog", order: 0 },
    { id: "doing", label: "Doing", role: "active", order: 1 },
  ];

  beforeEach(() => {
    projectFindById.mockImplementation((_id: unknown, projection?: string) => ({
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

  it("takes one it does define", async () => {
    const res = await GET(request("?status=doing"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.status).toEqual({ $in: ["doing"] });
  });

  it("takes a list where at least one id exists, unknown ids and all", async () => {
    const res = await GET(request("?status=doing,in_progress"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.status).toEqual({ $in: ["doing", "in_progress"] });
  });

  it("trims the ids it was given", async () => {
    const res = await GET(request("?status=doing,%20backlog"), ctx());

    expect(res.status).toBe(200);
    expect(filterUsed()?.status).toEqual({ $in: ["doing", "backlog"] });
  });

  it("does not echo an unbounded status back into the refusal", async () => {
    const res = await GET(request(`?status=${"x".repeat(5000)}`), ctx());

    expect(res.status).toBe(400);
    expect((await res.json()).error.length).toBeLessThan(500);
  });

  it("judges a board with no stored columns by the built-in ones", async () => {
    projectFindById.mockReturnValue({ lean: async () => ({ categories: [], columns: [] }) });

    const seeded = await GET(request("?status=in_progress"), ctx());
    expect(seeded.status).toBe(200);

    const invented = await GET(request("?status=no-such-column"), ctx());
    expect(invented.status).toBe(400);
  });
});
