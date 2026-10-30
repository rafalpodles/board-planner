import { describe, expect, it } from "vitest";
import { hostToolName, toolFromShape, viewContext } from "./context";

const task = { _id: "6ac760c7a7f1e7237e2d8865", project: "69a52e3b399b27d3cbb2c5a5", taskNumber: 969, title: "Card", status: "done" };

describe("viewContext", () => {
  it("prefers the server's own view context", () => {
    const meta = { tool: "list_tasks", arguments: { project: "BP", offset: 50 }, origin: "https://board.example" };
    expect(viewContext(meta, "get_task", { taskKey: "BP-1" }, task)).toEqual({ tool: "list_tasks", args: { project: "BP", offset: 50 }, origin: "https://board.example", argsKnown: true });
  });

  it("uses the host's tool info and arguments when the result's _meta was dropped", () => {
    expect(viewContext(undefined, "list_tasks", { project: "BP", limit: 1 }, { tasks: [] })).toEqual({ tool: "list_tasks", args: { project: "BP", limit: 1 }, argsKnown: true });
    expect(viewContext({}, "mcp__board-planner__get_task", undefined, task)).toEqual({ tool: "get_task", args: {}, argsKnown: false });
  });

  it("trusts the host's tool name over the payload's shape", () => {
    const emptyPage = { total: 0, returned: 0, offset: 100, nextOffset: null, tasks: [] };
    expect(viewContext(undefined, "my_tasks", { offset: 100 }, emptyPage)).toEqual({ tool: "my_tasks", args: { offset: 100 }, argsKnown: true });
    expect(viewContext(undefined, "create_task", { project: "BP", title: "T" }, task)?.tool).toBe("create_task");
  });

  it("does not trust arguments for a tool guessed from the payload", () => {
    const emptyPage = { total: 0, returned: 0, offset: 100, nextOffset: null, tasks: [] };
    expect(viewContext(undefined, undefined, { offset: 100 }, emptyPage)).toEqual({ tool: "list_tasks", args: { offset: 100 }, argsKnown: false });
  });

  it("falls back to the payload's shape when the host names nothing", () => {
    expect(viewContext(undefined, undefined, undefined, task)).toEqual({ tool: "get_task", args: {}, argsKnown: false });
  });

  it("is silent about a result it cannot identify", () => {
    expect(viewContext(undefined, "list_comments", undefined, { comments: [] })).toBeUndefined();
  });
});

describe("hostToolName", () => {
  it.each([["get_task", "get_task"], ["mcp__1a2b__search_tasks", "search_tasks"], ["list_comments", undefined], [undefined, undefined]])("%s → %s", (name, tool) => {
    expect(hostToolName(name)).toBe(tool);
  });
});

describe("toolFromShape", () => {
  it.each([
    ["a full task", task, "get_task"],
    ["a minimal write answer", { key: "BP-1", title: "T", status: "todo", priority: "medium", assignee: null, url: "https://board.example/projects/BP/tasks/1" }, "update_task"],
    ["a board page", { total: 1, returned: 1, offset: 0, nextOffset: null, tasks: [{ key: "BP-1", title: "T" }] }, "list_tasks"],
    ["the caller's tasks", { total: 1, returned: 1, offset: 0, nextOffset: null, tasks: [{ key: "BP-1", statusRole: "active" }] }, "my_tasks"],
    ["a search", { returned: 0, truncated: false, tasks: [] }, "search_tasks"],
    ["a sprint", { sprint: { name: "S" }, tasks: [] }, "get_sprint"],
    ["sprints", [{ name: "S" }], "list_sprints"],
    ["stats", { total: 4, done: 1, statusBreakdown: { todo: 3 } }, "get_project_stats"],
    ["something else", { comments: [] }, undefined],
    ["text", "plain", undefined],
  ])("%s", (_name, data, tool) => {
    expect(toolFromShape(data)).toBe(tool);
  });
});
