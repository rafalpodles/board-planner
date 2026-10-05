import { describe, it, expect } from "vitest";
import { describeLink, taskSummary, withTaskKeys } from "./task-shape";

describe("taskSummary", () => {
  it("keeps what is needed to know a write worked and to find the task", () => {
    expect(
      taskSummary(
        { taskNumber: 7, title: "T", status: "todo", priority: "high", assignee: { username: "rafal" } },
        "BP-7",
        "https://b.example/projects/BP/tasks/7"
      )
    ).toEqual({
      key: "BP-7",
      title: "T",
      status: "todo",
      priority: "high",
      assignee: "rafal",
      url: "https://b.example/projects/BP/tasks/7",
    });
  });

  it("says nobody when the task has no assignee", () => {
    expect(taskSummary({ title: "T", assignee: null }, "BP-7", "u").assignee).toBeNull();
  });
});

describe("withTaskKeys", () => {
  const task = {
    title: "Epic",
    blockedBy: [{ _id: "b", taskNumber: 3, title: "Blocker", status: "todo" }],
    blocking: [{ _id: "c", taskNumber: 4, title: "Blocked", status: "todo" }],
    relations: [
      { type: "parent_of", task: { _id: "k1", taskNumber: 8, title: "Child one", status: "todo" } },
      { type: "relates", task: { _id: "r", taskNumber: 9, title: "Related", status: "done" } },
    ],
    relatedFrom: [
      { type: "parent_of", task: { _id: "p", taskNumber: 1, title: "Top", status: "active" } },
      { type: "duplicates", task: { _id: "d", taskNumber: 2, title: "Copy", status: "todo" } },
    ],
  };

  it("names every linked task by key, and keeps everything it already carried", () => {
    const keyed = withTaskKeys(task, "MY-APP");

    expect(keyed.blockedBy).toEqual([{ _id: "b", taskNumber: 3, title: "Blocker", status: "todo", key: "MY-APP-3" }]);
    expect(keyed.blocking).toEqual([{ _id: "c", taskNumber: 4, title: "Blocked", status: "todo", key: "MY-APP-4" }]);
    expect(keyed.relations[1]).toEqual({
      type: "relates",
      task: { _id: "r", taskNumber: 9, title: "Related", status: "done", key: "MY-APP-9" },
    });
    expect(keyed.relatedFrom[1]).toMatchObject({ type: "duplicates", task: { key: "MY-APP-2" } });
    expect(keyed.title).toBe("Epic");
  });

  it("reads parent_of from both ends: the parent from the far side, the children from this one", () => {
    const keyed = withTaskKeys(task, "BP");

    expect(keyed.parent).toEqual({ key: "BP-1", title: "Top", status: "active" });
    expect(keyed.children).toEqual([{ key: "BP-8", title: "Child one", status: "todo" }]);
  });

  it("has no parent and no children when nothing is linked", () => {
    const keyed = withTaskKeys({ title: "Lone" }, "BP");

    expect(keyed.parent).toBeNull();
    expect(keyed.children).toEqual([]);
  });

  it("leaves a link to a task that no longer resolves alone rather than inventing a key", () => {
    const keyed = withTaskKeys({ relations: [{ type: "relates", task: null }] }, "BP");

    expect(keyed.relations).toEqual([{ type: "relates", task: null }]);
    expect(keyed.children).toEqual([]);
  });
});

describe("describeLink", () => {
  it.each([
    ["blocked_by", "BP-1 is blocked by BP-2"],
    ["relates", "BP-1 relates to BP-2"],
    ["duplicates", "BP-1 is a duplicate of BP-2"],
    ["parent_of", "BP-1 is the parent of BP-2"],
  ] as const)("says what %s means, read from the first key's side", (type, sentence) => {
    expect(describeLink(type, "bp-1", "bp-2", false)).toEqual({
      message: `Linked: ${sentence}`,
      taskKey: "BP-1",
      targetTaskKey: "BP-2",
      type,
    });
  });

  it("says a link was removed rather than added", () => {
    expect(describeLink("parent_of", "BP-1", "BP-2", true).message).toBe("Removed: BP-1 is the parent of BP-2");
  });
});
