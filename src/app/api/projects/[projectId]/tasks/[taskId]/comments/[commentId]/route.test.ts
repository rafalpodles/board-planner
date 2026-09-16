import { describe, it, expect, vi, beforeEach } from "vitest";

const taskFindOne = vi.fn();
const commentFindOne = vi.fn();
const save = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { findOne: taskFindOne } }));
vi.mock("@/models/comment", () => ({
  Comment: {
    findOne: commentFindOne,
    findById: () => ({ populate: () => Promise.resolve({ _id: "c1" }) }),
  },
}));
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, { ...(ctx as object), user: { _id: "author1" } }),
}));

const { PUT } = await import("./route");

let comment: { author: { toString(): string }; body: string; save: typeof save };

function edit(body: string) {
  return PUT(
    new Request("https://app.example.com/x", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    }),
    { params: Promise.resolve({ projectId: "p1", taskId: "t1", commentId: "c1" }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  taskFindOne.mockResolvedValue({ _id: "t1" });
  comment = { author: { toString: () => "author1" }, body: "before", save };
  commentFindOne.mockResolvedValue(comment);
});

// BP-323: the create path caps a comment, and an edit is the other way to grow one
describe("PUT a comment", () => {
  it("refuses an edit past the length cap and keeps the comment as it was", async () => {
    const res = await edit("c".repeat(20_001));

    expect(res.status).toBe(400);
    expect(comment.body).toBe("before");
    expect(save).not.toHaveBeenCalled();
  });

  it("stores an edit at the cap", async () => {
    const res = await edit("c".repeat(20_000));

    expect(res.status).not.toBe(400);
    expect(save).toHaveBeenCalled();
  });
});
