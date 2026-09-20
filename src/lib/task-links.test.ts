import { describe, it, expect, vi, beforeEach } from "vitest";
// An independent reimplementation of MongoDB's query language, pinned at the version mongoose
// itself depends on. NOT the server's matcher — server-side queries are evaluated by MongoDB —
// but the four shapes this file relies on were checked against MongoDB's documented semantics:
// `$elemMatch` (same element), `$pull` with a document criteria (partial match per element),
// `{ $exists: true, $ne: [] }` (excludes the empty array) and `$ne` on an id. What it buys is a
// store the code can be run against, rather than a stub that answers whatever the test wanted.
import sift from "sift";

interface Doc {
  _id: string;
  project: string;
  taskNumber: number;
  title: string;
  status: string;
  assignee?: string;
  watchers?: string[];
  relations?: { task: string; type: string }[];
  blockedBy?: string[];
}

let store: Doc[] = [];

const updateOne = vi.fn();
const updateMany = vi.fn();
const findByIdAndUpdate = vi.fn();
const findOneAndUpdate = vi.fn();
const logActivities = vi.fn();
const dispatchWebhooks = vi.fn();
const dispatchNotifications = vi.fn();
const createNotifications = vi.fn();

const lean = <T>(value: T) => ({ lean: async () => value });

type Update = {
  $pull?: Record<string, unknown>;
  $push?: Record<string, unknown>;
  $addToSet?: Record<string, unknown>;
};

/**
 * The writes really land on the store. A mock that only records its arguments cannot tell a read
 * taken BEFORE a pull from one taken after it — and "before" is the whole of what keeps the
 * previous parent knowable, so the ordering has to be observable here or nothing pins it.
 */
function apply(doc: Doc, update: Update): void {
  const list = (field: string) => (doc as unknown as Record<string, unknown[]>)[field] ?? [];
  const set = (field: string, value: unknown[]) => {
    (doc as unknown as Record<string, unknown[]>)[field] = value;
  };

  for (const [field, criteria] of Object.entries(update.$pull ?? {})) {
    const matches =
      criteria && typeof criteria === "object"
        ? sift(criteria as object)
        : (item: unknown) => item === criteria;
    set(
      field,
      list(field).filter((item) => !matches(item))
    );
  }
  for (const [field, value] of Object.entries(update.$push ?? {})) {
    set(field, [...list(field), value]);
  }
  for (const [field, value] of Object.entries(update.$addToSet ?? {})) {
    if (!list(field).some((item) => item === value)) set(field, [...list(field), value]);
  }
}

vi.mock("@/models/task", () => ({
  Task: {
    findOne: (filter: object) => lean(store.find(sift(filter)) ?? null),
    find: (filter: object) => lean(store.filter(sift(filter))),
    // `matchedCount` and `modifiedCount` are both read by the production code, and they are NOT
    // the same answer: a `$pull` whose criteria match nothing still matches its document. A mock
    // that made one a synonym of the other would pass a guard that read the wrong one.
    updateOne: async (filter: object, update: Update) => {
      updateOne(filter, update);
      const doc = store.find(sift(filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      const before = JSON.stringify(doc);
      apply(doc, update);
      return { matchedCount: 1, modifiedCount: JSON.stringify(doc) === before ? 0 : 1 };
    },
    updateMany: async (filter: object, update: Update) => {
      updateMany(filter, update);
      for (const doc of store.filter(sift(filter))) apply(doc, update);
    },
    findByIdAndUpdate: async (id: string, update: Update) => {
      findByIdAndUpdate(id, update);
      const doc = store.find((d) => d._id === id);
      if (doc) apply(doc, update);
    },
    // `returnDocument: "before"` is honoured, because the production code decides what to
    // announce from the document the write itself handed back. A mock that returned the state
    // AFTER the pull would make every "did this write remove anything" answer false.
    findOneAndUpdate: (
      filter: object,
      update: Update,
      options?: { returnDocument?: "before" | "after" }
    ) => {
      findOneAndUpdate(filter, update, options);
      const doc = store.find(sift(filter));
      const before = doc ? structuredClone(doc) : null;
      if (doc) apply(doc, update);
      return lean(options?.returnDocument === "before" ? before : doc ?? null);
    },
  },
}));
vi.mock("@/models/project", () => ({
  Project: { findById: () => lean({ key: "BP", name: "Board Planner" }) },
}));
vi.mock("@/lib/usernames", () => ({ usernameOf: async () => "rafal" }));
vi.mock("@/lib/activity", () => ({
  logActivities: (rows: unknown[]) => logActivities(rows),
}));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: (...a: unknown[]) => dispatchWebhooks(...a) }));
vi.mock("@/lib/notifications", () => ({
  dispatchNotifications: (...a: unknown[]) => dispatchNotifications(...a),
}));
vi.mock("@/lib/in-app-notifications", () => ({
  createNotifications: (p: unknown) => createNotifications(p),
  collectRecipients: (t: { assignee?: string; watchers?: string[] }) =>
    [t.assignee, ...(t.watchers ?? [])].filter(Boolean),
  assigneeIdOf: (t: { assignee?: string }) => t.assignee,
}));

const { addTaskLink, removeTaskLink } = await import("./task-links");

const P = "p1";
const ACTOR = "u-actor";

function task(id: string, taskNumber: number, extra: Partial<Doc> = {}): Doc {
  return {
    _id: id,
    project: P,
    taskNumber,
    title: `Task ${taskNumber}`,
    status: "todo",
    watchers: [],
    relations: [],
    blockedBy: [],
    ...extra,
  };
}

/**
 * Every timeline row this call wrote, as [taskId, action, direction, oldValue, newValue].
 *
 * The two value slots stay apart on purpose. Collapsing them to whichever is non-empty reads the
 * same either way round, and the timeline does not: it renders `newValue` for `link_added` and
 * `oldValue` for `link_removed`, so a write into the wrong slot is a row naming no other end.
 */
type LoggedRow = {
  taskId: string;
  action: string;
  field: string;
  oldValue: string;
  newValue: string;
};

function rows(): [string, string, string, string, string][] {
  return logActivities.mock.calls.flatMap((c) =>
    (c[0] as LoggedRow[]).map(
      (r) =>
        [r.taskId, r.action, r.field, r.oldValue, r.newValue] as [
          string,
          string,
          string,
          string,
          string,
        ]
    )
  );
}

function notifiedTasks(): { taskId: string; title: string }[] {
  return createNotifications.mock.calls.map((c) => ({
    taskId: (c[0] as { taskId: string }).taskId,
    title: (c[0] as { title: string }).title,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, and two tests below give `updateOne` a side effect to
  // simulate a task vanishing mid-request. Without this, that side effect ran in every test
  // declared after them.
  updateOne.mockReset();
  findOneAndUpdate.mockReset();
  store = [];
});

describe("addTaskLink", () => {
  it("writes a row at both ends of a new relation, naming the other end from each side", async () => {
    store = [task("a", 1), task("b", 2)];

    const result = await addTaskLink(P, "a", "b", "relates", ACTOR);

    expect(result).toEqual({ ok: true });
    expect(rows()).toEqual([
      ["a", "link_added", "relates", "", "BP-2"],
      ["b", "link_added", "relates", "", "BP-1"],
    ]);
    expect(dispatchWebhooks).toHaveBeenCalledTimes(1);
    expect(dispatchWebhooks.mock.calls[0][1]).toBe("task_linked");
  });

  it("reads the blocking direction from each end", async () => {
    store = [task("a", 1), task("b", 2)];

    await addTaskLink(P, "a", "b", "blocked_by", ACTOR);

    expect(rows()).toEqual([
      ["a", "link_added", "blocked_by", "", "BP-2"],
      ["b", "link_added", "blocks", "", "BP-1"],
    ]);
    expect(findByIdAndUpdate).toHaveBeenCalledWith("a", { $addToSet: { blockedBy: "b" } });
  });

  // The case the ticket is about: the epic that loses a child is named by nobody in the call.
  it("tells the previous parent it lost a child, and notifies its watchers", async () => {
    store = [
      task("old", 9, { relations: [{ task: "child", type: "parent_of" }], watchers: ["u-owner"] }),
      task("new", 10),
      task("child", 11),
    ];

    await addTaskLink(P, "new", "child", "parent_of", ACTOR);

    expect(rows()).toEqual([
      ["old", "link_removed", "parent_of", "BP-11", ""],
      ["child", "link_removed", "child_of", "BP-9", ""],
      ["new", "link_added", "parent_of", "", "BP-11"],
      ["child", "link_added", "child_of", "", "BP-10"],
    ]);

    const notified = notifiedTasks();
    expect(notified.map((n) => n.taskId).sort()).toEqual(["child", "new", "old"]);
    expect(notified.find((n) => n.taskId === "old")?.title).toBe(
      "rafal removed BP-11 from BP-9's children"
    );
    expect(
      createNotifications.mock.calls.find(
        (c) => (c[0] as { taskId: string }).taskId === "old"
      )?.[0]
    ).toMatchObject({ type: "task_linked", recipientIds: ["u-owner"] });

    // And the move itself happened: the rows above describe a real re-parent, not a narration
    expect(store.find((d) => d._id === "old")!.relations).toEqual([]);
    expect(store.find((d) => d._id === "new")!.relations).toEqual([
      { task: "child", type: "parent_of" },
    ]);
  });

  // It both lost and gained a parent; the bell says where it ended up, the timeline keeps both.
  it("rings the re-parented child once, about the parent it gained", async () => {
    store = [
      task("old", 9, { relations: [{ task: "child", type: "parent_of" }] }),
      task("new", 10),
      task("child", 11),
    ];

    await addTaskLink(P, "new", "child", "parent_of", ACTOR);

    const forChild = notifiedTasks().filter((n) => n.taskId === "child");
    expect(forChild).toHaveLength(1);
    expect(forChild[0].title).toBe("rafal made BP-10 the parent of BP-11");
  });

  it("says nothing when the same link is sent again", async () => {
    store = [task("a", 1, { relations: [{ task: "b", type: "relates" }] }), task("b", 2)];

    const result = await addTaskLink(P, "a", "b", "relates", ACTOR);

    expect(result).toEqual({ ok: true });
    expect(rows()).toEqual([]);
    expect(createNotifications).not.toHaveBeenCalled();
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });

  it("says nothing when an existing blocker is sent again", async () => {
    store = [task("a", 1, { blockedBy: ["b"] }), task("b", 2)];

    expect(await addTaskLink(P, "a", "b", "blocked_by", ACTOR)).toEqual({ ok: true });
    expect(rows()).toEqual([]);
  });

  // One pair holds one relation, so choosing a different type silently replaced the old one.
  it("records the relation a different type replaced", async () => {
    store = [task("a", 1, { relations: [{ task: "b", type: "relates" }] }), task("b", 2)];

    await addTaskLink(P, "a", "b", "duplicates", ACTOR);

    expect(rows()).toEqual([
      ["a", "link_removed", "relates", "BP-2", ""],
      ["b", "link_removed", "relates", "BP-1", ""],
      ["a", "link_added", "duplicates", "", "BP-2"],
      ["b", "link_added", "duplicated_by", "", "BP-1"],
    ]);
    expect(dispatchWebhooks.mock.calls.map((c) => c[1])).toEqual(["task_unlinked", "task_linked"]);
    // "one pair holds one relation" is a claim about the stored document, not about the rows
    expect(store.find((d) => d._id === "a")!.relations).toEqual([
      { task: "b", type: "duplicates" },
    ]);
  });

  it("refuses a task linked to itself", async () => {
    expect(await addTaskLink(P, "a", "a", "relates", ACTOR)).toEqual({
      ok: false,
      error: "A task cannot depend on itself",
      status: 400,
    });
  });

  it("refuses a task that is not on this project", async () => {
    store = [task("a", 1)];

    expect(await addTaskLink(P, "a", "b", "relates", ACTOR)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("refuses a parent that is already a descendant, without writing anything", async () => {
    store = [
      task("a", 1),
      task("b", 2, { relations: [{ task: "a", type: "parent_of" }] }),
      // A third task holding `b` — the TARGET — as its child, because that is what the detach
      // looks for. Holding `a` instead made the detach a no-op for this fixture either way, and
      // the "writes nothing" half of this test was satisfied trivially.
      task("elsewhere", 3, { relations: [{ task: "b", type: "parent_of" }] }),
    ];

    expect(await addTaskLink(P, "a", "b", "parent_of", ACTOR)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(rows()).toEqual([]);
    expect(store.find((d) => d._id === "elsewhere")!.relations).toEqual([
      { task: "b", type: "parent_of" },
    ]);
    expect(store.find((d) => d._id === "a")!.relations).toEqual([]);
  });

  it("refuses a blocker that would close a cycle", async () => {
    store = [task("a", 1), task("b", 2, { blockedBy: ["a"] })];

    expect(await addTaskLink(P, "a", "b", "blocked_by", ACTOR)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
  });
});

describe("removeTaskLink", () => {
  it("writes a row at both ends of a link it actually held", async () => {
    store = [task("a", 1, { relations: [{ task: "b", type: "duplicates" }] }), task("b", 2)];

    expect(await removeTaskLink(P, "a", "b", "duplicates", ACTOR)).toEqual({ ok: true });
    expect(rows()).toEqual([
      ["a", "link_removed", "duplicates", "BP-2", ""],
      ["b", "link_removed", "duplicated_by", "BP-1", ""],
    ]);
    expect(dispatchWebhooks.mock.calls[0][1]).toBe("task_unlinked");
  });

  // BP-657: the same call from the other end removes nothing. Until that is settled, it must at
  // least not write a history row claiming it did.
  it("says nothing when this end held no such link", async () => {
    store = [task("a", 1), task("b", 2, { relations: [{ task: "a", type: "duplicates" }] })];

    expect(await removeTaskLink(P, "a", "b", "duplicates", ACTOR)).toEqual({ ok: true });
    expect(rows()).toEqual([]);
    expect(createNotifications).not.toHaveBeenCalled();
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });

  it("says nothing when the named type is not the type that is stored", async () => {
    store = [task("a", 1, { relations: [{ task: "b", type: "relates" }] }), task("b", 2)];

    expect(await removeTaskLink(P, "a", "b", "duplicates", ACTOR)).toMatchObject({ ok: true });
    expect(rows()).toEqual([]);
    // And nothing was taken: the `$pull` runs before the guard, so a criteria that forgot the type
    // would delete the relation that IS there and still report having done nothing.
    expect(store.find((d) => d._id === "a")!.relations).toEqual([{ task: "b", type: "relates" }]);
  });

  it("records a blocker being taken off", async () => {
    store = [task("a", 1, { blockedBy: ["b"] }), task("b", 2)];

    await removeTaskLink(P, "a", "b", "blocked_by", ACTOR);

    expect(rows()).toEqual([
      ["a", "link_removed", "blocked_by", "BP-2", ""],
      ["b", "link_removed", "blocks", "BP-1", ""],
    ]);
  });

  it("refuses a task that is not on this project", async () => {
    expect(await removeTaskLink(P, "a", "b", "relates", ACTOR)).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe("a child with more than one parent", () => {
  // The detach is a loop, and every fixture elsewhere gives the child exactly one parent — so its
  // second iteration was pinned by nothing. Data like this is already broken (a task has one
  // parent), which is the only reason the loop exists rather than a single write.
  it("takes the child off every one of them, and tells each", async () => {
    store = [
      task("old-a", 8, { relations: [{ task: "child", type: "parent_of" }], watchers: ["u-a"] }),
      task("old-b", 9, { relations: [{ task: "child", type: "parent_of" }], watchers: ["u-b"] }),
      task("new", 10),
      task("child", 11),
    ];

    await addTaskLink(P, "new", "child", "parent_of", ACTOR);

    expect(store.find((d) => d._id === "old-a")!.relations).toEqual([]);
    expect(store.find((d) => d._id === "old-b")!.relations).toEqual([]);
    expect(store.find((d) => d._id === "new")!.relations).toEqual([
      { task: "child", type: "parent_of" },
    ]);

    // Both losses, then the gain — and the child's side of each
    expect(rows()).toEqual([
      ["old-a", "link_removed", "parent_of", "BP-11", ""],
      ["child", "link_removed", "child_of", "BP-8", ""],
      ["old-b", "link_removed", "parent_of", "BP-11", ""],
      ["child", "link_removed", "child_of", "BP-9", ""],
      ["new", "link_added", "parent_of", "", "BP-11"],
      ["child", "link_added", "child_of", "", "BP-10"],
    ]);

    const notified = createNotifications.mock.calls.map((c) => c[0] as { taskId: string });
    expect(notified.map((n) => n.taskId).sort()).toEqual(["child", "new", "old-a", "old-b"]);
  });

  // One write, in one order: the timeline breaks a createdAt tie on _id, so the order these are
  // inserted in is the order a reader sees
  it("writes every row of the act in a single batch", async () => {
    store = [
      task("old", 9, { relations: [{ task: "child", type: "parent_of" }] }),
      task("new", 10),
      task("child", 11),
    ];

    await addTaskLink(P, "new", "child", "parent_of", ACTOR);

    expect(logActivities).toHaveBeenCalledTimes(1);
    expect((logActivities.mock.calls[0][0] as unknown[]).length).toBe(4);
  });
});

describe("the task goes away mid-request", () => {
  // The detach proves what it removed; the attach has to prove what it added, or the sentence
  // announces a parenting that never happened.
  it("announces the detach it really did, and refuses the link it could not make", async () => {
    store = [
      task("old", 9, { relations: [{ task: "child", type: "parent_of" }] }),
      task("new", 10),
      task("child", 11),
    ];
    // Deleted between the PULL and the PUSH. Deleting on the pull instead would make both writes
    // miss, and the test could not then tell which of the two the guard reads.
    updateOne.mockImplementation((_filter: object, update: Update) => {
      if (update.$push) store = store.filter((d) => d._id !== "new");
    });

    expect(await addTaskLink(P, "new", "child", "parent_of", ACTOR)).toEqual({
      ok: false,
      error: "Task not found — it was removed while this link was being made",
      status: 404,
    });

    // The old epic really did lose the child, so it is still owed its row
    expect(rows()).toEqual([
      ["old", "link_removed", "parent_of", "BP-11", ""],
      ["child", "link_removed", "child_of", "BP-9", ""],
    ]);
    expect(rows().some((r) => r[1] === "link_added")).toBe(false);
  });
});

describe("somebody else is re-parenting the same child", () => {
  // The detach loop's own writes cannot make a document match twice — `$pull` uses the operand the
  // filter matched on. Another request's `$push` can. Without a guard the loop keeps going for as
  // long as that traffic lasts, and collects the same epic more than once on the way: a duplicate
  // history row and a duplicate webhook for one act.
  it("detaches a parent once, however often it is put back", async () => {
    store = [
      task("old", 9, { relations: [{ task: "child", type: "parent_of" }] }),
      task("new", 10),
      task("child", 11),
    ];
    // The recorder runs before the write, so re-adding on the SECOND call puts the relation back
    // after the first iteration has already detached it — which is what another request doing a
    // re-parent looks like from in here. Re-adding on the first call would only give the first
    // `$pull` two elements to remove at once.
    let call = 0;
    findOneAndUpdate.mockImplementation(() => {
      call += 1;
      if (call === 2) {
        store
          .find((d) => d._id === "old")!
          .relations!.push({ task: "child", type: "parent_of" });
      }
    });

    await addTaskLink(P, "new", "child", "parent_of", ACTOR);

    const removals = rows().filter((r) => r[1] === "link_removed" && r[0] === "old");
    expect(removals).toHaveLength(1);
    // and the loop stopped rather than going round again
    expect(rows().filter((r) => r[0] === "child" && r[1] === "link_removed")).toHaveLength(1);
  });
});

describe("a relation replaced by another", () => {
  // The replaced link used to be announced on the strength of the read taken before the write —
  // the very thing the parent detach was rewritten to stop doing. Two ways it lies:

  it("does not report the replacement when the task vanished before the pull", async () => {
    store = [task("a", 1, { relations: [{ task: "b", type: "relates" }] }), task("b", 2)];
    updateOne.mockImplementation((_filter: object, update: Update) => {
      if (update.$pull) store = store.filter((d) => d._id !== "a");
    });

    expect(await addTaskLink(P, "a", "b", "duplicates", ACTOR)).toEqual({
      ok: false,
      error: "Task not found — it was removed while this link was being made",
      status: 404,
    });
    // Nothing was removed and nothing was added, so nothing is owed a row
    expect(rows()).toEqual([]);
  });

  // No deletion needed for this one. Two requests replacing the same relation both read it as
  // present and only one can pull it; the loser's `$pull` still MATCHES its document, so a guard
  // reading matchedCount would let it announce a removal somebody else performed.
  it("does not report a replacement another request had already made", async () => {
    store = [task("a", 1, { relations: [{ task: "b", type: "relates" }] }), task("b", 2)];
    updateOne.mockImplementation((_filter: object, update: Update) => {
      // Somebody else got there between this request's read and its own write
      if (update.$pull) store.find((d) => d._id === "a")!.relations = [];
    });

    expect(await addTaskLink(P, "a", "b", "duplicates", ACTOR)).toEqual({ ok: true });

    expect(rows().filter((r) => r[1] === "link_removed")).toEqual([]);
    expect(rows().map((r) => [r[0], r[1], r[2]])).toEqual([
      ["a", "link_added", "duplicates"],
      ["b", "link_added", "duplicated_by"],
    ]);
  });
});

describe("a board is not the only board", () => {
  // Every read and write in the module is scoped by project. Without a task on a SECOND board,
  // deleting those filters changes no assertion — and an un-scoped `parent_of` detach would reach
  // across every board in the database.
  const OTHER = "p2";

  it("refuses to link a task on another board", async () => {
    store = [task("a", 1), { ...task("b", 2), project: OTHER }];

    expect(await addTaskLink(P, "a", "b", "relates", ACTOR)).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(store.find((d) => d._id === "a")!.relations).toEqual([]);
  });

  // The descendant check scans the board's own parent graph. Unscoped it would refuse a perfectly
  // good link because some other board happens to hold the opposite chain.
  it("does not refuse a link because another board holds the opposite chain", async () => {
    // The walk starts at the target and goes down. For the filter to matter the chain has to
    // leave this board on the SECOND hop: `b` is here and names `z`, `z` is elsewhere and names
    // `a`. Scoped, the walk stops at `z`; unscoped it reaches `a` and refuses a good link.
    store = [
      task("a", 1),
      task("b", 2, { relations: [{ task: "z", type: "parent_of" }] }),
      { ...task("z", 80, { relations: [{ task: "a", type: "parent_of" }] }), project: OTHER },
    ];

    expect(await addTaskLink(P, "a", "b", "parent_of", ACTOR)).toEqual({ ok: true });
    expect(store.find((d) => d._id === "a")!.relations).toEqual([{ task: "b", type: "parent_of" }]);
  });

  it("leaves another board's parent holding its child", async () => {
    store = [
      { ...task("elsewhere", 90, { relations: [{ task: "child", type: "parent_of" }] }), project: OTHER },
      task("mine", 10),
      task("child", 11),
    ];

    await addTaskLink(P, "mine", "child", "parent_of", ACTOR);

    expect(store.find((d) => d._id === "elsewhere")!.relations).toEqual([
      { task: "child", type: "parent_of" },
    ]);
    expect(rows().map((r) => r[0])).toEqual(["mine", "child"]);
  });

  it("will not remove a link from a task on another board", async () => {
    store = [{ ...task("a", 1, { relations: [{ task: "b", type: "relates" }] }), project: OTHER }];

    expect(await removeTaskLink(P, "a", "b", "relates", ACTOR)).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(store.find((d) => d._id === "a")!.relations).toEqual([{ task: "b", type: "relates" }]);
  });
});

describe("the same id, spelled differently", () => {
  // `isValidObjectId` accepts upper-case hex and `resolveTaskId` passes the path segment through
  // untouched, while `String(ObjectId)` is lower-case. Mongo casts every spelling to one id and
  // writes; only the comparisons here disagree — and the worst of it was a DELETE that really
  // removed the link and then reported nothing at all.
  const LOWER_A = "507f1f77bcf86cd799439011";
  const UPPER_A = LOWER_A.toUpperCase();
  const LOWER_B = "507f1f77bcf86cd799439012";
  const UPPER_B = LOWER_B.toUpperCase();

  it("records the removal when the request spells the id in upper case", async () => {
    store = [task(LOWER_A, 1, { blockedBy: [LOWER_B] }), task(LOWER_B, 2)];

    expect(await removeTaskLink(P, UPPER_A, UPPER_B, "blocked_by", ACTOR)).toEqual({ ok: true });
    expect(store.find((d) => d._id === LOWER_A)!.blockedBy).toEqual([]);
    expect(rows()).toEqual([
      [LOWER_A, "link_removed", "blocked_by", "BP-2", ""],
      [LOWER_B, "link_removed", "blocks", "BP-1", ""],
    ]);
  });

  it("still says nothing when an upper-case request re-sends a link that exists", async () => {
    store = [task(LOWER_A, 1, { relations: [{ task: LOWER_B, type: "relates" }] }), task(LOWER_B, 2)];

    expect(await addTaskLink(P, UPPER_A, UPPER_B, "relates", ACTOR)).toEqual({ ok: true });
    expect(rows()).toEqual([]);
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });

  // The same mismatch made a task its own parent: `targetTaskId === taskId` compared two spellings
  it("refuses a task linked to itself under a different spelling", async () => {
    store = [task(LOWER_A, 1)];

    expect(await addTaskLink(P, UPPER_A, LOWER_A, "relates", ACTOR)).toMatchObject({
      ok: false,
      status: 400,
    });
    // and the relation this used to write is not there
    expect(store.find((d) => d._id === LOWER_A)!.relations).toEqual([]);
  });

  // A re-parent that changes nothing must not fabricate the loss of a child
  it("does not report a parent losing the child it is being given", async () => {
    store = [
      task(LOWER_A, 1, { relations: [{ task: LOWER_B, type: "parent_of" }] }),
      task(LOWER_B, 2),
    ];

    expect(await addTaskLink(P, UPPER_A, UPPER_B, "parent_of", ACTOR)).toEqual({ ok: true });
    expect(rows()).toEqual([]);
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });
});

describe("what leaves the building", () => {
  // The event name alone says nothing about what a receiver is handed, and no other layer covers
  // the payload: the e2e rig cannot deliver a webhook at all (isAllowedWebhookUrl refuses http).
  it("hands the webhook both ends, the type, and the sentence", async () => {
    store = [task("a", 1), task("b", 2)];

    await addTaskLink(P, "a", "b", "parent_of", ACTOR);

    expect(dispatchWebhooks).toHaveBeenCalledTimes(1);
    const [projectId, event, payload] = dispatchWebhooks.mock.calls[0];
    expect(projectId).toBe(P);
    expect(event).toBe("task_linked");
    expect(payload).toEqual({
      project: { key: "BP", name: "Board Planner" },
      task: { taskKey: "BP-1", title: "Task 1", status: "todo" },
      data: {
        type: "parent_of",
        relatedTaskKey: "BP-2",
        relatedTaskTitle: "Task 2",
        summary: "rafal made BP-1 the parent of BP-2",
      },
    });
  });

  // The project's shared Slack/Discord channel is a second dispatcher with its own event filter
  it("tells the project's own channel the same thing", async () => {
    store = [task("a", 1), task("b", 2)];

    await addTaskLink(P, "a", "b", "relates", ACTOR);

    expect(dispatchNotifications).toHaveBeenCalledTimes(1);
    const [projectId, event, payload] = dispatchNotifications.mock.calls[0];
    expect([projectId, event]).toEqual([P, "task_linked"]);
    // The formatters read `data.summary` and `data.relatedTaskKey`; an absent one renders blank
    expect(payload).toMatchObject({
      data: { summary: "rafal linked BP-1 to BP-2", relatedTaskKey: "BP-2" },
    });
  });

  it("gives the e-mail everything it needs to render a row", async () => {
    store = [task("a", 1, { assignee: "u-assignee" }), task("b", 2)];

    await addTaskLink(P, "a", "b", "duplicates", ACTOR);

    const forA = createNotifications.mock.calls
      .map((c) => c[0] as { taskId: string; email?: Record<string, unknown> })
      .find((n) => n.taskId === "a")!;
    expect(forA.email).toEqual({
      kicker: "Tasks linked",
      taskKey: "BP-1",
      taskTitle: "Task 1",
      taskMeta: "Board Planner · rafal marked BP-1 as a duplicate of BP-2",
      projectRef: "BP",
      taskNumber: 1,
      assigneeId: "u-assignee",
    });
  });

  it("calls the removal a removal in the mail", async () => {
    store = [task("a", 1, { relations: [{ task: "b", type: "relates" }] }), task("b", 2)];

    await removeTaskLink(P, "a", "b", "relates", ACTOR);

    const forA = createNotifications.mock.calls
      .map((c) => c[0] as { taskId: string; email?: { kicker?: string } })
      .find((n) => n.taskId === "a")!;
    expect(forA.email?.kicker).toBe("Link removed");
  });
});
