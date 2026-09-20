import { describe, it, expect, vi, beforeEach } from "vitest";
// mongoose's own query matcher, so the filter that finds the previous parents is judged by
// MongoDB semantics rather than by a stub that answers whatever the test wanted
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
const logActivity = vi.fn();
const dispatchWebhooks = vi.fn();
const dispatchNotifications = vi.fn();
const createNotifications = vi.fn();

const lean = <T>(value: T) => ({ lean: async () => value });

vi.mock("@/models/task", () => ({
  Task: {
    findOne: (filter: object) => lean(store.find(sift(filter)) ?? null),
    find: (filter: object) => lean(store.filter(sift(filter))),
    updateOne,
    updateMany,
    findByIdAndUpdate,
    findOneAndUpdate,
  },
}));
vi.mock("@/models/project", () => ({
  Project: { findById: () => lean({ key: "BP", name: "Board Planner" }) },
}));
vi.mock("@/lib/usernames", () => ({ usernameOf: async () => "rafal" }));
vi.mock("@/lib/activity", () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }));
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

/** Every timeline row this call wrote, as [taskId, action, direction, otherKey]. */
function rows(): [string, string, string, string][] {
  return logActivity.mock.calls.map((c) => [
    c[0] as string,
    c[2] as string,
    c[3] as string,
    (c[4] || c[5]) as string,
  ]);
}

function notifiedTasks(): { taskId: string; title: string }[] {
  return createNotifications.mock.calls.map((c) => ({
    taskId: (c[0] as { taskId: string }).taskId,
    title: (c[0] as { title: string }).title,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  store = [];
});

describe("addTaskLink", () => {
  it("writes a row at both ends of a new relation, naming the other end from each side", async () => {
    store = [task("a", 1), task("b", 2)];

    const result = await addTaskLink(P, "a", "b", "relates", ACTOR);

    expect(result).toEqual({ ok: true, changed: true });
    expect(rows()).toEqual([
      ["a", "link_added", "relates", "BP-2"],
      ["b", "link_added", "relates", "BP-1"],
    ]);
    expect(dispatchWebhooks).toHaveBeenCalledTimes(1);
    expect(dispatchWebhooks.mock.calls[0][1]).toBe("task_linked");
  });

  it("reads the blocking direction from each end", async () => {
    store = [task("a", 1), task("b", 2)];

    await addTaskLink(P, "a", "b", "blocked_by", ACTOR);

    expect(rows()).toEqual([
      ["a", "link_added", "blocked_by", "BP-2"],
      ["b", "link_added", "blocks", "BP-1"],
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
      ["old", "link_removed", "parent_of", "BP-11"],
      ["child", "link_removed", "child_of", "BP-9"],
      ["new", "link_added", "parent_of", "BP-11"],
      ["child", "link_added", "child_of", "BP-10"],
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

    expect(result).toEqual({ ok: true, changed: false });
    expect(logActivity).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });

  it("says nothing when an existing blocker is sent again", async () => {
    store = [task("a", 1, { blockedBy: ["b"] }), task("b", 2)];

    expect(await addTaskLink(P, "a", "b", "blocked_by", ACTOR)).toEqual({
      ok: true,
      changed: false,
    });
    expect(logActivity).not.toHaveBeenCalled();
  });

  // One pair holds one relation, so choosing a different type silently replaced the old one.
  it("records the relation a different type replaced", async () => {
    store = [task("a", 1, { relations: [{ task: "b", type: "relates" }] }), task("b", 2)];

    await addTaskLink(P, "a", "b", "duplicates", ACTOR);

    expect(rows()).toEqual([
      ["a", "link_removed", "relates", "BP-2"],
      ["b", "link_removed", "relates", "BP-1"],
      ["a", "link_added", "duplicates", "BP-2"],
      ["b", "link_added", "duplicated_by", "BP-1"],
    ]);
    expect(dispatchWebhooks.mock.calls.map((c) => c[1])).toEqual(["task_unlinked", "task_linked"]);
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
    ];

    expect(await addTaskLink(P, "a", "b", "parent_of", ACTOR)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(logActivity).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
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

    expect(await removeTaskLink(P, "a", "b", "duplicates", ACTOR)).toEqual({
      ok: true,
      changed: true,
    });
    expect(rows()).toEqual([
      ["a", "link_removed", "duplicates", "BP-2"],
      ["b", "link_removed", "duplicated_by", "BP-1"],
    ]);
    expect(dispatchWebhooks.mock.calls[0][1]).toBe("task_unlinked");
  });

  // BP-657: the same call from the other end removes nothing. Until that is settled, it must at
  // least not write a history row claiming it did.
  it("says nothing when this end held no such link", async () => {
    store = [task("a", 1), task("b", 2, { relations: [{ task: "a", type: "duplicates" }] })];

    expect(await removeTaskLink(P, "a", "b", "duplicates", ACTOR)).toEqual({
      ok: true,
      changed: false,
    });
    expect(logActivity).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });

  it("says nothing when the named type is not the type that is stored", async () => {
    store = [task("a", 1, { relations: [{ task: "b", type: "relates" }] }), task("b", 2)];

    expect(await removeTaskLink(P, "a", "b", "duplicates", ACTOR)).toMatchObject({
      changed: false,
    });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("records a blocker being taken off", async () => {
    store = [task("a", 1, { blockedBy: ["b"] }), task("b", 2)];

    await removeTaskLink(P, "a", "b", "blocked_by", ACTOR);

    expect(rows()).toEqual([
      ["a", "link_removed", "blocked_by", "BP-2"],
      ["b", "link_removed", "blocks", "BP-1"],
    ]);
  });

  it("refuses a task that is not on this project", async () => {
    expect(await removeTaskLink(P, "a", "b", "relates", ACTOR)).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});
