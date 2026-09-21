import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const insertMany = vi.fn();

vi.mock("@/models/activityLog", () => ({ ActivityLog: { create, insertMany } }));

const { logActivity, logActivities, editSessions, presentSessions, EDIT_SESSION_MS } = await import(
  "./activity"
);

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

  it("marks a project's field and its type, and only that", async () => {
    await logActivities([
      { taskId: "a", userId: "u1", action: "updated", field: "Notes", oldValue: "x", newValue: "y", customField: true, fieldType: "text" },
      { taskId: "a", userId: "u1", action: "updated", field: "title", oldValue: "x", newValue: "y" },
    ]);

    const [custom, builtIn] = insertMany.mock.calls[0][0];
    expect(custom).toMatchObject({ customField: true, fieldType: "text" });
    expect(builtIn).not.toHaveProperty("customField");
    expect(builtIn).not.toHaveProperty("fieldType");
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

describe("editSessions", () => {
  const t0 = new Date("2026-09-21T10:00:00Z").getTime();
  let n = 0;
  const row = (minutesAgo: number, over: Record<string, unknown> = {}) => ({
    _id: `r${++n}`,
    user: "u1",
    action: "updated",
    field: "description",
    customField: false,
    createdAt: new Date(t0 - minutesAgo * 60_000),
    ...over,
  });
  const ids = (sessions: ReturnType<typeof editSessions>) =>
    sessions.map((s) => [String(s.newest._id), String(s.oldest._id)]);

  it("folds one person's saves of one typed field into a session", () => {
    const a = row(1);
    const b = row(3);
    const c = row(5);
    expect(ids(editSessions([a, b, c] as never))).toEqual([[a._id, c._id]]);
  });

  it("measures the gap between saves, not the length of the session", () => {
    const rows = [row(0), row(8), row(16), row(24)];
    expect(editSessions(rows as never)).toHaveLength(1);
  });

  it.each([
    ["somebody else's save", { user: "u2" }],
    ["another field", { field: "title" }],
    ["a project field that happens to share the name", { customField: true }],
    ["a change that is not a typed edit", { action: "status_changed", field: "status" }],
    ["a pick from a list", { field: "priority" }],
  ])("keeps %s apart", (_label, over) => {
    const rows = [row(1), row(2, over), row(3)];
    expect(editSessions(rows as never)).toHaveLength(3);
  });

  it("ends a session after a pause longer than the window", () => {
    const rows = [row(0), row(EDIT_SESSION_MS / 60_000 + 1)];
    expect(editSessions(rows as never)).toHaveLength(2);
  });

  it.each(["text", "number"])("folds a project's own %s field as well", (fieldType) => {
    const rows = [
      row(1, { field: "Notes", customField: true, fieldType }),
      row(2, { field: "Notes", customField: true, fieldType }),
    ];
    expect(editSessions(rows as never)).toHaveLength(1);
  });

  it.each(["checkbox", "dropdown", "multiselect", "date"])(
    "keeps every change to a project's %s field, since each one is a choice",
    (fieldType) => {
      const rows = [
        row(1, { field: "Approved", customField: true, fieldType }),
        row(2, { field: "Approved", customField: true, fieldType }),
      ];
      expect(editSessions(rows as never)).toHaveLength(2);
    }
  );
});

describe("presentSessions", () => {
  const full = (id: string, oldValue: string, newValue: string, over: Record<string, unknown> = {}) => ({
    _id: id,
    field: "title",
    customField: false,
    oldValue,
    newValue,
    ...over,
  });
  const session = (newest: string, oldest: string) => ({
    newest: { _id: newest },
    oldest: { _id: oldest },
  });

  it("shows a session as what the field said before it and what it says after", () => {
    const shown = presentSessions([session("b", "a")] as never, [full("a", "one", "two"), full("b", "two", "three")]);
    expect(shown).toEqual([expect.objectContaining({ _id: "b", oldValue: "one", newValue: "three" })]);
  });

  it("drops a session that ended where it began", () => {
    const shown = presentSessions([session("b", "a")] as never, [full("a", "one", "two"), full("b", "two", "one")]);
    expect(shown).toEqual([]);
  });

  // A single row is a real change whatever it says
  it("keeps a single row as written", () => {
    const shown = presentSessions([session("a", "a")] as never, [full("a", "one", "two")]);
    expect(shown).toEqual([expect.objectContaining({ oldValue: "one", newValue: "two" })]);
  });

  it("says when a description run ended with the description gone", () => {
    const shown = presentSessions(
      [{ newest: { _id: "b" }, oldest: { _id: "a" } }] as never,
      [full("a", "old", "mid", { field: "description" }), full("b", "mid", "", { field: "description" })]
    );
    expect(shown).toEqual([expect.objectContaining({ oldValue: "old", newValue: "", cleared: true })]);
  });

  it("omits the description's new text, which the history never shows", () => {
    const shown = presentSessions(
      [session("a", "a"), session("c", "c")] as never,
      [full("a", "old", "new", { field: "description" }), full("c", "x", "y", { field: "description", customField: true })]
    );
    expect(shown.map((r) => r.newValue)).toEqual(["", "y"]);
  });
});
