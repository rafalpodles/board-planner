import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { registerPlannerTools } from "./tools";
import { PlannerClient } from "./planner-client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;

function registered() {
  const tools = new Map<string, { schema: z.ZodObject<z.ZodRawShape>; handler: Handler }>();
  const server = {
    registerTool: (
      name: string,
      config: { inputSchema: z.ZodObject<z.ZodRawShape> },
      handler: Handler
    ) => tools.set(name, { schema: config.inputSchema, handler }),
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

describe("update_task and the agent that runs it", () => {
  function callUpdate(args: Record<string, unknown>) {
    return registered().get("update_task")!.handler({ taskKey: "BP-1", ...args }, extra);
  }

  it("offers the parameter at all", () => {
    expect(Object.keys(registered().get("update_task")!.schema.shape)).toContain("agent");
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

  it("refuses a name no agent has, without writing anything", async () => {
    vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([{ _id: "a1", name: "Default" }]);
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await expect(callUpdate({ agent: "Nonexistent" })).rejects.toThrow(/Nonexistent/);
    expect(update).not.toHaveBeenCalled();
  });

  it("resolves a project-scoped agent only against the task's own project, never a namesake elsewhere", async () => {
    vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([
      { _id: "elsewhere", name: "Runner", scope: "project", projectId: "p2" },
      { _id: "a1", name: "Runner", scope: "project", projectId: "p1" },
    ]);
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await callUpdate({ agent: "Runner" });

    expect(update).toHaveBeenCalledWith("p1", "t1", { agent: "a1" });
  });

  it("refuses a name that exists only on another project, saying so rather than a bare \"not found\"", async () => {
    vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([
      { _id: "elsewhere", name: "Runner", scope: "project", projectId: "p2" },
    ]);
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await expect(callUpdate({ agent: "Runner" })).rejects.toThrow(/another project/);
    expect(update).not.toHaveBeenCalled();
  });

  it("resolves a global agent regardless of project", async () => {
    vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([
      { _id: "g1", name: "Default", scope: "global", projectId: null },
    ]);
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await callUpdate({ agent: "default" });

    expect(update).toHaveBeenCalledWith("p1", "t1", { agent: "g1" });
  });

  it("resolves a personal (user-scope) agent regardless of project too", async () => {
    vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([
      { _id: "u1", name: "Admin's own", scope: "user", projectId: null },
    ]);
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await callUpdate({ agent: "admin's own" });

    expect(update).toHaveBeenCalledWith("p1", "t1", { agent: "u1" });
  });

  it("sends null for the empty string, which means nobody runs it", async () => {
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});
    const agents = vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([]);

    await callUpdate({ agent: "" });

    expect(update).toHaveBeenCalledWith("p1", "t1", { agent: null });
    expect(agents).not.toHaveBeenCalled();
  });

  it("leaves the field out entirely when the caller says nothing about it", async () => {
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});
    const agents = vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([]);

    await callUpdate({ title: "renamed" });

    expect(update).toHaveBeenCalledWith("p1", "t1", { title: "renamed" });
    expect(agents).not.toHaveBeenCalled();
  });

  it("tells the caller who may actually choose an agent, not the retired instance-admin rule", () => {
    const description = registered().get("update_task")!.schema.shape.agent.description;

    expect(description).not.toMatch(/instance admin/i);
    expect(description).toMatch(/a project agent may be chosen by anyone who can edit the task/i);
  });

  it("keeps the standalone copy (mcp-server/src/tools.ts) in sync", () => {
    const source = readFileSync(join(process.cwd(), "mcp-server/src/tools.ts"), "utf8");

    expect(source).not.toMatch(/instance admin/i);
    expect(source).toMatch(/anyone who can edit the task/i);
  });
});

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

  it("update_task still unassigns on an empty string without consulting the roster", async () => {
    const listUsers = vi.spyOn(PlannerClient.prototype, "listAssignableUsers");
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await callUpdate({ assignee: "" });

    expect(listUsers).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith("p1", "t1", expect.objectContaining({ assignee: null }));
  });
});
