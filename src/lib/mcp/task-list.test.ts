import { describe, it, expect } from "vitest";
import { listedTask, pageOf, sprintParam } from "./task-list";

describe("listedTask", () => {
  it("keeps what picks work from a listing, with a key to act on it by", () => {
    expect(
      listedTask(
        {
          taskNumber: 12,
          title: "T",
          status: "todo",
          priority: "high",
          assignee: { username: "rafal" },
          dueDate: "2026-10-10T00:00:00.000Z",
          sprint: { name: "Sprint 4" },
          parent: { taskNumber: 3 },
        },
        "MY-APP"
      )
    ).toEqual({
      key: "MY-APP-12",
      title: "T",
      status: "todo",
      priority: "high",
      assignee: "rafal",
      dueDate: "2026-10-10",
      sprint: "Sprint 4",
      parent: "MY-APP-3",
    });
  });

  it("says nothing where there is nothing, and reads a task predating priority as medium", () => {
    expect(listedTask({ taskNumber: 1, title: "T", status: "todo" }, "BP")).toMatchObject({
      priority: "medium",
      assignee: null,
      dueDate: null,
      sprint: null,
      parent: null,
    });
  });
});

describe("listedTask on an epic", () => {
  it("adds how many of its children are done", () => {
    expect(
      listedTask({ taskNumber: 1, title: "E", status: "todo", progress: { done: 2, total: 5 } }, "BP").progress
    ).toBe("2 of 5 done");
  });

  it("adds nothing to a task without children", () => {
    expect(listedTask({ taskNumber: 1, title: "E", status: "todo" }, "BP")).not.toHaveProperty("progress");
  });
});

describe("pageOf", () => {
  it("points at the next page while the total is not reached", () => {
    expect(pageOf(["a", "b"], 5, 0)).toEqual({ total: 5, returned: 2, offset: 0, nextOffset: 2, tasks: ["a", "b"] });
    expect(pageOf(["c", "d"], 5, 2).nextOffset).toBe(4);
  });

  it("points nowhere on the last page, so a truncated list cannot pass for a complete one", () => {
    expect(pageOf(["e"], 5, 4).nextOffset).toBeNull();
    expect(pageOf([], 0, 0)).toMatchObject({ total: 0, returned: 0, nextOffset: null });
  });
});

describe("sprintParam", () => {
  const sprints = [
    { _id: "507f1f77bcf86cd799439011", name: "Sprint 4" },
    { _id: "507f1f77bcf86cd799439012", name: "Hardening" },
  ];

  it("finds a sprint by name, in any case", () => {
    expect(sprintParam("hardening", sprints)).toBe("507f1f77bcf86cd799439012");
  });

  it("passes an id and the backlog sentinel through", () => {
    expect(sprintParam("507f1f77bcf86cd799439011", [])).toBe("507f1f77bcf86cd799439011");
    expect(sprintParam("Backlog", [])).toBe("backlog");
  });

  it("refuses a name two sprints share, with their ids, instead of answering for the first", () => {
    const twins = [
      { _id: "507f1f77bcf86cd799439011", name: "Sprint 4" },
      { _id: "507f1f77bcf86cd799439022", name: "sprint 4" },
    ];

    expect(() => sprintParam("Sprint 4", twins)).toThrow(
      /2 sprints are named "Sprint 4".*507f1f77bcf86cd799439011.*507f1f77bcf86cd799439022/
    );
    // ...and an id still says which one
    expect(sprintParam("507f1f77bcf86cd799439022", twins)).toBe("507f1f77bcf86cd799439022");
  });

  it("names the sprints the board has when the name matches none", () => {
    expect(() => sprintParam("Sprint 9", sprints)).toThrow(/No sprint "Sprint 9".*Sprint 4, Hardening/);
  });
});
