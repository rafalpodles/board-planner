import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { registerPlannerTools } from "./tools";
import { PlannerClient } from "./planner-client";
import { DEPENDENCY_TYPES } from "@/types";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;

// The registration is the only export, so the tools are reached by capturing what it registers.
// This calls the callbacks directly and so skips the SDK's parse step — tools.strict.test.ts is
// the one that drives the real transport.
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

  // Sending the name through unresolved would reach an ObjectId ref as a string and come back as
  // "that agent cannot run on this project" — a refusal about the wrong thing
  it("refuses a name no agent has, without writing anything", async () => {
    vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([{ _id: "a1", name: "Default" }]);
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await expect(callUpdate({ agent: "Nonexistent" })).rejects.toThrow(/Nonexistent/);
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * BP-496: `/api/agents` sends the project agents of every project the caller can reach, not just
   * this task's — an instance admin sees all of them. Resolution has to filter by the task's own
   * project the way PropertyRail's picker does, or a namesake belonging to another board either
   * gets chosen silently or reaches the write only to be refused by `agentUsableOnProject`.
   */
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

  // The control: a global agent carries no project of its own, so it must keep resolving
  // everywhere exactly as before this fix
  it("resolves a global agent regardless of project", async () => {
    vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([
      { _id: "g1", name: "Default", scope: "global", projectId: null },
    ]);
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await callUpdate({ agent: "default" });

    expect(update).toHaveBeenCalledWith("p1", "t1", { agent: "g1" });
  });

  // A second control, distinct from the global one above: a personal agent also carries no
  // project of its own (the filter only gates `scope === "project"`), so it must resolve
  // regardless of project too — this pins that down against a fix that narrowed the check to
  // `scope === "global"` instead of `scope !== "project"`, which would wrongly exclude it
  it("resolves a personal (user-scope) agent regardless of project too", async () => {
    vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([
      { _id: "u1", name: "Admin's own", scope: "user", projectId: null },
    ]);
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    await callUpdate({ agent: "admin's own" });

    expect(update).toHaveBeenCalledWith("p1", "t1", { agent: "u1" });
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

  // BP-518: the description told an AI client this needed an instance admin, when since BP-358
  // the choice belongs to whoever may edit the task — see task-service.ts's agentUsableOnProject.
  it("tells the caller who may actually choose an agent, not the retired instance-admin rule", () => {
    const description = registered().get("update_task")!.schema.shape.agent.description;

    expect(description).not.toMatch(/instance admin/i);
    expect(description).toMatch(/a project agent may be chosen by anyone who can edit the task/i);
  });

  // The standalone package ships its own copy of this description (mcp-server/src/tools.ts) and
  // nothing else here reads it, so a fix applied to one side and not the other compiles clean and
  // says nothing — the same drift api-client-drift.test.ts guards for the HTTP client pair.
  it("keeps the standalone copy (mcp-server/src/tools.ts) in sync", () => {
    const source = readFileSync(join(process.cwd(), "mcp-server/src/tools.ts"), "utf8");

    // A shorter marker than the in-app assertion above: the concatenated string is one line here,
    // but split across "+"-joined literals in the raw source, so a phrase spanning two of them
    // would never match the file's text even though it matches fine once JS has joined them.
    expect(source).not.toMatch(/instance admin/i);
    expect(source).toMatch(/anyone who can edit the task/i);
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

/**
 * Linking tasks over MCP. Until this landed the only way to write an epic's children was a
 * checklist, which nothing can move, assign or run — so the relations the board already stores
 * were unreachable from the connection that files the work.
 *
 * The far end is named by key, like every other task parameter, and resolved to an id here: ids
 * appear in no MCP response, so a parameter demanding one cannot be filled from a conversation.
 */
describe("link_tasks and unlink_tasks", () => {
  const ENDS = {
    "BP-644": { projectId: "p1", taskId: "epic" },
    "BP-649": { projectId: "p1", taskId: "child" },
    "MP-7": { projectId: "p2", taskId: "elsewhere" },
  } as const;

  function resolvesByKey() {
    vi.spyOn(PlannerClient.prototype, "resolveTaskKey").mockImplementation(async (key: string) => {
      const end = ENDS[key.toUpperCase() as keyof typeof ENDS];
      if (!end) throw new Error(`Task ${key} not found`);
      return end;
    });
  }

  beforeEach(resolvesByKey);

  it("sends the far end's id and the type, scoped to the shared project", async () => {
    const add = vi.spyOn(PlannerClient.prototype, "addTaskLink").mockResolvedValue({});

    await registered()
      .get("link_tasks")!
      .handler({ taskKey: "BP-644", targetTaskKey: "BP-649", type: "parent_of" }, extra);

    expect(add).toHaveBeenCalledWith("p1", "epic", "child", "parent_of");
  });

  // The route's DELETE is a $pull that answers "Dependency removed" whether or not anything
  // matched, so every one of these is about the tool refusing to relay a success it cannot see
  function ends(task: Record<string, unknown>) {
    vi.spyOn(PlannerClient.prototype, "getTask").mockResolvedValue(task);
  }

  it("removes the link the end really holds", async () => {
    ends({ relations: [{ task: { _id: "child" }, type: "parent_of" }] });
    const remove = vi.spyOn(PlannerClient.prototype, "removeTaskLink").mockResolvedValue({});

    await registered()
      .get("unlink_tasks")!
      .handler({ taskKey: "BP-644", targetTaskKey: "BP-649", type: "parent_of" }, extra);

    expect(remove).toHaveBeenCalledWith("p1", "epic", "child", "parent_of");
  });

  it("sends the caller to the other end when that is where the link is stored", async () => {
    ends({ relatedFrom: [{ task: { _id: "child" }, type: "relates" }] });
    const remove = vi.spyOn(PlannerClient.prototype, "removeTaskLink").mockResolvedValue({});

    await expect(
      registered()
        .get("unlink_tasks")!
        .handler({ taskKey: "BP-644", targetTaskKey: "BP-649", type: "relates" }, extra)
    ).rejects.toThrow(/BP-649 holds that relates link, not BP-644/);

    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses a link neither end holds rather than reporting a removal", async () => {
    ends({ relations: [], relatedFrom: [], blockedBy: [], blocking: [] });
    const remove = vi.spyOn(PlannerClient.prototype, "removeTaskLink").mockResolvedValue({});

    await expect(
      registered()
        .get("unlink_tasks")!
        .handler({ taskKey: "BP-644", targetTaskKey: "BP-649", type: "duplicates" }, extra)
    ).rejects.toThrow(/Neither BP-644 nor BP-649 holds a duplicates link/);

    expect(remove).not.toHaveBeenCalled();
  });

  // blocked_by lives in its own array, so the near and far ends are different fields from the
  // three that share `relations` — a helper that only read those would pass every test above
  it("reads blocked_by from its own array, at both ends", async () => {
    ends({ blockedBy: [{ _id: "child" }] });
    const remove = vi.spyOn(PlannerClient.prototype, "removeTaskLink").mockResolvedValue({});

    await registered()
      .get("unlink_tasks")!
      .handler({ taskKey: "BP-644", targetTaskKey: "BP-649", type: "blocked_by" }, extra);
    expect(remove).toHaveBeenCalledWith("p1", "epic", "child", "blocked_by");

    ends({ blocking: [{ _id: "child" }] });
    await expect(
      registered()
        .get("unlink_tasks")!
        .handler({ taskKey: "BP-644", targetTaskKey: "BP-649", type: "blocked_by" }, extra)
    ).rejects.toThrow(/BP-649 holds that blocked_by link/);
  });

  // The types share the `relations` array, so a check that ignored the type would remove the wrong
  // link and call it the right one
  it("will not take a relates link off an end that holds a duplicates one", async () => {
    ends({ relations: [{ task: { _id: "child" }, type: "duplicates" }] });
    const remove = vi.spyOn(PlannerClient.prototype, "removeTaskLink").mockResolvedValue({});

    await expect(
      registered()
        .get("unlink_tasks")!
        .handler({ taskKey: "BP-644", targetTaskKey: "BP-649", type: "relates" }, extra)
    ).rejects.toThrow(/Neither BP-644 nor BP-649 holds a relates link/);

    expect(remove).not.toHaveBeenCalled();
  });

  // The route looks the far end up by `{ _id, project }`, so this pair would come back "Task not
  // found" — a sentence that sends the caller hunting for a typo in a key that resolved fine
  it.each(["link_tasks", "unlink_tasks"])("%s refuses a pair on two boards, by name", async (tool) => {
    const add = vi.spyOn(PlannerClient.prototype, "addTaskLink").mockResolvedValue({});
    const remove = vi.spyOn(PlannerClient.prototype, "removeTaskLink").mockResolvedValue({});

    await expect(
      registered().get(tool)!.handler({ taskKey: "BP-644", targetTaskKey: "MP-7", type: "relates" }, extra)
    ).rejects.toThrow(/BP-644 and MP-7 are on different boards/);

    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("takes the four kinds the board stores and nothing else", () => {
    const { schema } = registered().get("link_tasks")!;

    // The board's own list, not four literals copied beside it: a fifth type added to
    // DEPENDENCY_TYPES has to reach the tool rather than be silently refused here
    expect((schema.shape.type as unknown as { options: readonly string[] }).options).toEqual(
      DEPENDENCY_TYPES
    );

    for (const type of ["blocked_by", "relates", "duplicates", "parent_of"]) {
      expect(
        schema.safeParse({ taskKey: "BP-1", targetTaskKey: "BP-2", type }).success
      ).toBe(true);
    }
    expect(
      schema.safeParse({ taskKey: "BP-1", targetTaskKey: "BP-2", type: "child_of" }).success
    ).toBe(false);
  });

  // The hint is what a caller sees when they guess the field name instead of the tool. It said
  // "the app — MCP does not link tasks", which stopped being true the moment these registered.
  it("update_task points a blockedBy guess at the tool that does it", () => {
    const { schema } = registered().get("update_task")!;

    const refusal = schema.safeParse({ taskKey: "BP-1", blockedBy: ["BP-2"] });

    expect(refusal.success).toBe(false);
    expect(refusal.error!.issues[0].message).toContain(
      '"blockedBy" — use the link_tasks tool on /api/mcp'
    );
  });
});
