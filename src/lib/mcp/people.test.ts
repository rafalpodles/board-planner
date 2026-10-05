import { describe, it, expect } from "vitest";
import { agentLines, memberLines, myTaskLines, type AgentRow } from "./people";

describe("memberLines", () => {
  it("keeps the username and the name, and drops everything else about a person", () => {
    expect(
      memberLines([{ username: "rafal", fullName: "Rafal", ...{ email: "r@example.com", _id: "x" } } as never, { username: "bot" }])
    ).toEqual([
      { username: "rafal", fullName: "Rafal" },
      { username: "bot", fullName: "" },
    ]);
  });
});

describe("myTaskLines", () => {
  const task = (taskNumber: number, statusRole: string | null, extra: object = {}) => ({
    taskNumber,
    title: `T${taskNumber}`,
    status: statusRole === "done" ? "shipped" : "todo",
    statusRole,
    project: { key: "MY-APP", name: "My app" },
    ...extra,
  });
  const ALL = [task(5, "active"), task(4, "done"), task(3, null), task(2, "done"), task(1, "approved")];
  const options = { includeDone: false, limit: 50, offset: 0 };

  it("names each task by key and says which board it is on", () => {
    expect(myTaskLines([task(5, "active", { priority: "high", dueDate: "2026-10-10T00:00:00.000Z" })], options).tasks).toEqual([
      {
        key: "MY-APP-5",
        title: "T5",
        status: "todo",
        statusRole: "active",
        priority: "high",
        dueDate: "2026-10-10",
        project: "My app",
      },
    ]);
  });

  it("leaves finished work out by its role, not by a column called done, and keeps work in a deleted column", () => {
    const answer = myTaskLines(ALL, options);

    expect(answer.tasks.map((t) => t.key)).toEqual(["MY-APP-5", "MY-APP-3", "MY-APP-1"]);
    expect(answer.total).toBe(3);
    expect(myTaskLines(ALL, { ...options, includeDone: true }).total).toBe(5);
  });

  it("pages over what is left, and says where the next page starts", () => {
    const first = myTaskLines(ALL, { ...options, limit: 2 });
    const second = myTaskLines(ALL, { ...options, limit: 2, offset: 2 });

    expect(first.tasks.map((t) => t.key)).toEqual(["MY-APP-5", "MY-APP-3"]);
    expect(first.nextOffset).toBe(2);
    expect(second.tasks.map((t) => t.key)).toEqual(["MY-APP-1"]);
    expect(second.nextOffset).toBeNull();
  });

  it("reads a task predating priority as medium, and a deleted board as #n", () => {
    expect(myTaskLines([{ taskNumber: 9, title: "x", project: null }], options).tasks[0]).toMatchObject({
      key: "#9",
      priority: "medium",
      project: null,
      dueDate: null,
    });
  });
});

describe("agentLines", () => {
  const agents: AgentRow[] = [
    { name: "Default", scope: "global", composition: { steps: [{}, {}], gates: [{}] } },
    { name: "Mine", scope: "user", description: "personal", composition: { steps: [{}] } },
    { name: "Here", scope: "project", projectId: "p1", composition: {} },
    { name: "Elsewhere", scope: "project", projectId: "p2", composition: { steps: [{}] } },
  ];

  it("offers the project's own, and the ones that belong to no project", () => {
    expect(agentLines(agents, "p1").map((a) => a.name)).toEqual(["Default", "Mine", "Here"]);
  });

  it("counts every step across the composition, so an agent with none can be seen to be unusable", () => {
    expect(agentLines(agents, "p1").map((a) => [a.name, a.steps])).toEqual([
      ["Default", 3],
      ["Mine", 1],
      ["Here", 0],
    ]);
  });

  it("carries no ids", () => {
    expect(Object.keys(agentLines(agents, "p1")[0]).sort()).toEqual(["description", "name", "scope", "steps"]);
  });
});
