import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const recipientsWithAccess = vi.fn();
const logActivities = vi.fn();
const logProjectAudit = vi.fn();

vi.mock("@/lib/grants", () => ({ recipientsWithAccess: (...a: unknown[]) => recipientsWithAccess(...a) }));
vi.mock("@/lib/activity", () => ({ logActivities: (...a: unknown[]) => logActivities(...a) }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit: (...a: unknown[]) => logProjectAudit(...a) }));

const { runImport, IMPORT_CHUNK } = await import("./engine");
const { currentProvenance } = await import("@/lib/activity-source");

const IMPORTER = new Types.ObjectId();
const MEMBER = new Types.ObjectId();
const SIZE_FIELD = new Types.ObjectId();

const project = {
  columns: [
    { id: "backlog", label: "Backlog", role: "backlog", order: 0 },
    { id: "doing", label: "In Progress", role: "active", order: 1 },
    { id: "done", label: "Done", role: "done", order: 2 },
  ],
  categories: [{ name: "bug" }, { name: "user-story" }],
  customFields: [
    { _id: SIZE_FIELD, name: "Size", fieldType: "dropdown", options: [{ id: "s", value: "Small" }, { id: "l", value: "Large" }], order: 0 },
    { _id: new Types.ObjectId(), name: "Points", fieldType: "number", order: 1 },
  ],
};

type Existing = { id: string; status?: string; held?: boolean; comments?: string[] };

function fakeDb({ existing = [] as Existing[], failOn = 0, landBeforeFailing = 0 } = {}) {
  let counter = 10;
  let inserts = 0;
  const writes = {
    tasks: [] as Record<string, unknown>[],
    updates: [] as { filter: unknown; update: { $set: Record<string, unknown> } }[],
    comments: [] as Record<string, unknown>[],
    sources: [] as string[],
    taskQueries: [] as Record<string, unknown>[],
  };
  const rows = existing.map((e) => ({ _id: new Types.ObjectId(), status: e.status ?? "backlog", externalRef: { id: e.id }, execution: e.held ? { runId: "r1" } : {}, comments: e.comments ?? [] }));
  const chain = <T>(value: () => T) => ({ select: () => ({ lean: async () => value() }), lean: async () => value() });
  const db = {
    Project: {
      findById: () => ({ lean: async () => project }),
      findOneAndUpdate: (_f: unknown, update: { $inc: { taskCounter: number } }) => {
        counter += update.$inc.taskCounter;
        return { lean: async () => ({ taskCounter: counter }) };
      },
    },
    User: {
      find: () => chain(() => [{ _id: MEMBER, username: "maya" }]),
    },
    Task: {
      find: (filter: Record<string, unknown>) => {
        writes.taskQueries.push(filter);
        const ids = (filter["externalRef.id"] as { $in: string[] }).$in;
        return chain(() => [
          ...rows.filter((r) => ids.includes(r.externalRef.id)),
          ...writes.tasks.filter((t) => ids.includes((t.externalRef as { id: string }).id)),
        ]);
      },
      insertMany: async (docs: Record<string, unknown>[]) => {
        inserts += 1;
        if (failOn && inserts === failOn) {
          writes.tasks.push(...docs.slice(0, landBeforeFailing));
          throw Object.assign(new Error("E11000 duplicate key error collection: tasks index: project_1_externalRef"), { code: 11000 });
        }
        writes.sources.push(currentProvenance().source);
        writes.tasks.push(...docs);
      },
      bulkWrite: async (ops: { updateOne: { filter: unknown; update: { $set: Record<string, unknown> } } }[]) =>
        void writes.updates.push(...ops.map((o) => o.updateOne)),
    },
    Comment: {
      find: (filter: Record<string, unknown>) =>
        chain(() =>
          rows
            .filter((r) => {
              const task = filter.task as { $in?: unknown[] } | unknown;
              return task && typeof task === "object" && "$in" in (task as object)
                ? ((task as { $in: unknown[] }).$in as unknown[]).includes(r._id)
                : task === r._id;
            })
            .flatMap((r) => r.comments.map((id) => ({ _id: new Types.ObjectId(), task: r._id, externalRef: { id } })))
        ),
      insertMany: async (docs: Record<string, unknown>[]) => void writes.comments.push(...docs),
      bulkWrite: async () => undefined,
    },
  };
  return { db: db as never, writes, rows };
}

const run = (db: never, tasks: Record<string, unknown>[], mapping = {}, dryRun = false) =>
  runImport(db, "p1", IMPORTER, { source: "jira", tasks: tasks as never }, mapping, { dryRun });

beforeEach(() => {
  vi.clearAllMocks();
  recipientsWithAccess.mockImplementation(async (_db: unknown, ids: string[]) => ids);
});

describe("runImport", () => {
  it("maps statuses by the mapping, then by column id or label, and reports the rest", async () => {
    const { db, writes } = fakeDb();
    const report = await run(
      db,
      [
        { id: "1", title: "a", status: "Open" },
        { id: "2", title: "b", status: "in progress" },
        { id: "3", title: "c", status: "DONE" },
        { id: "4", title: "d", status: "Waiting for QA" },
      ],
      { statuses: { Open: "doing" } }
    );
    expect(writes.tasks.map((t) => t.status)).toEqual(["doing", "doing", "done", "backlog"]);
    expect(report.unmapped.statuses).toEqual(["Waiting for QA"]);
  });

  it("reports a type with no category, a priority it does not know and a person with no account here", async () => {
    const { db, writes } = fakeDb();
    const report = await run(db, [
      { id: "1", title: "a", type: "Bug", priority: "HIGH", assignee: "maya" },
      { id: "2", title: "b", type: "Epic", priority: "Blocker", assignee: "ghost" },
    ]);
    expect(writes.tasks.map((t) => [t.category, t.priority, t.assignee])).toEqual([
      ["bug", "high", MEMBER],
      ["user-story", "medium", null],
    ]);
    expect(report.unmapped).toEqual({ statuses: [], users: ["ghost"], types: ["Epic"] });
    expect(report.dropped).toContainEqual({ id: "2", field: "priority", value: "Blocker", reason: "not low, medium, high or urgent" });
  });

  it("leaves a person unassigned who has an account but no access to the board", async () => {
    recipientsWithAccess.mockResolvedValue([]);
    const { db, writes } = fakeDb();
    const report = await run(db, [{ id: "1", title: "a", assignee: "maya" }]);
    expect(writes.tasks[0].assignee).toBeNull();
    expect(report.unmapped.users).toEqual(["maya"]);
  });

  it("validates every field value and reports each one it drops, instead of dropping it silently", async () => {
    const { db, writes } = fakeDb();
    const report = await run(db, [
      { id: "1", title: "a", fields: { size: "large", Points: "5", Colour: "red" } },
      { id: "2", title: "b", fields: { Size: "Huge", Points: "lots" } },
    ]);
    expect(writes.tasks[0].customFieldValues).toEqual({ [String(SIZE_FIELD)]: "l", [String(project.customFields[1]._id)]: 5 });
    expect(writes.tasks[1].customFieldValues).toEqual({});
    expect(report.dropped.map((d) => [d.id, d.field, d.reason])).toEqual([
      ["1", "Colour", "no field of that name on this board"],
      ["2", "Size", "Size must be one of its options"],
      ["2", "Points", "Points must be a number"],
    ]);
  });

  it("skips a task with no title, shortens what is too long, and says so", async () => {
    const { db, writes } = fakeDb();
    const report = await run(db, [
      { id: "1", title: "​  " },
      { id: "2", title: "t".repeat(250), description: "d" },
    ]);
    expect(report.skipped).toEqual([{ id: "1", reason: "no title" }]);
    expect(report.truncated).toEqual([{ id: "2", field: "title" }]);
    expect((writes.tasks[0].title as string).length).toBe(200);
  });

  it("keeps the source's creation time and a finish only for a task in a done column", async () => {
    const { db, writes } = fakeDb();
    const report = await run(db, [
      { id: "1", title: "a", status: "done", createdAt: "2025-01-02T03:04:05Z", completedAt: "2025-02-01T00:00:00Z" },
      { id: "2", title: "b", status: "doing", completedAt: "2025-02-01T00:00:00Z" },
      { id: "3", title: "c", createdAt: "2999-01-01T00:00:00Z" },
    ]);
    expect(writes.tasks[0]).toMatchObject({ createdAt: new Date("2025-01-02T03:04:05Z"), taskNumber: 11 });
    const rows = logActivities.mock.calls[0][1] as { action: string; at: Date; oldValue?: string }[];
    expect(rows.filter((r) => r.action === "status_changed")).toEqual([
      expect.objectContaining({ newValue: "done", oldValue: "backlog", at: new Date("2025-02-01T00:00:00Z") }),
    ]);
    expect(report.dropped.map((d) => [d.id, d.field])).toEqual([
      ["2", "completedAt"],
      ["3", "createdAt"],
    ]);
  });

  // Insights counts a finish against its creation; with no creation, or one after it, a lead time of zero
  it("keeps no finish it cannot measure, and says why", async () => {
    const { db } = fakeDb();
    const report = await run(db, [
      { id: "1", title: "a", status: "done", completedAt: "2025-02-01T00:00:00Z" },
      { id: "2", title: "b", status: "done", createdAt: "2025-03-01T00:00:00Z", completedAt: "2025-02-01T00:00:00Z" },
    ]);
    expect(report.dropped.map((d) => [d.id, d.reason])).toEqual([
      ["1", "the task has no creation time to measure it from"],
      ["2", "it is before the task was created"],
    ]);
    expect((logActivities.mock.calls[0][1] as { action: string }[]).map((r) => r.action)).toEqual(["created", "created"]);
  });

  it("updates a task it imported before instead of making a second one, looking it up by source and id", async () => {
    const { db, writes } = fakeDb({ existing: [{ id: "1" }] });
    const report = await run(db, [
      { id: "1", title: "again" },
      { id: "2", title: "new" },
    ]);
    expect(report).toMatchObject({ created: 1, updated: 1 });
    expect(writes.tasks.map((t) => t.title)).toEqual(["new"]);
    expect(writes.updates.map((u) => u.update.$set.title)).toEqual(["again"]);
    expect(writes.taskQueries[0]).toEqual({ project: "p1", "externalRef.source": "jira", "externalRef.id": { $in: ["1", "2"] } });
  });

  it("records a re-run's move between columns in the history, as any other move is", async () => {
    const { db, writes, rows } = fakeDb({ existing: [{ id: "1", status: "backlog" }] });
    await run(db, [{ id: "1", title: "a", status: "done", createdAt: "2025-01-01T00:00:00Z", completedAt: "2025-02-01T00:00:00Z" }]);
    expect(writes.updates[0].update.$set.status).toBe("done");
    expect(logActivities.mock.calls.at(-1)![1]).toEqual([
      expect.objectContaining({ taskId: rows[0]._id, action: "status_changed", oldValue: "backlog", newValue: "done", at: new Date("2025-02-01T00:00:00Z") }),
    ]);
  });

  it("leaves a task a machine is running in its column, and says so", async () => {
    const { db, writes } = fakeDb({ existing: [{ id: "1", status: "doing", held: true }] });
    const report = await run(db, [{ id: "1", title: "a", status: "done" }]);
    expect(writes.updates[0].update.$set).not.toHaveProperty("status");
    expect(report.notImported).toEqual([{ id: "1", what: "its column: a machine is running it" }]);
    expect(logActivities.mock.calls.at(-1)![1]).toEqual([]);
  });

  it("never unassigns: somebody it cannot name leaves the board's assignee as it is", async () => {
    const { db, writes } = fakeDb({ existing: [{ id: "1" }, { id: "2" }] });
    await run(db, [
      { id: "1", title: "a", assignee: "ghost" },
      { id: "2", title: "b", assignee: "maya" },
    ]);
    expect(writes.updates.map((u) => u.update.$set.assignee)).toEqual([undefined, MEMBER]);
  });

  it("writes a comment whose author has no account under the importer, keeping the author's name", async () => {
    const { db, writes } = fakeDb();
    await run(db, [{ id: "1", title: "a", comments: [{ id: "c1", author: "Old Name", body: "hello" }, { id: "c2", author: "maya", body: "hi" }] }]);
    expect(writes.comments.map((c) => [c.author, c.body, c.source])).toEqual([
      [IMPORTER, "*Originally by Old Name*\n\nhello", "import"],
      [MEMBER, "hi", "import"],
    ]);
  });

  it("counts a dry run's comments the way the real run will", async () => {
    const { db } = fakeDb({ existing: [{ id: "1", comments: ["c1"] }] });
    const tasks = [{ id: "1", title: "a", comments: [{ id: "c1", body: "x" }, { id: "c2", body: "y" }] }];
    expect((await run(db, tasks, {}, true)).comments).toEqual({ created: 1, updated: 1 });
  });

  it("writes nothing on a dry run, and reports what the real run would", async () => {
    const { db, writes } = fakeDb({ existing: [{ id: "1" }] });
    const dry = await run(db, [{ id: "1", title: "a" }, { id: "2", title: "b", priority: "x" }], {}, true);
    expect(writes.tasks).toEqual([]);
    expect(logActivities).not.toHaveBeenCalled();
    expect(logProjectAudit).not.toHaveBeenCalled();
    expect(dry).toMatchObject({ dryRun: true, created: 1, updated: 1, complete: true });
    expect(dry.dropped).toHaveLength(1);
  });

  // That nobody is told is the e2e's to prove, against the real senders
  it("writes one audit row, and its rows say they came from the import", async () => {
    const { db, writes } = fakeDb();
    await run(db, [{ id: "1", title: "a", assignee: "maya" }]);
    expect(logProjectAudit).toHaveBeenCalledTimes(1);
    expect(logProjectAudit.mock.calls[0][3]).toBe("tasks_imported");
    expect(writes.sources).toEqual(["import"]);
  });

  it("stops at a chunk that fails, keeps what came before with its history, and says how far it got", async () => {
    const { db, writes } = fakeDb({ failOn: 2, landBeforeFailing: 3 });
    const tasks = Array.from({ length: IMPORT_CHUNK * 2 + 5 }, (_, i) => ({ id: String(i), title: `t${i}` }));
    const report = await run(db, tasks);
    const error = "another import of the same tasks ran at the same time";
    expect(report).toMatchObject({ complete: false, processed: IMPORT_CHUNK + 3, created: IMPORT_CHUNK + 3, error });
    expect(writes.tasks).toHaveLength(IMPORT_CHUNK + 3);
    // The three the failing insert kept still get their history, so a re-run does not leave them bare
    const created = logActivities.mock.calls.flatMap((c) => c[1] as { action: string }[]).filter((r) => r.action === "created");
    expect(created).toHaveLength(IMPORT_CHUNK + 3);
    expect(logProjectAudit.mock.calls[0][4]).toContain(`Stopped after ${IMPORT_CHUNK + 3} of ${IMPORT_CHUNK * 2 + 5}: ${error}`);
  });
});
