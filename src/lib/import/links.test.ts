import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const logActivities = vi.fn();
vi.mock("@/lib/activity", () => ({ logActivities: (...a: unknown[]) => logActivities(...a) }));

const { linkImported } = await import("./links");

const IMPORTER = new Types.ObjectId();

interface Row {
  _id: Types.ObjectId;
  taskNumber: number;
  externalRef?: { source: string; id: string };
  relations: { task: Types.ObjectId; type: string }[];
  blockedBy: Types.ObjectId[];
}

function board(rows: { ref?: string; source?: string }[]) {
  const tasks: Row[] = rows.map((r, i) => ({
    _id: new Types.ObjectId(),
    taskNumber: i + 1,
    ...(r.ref && { externalRef: { source: r.source ?? "jira", id: r.ref } }),
    relations: [],
    blockedBy: [],
  }));
  const writes: unknown[] = [];
  const chain = <T>(value: () => T) => ({ select: () => ({ lean: async () => value() }), lean: async () => value() });
  const db = {
    Project: { findById: () => ({ lean: async () => ({ key: "TP" }) }) },
    Task: {
      find: (filter: Record<string, unknown>) =>
        chain(() => {
          if (filter["externalRef.id"]) {
            const ids = (filter["externalRef.id"] as { $in: string[] }).$in;
            return tasks.filter((t) => t.externalRef?.source === filter["externalRef.source"] && ids.includes(t.externalRef!.id));
          }
          return tasks;
        }),
      bulkWrite: async (ops: { updateOne: { filter: { _id: string }; update: Record<string, Record<string, unknown>> } }[]) => {
        writes.push(...ops);
        for (const { updateOne } of ops) {
          const t = tasks.find((x) => String(x._id) === String(updateOne.filter._id))!;
          if (updateOne.update.$push) t.relations.push(updateOne.update.$push.relations as Row["relations"][number]);
          if (updateOne.update.$addToSet) t.blockedBy.push(updateOne.update.$addToSet.blockedBy as Types.ObjectId);
        }
      },
    },
  };
  return { db: db as never, tasks, writes };
}

const run = (db: never, tasks: { id: string; parent?: string; blockedBy?: string[] }[], opts = { dryRun: false, pending: new Set<string>() }) =>
  linkImported(db, "p1", IMPORTER, "jira", tasks.map((t) => ({ title: "t", ...t })), opts);

beforeEach(() => vi.clearAllMocks());

describe("linkImported", () => {
  it("links a parent and a blocker inside one import, with a history row at both ends", async () => {
    const { db, tasks } = board([{ ref: "A" }, { ref: "B" }, { ref: "C" }]);
    const outcome = await run(db, [{ id: "A" }, { id: "B", parent: "A", blockedBy: ["C"] }, { id: "C" }]);
    expect(outcome).toEqual({ created: 2, unlinked: [] });
    expect(tasks[0].relations).toEqual([{ task: tasks[1]._id, type: "parent_of" }]);
    expect(tasks[1].blockedBy).toEqual([tasks[2]._id]);
    expect((logActivities.mock.calls[0][1] as { field: string; newValue: string }[]).map((r) => [r.field, r.newValue])).toEqual([
      ["parent_of", "TP-2"],
      ["child_of", "TP-1"],
      ["blocked_by", "TP-3"],
      ["blocks", "TP-2"],
    ]);
  });

  it("finds a task an earlier import of the same source made, and lists a reference that names nothing", async () => {
    const { db, tasks } = board([{ ref: "OLD-1" }, { ref: "NEW-1" }, { ref: "X", source: "trello" }]);
    const outcome = await run(db, [{ id: "NEW-1", parent: "OLD-1", blockedBy: ["X", "GONE"] }]);
    expect(outcome.created).toBe(1);
    expect(tasks[0].relations).toHaveLength(1);
    expect(outcome.unlinked).toEqual([
      { id: "NEW-1", what: "blocked by “X”: no such task in this file or an earlier import" },
      { id: "NEW-1", what: "blocked by “GONE”: no such task in this file or an earlier import" },
    ]);
  });

  it("adds nothing twice on a re-run, and never takes a child off the parent the board gave it", async () => {
    const { db, tasks, writes } = board([{ ref: "P" }, { ref: "C" }, { ref: "Q" }, { ref: "B" }]);
    await run(db, [{ id: "C", parent: "P", blockedBy: ["B"] }]);
    writes.length = 0;
    const again = await run(db, [{ id: "C", parent: "P", blockedBy: ["B"] }]);
    expect(again).toEqual({ created: 0, unlinked: [] });
    expect(writes).toEqual([]);
    const moved = await run(db, [{ id: "C", parent: "Q" }]);
    expect(moved.unlinked).toEqual([{ id: "C", what: "parent “Q”: it already has another parent on the board" }]);
    expect(tasks[2].relations).toEqual([]);
  });

  it("refuses a loop of parents or of blockers, and a task naming itself", async () => {
    const { db } = board([{ ref: "A" }, { ref: "B" }, { ref: "C" }]);
    const outcome = await run(db, [
      { id: "A", parent: "B", blockedBy: ["C"] },
      { id: "B", parent: "A" },
      { id: "C", blockedBy: ["A", "C"] },
    ]);
    expect(outcome.created).toBe(2);
    expect(outcome.unlinked).toEqual([
      { id: "B", what: "parent “A”: it would be its own ancestor" },
      { id: "C", what: "blocked by “A”: the two would block each other" },
      { id: "C", what: "blocked by: names the task itself" },
    ]);
  });

  it("leaves a pair already linked another way as it is", async () => {
    const { db, tasks } = board([{ ref: "P" }, { ref: "C" }]);
    tasks[0].relations.push({ task: tasks[1]._id, type: "relates" });
    const outcome = await run(db, [{ id: "C", parent: "P" }]);
    expect(outcome.unlinked).toEqual([{ id: "C", what: "parent “P”: the two are already linked another way" }]);
  });

  it("counts on a dry run what the real run will link, for tasks the file has not made yet, writing nothing", async () => {
    const { db, writes } = board([{ ref: "OLD" }]);
    const tasks = [{ id: "NEW", parent: "OLD" }, { id: "KID", parent: "NEW" }];
    const dry = await run(db, tasks, { dryRun: true, pending: new Set(["NEW", "KID"]) });
    expect(dry).toEqual({ created: 2, unlinked: [] });
    expect(writes).toEqual([]);
    expect(logActivities).not.toHaveBeenCalled();
  });

  it("refuses a task as its own parent", async () => {
    const { db } = board([{ ref: "A" }]);
    expect((await run(db, [{ id: "A", parent: "A" }])).unlinked).toEqual([{ id: "A", what: "parent: names the task itself" }]);
  });

  it("names why a task of the file has nothing to link: skipped, or not reached before a stop", async () => {
    const { db } = board([{ ref: "A" }]);
    const outcome = await linkImported(
      db,
      "p1",
      IMPORTER,
      "jira",
      [{ id: "A", title: "t", parent: "S" }, { id: "L", title: "t", parent: "A" }],
      { dryRun: false, pending: new Set(), absent: new Map([["S", "was skipped: no title"], ["L", "was not imported: the import stopped"]]) }
    );
    expect(outcome.unlinked).toEqual([
      { id: "A", what: "parent “S”: that task was skipped: no title" },
      { id: "L", what: "parent “A”: this task was not imported: the import stopped" },
    ]);
  });

  it("counts and records only a link that landed", async () => {
    const { db, tasks } = board([{ ref: "P" }, { ref: "C" }]);
    (db as unknown as { Task: { bulkWrite: () => Promise<void> } }).Task.bulkWrite = async () => {};
    const outcome = await run(db, [{ id: "C", parent: "P" }]);
    expect(outcome.created).toBe(0);
    expect(tasks[0].relations).toEqual([]);
    expect(logActivities.mock.calls[0]?.[1] ?? []).toEqual([]);
  });
});
