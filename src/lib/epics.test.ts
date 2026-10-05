import { describe, it, expect, vi } from "vitest";
import { epicClauses, epicProgressFor } from "./epics";
import { progressLine, tallyProgress } from "./epic-progress";
import type { ScopedDb } from "@/lib/db-scope";

const EPIC = "507f1f77bcf86cd799439011";
const OTHER = "507f1f77bcf86cd799439012";
const A = "507f1f77bcf86cd7994390a1";
const B = "507f1f77bcf86cd7994390a2";
const C = "507f1f77bcf86cd7994390a3";

const column = (id: string, role: string, order: number) => ({ id, label: id, color: "#000", role, order });

function fakeDb(opts: {
  parents: { _id: string; relations: { type: string; task: string }[] }[];
  statuses: Record<string, string>;
  columns?: ReturnType<typeof column>[];
}) {
  const taskFind = vi.fn((filter: { _id?: { $in: string[] }; relations?: unknown }, projection: string) => ({
    lean: async () =>
      projection === "relations"
        ? opts.parents.filter((p) => filter._id!.$in.includes(p._id))
        : filter._id!.$in.filter((id) => id in opts.statuses).map((id) => ({ _id: id, status: opts.statuses[id] })),
  }));
  const findOne = vi.fn(async () => null);
  const db = {
    Task: { find: taskFind, findOne },
    Project: { findById: () => ({ lean: async () => ({ columns: opts.columns }) }) },
  } as unknown as ScopedDb;
  return { db, taskFind };
}

describe("tallyProgress", () => {
  it("counts the statuses it is told are done", () => {
    expect(tallyProgress(["a", "b", "b", "c"], ["b", "c"])).toEqual({
      total: 4,
      done: 3,
      byStatus: { a: 1, b: 2, c: 1 },
    });
  });

  it("is 0 of 0 for no children", () => {
    expect(tallyProgress([], ["done"])).toEqual({ total: 0, done: 0, byStatus: {} });
  });

  it("reads a status no done column has as unfinished", () => {
    expect(tallyProgress(["gone"], ["done"]).done).toBe(0);
  });
});

describe("progressLine", () => {
  it("reads as the card does", () => {
    expect(progressLine({ done: 2, total: 5 })).toBe("2 of 5 done");
  });
});

describe("epicProgressFor", () => {
  it("takes done from the column's role, on a board whose done column is not called done", async () => {
    const { db } = fakeDb({
      parents: [{ _id: EPIC, relations: [{ type: "parent_of", task: A }, { type: "parent_of", task: B }, { type: "parent_of", task: C }] }],
      statuses: { [A]: "shipped", [B]: "doing", [C]: "done" },
      columns: [column("todo", "backlog", 0), column("doing", "active", 1), column("shipped", "done", 2), column("done", "active", 3)],
    });

    const progress = await epicProgressFor(db, "p1", [EPIC]);

    expect(progress.get(EPIC)).toEqual({ total: 3, done: 1, byStatus: { shipped: 1, doing: 1, done: 1 } });
  });

  it("counts every column carrying the done role", async () => {
    const { db } = fakeDb({
      parents: [{ _id: EPIC, relations: [{ type: "parent_of", task: A }, { type: "parent_of", task: B }] }],
      statuses: { [A]: "shipped", [B]: "archived" },
      columns: [column("todo", "backlog", 0), column("shipped", "done", 1), column("archived", "done", 2)],
    });

    expect((await epicProgressFor(db, "p1", [EPIC])).get(EPIC)?.done).toBe(2);
  });

  it("falls back to the default board's done column when the project stores none", async () => {
    const { db } = fakeDb({
      parents: [{ _id: EPIC, relations: [{ type: "parent_of", task: A }, { type: "parent_of", task: B }] }],
      statuses: { [A]: "done", [B]: "in_progress" },
    });

    expect((await epicProgressFor(db, "p1", [EPIC])).get(EPIC)).toMatchObject({ total: 2, done: 1 });
  });

  it("does not count a link that is not parent_of", async () => {
    const { db } = fakeDb({
      parents: [{ _id: EPIC, relations: [{ type: "relates", task: A }, { type: "parent_of", task: B }] }],
      statuses: { [A]: "done", [B]: "todo" },
      columns: [column("todo", "backlog", 0), column("done", "done", 1)],
    });

    expect((await epicProgressFor(db, "p1", [EPIC])).get(EPIC)).toMatchObject({ total: 1, done: 0 });
  });

  it("leaves a task with no children out, and a child that no longer exists uncounted", async () => {
    const { db } = fakeDb({
      parents: [{ _id: EPIC, relations: [{ type: "parent_of", task: A }, { type: "parent_of", task: B }] }],
      statuses: { [A]: "done" },
      columns: [column("todo", "backlog", 0), column("done", "done", 1)],
    });

    const progress = await epicProgressFor(db, "p1", [EPIC, OTHER]);

    expect(progress.has(OTHER)).toBe(false);
    expect(progress.get(EPIC)).toMatchObject({ total: 1, done: 1 });
  });

  it("answers for a whole page in two reads of tasks, however many epics it holds", async () => {
    const { db, taskFind } = fakeDb({
      parents: [
        { _id: EPIC, relations: [{ type: "parent_of", task: A }] },
        { _id: OTHER, relations: [{ type: "parent_of", task: B }, { type: "parent_of", task: C }] },
      ],
      statuses: { [A]: "done", [B]: "todo", [C]: "todo" },
      columns: [column("todo", "backlog", 0), column("done", "done", 1)],
    });

    const progress = await epicProgressFor(db, "p1", [EPIC, OTHER]);

    expect(taskFind).toHaveBeenCalledTimes(2);
    expect(progress.get(EPIC)).toMatchObject({ total: 1, done: 1 });
    expect(progress.get(OTHER)).toMatchObject({ total: 2, done: 0 });
  });

  it("asks nothing for an empty page, and reads no statuses when nothing on it has children", async () => {
    const empty = fakeDb({ parents: [], statuses: {} });
    expect((await epicProgressFor(empty.db, "p1", [])).size).toBe(0);
    expect(empty.taskFind).not.toHaveBeenCalled();

    const childless = fakeDb({ parents: [], statuses: {} });
    expect((await epicProgressFor(childless.db, "p1", [A])).size).toBe(0);
    expect(childless.taskFind).toHaveBeenCalledTimes(1);
  });

  it("stays inside the board it was asked about", async () => {
    const { db, taskFind } = fakeDb({
      parents: [{ _id: EPIC, relations: [{ type: "parent_of", task: A }] }],
      statuses: { [A]: "done" },
    });

    await epicProgressFor(db, "p1", [EPIC]);

    for (const [filter] of taskFind.mock.calls) expect(filter).toMatchObject({ project: "p1" });
  });
});

describe("epicClauses", () => {
  const dbWith = (parent: unknown) =>
    ({ Task: { findOne: () => ({ lean: async () => parent }) } }) as unknown as ScopedDb;

  it("restricts to the children named on the parent's own document", async () => {
    const result = await epicClauses(
      dbWith({ relations: [{ type: "parent_of", task: A }, { type: "relates", task: B }, { type: "parent_of", task: C }] }),
      "p1",
      { parent: EPIC }
    );

    expect(result).toEqual({ clauses: [{ _id: { $in: [A, C] } }] });
  });

  it("refuses a parent that is not an id, and one that is not on the board", async () => {
    expect(await epicClauses(dbWith(null), "p1", { parent: "nope" })).toEqual({ error: "Invalid parent id" });
    expect(await epicClauses(dbWith(null), "p1", { parent: EPIC })).toEqual({
      error: "Invalid parent — no such task on this board",
    });
  });

  it("asks for tasks that have children, or for those that have none", async () => {
    expect(await epicClauses(dbWith(null), "p1", { hasChildren: true })).toEqual({
      clauses: [{ relations: { $elemMatch: { type: "parent_of" } } }],
    });
    expect(await epicClauses(dbWith(null), "p1", { hasChildren: false })).toEqual({
      clauses: [{ relations: { $not: { $elemMatch: { type: "parent_of" } } } }],
    });
  });

  it("adds nothing when asked nothing", async () => {
    expect(await epicClauses(dbWith(null), "p1", {})).toEqual({ clauses: [] });
  });
});
