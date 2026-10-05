import { describe, it, expect, vi, beforeEach } from "vitest";

const epicClauses = vi.fn();
const epicProgressFor = vi.fn();
vi.mock("@/lib/epics", () => ({ epicClauses, epicProgressFor }));

const { PM_TOOLS, refuseUndeclaredArgs } = await import("./tools");

const EPIC_ID = "507f1f77bcf86cd799439011";
const ctx = { projectId: "p1", projectKey: "BP", pmUserId: "pm", triggeredByUserId: "pm" } as never;

function listDb(rows: { _id: string; taskNumber: number; title: string }[]) {
  const find = vi.fn(() => ({
    sort: () => ({ skip: () => ({ limit: () => ({ populate: async () => rows }) }) }),
  }));
  const countDocuments = vi.fn(async () => rows.length);
  const findOne = vi.fn(async () => ({ _id: EPIC_ID, taskNumber: 7 }));
  return { db: { Task: { find, countDocuments, findOne }, Project: { findById: () => ({ lean: async () => ({}) }) } } as never, find, countDocuments, findOne };
}

beforeEach(() => {
  epicClauses.mockReset().mockResolvedValue({ clauses: [] });
  epicProgressFor.mockReset().mockResolvedValue(new Map());
});

describe("the PM agent's list_tasks and an epic", () => {
  it("declares parent and hasChildren, so the argument guard lets them through", () => {
    expect(refuseUndeclaredArgs(PM_TOOLS.list_tasks, { parent: "BP-7", hasChildren: true })).toBeNull();
  });

  it("narrows to an epic's children by the same clauses the route uses, resolved from its key", async () => {
    const clause = { _id: { $in: ["c1"] } };
    epicClauses.mockResolvedValue({ clauses: [clause] });
    const { db, find, countDocuments } = listDb([]);

    await PM_TOOLS.list_tasks.execute(db, { parent: "BP-7" }, ctx);

    expect(epicClauses).toHaveBeenCalledWith(db, "p1", { parent: EPIC_ID, hasChildren: undefined });
    const used = { project: "p1", $and: [clause] };
    expect(find).toHaveBeenCalledWith(used);
    expect(countDocuments).toHaveBeenCalledWith(used);
  });

  it("passes hasChildren on", async () => {
    const { db } = listDb([]);

    await PM_TOOLS.list_tasks.execute(db, { hasChildren: true }, ctx);

    expect(epicClauses).toHaveBeenCalledWith(db, "p1", { parent: undefined, hasChildren: true });
  });

  it("filters on nothing extra when neither is given", async () => {
    const { db, find } = listDb([]);

    await PM_TOOLS.list_tasks.execute(db, {}, ctx);

    expect(find).toHaveBeenCalledWith({ project: "p1" });
  });

  it("says what is wrong rather than listing the whole board", async () => {
    epicClauses.mockResolvedValue({ error: "Invalid parent — no such task on this board" });
    const { db, find } = listDb([]);

    const outcome = await PM_TOOLS.list_tasks.execute(db, { parent: "BP-7" }, ctx);

    expect(outcome.result).toEqual({ error: "Invalid parent — no such task on this board" });
    expect(find).not.toHaveBeenCalled();
  });

  it("refuses a hasChildren that is not a boolean", async () => {
    const { db, find } = listDb([]);

    const outcome = await PM_TOOLS.list_tasks.execute(db, { hasChildren: "yes" }, ctx);

    expect(outcome.result).toEqual({ error: "hasChildren must be true or false" });
    expect(find).not.toHaveBeenCalled();
  });

  it("says how many of an epic's children are done, and nothing of it for a plain task", async () => {
    epicProgressFor.mockResolvedValue(new Map([["e", { total: 4, done: 1, byStatus: {} }]]));
    const { db } = listDb([
      { _id: "e", taskNumber: 1, title: "Epic" },
      { _id: "p", taskNumber: 2, title: "Plain" },
    ]);

    const { result } = await PM_TOOLS.list_tasks.execute(db, {}, ctx);

    const tasks = (result as { tasks: Record<string, unknown>[] }).tasks;
    expect(tasks[0].progress).toBe("1 of 4 done");
    expect(tasks[1]).not.toHaveProperty("progress");
  });
});

describe("the PM agent's get_task on an epic", () => {
  function getDb(relations: unknown[]) {
    const task = {
      _id: "e",
      taskNumber: 1,
      title: "Epic",
      status: "todo",
      priority: "medium",
      description: "",
      checklist: [],
      blockedBy: [],
      relations,
    };
    const populated = { populate: () => populated, then: (resolve: (t: unknown) => void) => resolve(task) };
    return {
      Task: { findOne: async () => task, findById: () => populated },
    } as never;
  }

  it("lists the children by key beside the progress", async () => {
    epicProgressFor.mockResolvedValue(new Map([["e", { total: 2, done: 1, byStatus: {} }]]));
    const db = getDb([
      { type: "parent_of", task: { taskNumber: 8, title: "A", status: "done" } },
      { type: "relates", task: { taskNumber: 9, title: "Not a child", status: "todo" } },
      { type: "parent_of", task: { taskNumber: 10, title: "B", status: "todo" } },
    ]);

    const { result } = await PM_TOOLS.get_task.execute(db, { taskKey: "BP-1" }, ctx);

    expect(result).toMatchObject({
      progress: "1 of 2 done",
      children: [
        { key: "BP-8", title: "A", status: "done" },
        { key: "BP-10", title: "B", status: "todo" },
      ],
    });
  });

  it("leaves both out for a task with no children", async () => {
    const { result } = await PM_TOOLS.get_task.execute(getDb([]), { taskKey: "BP-1" }, ctx);

    expect(result).not.toHaveProperty("progress");
    expect(result).not.toHaveProperty("children");
  });
});
