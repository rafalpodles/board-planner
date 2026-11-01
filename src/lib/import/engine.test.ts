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
const { CRITERION_TEXT_MAX_LENGTH, MAX_CHECKLIST_ITEMS, isValidCriterionText } = await import("@/lib/identifiers");

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

let linkFailure: Error | null = null;

const ACCOUNTS = [{ _id: MEMBER, username: "maya", email: "maya.k@example.com" }];

type Existing = { id: string; status?: string; held?: boolean; comments?: string[]; checklist?: { _id: Types.ObjectId; text: string; done: boolean }[] };

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
  const rows = existing.map((e) => ({ _id: new Types.ObjectId(), status: e.status ?? "backlog", externalRef: { id: e.id }, execution: e.held ? { runId: "r1" } : {}, comments: e.comments ?? [], checklist: e.checklist }));
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
      find: (filter: { $or: { username?: { $in: string[] }; email?: { $in: string[] } }[] }) =>
        chain(() =>
          ACCOUNTS.filter((u) =>
            filter.$or.some((clause) => clause.username?.$in.includes(u.username) || clause.email?.$in.includes(u.email))
          )
        ),
    },
    Task: {
      find: (filter: Record<string, unknown>) => {
        writes.taskQueries.push(filter);
        if (!filter["externalRef.id"]) return chain(() => (linkFailure ? (() => { throw linkFailure; })() : []));
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
      { id: "2", title: "b", type: "Epic", priority: "Showstopper", assignee: "ghost" },
    ]);
    expect(writes.tasks.map((t) => [t.category, t.priority, t.assignee])).toEqual([
      ["bug", "high", MEMBER],
      ["user-story", "medium", null],
    ]);
    expect(report.unmapped).toEqual({ statuses: [], users: ["ghost"], types: ["Epic"] });
    expect(report.dropped).toContainEqual({ id: "2", field: "priority", value: "Showstopper", reason: "not low, medium, high or urgent" });
  });

  it("writes a new task's checklist, unticked unless the file says otherwise", async () => {
    const { db, writes } = fakeDb();
    await run(db, [{ id: "1", title: "a", checklist: [{ text: " one ", done: true }, { text: "two" }, { text: "   " }, { text: "\u3164" }] }, { id: "2", title: "b" }]);
    expect(writes.tasks.map((t) => t.checklist)).toEqual([[{ text: "one", done: true }, { text: "two", done: false }], []]);
  });

  it("makes a checklist's text what the board itself would take, and says what it shortened", async () => {
    const { db, writes } = fakeDb();
    const long = "x".repeat(CRITERION_TEXT_MAX_LENGTH + 1);
    const report = await run(db, [{ id: "1", title: "a", checklist: [{ text: `line\none‮` }, { text: long }] }]);
    const items = writes.tasks[0].checklist as { text: string }[];
    expect(items.map((i) => i.text)).toEqual(["line one", long.slice(0, CRITERION_TEXT_MAX_LENGTH)]);
    expect(items.every((i) => isValidCriterionText(i.text))).toBe(true);
    expect(report.truncated).toEqual([{ id: "1", field: "checklist" }]);
  });

  it("cuts a checklist to what a task holds, and says so", async () => {
    const { db, writes } = fakeDb();
    const checklist = Array.from({ length: MAX_CHECKLIST_ITEMS + 1 }, (_, i) => ({ text: `c${i}` }));
    const report = await run(db, [{ id: "1", title: "a", checklist }]);
    expect(writes.tasks[0].checklist).toHaveLength(MAX_CHECKLIST_ITEMS);
    expect(report.truncated).toEqual([{ id: "1", field: "checklist" }]);
  });

  it("keeps a criterion's id and what only the board has when a task is imported again, the file deciding the tick", async () => {
    const [same, reworded, added] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    const checklist = [
      { _id: same, text: "Step one", done: false },
      { _id: reworded, text: "Step  TWO", done: true },
      { _id: added, text: "Added on the board", done: true },
    ];
    const { db, writes } = fakeDb({ existing: [{ id: "1", checklist }] });
    await run(db, [{ id: "1", title: "a", checklist: [{ text: "Step one", done: true }, { text: "step two" }, { text: "New in the file" }] }]);
    expect(writes.updates[0].update.$set.checklist).toEqual([
      { _id: same, text: "Step one", done: true },
      { _id: reworded, text: "step two", done: false },
      { text: "New in the file", done: false },
      { _id: added, text: "Added on the board", done: true },
    ]);
  });

  it("keeps a criterion with no id that the file does not name, and says what stayed, on a check and on the run", async () => {
    const checklist = [{ text: "Old one", done: true }, { text: "Old two", done: false }] as never;
    const tasks = [{ id: "1", title: "a", checklist: [{ text: "New" }] }];
    const checked = await run(fakeDb({ existing: [{ id: "1", checklist }] }).db, tasks, {}, true);
    const { db, writes } = fakeDb({ existing: [{ id: "1", checklist }] });
    const report = await run(db, tasks);
    const said = [{ id: "a", what: "2 criteria on the task that the file does not have, left in place" }];
    expect(checked.notImported).toEqual(said);
    expect(report.notImported).toEqual(said);
    expect((writes.updates[0].update.$set.checklist as { text: string }[]).map((i) => i.text)).toEqual(["New", "Old one", "Old two"]);
  });

  it("says nothing about a checklist the file matches in full", async () => {
    const checklist = [{ _id: new Types.ObjectId(), text: "One", done: false }];
    const report = await run(fakeDb({ existing: [{ id: "1", checklist }] }).db, [{ id: "1", title: "a", checklist: [{ text: "One" }] }]);
    expect(report.notImported).toEqual([]);
  });

  it("leaves a task's checklist alone when the file has none for it", async () => {
    const { db, writes } = fakeDb({ existing: [{ id: "1", checklist: [{ _id: new Types.ObjectId(), text: "Kept", done: false }] }] });
    await run(db, [{ id: "1", title: "a", checklist: [] }]);
    expect(writes.updates[0].update.$set).not.toHaveProperty("checklist");
  });

  it("keeps the file's criteria first when the two together are more than a task holds, and a check says what will go", async () => {
    const held = Array.from({ length: MAX_CHECKLIST_ITEMS }, (_, i) => ({ _id: new Types.ObjectId(), text: `board ${i}`, done: false }));
    const tasks = [{ id: "1", title: "a", checklist: [{ text: "from the file" }] }];
    const checked = await run(fakeDb({ existing: [{ id: "1", checklist: held }] }).db, tasks, {}, true);
    const { db, writes } = fakeDb({ existing: [{ id: "1", checklist: held }] });
    const report = await run(db, tasks);
    const written = writes.updates[0].update.$set.checklist as { text: string }[];
    expect(written).toHaveLength(MAX_CHECKLIST_ITEMS);
    expect(written[0].text).toBe("from the file");
    const said = [
      { id: "a", what: "199 criteria on the task that the file does not have, left in place" },
      { id: "a", what: "1 criterion removed from the task, as it holds 200 and the file comes first" },
    ];
    expect(report.notImported).toEqual(said);
    expect(checked.notImported).toEqual(said);
  });

  it("writes a new task's place, and never moves a task imported before", async () => {
    const { db, writes } = fakeDb({ existing: [{ id: "1" }] });
    await run(db, [{ id: "1", title: "a", order: 4 }, { id: "2", title: "b", order: 5 }, { id: "3", title: "c" }]);
    expect(writes.tasks.map((t) => t.order)).toEqual([5, 0]);
    expect(writes.updates[0].update.$set).not.toHaveProperty("order");
  });

  it("puts what the file's reader left behind in the report, on a check and on the run itself", async () => {
    const notes = [{ id: "Old ideas", what: "an archived list, with its 3 cards" }];
    const bundle = { source: "Trello", tasks: [{ id: "1", title: "a" }], notes };
    expect((await runImport(fakeDb().db, "p1", IMPORTER, bundle, {}, { dryRun: true })).notImported).toEqual(notes);
    expect((await runImport(fakeDb().db, "p1", IMPORTER, bundle, {}, { dryRun: false })).notImported).toEqual(notes);
  });

  it("keeps the labels a board offers and lists each other one, instead of dropping them all", async () => {
    const tags = new Types.ObjectId();
    project.customFields.push({ _id: tags, name: "Tags", fieldType: "multiselect", options: [{ id: "t1", value: "billing" }], order: 2 } as never);
    try {
      const { db, writes } = fakeDb();
      const report = await run(db, [
        { id: "1", title: "a", fields: { Tags: ["billing", "brand-new", "billing"] } },
        { id: "2", title: "b", fields: { Tags: ["nothing-known"] } },
      ]);
      expect(writes.tasks.map((t) => t.customFieldValues)).toEqual([{ [String(tags)]: ["t1"] }, {}]);
      expect(report.dropped.map((d) => [d.id, d.value])).toEqual([["1", "brand-new"], ["2", "nothing-known"]]);
    } finally {
      project.customFields.pop();
    }
  });

  it("reads the priority scales Jira and Linear ship with, and takes No priority as none given", async () => {
    const { db, writes } = fakeDb();
    const report = await run(db, ["Highest", "Blocker", "Critical", "Major", "Normal", "Lowest", "Minor", "Trivial", "No priority", "none", "-", "Najwyższy", "Niski", "Blokujący", "Drobny", "Immediate"].map((priority, i) => ({ id: String(i), title: "t", priority })));
    expect(writes.tasks.map((t) => t.priority)).toEqual(["urgent", "urgent", "urgent", "high", "medium", "low", "low", "low", "medium", "medium", "medium", "urgent", "low", "urgent", "low", "urgent"]);
    expect(report.dropped).toEqual([]);
  });

  it("leaves a person unassigned who has an account but no access to the board", async () => {
    recipientsWithAccess.mockResolvedValue([]);
    const { db, writes } = fakeDb();
    const report = await run(db, [{ id: "1", title: "a", assignee: "maya" }]);
    expect(writes.tasks[0].assignee).toBeNull();
    expect(report.unmapped.users).toEqual(["maya"]);
  });

  it("finds a person by e-mail as well as by username, whatever the case", async () => {
    const { db, writes } = fakeDb();
    const report = await run(db, [
      { id: "1", title: "a", assignee: "Maya.K@Example.com" },
      { id: "2", title: "b", assignee: "nobody@example.com" },
    ]);
    expect(writes.tasks.map((t) => t.assignee)).toEqual([MEMBER, null]);
    expect(report.unmapped.users).toEqual(["nobody@example.com"]);
  });

  it("does not list a person the mapping deliberately leaves unassigned", async () => {
    const { db, writes } = fakeDb();
    const report = await run(db, [{ id: "1", title: "a", assignee: "maya" }, { id: "2", title: "b", assignee: "ghost" }], { users: { maya: null } });
    expect(writes.tasks.map((t) => t.assignee)).toEqual([null, null]);
    expect(report.unmapped.users).toEqual(["ghost"]);
  });

  it("keeps a due day, refuses one that is not a calendar day and says so, and never clears one on a re-run", async () => {
    const { db, writes } = fakeDb({ existing: [{ id: "3" }] });
    const report = await run(db, [
      { id: "1", title: "a", dueDate: "2027-02-28" },
      { id: "2", title: "b", dueDate: "2027-02-31" },
      { id: "3", title: "c" },
      { id: "4", title: "d", dueDate: "2027-02-28T10:00" },
    ]);
    expect(writes.tasks.map((t) => t.dueDate)).toEqual([new Date("2027-02-28T00:00:00.000Z"), null, null]);
    expect(report.dropped.map((d) => [d.id, d.value])).toEqual([
      ["2", "2027-02-31"],
      ["4", "2027-02-28T10:00"],
    ]);
    expect(report.dropped[0]).toEqual({ id: "2", field: "dueDate", value: "2027-02-31", reason: "not a day, YYYY-MM-DD" });
    expect(writes.updates[0].update.$set).not.toHaveProperty("dueDate");
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

  it("keeps the line breaks of a description and a comment, and turns a title's into a space", async () => {
    const { db, writes } = fakeDb();
    await run(db, [{ id: "1", title: "a\nb", description: "one\r\ntwo\n\tthree\u202e", comments: [{ id: "c", author: "maya", body: "x\ry" }] }]);
    expect(writes.tasks[0]).toMatchObject({ title: "a b", description: "one\ntwo\n\tthree" });
    expect(writes.comments[0].body).toBe("x\ny");
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
      expect.objectContaining({ taskId: rows[0]._id, action: "status_changed", oldValue: "backlog", newValue: "done" }),
    ]);
    // After whatever the board did since the first import, never before it
    const at = (logActivities.mock.calls.at(-1)![1] as { at: Date }[])[0].at;
    expect(Date.now() - at.getTime()).toBeLessThan(5_000);
  });

  describe("a finished task", () => {
    const FINISHED = { id: "1", title: "a", finished: true, createdAt: "2025-01-01T00:00:00Z", completedAt: "2025-02-01T00:00:00Z" };
    const withColumns = async (columns: typeof project.columns, act: () => Promise<void>) => {
      const held = project.columns;
      project.columns = columns;
      try {
        await act();
      } finally {
        project.columns = held;
      }
    };

    it("goes to the done column from one that is not, keeps its time, and the report says so", async () => {
      const { db, writes } = fakeDb();
      const report = await run(db, [{ ...FINISHED, status: "This Week" }], { statuses: { "This Week": "doing" } });
      expect(writes.tasks[0]).toMatchObject({ status: "done", updatedAt: new Date(FINISHED.completedAt) });
      expect(report.dropped).toEqual([]);
      expect(report.notImported).toEqual([{ id: "a", what: "its status “This Week”: it is finished, so it goes to Done" }]);
    });

    it("says the same on a check as on the import", async () => {
      const { db } = fakeDb();
      const report = await run(db, [{ ...FINISHED, status: "This Week" }], { statuses: { "This Week": "doing" } }, true);
      expect(report.notImported).toEqual([{ id: "a", what: "its status “This Week”: it is finished, so it goes to Done" }]);
    });

    it("does not call a status it never used unmapped", async () => {
      const { db, writes } = fakeDb();
      const report = await run(db, [{ ...FINISHED, status: "Nowhere" }, { id: "2", title: "b", status: "Nowhere 2" }]);
      expect(writes.tasks[0].status).toBe("done");
      expect(report.unmapped.statuses).toEqual(["Nowhere 2"]);
    });

    it("stays in a done column of the file's choosing, so lists mapped apart stay apart", async () => {
      const second = { id: "wontdo", label: "Won't do", role: "done", order: 3 };
      await withColumns([...project.columns, second], async () => {
        const { db, writes } = fakeDb();
        const report = await run(db, [{ ...FINISHED, status: "Dropped" }], { statuses: { Dropped: "wontdo" } });
        expect(writes.tasks[0].status).toBe("wontdo");
        expect(report.notImported).toEqual([]);
      });
    });

    it("stays where it would have gone on a board with no done column, and its time is refused", async () => {
      await withColumns(project.columns.filter((c) => c.role !== "done"), async () => {
        const { db, writes } = fakeDb();
        const report = await run(db, [{ ...FINISHED, status: "This Week" }], { statuses: { "This Week": "doing" } });
        expect(writes.tasks[0].status).toBe("doing");
        expect(report.dropped).toEqual([expect.objectContaining({ field: "completedAt", reason: "the task is not in a done column" })]);
        expect(report.notImported).toEqual([]);
      });
    });

    it("moves on a later import, as any other change of column does", async () => {
      const { db, writes } = fakeDb({ existing: [{ id: "1", status: "doing" }] });
      await run(db, [{ ...FINISHED, status: "This Week" }], { statuses: { "This Week": "doing" } });
      expect(writes.updates[0].update.$set.status).toBe("done");
    });

    it("goes to done with nothing to report when it named no status", async () => {
      const { db, writes } = fakeDb();
      const report = await run(db, [FINISHED]);
      expect(writes.tasks[0].status).toBe("done");
      expect(report.notImported).toEqual([]);
    });

    it("changes nothing for a task that is not finished", async () => {
      const { db, writes } = fakeDb();
      await run(db, [{ id: "1", title: "a", finished: false, status: "This Week" }], { statuses: { "This Week": "doing" } });
      expect(writes.tasks[0].status).toBe("doing");
    });
  });

  it("leaves a task a machine is running in its column, and says so", async () => {
    const { db, writes } = fakeDb({ existing: [{ id: "1", status: "doing", held: true }] });
    const report = await run(db, [{ id: "1", title: "a", status: "done" }]);
    expect(writes.updates[0].update.$set).not.toHaveProperty("status");
    expect(report.notImported).toEqual([{ id: "1", what: "its column: a machine is running it" }]);
    expect(logActivities.mock.calls.at(-1)![1]).toEqual([]);
  });

  it("leaves a description, category or priority the file does not carry as the board has it on a re-run", async () => {
    const { db, writes } = fakeDb({ existing: [{ id: "1" }, { id: "2" }] });
    await run(db, [
      { id: "1", title: "a" },
      { id: "2", title: "b", description: "new", type: "bug", priority: "high" },
    ]);
    expect(writes.updates[0].update.$set).not.toHaveProperty("description");
    expect(writes.updates[0].update.$set).not.toHaveProperty("category");
    expect(writes.updates[0].update.$set).not.toHaveProperty("priority");
    expect(writes.updates[1].update.$set).toMatchObject({ description: "new", category: "bug", priority: "high" });
  });

  it("leaves a task in its column on a re-run when the file gives no status, or one it cannot match", async () => {
    const { db, writes } = fakeDb({ existing: [{ id: "1", status: "doing" }, { id: "2", status: "doing" }, { id: "3", status: "doing" }] });
    const report = await run(db, [
      { id: "1", title: "a" },
      { id: "2", title: "b", status: "Waiting for QA" },
      { id: "3", title: "c", status: "done" },
    ]);
    expect(writes.updates.map((u) => u.update.$set.status)).toEqual([undefined, undefined, "done"]);
    expect(report.unmapped.statuses).toEqual(["Waiting for QA"]);
    expect((logActivities.mock.calls.at(-1)![1] as { taskId: unknown }[]).length).toBe(1);
  });

  it("refuses a day that does not exist rather than rolling it into the next month, and reads a time with no zone as UTC", async () => {
    // CI runs in UTC, where reading a zone-less time locally would look right too
    const zone = process.env.TZ;
    process.env.TZ = "Europe/Warsaw";
    try {
      const { db, writes } = fakeDb();
      const report = await run(db, [
        { id: "1", title: "a", createdAt: "2026-02-31T08:00:00Z" },
        { id: "2", title: "b", createdAt: "2026-01-15T08:00" },
        { id: "3", title: "c", createdAt: "2026-01-15 09:30" },
      ]);
      expect(report.dropped.map((d) => [d.id, d.field])).toEqual([["1", "createdAt"]]);
      expect(writes.tasks.slice(1).map((t) => t.createdAt)).toEqual([new Date("2026-01-15T08:00:00.000Z"), new Date("2026-01-15T09:30:00.000Z")]);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("reads only ISO dates for a creation or finish time, so a day-first date is never read month-first", async () => {
    const { db, writes } = fakeDb();
    const report = await run(db, [{ id: "1", title: "a", createdAt: "05/10/2026" }]);
    expect(report.dropped).toEqual([{ id: "1", field: "createdAt", value: "05/10/2026", reason: "not a date in the past" }]);
  });

  it("never unassigns: somebody it cannot name leaves the board's assignee as it is", async () => {
    const { db, writes } = fakeDb({ existing: [{ id: "1" }, { id: "2" }] });
    await run(db, [
      { id: "1", title: "a", assignee: "ghost" },
      { id: "2", title: "b", assignee: "maya" },
    ]);
    expect(writes.updates.map((u) => [u.update.$set.assignee, u.update.$set.assignedBy])).toEqual([
      [undefined, undefined],
      [MEMBER, IMPORTER],
    ]);
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
    const tasks = Array.from({ length: IMPORT_CHUNK * 2 + 5 }, (_, i) => ({ id: String(i), title: `t${i}`, ...(i === IMPORT_CHUNK * 2 && { parent: "0" }) }));
    const report = await run(db, tasks);
    // A task the stop never reached says so, rather than going unmentioned
    expect(report.notImported).toContainEqual({ id: String(IMPORT_CHUNK * 2), what: "parent “0”: this task was not imported: the import stopped" });
    const error = "another import of the same tasks ran at the same time";
    expect(report).toMatchObject({ complete: false, processed: IMPORT_CHUNK + 3, created: IMPORT_CHUNK + 3, error });
    expect(writes.tasks).toHaveLength(IMPORT_CHUNK + 3);
    // The three the failing insert kept still get their history, so a re-run does not leave them bare
    const created = logActivities.mock.calls.flatMap((c) => c[1] as { action: string }[]).filter((r) => r.action === "created");
    expect(created).toHaveLength(IMPORT_CHUNK + 3);
    expect(logProjectAudit.mock.calls[0][4]).toContain(`Stopped after ${IMPORT_CHUNK + 3} of ${IMPORT_CHUNK * 2 + 5}: ${error}`);
  });

  it("says a link names a task of the file that was skipped, rather than no task at all", async () => {
    const { db } = fakeDb();
    const report = await run(db, [{ id: "1", title: "a", parent: "2" }, { id: "2", title: "  " }], {}, true);
    expect(report.notImported).toContainEqual({ id: "1", what: "parent “2”: that task was skipped: no title" });
  });

  it("keeps its report and its audit row when making the links fails", async () => {
    linkFailure = new Error("the database went away");
    try {
      const { db } = fakeDb();
      const report = await run(db, [{ id: "1", title: "a", parent: "2" }, { id: "2", title: "b" }]);
      expect(report).toMatchObject({ created: 2, complete: false, error: "the links between tasks were not made: the database went away" });
      expect(logProjectAudit).toHaveBeenCalledTimes(1);
    } finally {
      linkFailure = null;
    }
  });
});
