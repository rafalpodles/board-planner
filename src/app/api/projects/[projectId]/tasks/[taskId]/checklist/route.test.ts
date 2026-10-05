import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const getAuthUser = vi.fn();
const check = vi.fn();
const taskFindOneAndUpdate = vi.fn();
const taskExists = vi.fn();
const logActivity = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/lib/activity", () => ({ logActivity }));
vi.mock("@/models/task", () => ({ Task: { findOneAndUpdate: taskFindOneAndUpdate, exists: taskExists } }));

const { POST } = await import("./route");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const TASK_ID = "507f1f77bcf86cd799439021";
const ME = new Types.ObjectId("507f1f77bcf86cd799439031");

function post(body?: unknown, taskId = TASK_ID) {
  return POST(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/tasks/${taskId}/checklist`, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
    { params: Promise.resolve({ projectId: PROJECT_ID, taskId }) }
  );
}

const filter = () => taskFindOneAndUpdate.mock.calls[0][0];
const update = () => taskFindOneAndUpdate.mock.calls[0][1];

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: ME, role: "member" });
  check.mockResolvedValue(true);
  taskFindOneAndUpdate.mockImplementation(async (_f: unknown, change: { $push: { checklist: unknown } }) => ({
    checklist: [change.$push.checklist],
  }));
});

describe("POST /api/projects/:projectId/tasks/:taskId/checklist", () => {
  it("pushes one criterion with its own id, in one update with no read before it", async () => {
    const res = await post({ text: "  one more  " });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(update().$push.checklist).toMatchObject({ text: "one more", done: false });
    expect(body.item).toMatchObject({ text: "one more", done: false });
    expect(String(update().$push.checklist._id)).toMatch(/^[0-9a-f]{24}$/);
    expect(filter()).toMatchObject({ _id: TASK_ID, project: PROJECT_ID });
    expect(taskExists).not.toHaveBeenCalled();
  });

  it("can add one that is already done", async () => {
    await post({ text: "x", done: true });

    expect(update().$push.checklist.done).toBe(true);
  });

  it("puts the cap in the match, so two adds racing cannot both pass it", async () => {
    await post({ text: "x" });

    expect(filter()).toHaveProperty("checklist.199", { $exists: false });
  });

  it("says why when the cap is what stopped it, and says 404 when the task is not there", async () => {
    taskFindOneAndUpdate.mockResolvedValue(null);

    taskExists.mockResolvedValue({ _id: TASK_ID });
    const full = await post({ text: "x" });
    expect(full.status).toBe(400);
    expect((await full.json()).error).toMatch(/at most 200/);

    taskExists.mockResolvedValue(null);
    expect((await post({ text: "x" })).status).toBe(404);
  });

  it("records the addition in the history, as the whole-list write does", async () => {
    await post({ text: "one more" });

    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      TASK_ID,
      ME,
      "criterion_added",
      String(update().$push.checklist._id),
      "",
      "one more"
    );
  });

  it.each([[{}], [{ text: "" }], [{ text: "   " }], [{ text: 5 }], [{ text: "x".repeat(501) }], [{ text: "a​b" }], [undefined]])(
    "refuses %j with 400 and writes nothing",
    async (body) => {
      expect((await post(body)).status).toBe(400);
      expect(taskFindOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  it("refuses a done that is not a boolean, and an id that is not an id", async () => {
    expect((await post({ text: "x", done: "yes" })).status).toBe(400);
    expect((await post({ text: "x" }, "not-an-id")).status).toBe(400);
    expect(taskFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
