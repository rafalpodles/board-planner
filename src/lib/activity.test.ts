import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const insertMany = vi.fn();

vi.mock("@/models/activityLog", () => ({ ActivityLog: { create, insertMany } }));

const { logActivity, logActivities } = await import("./activity");

beforeEach(() => {
  vi.clearAllMocks();
  create.mockReset();
  insertMany.mockReset();
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
