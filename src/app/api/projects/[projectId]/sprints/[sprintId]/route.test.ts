import { describe, it, expect, vi, beforeEach } from "vitest";

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const OUR_SPRINT = "507f1f77bcf86cd799439011";
const OUR_OTHER_SPRINT = "507f1f77bcf86cd799439013";
const THEIR_SPRINT = "507f1f77bcf86cd799439012";

const sprintFindOne = vi.fn();
const sprintFindOneAndUpdate = vi.fn();
const sprintFindOneAndDelete = vi.fn();
const sprintUpdateMany = vi.fn();
const taskUpdateMany = vi.fn();
const taskCountDocuments = vi.fn();

const OWNED_BY_THIS_PROJECT = new Set([OUR_SPRINT, OUR_OTHER_SPRINT]);

function answerFor(query: { _id?: unknown; project?: unknown } | undefined) {
  const mine =
    query?.project === PROJECT &&
    typeof query?._id === "string" &&
    OWNED_BY_THIS_PROJECT.has(query._id);
  return Promise.resolve(mine ? { _id: query!._id } : null);
}

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/sprint", () => ({
  Sprint: {
    findOne: (query: { _id?: unknown; project?: unknown }) => {
      sprintFindOne(query);
      const value = answerFor(query);
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

beforeEach(() => {
  vi.clearAllMocks();
  sprintFindOneAndUpdate.mockResolvedValue({ _id: OUR_SPRINT });
  sprintFindOneAndDelete.mockResolvedValue({ _id: OUR_SPRINT });
  taskCountDocuments.mockResolvedValue(0);
});

describe("PUT .../sprints/[sprintId] — a sprint of another project", () => {
  it("refuses without touching a single task", async () => {
    const res = await PUT(
      request({ status: "completed", moveIncompleteToBacklog: true }),
      ctx(THEIR_SPRINT)
    );

    expect(res.status).toBe(404);
    expect(taskUpdateMany).not.toHaveBeenCalled();
    expect(sprintFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("asks for the sprint by project as well as by id", async () => {
    await PUT(request({ status: "completed" }), ctx(THEIR_SPRINT));

    expect(sprintFindOne).toHaveBeenCalledWith({ _id: THEIR_SPRINT, project: PROJECT });
  });

  it("refuses before the sprint-deactivation sweep as well", async () => {
    await PUT(request({ status: "active" }), ctx(THEIR_SPRINT));

    expect(sprintUpdateMany).not.toHaveBeenCalled();
  });
});

describe("PUT .../sprints/[sprintId] — our own sprint", () => {
  it("scopes the task move to this project as well as this sprint", async () => {
    await PUT(request({ status: "completed", moveIncompleteToBacklog: true }), ctx(OUR_SPRINT));

    expect(taskUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ project: PROJECT, sprint: OUR_SPRINT }),
      { $set: { sprint: null } }
    );
  });

  it("moves unfinished tasks to another sprint of this project", async () => {
    await PUT(
      request({ status: "completed", moveIncompleteToSprint: OUR_OTHER_SPRINT }),
      ctx(OUR_SPRINT)
    );

    expect(sprintFindOne).toHaveBeenCalledWith({ _id: OUR_OTHER_SPRINT, project: PROJECT });
    expect(taskUpdateMany).toHaveBeenCalledWith(expect.anything(), {
      $set: { sprint: OUR_OTHER_SPRINT },
    });
  });

  it("refuses a destination sprint that is not this project's", async () => {
    const res = await PUT(
      request({ status: "completed", moveIncompleteToSprint: THEIR_SPRINT }),
      ctx(OUR_SPRINT)
    );

    expect(res.status).toBe(400);
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses both flags together without running the backlog sweep first", async () => {
    const res = await PUT(
      request({
        status: "completed",
        moveIncompleteToBacklog: true,
        moveIncompleteToSprint: THEIR_SPRINT,
      }),
      ctx(OUR_SPRINT)
    );

    expect(res.status).toBe(400);
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  it("does not run both moves over the top of each other when both are asked for", async () => {
    await PUT(
      request({
        status: "completed",
        moveIncompleteToBacklog: true,
        moveIncompleteToSprint: OUR_OTHER_SPRINT,
      }),
      ctx(OUR_SPRINT)
    );

    expect(taskUpdateMany).toHaveBeenCalledTimes(1);
    expect(taskUpdateMany).toHaveBeenCalledWith(expect.anything(), {
      $set: { sprint: OUR_OTHER_SPRINT },
    });
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

    expect(sprintFindOneAndDelete).toHaveBeenCalledWith({ _id: OUR_SPRINT, project: PROJECT });
    expect(taskUpdateMany).toHaveBeenCalledWith(
      { project: PROJECT, sprint: OUR_SPRINT },
      { $set: { sprint: null } }
    );
  });

  it("GET asks by project and counts only this project's tasks", async () => {
    await GET(new Request("https://app.example.com/x"), ctx(OUR_SPRINT));

    expect(sprintFindOne).toHaveBeenCalledWith({ _id: OUR_SPRINT, project: PROJECT });
    expect(taskCountDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ project: PROJECT, sprint: OUR_SPRINT })
    );
  });

  it("GET refuses another project's sprint", async () => {
    const res = await GET(new Request("https://app.example.com/x"), ctx(THEIR_SPRINT));

    expect(res.status).toBe(404);
  });

  it("GET refuses a malformed sprint id", async () => {
    const res = await GET(new Request("https://app.example.com/x"), ctx("not-an-id"));

    expect(res.status).toBe(400);
  });
});
