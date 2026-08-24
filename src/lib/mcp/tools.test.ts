import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerPlannerTools } from "./tools";
import { PlannerClient } from "./planner-client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;

// The registration is the only export, so the tools are reached by capturing what it registers
function registered() {
  const tools = new Map<string, { schema: Record<string, z.ZodTypeAny>; handler: Handler }>();
  const server = {
    tool: (name: string, _desc: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) =>
      tools.set(name, { schema, handler }),
  } as unknown as McpServer;
  registerPlannerTools(server);
  return tools;
}

const extra = { authInfo: { token: "cp_x", extra: { baseUrl: "https://board.example.com" } } };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(PlannerClient.prototype, "resolveTaskKey").mockResolvedValue({
    projectId: "p1",
    taskId: "t1",
  });
});

/**
 * BP-358: a claim requires a named agent, so a task assigned over MCP with no way to name one is
 * structurally unclaimable — and this repo's own workflow runs through MCP. Resolved by name
 * because an agent id appears in no MCP response, so demanding one would leave the parameter
 * unreachable from a conversation.
 */
describe("update_task and the agent that runs it", () => {
  function callUpdate(args: Record<string, unknown>) {
    return registered().get("update_task")!.handler({ taskKey: "BP-1", ...args }, extra);
  }

  it("offers the parameter at all", () => {
    expect(Object.keys(registered().get("update_task")!.schema)).toContain("agent");
  });

  it("resolves the agent by name and sends its id", async () => {
    vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([
      { _id: "a1", name: "Default" },
      { _id: "a2", name: "With security review" },
    ]);
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await callUpdate({ agent: "With security review" });

    expect(update).toHaveBeenCalledWith("p1", "t1", { agent: "a2" });
  });

  it("matches the name regardless of case, the way assignee does", async () => {
    vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([{ _id: "a1", name: "Default" }]);
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await callUpdate({ agent: "default" });

    expect(update).toHaveBeenCalledWith("p1", "t1", { agent: "a1" });
  });

  // Sending the name through unresolved would reach an ObjectId ref as a string and come back as
  // "that agent cannot run on this project" — a refusal about the wrong thing
  it("refuses a name no agent has, without writing anything", async () => {
    vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([{ _id: "a1", name: "Default" }]);
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await expect(callUpdate({ agent: "Nonexistent" })).rejects.toThrow(/Nonexistent/);
    expect(update).not.toHaveBeenCalled();
  });

  // Null, not "": an empty string is not a value an ObjectId ref can hold, and only updateTask's
  // own normalisation stands between the two
  it("sends null for the empty string, which means nobody runs it", async () => {
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});
    const agents = vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([]);

    await callUpdate({ agent: "" });

    expect(update).toHaveBeenCalledWith("p1", "t1", { agent: null });
    expect(agents).not.toHaveBeenCalled();
  });

  // The gate is on the field, not the request: an ordinary edit must not start needing an admin
  it("leaves the field out entirely when the caller says nothing about it", async () => {
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});
    const agents = vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([]);

    await callUpdate({ title: "renamed" });

    expect(update).toHaveBeenCalledWith("p1", "t1", { title: "renamed" });
    expect(agents).not.toHaveBeenCalled();
  });
});

/**
 * BP-400. Both tools resolved a username against the whole instance's roster before this branch;
 * now they resolve it against listAssignableUsers, which is scoped to the board. Nothing above
 * exercises the assignee branch at all, so this is new coverage rather than an update to existing
 * coverage — the "typo" and "no access" cases were previously indistinguishable and untested here.
 */
describe("resolving an assignee through the board's own roster", () => {
  function callCreate(args: Record<string, unknown>) {
    return registered().get("create_task")!.handler({ project: "BP", title: "x", ...args }, extra);
  }

  function callUpdate(args: Record<string, unknown>) {
    return registered().get("update_task")!.handler({ taskKey: "BP-1", ...args }, extra);
  }

  beforeEach(() => {
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({
      _id: "p1",
      key: "BP",
      customFields: [],
    } as never);
  });

  it("create_task resolves the username against the board's roster, not the instance's", async () => {
    const listUsers = vi
      .spyOn(PlannerClient.prototype, "listAssignableUsers")
      .mockResolvedValue([{ _id: "u1", username: "kuba" }]);
    const create = vi.spyOn(PlannerClient.prototype, "createTask").mockResolvedValue({});

    await callCreate({ assignee: "KUBA" });

    expect(listUsers).toHaveBeenCalledWith("p1");
    expect(create).toHaveBeenCalledWith("p1", expect.objectContaining({ assignee: "kuba" }));
  });

  // Whoever calls this cannot tell a typo from somebody genuinely without access, on purpose —
  // splitting the two would mean confirming an account exists elsewhere on the instance
  it("create_task refuses a username the board's roster does not contain", async () => {
    vi.spyOn(PlannerClient.prototype, "listAssignableUsers").mockResolvedValue([]);
    const create = vi.spyOn(PlannerClient.prototype, "createTask").mockResolvedValue({});

    await expect(callCreate({ assignee: "outsider" })).rejects.toThrow(
      /not someone this board can be assigned to/
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("update_task resolves the username against the board's roster too", async () => {
    const listUsers = vi
      .spyOn(PlannerClient.prototype, "listAssignableUsers")
      .mockResolvedValue([{ _id: "u1", username: "kuba" }]);
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await callUpdate({ assignee: "kuba" });

    expect(listUsers).toHaveBeenCalledWith("p1");
    expect(update).toHaveBeenCalledWith("p1", "t1", expect.objectContaining({ assignee: "kuba" }));
  });

  it("update_task refuses a username the board's roster does not contain", async () => {
    vi.spyOn(PlannerClient.prototype, "listAssignableUsers").mockResolvedValue([]);
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await expect(callUpdate({ assignee: "outsider" })).rejects.toThrow(
      /not someone this board can be assigned to/
    );
    expect(update).not.toHaveBeenCalled();
  });

  // "" unassigns, same as the agent field — it must not be resolved against the roster at all
  it("update_task still unassigns on an empty string without consulting the roster", async () => {
    const listUsers = vi.spyOn(PlannerClient.prototype, "listAssignableUsers");
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await callUpdate({ assignee: "" });

    expect(listUsers).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith("p1", "t1", expect.objectContaining({ assignee: null }));
  });
});
