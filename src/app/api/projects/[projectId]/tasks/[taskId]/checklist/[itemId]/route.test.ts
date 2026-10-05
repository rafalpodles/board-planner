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

const { PATCH, DELETE } = await import("./route");

const PROJECT_ID = "507f1f77bcf86cd799439011";
const TASK_ID = "507f1f77bcf86cd799439021";
const A = "507f1f77bcf86cd799439041";
const B = "507f1f77bcf86cd799439042";
const ME = new Types.ObjectId("507f1f77bcf86cd799439031");

// As the row stood BEFORE the write: the route hands the history what this write changed
const BEFORE = {
  checklist: [
    { _id: new Types.ObjectId(A), text: "first", done: false },
    { _id: new Types.ObjectId(B), text: "second", done: true },
  ],
};

function request(method: "PATCH" | "DELETE", body?: unknown, ids = { taskId: TASK_ID, itemId: A }) {
  const init = { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) };
  const context = { params: Promise.resolve({ projectId: PROJECT_ID, ...ids }) };
  const url = `http://localhost/api/projects/${PROJECT_ID}/tasks/${ids.taskId}/checklist/${ids.itemId}`;
  return (method === "PATCH" ? PATCH : DELETE)(new Request(url, init), context);
}

const filter = () => taskFindOneAndUpdate.mock.calls[0][0];
const change = () => taskFindOneAndUpdate.mock.calls[0][1];
const options = () => taskFindOneAndUpdate.mock.calls[0][2];

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: ME, role: "member" });
  check.mockResolvedValue(true);
  taskFindOneAndUpdate.mockResolvedValue(BEFORE);
});

describe("PATCH …/checklist/:itemId", () => {
  it("sets the one row by its id, in one update, and leaves the others to the array filter", async () => {
    const res = await request("PATCH", { done: true });

    expect(res.status).toBe(200);
    expect(filter()).toMatchObject({ _id: TASK_ID, project: PROJECT_ID, "checklist._id": A });
    expect(change()).toEqual({ $set: { "checklist.$[c].done": true } });
    expect(options()).toMatchObject({ arrayFilters: [{ "c._id": A }], returnDocument: "before" });
    expect((await res.json()).checklist.map((c: { done: boolean }) => c.done)).toEqual([true, true]);
  });

  it("sets only what it was given", async () => {
    await request("PATCH", { text: "  first, reworded " });

    expect(change()).toEqual({ $set: { "checklist.$[c].text": "first, reworded" } });
  });

  it("records a tick, an untick and a rewording as the whole-list write does", async () => {
    await request("PATCH", { done: true, text: "first, reworded" });

    expect(logActivity).toHaveBeenCalledWith(expect.anything(), TASK_ID, ME, "criterion_edited", A, "first", "first, reworded");
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), TASK_ID, ME, "criterion_checked", A, "", "first, reworded");

    logActivity.mockClear();
    await request("PATCH", { done: false }, { taskId: TASK_ID, itemId: B });
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), TASK_ID, ME, "criterion_unchecked", B, "", "second");
  });

  it("records nothing for a write that changed nothing", async () => {
    await request("PATCH", { done: false, text: "first" });

    expect(logActivity).not.toHaveBeenCalled();
  });

  it("answers 404 for a task that is not there and for a criterion that is not on it", async () => {
    taskFindOneAndUpdate.mockResolvedValue(null);

    taskExists.mockResolvedValue(null);
    expect((await (await request("PATCH", { done: true })).json()).error).toBe("Task not found");
    taskExists.mockResolvedValue({ _id: TASK_ID });
    const res = await request("PATCH", { done: true });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Criterion not found");
  });

  it.each([[{}], [undefined], [{ text: "" }], [{ text: 3 }], [{ done: "yes" }], [{ text: "a​b" }]])(
    "refuses %j with 400 and writes nothing",
    async (body) => {
      expect((await request("PATCH", body)).status).toBe(400);
      expect(taskFindOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  it("refuses an id that is not an id", async () => {
    expect((await request("PATCH", { done: true }, { taskId: TASK_ID, itemId: "nope" })).status).toBe(400);
    expect((await request("PATCH", { done: true }, { taskId: "nope", itemId: A })).status).toBe(400);
  });
});

describe("DELETE …/checklist/:itemId", () => {
  it("pulls the one row by its id and answers with what is left", async () => {
    const res = await request("DELETE");

    expect(change()).toEqual({ $pull: { checklist: { _id: A } } });
    expect(filter()).toMatchObject({ _id: TASK_ID, project: PROJECT_ID, "checklist._id": A });
    expect((await res.json()).checklist.map((c: { text: string }) => c.text)).toEqual(["second"]);
  });

  it("records the removal with the text that was removed", async () => {
    await request("DELETE");

    expect(logActivity).toHaveBeenCalledWith(expect.anything(), TASK_ID, ME, "criterion_removed", A, "first", "");
  });

  it("answers 404 for a criterion that is not there", async () => {
    taskFindOneAndUpdate.mockResolvedValue(null);
    taskExists.mockResolvedValue({ _id: TASK_ID });

    expect((await request("DELETE")).status).toBe(404);
    expect(logActivity).not.toHaveBeenCalled();
  });
});
