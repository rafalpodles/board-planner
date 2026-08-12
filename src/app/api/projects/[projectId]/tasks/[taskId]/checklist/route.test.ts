import { describe, it, expect, vi, beforeEach } from "vitest";

const findOneAndUpdate = vi.fn();
const findOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { findOneAndUpdate, findOne } }));
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, { ...(ctx as object), user: { _id: "u1" } }),
}));

const { DELETE, PUT } = await import("./route");

const ITEM_ID = "507f1f77bcf86cd799439011";

function request(method: string, body: unknown) {
  return new Request("https://app.example.com/api/projects/p1/tasks/t1/checklist", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: "p1", taskId: "t1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  findOneAndUpdate.mockResolvedValue({ _id: "t1", checklist: [] });
  findOne.mockResolvedValue({ _id: "t1", checklist: [], save: vi.fn() });
});

describe("DELETE /api/projects/:projectId/tasks/:taskId/checklist", () => {
  it("pulls the item named by a valid id", async () => {
    const res = await DELETE(request("DELETE", { itemId: ITEM_ID }), ctx());

    expect(res.status).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "t1", project: "p1" },
      { $pull: { checklist: { _id: ITEM_ID } } },
      expect.anything()
    );
  });

  // BP-304: {"$ne": null} became {$pull: {checklist: {_id: {$ne: null}}}} — the whole
  // checklist wiped in one call.
  it("refuses a Mongo operator in place of an itemId", async () => {
    const res = await DELETE(request("DELETE", { itemId: { $ne: null } }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("PUT /api/projects/:projectId/tasks/:taskId/checklist", () => {
  it("refuses a Mongo operator in place of an itemId", async () => {
    const res = await PUT(request("PUT", { itemId: { $ne: null }, done: true }), ctx());

    expect(res.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("refuses a reorder whose item carries a non-id _id", async () => {
    const body = { checklist: [{ text: "a", done: false, _id: { $ne: null } }] };

    const res = await PUT(request("PUT", body), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("still reorders items that carry a real id", async () => {
    const body = { checklist: [{ text: "a", done: false, _id: ITEM_ID }] };

    const res = await PUT(request("PUT", body), ctx());

    expect(res.status).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalled();
  });
});
