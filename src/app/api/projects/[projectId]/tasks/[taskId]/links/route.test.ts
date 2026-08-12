import { describe, it, expect, vi, beforeEach } from "vitest";

const findOneAndUpdate = vi.fn();
const findOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({
  Task: {
    findOneAndUpdate,
    findOne,
    find: () => ({ lean: async () => [] }),
    updateOne: vi.fn(),
    updateMany: vi.fn(),
  },
}));
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, { ...(ctx as object), user: { _id: "u1" } }),
}));

const { DELETE, POST } = await import("./route");

const OTHER_TASK = "507f1f77bcf86cd799439011";

function request(method: string, body: unknown) {
  return new Request("https://app.example.com/api/projects/p1/tasks/t1/links", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: "p1", taskId: "t1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  findOneAndUpdate.mockResolvedValue({ _id: "t1" });
  findOne.mockResolvedValue({ _id: "t1", relations: [], blockedBy: [], save: vi.fn() });
});

describe("DELETE /api/projects/:projectId/tasks/:taskId/links", () => {
  it("pulls the dependency named by a valid id", async () => {
    const res = await DELETE(request("DELETE", { taskId: OTHER_TASK }), ctx());

    expect(res.status).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "t1", project: "p1" },
      { $pull: { blockedBy: OTHER_TASK } },
      expect.anything()
    );
  });

  // BP-304: {"$ne": null} became {$pull: {blockedBy: {$ne: null}}} — every dependency
  // stripped in one call, uncast by Mongoose.
  it("refuses a Mongo operator in place of a taskId", async () => {
    const res = await DELETE(request("DELETE", { taskId: { $ne: null } }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses an operator in the legacy blockedByTaskId field too", async () => {
    const res = await DELETE(request("DELETE", { blockedByTaskId: { $ne: null } }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  // {$pull: {relations: {task, type: {$ne: null}}}} drops every relation to that task
  it("refuses an unknown dependency type", async () => {
    const res = await DELETE(request("DELETE", { taskId: OTHER_TASK, type: { $ne: null } }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("POST /api/projects/:projectId/tasks/:taskId/links", () => {
  it("refuses a Mongo operator in place of a taskId", async () => {
    const res = await POST(request("POST", { taskId: { $ne: null } }), ctx());

    expect(res.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
  });
});
