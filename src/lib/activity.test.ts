import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const insertMany = vi.fn();
const updateOne = vi.fn();
const deleteOne = vi.fn();
const latestRow = vi.fn();

vi.mock("@/models/activityLog", () => ({
  ActivityLog: {
    create,
    insertMany,
    updateOne,
    deleteOne,
    findOne: () => ({ sort: () => ({ select: () => ({ lean: latestRow }) }) }),
  },
}));

const { logActivity, logActivities, logEditSession, EDIT_SESSION_MS } = await import("./activity");

beforeEach(() => {
  vi.clearAllMocks();
  create.mockReset();
  insertMany.mockReset();
  updateOne.mockReset();
  deleteOne.mockReset();
  latestRow.mockReset();
});

/**
 * Every other test file in this repo mocks `@/lib/activity`, so until this one existed the module
 * could be emptied out entirely — an early `return` before the write — with the whole suite green.
 */
describe("logActivities", () => {
  const row = (taskId: string, newValue: string) => ({
    taskId,
    userId: "u1",
    action: "link_added" as const,
    field: "relates",
    newValue,
  });

  it("writes the rows in the order it was given them", async () => {
    await logActivities([row("a", "BP-2"), row("b", "BP-1")]);

    expect(insertMany).toHaveBeenCalledTimes(1);
    expect(insertMany.mock.calls[0][0].map((d: { task: string }) => d.task)).toEqual(["a", "b"]);
    // And no options: `ordered` defaults to true, which is what stops the server reordering them
    // and what decides whether a failure leaves the earlier rows behind.
    expect(insertMany.mock.calls[0]).toHaveLength(1);
  });

  // The order is the whole reason this is one call: a reader breaks a createdAt tie on _id, and
  // Mongoose mints those while casting, in array order.
  it("maps each row the way logActivity maps its arguments", async () => {
    await logActivities([
      { taskId: "a", userId: "u1", action: "link_removed", field: "parent_of", oldValue: "BP-9" },
    ]);

    expect(insertMany.mock.calls[0][0]).toEqual([
      { task: "a", user: "u1", action: "link_removed", field: "parent_of", oldValue: "BP-9", newValue: "" },
    ]);
  });

  it("writes nothing rather than an empty batch", async () => {
    await logActivities([]);

    expect(insertMany).not.toHaveBeenCalled();
  });

  // The contract every caller relies on: a history row must never break the write it describes
  it("does not propagate a failed write", async () => {
    insertMany.mockRejectedValue(new Error("no"));

    await expect(logActivities([row("a", "BP-2")])).resolves.toBeUndefined();
  });

  // An ordered bulk keeps what went in before the failure, and `rows` is built losses-first — so
  // a truncated batch is a timeline saying a task lost its parent and never gained one. The count
  // is the only way an operator can tell that from a batch that wrote nothing.
  it("says how much of a truncated batch was written", async () => {
    const partial = Object.assign(new Error("interrupted"), { insertedDocs: [{}, {}] });
    insertMany.mockRejectedValue(partial);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await logActivities([row("a", "1"), row("b", "2"), row("c", "3")]);

    expect(warn).toHaveBeenCalledWith("Failed to log activity: wrote 2 of 3 rows");
    warn.mockRestore();
  });

  it("reports nothing written when the batch never reached the server", async () => {
    insertMany.mockRejectedValue(new Error("validation"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await logActivities([row("a", "1")]);

    expect(warn).toHaveBeenCalledWith("Failed to log activity: wrote 0 of 1 rows");
    warn.mockRestore();
  });
});

describe("logActivity", () => {
  it("normalises the three optional fields to empty strings", async () => {
    await logActivity("a", "u1", "created");

    expect(create).toHaveBeenCalledWith({
      task: "a",
      user: "u1",
      action: "created",
      field: "",
      oldValue: "",
      newValue: "",
    });
  });

  // Null is a sync writing about what GitHub said, which no person authored (BP-628)
  it("keeps a null author rather than dropping the row", async () => {
    await logActivity("a", null, "pr_linked", "linkedPRs", "", "https://example/pull/1");

    expect(create.mock.calls[0][0]).toMatchObject({ user: null, newValue: "https://example/pull/1" });
  });

  it("does not propagate a failed write", async () => {
    create.mockRejectedValue(new Error("no"));

    await expect(logActivity("a", "u1", "created")).resolves.toBeUndefined();
  });
});

describe("logEditSession", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    _id: "row1",
    user: "u1",
    action: "updated",
    field: "description",
    oldValue: "before the session",
    createdAt: new Date(Date.now() - 60_000),
    ...over,
  });

  it("writes a new row when nothing is in progress", async () => {
    latestRow.mockResolvedValue(null);

    await logEditSession("t1", "u1", "description", "a", "b");

    expect(create).toHaveBeenCalledWith({
      task: "t1",
      user: "u1",
      action: "updated",
      field: "description",
      oldValue: "a",
      newValue: "b",
    });
  });

  // Typing a paragraph saved it dozens of times; each save was a row with the whole text in it
  it("extends the same person's edit instead of adding a row, keeping what it said before", async () => {
    latestRow.mockResolvedValue(row());

    await logEditSession("t1", "u1", "description", "half typed", "fully typed");

    expect(create).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledWith({ _id: "row1" }, { $set: { newValue: "fully typed" } });
  });

  it("leaves no row when the session ends where it began", async () => {
    latestRow.mockResolvedValue(row());

    await logEditSession("t1", "u1", "description", "something", "before the session");

    expect(deleteOne).toHaveBeenCalledWith({ _id: "row1" });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["somebody else's edit", { user: "u2" }],
    ["an edit of another field", { field: "title" }],
    ["an older edit", { createdAt: new Date(Date.now() - EDIT_SESSION_MS - 1_000) }],
    ["a row that is not an edit", { action: "status_changed" }],
  ])("starts a new row after %s", async (_label, over) => {
    latestRow.mockResolvedValue(row(over));

    await logEditSession("t1", "u1", "description", "a", "b");

    expect(updateOne).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  });
});
