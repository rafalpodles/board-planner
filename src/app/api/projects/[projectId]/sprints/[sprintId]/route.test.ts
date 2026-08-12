import { describe, it, expect, vi, beforeEach } from "vitest";

const sprintFindOne = vi.fn();
const sprintFindOneAndUpdate = vi.fn();
const sprintFindOneAndDelete = vi.fn();
const sprintUpdateMany = vi.fn();
const taskUpdateMany = vi.fn();
const taskCountDocuments = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
// Each findOne answers the next queued value; the last one repeats. The handler only ever asks
// "is this sprint mine", so a queue is enough to model both the path sprint and a destination.
let owned: boolean[] = [true];

function nextOwned(): Promise<unknown> {
  const yes = owned.length > 1 ? owned.shift()! : owned[0];
  return Promise.resolve(yes ? { _id: "507f1f77bcf86cd799439011" } : null);
}

vi.mock("@/models/sprint", () => ({
  Sprint: {
    findOne: (...args: unknown[]) => {
      sprintFindOne(...args);
      const value = nextOwned();
      return { select: () => ({ lean: () => value }), lean: () => value };
    },
    findOneAndUpdate: sprintFindOneAndUpdate,
    findOneAndDelete: sprintFindOneAndDelete,
    updateMany: sprintUpdateMany,
  },
}));
vi.mock("@/models/task", () => ({
  Task: { updateMany: taskUpdateMany, countDocuments: taskCountDocuments },
}));
vi.mock("@/models/project", () => ({
  Project: { findById: () => ({ lean: async () => ({ columns: [{ id: "done", role: "done" }] }) }) },
}));
vi.mock("@/lib/columns", () => ({ columnIdsWithRole: () => ["done"] }));
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, { ...(ctx as object), user: { _id: "u1" } }),
}));

const { PUT, DELETE, GET } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const OUR_SPRINT = "507f1f77bcf86cd799439011";
const THEIR_SPRINT = "507f1f77bcf86cd799439012";

function request(body: unknown) {
  return new Request(`https://app.example.com/api/projects/${PROJECT}/sprints/x`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = (sprintId: string) => ({
  params: Promise.resolve({ projectId: PROJECT, sprintId }),
});

function owns(...answers: boolean[]) {
  owned = answers;
}

beforeEach(() => {
  vi.clearAllMocks();
  owns(true);
  sprintFindOneAndUpdate.mockResolvedValue({ _id: OUR_SPRINT });
  sprintFindOneAndDelete.mockResolvedValue({ _id: OUR_SPRINT });
  taskCountDocuments.mockResolvedValue(0);
});

// BP-314: the two Task.updateMany calls ran BEFORE the ownership check, and the filter carried
// no `project`, so a member of any board could empty a sprint on a board they cannot read and
// get a 404 that read as "nothing happened".
describe("PUT .../sprints/[sprintId] — a sprint of another project", () => {
  it("refuses without touching a single task", async () => {
    owns(false);

    const res = await PUT(
      request({ status: "completed", moveIncompleteToBacklog: true }),
      ctx(THEIR_SPRINT)
    );

    expect(res.status).toBe(404);
    expect(taskUpdateMany).not.toHaveBeenCalled();
    expect(sprintFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses before the sprint-deactivation sweep as well", async () => {
    owns(false);

    await PUT(request({ status: "active" }), ctx(THEIR_SPRINT));

    expect(sprintUpdateMany).not.toHaveBeenCalled();
  });
});

describe("PUT .../sprints/[sprintId] — our own sprint", () => {
  it("scopes the task move to this project as well as this sprint", async () => {
    await PUT(
      request({ status: "completed", moveIncompleteToBacklog: true }),
      ctx(OUR_SPRINT)
    );

    expect(taskUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ project: PROJECT, sprint: OUR_SPRINT }),
      { $set: { sprint: null } }
    );
  });

  it("refuses a destination sprint that is not this project's", async () => {
    owns(true, false); // the path sprint is ours, the destination is not

    const res = await PUT(
      request({ status: "completed", moveIncompleteToSprint: THEIR_SPRINT }),
      ctx(OUR_SPRINT)
    );

    expect(res.status).toBe(400);
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a malformed sprint id with 400 rather than a cast error", async () => {
    const res = await PUT(request({ status: "completed" }), ctx("not-an-id"));

    expect(res.status).toBe(400);
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });
});

describe("the other two handlers", () => {
  it("DELETE returns tasks to the backlog scoped to this project", async () => {
    await DELETE(new Request("https://app.example.com/x", { method: "DELETE" }), ctx(OUR_SPRINT));

    expect(taskUpdateMany).toHaveBeenCalledWith(
      { project: PROJECT, sprint: OUR_SPRINT },
      { $set: { sprint: null } }
    );
  });

  it("GET counts only this project's tasks", async () => {
    await GET(new Request("https://app.example.com/x"), ctx(OUR_SPRINT));

    expect(taskCountDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ project: PROJECT, sprint: OUR_SPRINT })
    );
  });

  it("GET refuses a malformed sprint id", async () => {
    const res = await GET(new Request("https://app.example.com/x"), ctx("not-an-id"));

    expect(res.status).toBe(400);
  });
});
