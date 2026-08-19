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
