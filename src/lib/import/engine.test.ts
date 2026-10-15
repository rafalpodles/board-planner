import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const recipientsWithAccess = vi.fn();
const logActivities = vi.fn();
const logProjectAudit = vi.fn();
const dispatchWebhooks = vi.fn();
const dispatchNotifications = vi.fn();
const createNotifications = vi.fn();

vi.mock("@/lib/grants", () => ({ recipientsWithAccess: (...a: unknown[]) => recipientsWithAccess(...a) }));
vi.mock("@/lib/activity", () => ({ logActivities: (...a: unknown[]) => logActivities(...a) }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit: (...a: unknown[]) => logProjectAudit(...a) }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks }));
vi.mock("@/lib/notifications", () => ({ dispatchNotifications }));
vi.mock("@/lib/in-app-notifications", () => ({ createNotifications }));

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

function fakeDb({ existing = [] as { id: string }[], failOn = 0 } = {}) {
  let counter = 10;
  let inserts = 0;
  const writes = { tasks: [] as Record<string, unknown>[], updates: 0, comments: [] as Record<string, unknown>[], sources: [] as string[] };
  const lean = <T>(value: T) => ({ select: () => ({ lean: async () => value }), lean: async () => value });
  const db = {
    Project: {
      findById: () => ({ lean: async () => project }),
      findOneAndUpdate: (_f: unknown, update: { $inc: { taskCounter: number } }) => {
        counter += update.$inc.taskCounter;
        return { lean: async () => ({ taskCounter: counter }) };
      },
    },
    User: {
      find: () => lean([{ _id: MEMBER, username: "maya" }]),
    },
    Task: {
      find: () => lean(existing.map((e) => ({ _id: new Types.ObjectId(), externalRef: { id: e.id } }))),
      countDocuments: async () => existing.length,
      insertMany: async (docs: Record<string, unknown>[]) => {
        inserts += 1;
        if (failOn && inserts === failOn) throw new Error("connection reset");
        writes.sources.push(currentProvenance().source);
        writes.tasks.push(...docs);
      },
      bulkWrite: async (ops: unknown[]) => void (writes.updates += ops.length),
    },
    Comment: {
      find: () => lean([]),
      insertMany: async (docs: Record<string, unknown>[]) => void writes.comments.push(...docs),
      bulkWrite: async () => undefined,
    },
  };
  return { db: db as never, writes };
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

  it("updates a task it imported before instead of making a second one", async () => {
    const { db, writes } = fakeDb({ existing: [{ id: "1" }] });
    const report = await run(db, [
      { id: "1", title: "again" },
      { id: "2", title: "new" },
    ]);
    expect(report).toMatchObject({ created: 1, updated: 1 });
    expect(writes.tasks.map((t) => t.title)).toEqual(["new"]);
    expect(writes.updates).toBe(1);
  });

  it("writes a comment whose author has no account under the importer, keeping the author's name", async () => {
    const { db, writes } = fakeDb();
    await run(db, [{ id: "1", title: "a", comments: [{ id: "c1", author: "Old Name", body: "hello" }, { id: "c2", author: "maya", body: "hi" }] }]);
    expect(writes.comments.map((c) => [c.author, c.body, c.source])).toEqual([
      [IMPORTER, "*Originally by Old Name*\n\nhello", "import"],
      [MEMBER, "hi", "import"],
    ]);
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

  it("tells nobody: no webhook, no notification, one audit row, and its rows say they came from the import", async () => {
    const { db, writes } = fakeDb();
    await run(db, [{ id: "1", title: "a", assignee: "maya" }]);
    expect(dispatchWebhooks).not.toHaveBeenCalled();
    expect(dispatchNotifications).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
    expect(logProjectAudit).toHaveBeenCalledTimes(1);
    expect(logProjectAudit.mock.calls[0][3]).toBe("tasks_imported");
    expect(writes.sources).toEqual(["import"]);
  });

  it("stops at a chunk that fails, keeps what came before, and says how far it got", async () => {
    const { db, writes } = fakeDb({ failOn: 2 });
    const tasks = Array.from({ length: IMPORT_CHUNK * 2 + 5 }, (_, i) => ({ id: String(i), title: `t${i}` }));
    const report = await run(db, tasks);
    expect(report).toMatchObject({ complete: false, processed: IMPORT_CHUNK, created: IMPORT_CHUNK, error: "connection reset" });
    expect(writes.tasks).toHaveLength(IMPORT_CHUNK);
    expect(logProjectAudit.mock.calls[0][4]).toContain(`Stopped after ${IMPORT_CHUNK} of ${IMPORT_CHUNK * 2 + 5}: connection reset`);
  });
});
