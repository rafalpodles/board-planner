import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";
import { z } from "zod";
import { registerPlannerTools } from "./tools";
import { PlannerClient } from "./planner-client";
import { DEPENDENCY_TYPES } from "@/types";
import { MAX_REORDER_IDS } from "@/lib/reorder";
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

/** What the client is actually told, after the shared fragments have been concatenated. */
function descriptions() {
  const said = new Map<string, string>();
  const server = {
    registerTool: (name: string, config: { description?: string }) =>
      said.set(name, config.description ?? ""),
  } as unknown as McpServer;
  registerPlannerTools(server);
  return said;
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

  // The `type` parameter's own describe() says "see the description", so each tool's description
  // has to carry the direction rules itself. Sharing one paragraph between the two tools is what
  // made that pointer lead nowhere on unlink_tasks once already.
  it.each(["link_tasks", "unlink_tasks"])("%s explains which end each type reads from", (tool) => {
    const described = descriptions().get(tool)!;

    // relates is in the list because it is the rule that cost two rounds to get right: the
    // sentence about it was rewritten twice and was false both times
    for (const rule of ["blocked_by means", "parent_of means", "duplicates means", "relates means"]) {
      expect(described, `${tool} says nothing about ${rule}`).toContain(rule);
    }
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
      '"blockedBy" — use the link_tasks tool, or the blockedBy of an item in create_tasks'
    );
  });
});

describe("reorder_tasks", () => {
  const board = [
    { _id: "t1", taskNumber: 1 },
    { _id: "t2", taskNumber: 2 },
    { _id: "t3", taskNumber: 3 },
  ];

  function stubBoard() {
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({ _id: "p1" });
    vi.spyOn(PlannerClient.prototype, "listTasks").mockResolvedValue(board);
    return vi.spyOn(PlannerClient.prototype, "reorderTasks").mockResolvedValue({ updated: 2 });
  }

  function callReorder(taskKeys: string[], project = "BP") {
    return registered().get("reorder_tasks")!.handler({ project, taskKeys }, extra);
  }

  it("sends the tasks' ids to the reorder route in the order the keys were listed", async () => {
    const reorder = stubBoard();

    await callReorder(["BP-3", "bp-1", "BP-02"]);

    expect(reorder).toHaveBeenCalledWith("p1", ["t3", "t1", "t2"]);
  });

  it("refuses unknown, duplicate, malformed and other-board keys together, and writes nothing", async () => {
    const reorder = stubBoard();

    const refusal = callReorder(["BP-1", "BP-99", "TRW-2", "BP-01", "nonsense"]);

    await expect(refusal).rejects.toThrow(/nothing was reordered/);
    await expect(refusal).rejects.toThrow(/BP-99 does not exist/);
    await expect(refusal).rejects.toThrow(/"TRW-2" is not a BP task key/);
    await expect(refusal).rejects.toThrow(/BP-1 is listed more than once/);
    await expect(refusal).rejects.toThrow(/"nonsense" is not a BP task key/);
    expect(reorder).not.toHaveBeenCalled();
  });

  it("lists only the first few problems of a long refusal, and bounds each key it quotes", async () => {
    stubBoard();
    const keys = [`${"z".repeat(50_000)}-1`, ...Array.from({ length: 200 }, (_, i) => `BP-${100 + i}`)];

    const refusal = String(await callReorder(keys).catch((error: Error) => error.message));

    expect(refusal).toContain(`"${"z".repeat(64)}…"`);
    expect(refusal).toContain("and 196 more");
    expect(refusal.length).toBeLessThan(400);
  });

  it("takes a key whose project key carries a hyphen", async () => {
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({ _id: "p1" });
    vi.spyOn(PlannerClient.prototype, "listTasks").mockResolvedValue(board);
    const reorder = vi.spyOn(PlannerClient.prototype, "reorderTasks").mockResolvedValue({});

    await callReorder(["MY-APP-2", "MY-APP-1"], "my-app");

    expect(reorder).toHaveBeenCalledWith("p1", ["t2", "t1"]);
  });

  it("accepts as many keys as the route does and refuses one more, or none", () => {
    const { schema } = registered().get("reorder_tasks")!;
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `BP-${i + 1}`);

    expect(schema.safeParse({ project: "BP", taskKeys: keys(MAX_REORDER_IDS) }).success).toBe(true);
    expect(schema.safeParse({ project: "BP", taskKeys: keys(MAX_REORDER_IDS + 1) }).success).toBe(false);
    expect(schema.safeParse({ project: "BP", taskKeys: [] }).success).toBe(false);
  });

  it("is where update_task points an order guess", () => {
    const { schema } = registered().get("update_task")!;

    const refusal = schema.safeParse({ taskKey: "BP-1", order: 3 });

    expect(refusal.success).toBe(false);
    expect(refusal.error!.issues[0].message).toContain('"order" — use the reorder_tasks tool');
  });
});

/**
 * BP-907. A bulk run is mostly answers: every write returned the whole stored task (createdBy,
 * assignedBy, organisation, checklist ids…), link_tasks said "Dependency added" whatever it had
 * linked, and get_task named linked tasks only by number.
 */
describe("what the tools answer", () => {
  const FULL = {
    _id: "t1",
    taskNumber: 12,
    title: "Written",
    status: "todo",
    priority: "high",
    assignee: { _id: "u1", username: "rafal", fullName: "Rafal" },
    createdBy: { _id: "u1", username: "rafal" },
    organisation: "o1",
    checklist: [{ _id: "c1", text: "x", done: false }],
  };
  const SUMMARY = {
    key: "MY-APP-12",
    title: "Written",
    status: "todo",
    priority: "high",
    assignee: "rafal",
    url: "https://board.example.com/projects/MY-APP/tasks/12",
  };
  const parse = (result: unknown) =>
    JSON.parse((result as { content: { text: string }[] }).content[0].text);

  beforeEach(() => {
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({ _id: "p1" });
  });

  it.each([
    ["create_task", () => vi.spyOn(PlannerClient.prototype, "createTask"), { project: "my-app", title: "Written" }],
    ["update_task", () => vi.spyOn(PlannerClient.prototype, "updateTask"), { taskKey: "MY-APP-12", title: "Written" }],
    ["change_task_status", () => vi.spyOn(PlannerClient.prototype, "changeTaskStatus"), { taskKey: "MY-APP-12", status: "todo" }],
  ])("%s answers with the full task unless asked for less", async (name, spy, args) => {
    spy().mockResolvedValue(FULL);

    const answer = parse(await registered().get(name)!.handler(args, extra));

    expect(answer).toEqual(FULL);
  });

  it.each([
    ["create_task", () => vi.spyOn(PlannerClient.prototype, "createTask"), { project: "my-app", title: "Written" }],
    ["update_task", () => vi.spyOn(PlannerClient.prototype, "updateTask"), { taskKey: "MY-APP-12", title: "Written" }],
    ["change_task_status", () => vi.spyOn(PlannerClient.prototype, "changeTaskStatus"), { taskKey: "MY-APP-12", status: "todo" }],
  ])("%s answers with key, title, status, priority, assignee and a link when minimal", async (name, spy, args) => {
    spy().mockResolvedValue(FULL);

    const answer = parse(await registered().get(name)!.handler({ ...args, minimal: true }, extra));

    expect(answer).toEqual(SUMMARY);
  });

  it("does not count `minimal` alone as something to change", async () => {
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue(FULL);
    const resolve = vi.spyOn(PlannerClient.prototype, "resolveTaskKey");

    await expect(
      registered().get("update_task")!.handler({ taskKey: "MY-APP-12", minimal: true }, extra)
    ).rejects.toThrow(/nothing to change/);
    // Refused before the lookup, so a call that changes nothing costs nothing
    expect(resolve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("keys a minimal answer from the stored number, so a padded key is answered canonically", async () => {
    vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue(FULL);

    const answer = parse(
      await registered().get("update_task")!.handler({ taskKey: "my-app-0012", title: "Written", minimal: true }, extra)
    );

    expect(answer.key).toBe("MY-APP-12");
    expect(answer.url).toBe("https://board.example.com/projects/MY-APP/tasks/12");
  });

  it("get_task names every linked task by key, and the parent and children", async () => {
    vi.spyOn(PlannerClient.prototype, "getTask").mockResolvedValue({
      title: "Epic",
      blockedBy: [{ _id: "b", taskNumber: 3, title: "Blocker", status: "todo" }],
      relations: [{ type: "parent_of", task: { _id: "k", taskNumber: 8, title: "Child", status: "todo" } }],
      relatedFrom: [{ type: "parent_of", task: { _id: "p", taskNumber: 1, title: "Top", status: "todo" } }],
    });

    const answer = parse(await registered().get("get_task")!.handler({ taskKey: "my-app-5" }, extra));

    expect(answer.blockedBy[0].key).toBe("MY-APP-3");
    expect(answer.relations[0].task.key).toBe("MY-APP-8");
    expect(answer.parent).toEqual({ key: "MY-APP-1", title: "Top", status: "todo" });
    expect(answer.children).toEqual([{ key: "MY-APP-8", title: "Child", status: "todo" }]);
  });

  it("link_tasks says what it linked, not just that something was", async () => {
    vi.spyOn(PlannerClient.prototype, "addTaskLink").mockResolvedValue({ message: "Dependency added" });
    vi.spyOn(PlannerClient.prototype, "resolveTaskKey").mockResolvedValue({ projectId: "p1", taskId: "t" });

    const answer = parse(
      await registered().get("link_tasks")!.handler({ taskKey: "bp-1", targetTaskKey: "bp-2", type: "parent_of" }, extra)
    );

    expect(answer).toEqual({
      message: "Linked: BP-1 is the parent of BP-2",
      taskKey: "BP-1",
      targetTaskKey: "BP-2",
      type: "parent_of",
    });
  });

  it("unlink_tasks says what it removed", async () => {
    vi.spyOn(PlannerClient.prototype, "removeTaskLink").mockResolvedValue({ message: "Dependency removed" });
    vi.spyOn(PlannerClient.prototype, "resolveTaskKey").mockResolvedValue({ projectId: "p1", taskId: "t" });
    vi.spyOn(PlannerClient.prototype, "getTask").mockResolvedValue({
      relations: [{ task: { _id: "t" }, type: "relates" }],
    });

    const answer = parse(
      await registered().get("unlink_tasks")!.handler({ taskKey: "BP-1", targetTaskKey: "BP-2", type: "relates" }, extra)
    );

    expect(answer.message).toBe("Removed: BP-1 relates to BP-2");
  });
});

/**
 * BP-906. list_tasks answered with every matching task's whole body — 393,665 characters for one
 * ordinary query on the BP board — and took four filters. It now pages, answers in short lines, and
 * filters on what REST already could (sprint, search) and on parent, due dates, blockers and fields.
 */
describe("list_tasks", () => {
  const SIZE_FIELD = { _id: "f1", name: "Size", fieldType: "dropdown", options: [{ id: "opt-l", value: "L" }] };
  let page: MockInstance<PlannerClient["pageTasks"]>;

  const run = (args: Record<string, unknown>) =>
    registered().get("list_tasks")!.handler({ project: "my-app", ...args }, extra);
  const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);
  const sent = () => page.mock.calls[0] as [string, Record<string, string>, string[]];

  beforeEach(() => {
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({
      _id: "p1",
      customFields: [SIZE_FIELD],
    } as never);
    page = vi
      .spyOn(PlannerClient.prototype, "pageTasks")
      .mockResolvedValue({ tasks: [], total: 0, limit: 50, offset: 0 });
  });

  it("asks for one short page by default, and says what it did not return", async () => {
    page.mockResolvedValue({
      tasks: [
        { taskNumber: 3, title: "Three", status: "todo", priority: "high", assignee: { username: "rafal" }, sprint: null, parent: null },
        { taskNumber: 4, title: "Four", status: "todo", assignee: null, sprint: { name: "S1" }, parent: { taskNumber: 1 } },
      ],
      total: 130,
      limit: 2,
      offset: 0,
    });

    const answer = parse(await run({ limit: 2 }));

    expect(sent()[1]).toEqual({ limit: "2", offset: "0", view: "summary" });
    expect(answer).toMatchObject({ total: 130, returned: 2, offset: 0, nextOffset: 2 });
    expect(answer.tasks[0]).toEqual({
      key: "MY-APP-3",
      title: "Three",
      status: "todo",
      priority: "high",
      assignee: "rafal",
      dueDate: null,
      sprint: null,
      parent: null,
    });
    expect(answer.tasks[1]).toMatchObject({ key: "MY-APP-4", sprint: "S1", parent: "MY-APP-1" });
  });

  it("starts from 50 and carries an offset through", async () => {
    await run({ offset: 100 });

    expect(sent()[1]).toMatchObject({ limit: "50", offset: "100", view: "summary" });
  });

  it("hands back the whole bodies, still paged, when asked for the full detail", async () => {
    const stored = { taskNumber: 3, title: "Three", checklist: [{ _id: "c" }] };
    page.mockResolvedValue({ tasks: [stored], total: 1, limit: 50, offset: 0 });

    const answer = parse(await run({ detail: "full" }));

    expect(sent()[1]).not.toHaveProperty("view");
    expect(answer.tasks).toEqual([stored]);
    expect(answer.nextOffset).toBeNull();
  });

  it("refuses a page bigger than it will build", () => {
    const { schema } = registered().get("list_tasks")!;

    expect(schema.safeParse({ project: "BP", limit: 101 }).success).toBe(false);
    expect(schema.safeParse({ project: "BP", limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ project: "BP", offset: -1 }).success).toBe(false);
    expect(schema.safeParse({ project: "BP", limit: 100, offset: 0 }).success).toBe(true);
  });

  it("passes the text, date and blocker filters on as the route spells them", async () => {
    await run({ search: "login", dueBefore: "2026-10-10", dueAfter: "2026-10-01", updatedSince: "2026-09-30", blocked: false });

    expect(sent()[1]).toMatchObject({
      search: "login",
      dueBefore: "2026-10-10",
      dueAfter: "2026-10-01",
      updatedSince: "2026-09-30",
      blocked: "false",
    });
  });

  describe("sprint", () => {
    it("is looked up by name", async () => {
      vi.spyOn(PlannerClient.prototype, "listSprints").mockResolvedValue([
        { _id: "507f1f77bcf86cd799439012", name: "Hardening" },
      ]);

      await run({ sprint: "hardening" });

      expect(sent()[1].sprint).toBe("507f1f77bcf86cd799439012");
    });

    it("needs no lookup for the backlog or an id", async () => {
      const lookup = vi.spyOn(PlannerClient.prototype, "listSprints");

      await run({ sprint: "backlog" });
      await run({ sprint: "507f1f77bcf86cd799439012" });

      expect(lookup).not.toHaveBeenCalled();
    });

    it("is refused, naming the sprints, when no sprint has the name", async () => {
      vi.spyOn(PlannerClient.prototype, "listSprints").mockResolvedValue([{ _id: "s1", name: "Hardening" }]);

      await expect(run({ sprint: "Nope" })).rejects.toThrow(/No sprint "Nope".*Hardening/);
      expect(page).not.toHaveBeenCalled();
    });
  });

  describe("parent", () => {
    it("is given by key and sent as the task's id", async () => {
      vi.spyOn(PlannerClient.prototype, "resolveTaskKey").mockResolvedValue({ projectId: "p1", taskId: "epic-id" });

      await run({ parent: "MY-APP-7" });

      expect(sent()[1].parent).toBe("epic-id");
    });

    it("is refused when it belongs to another board", async () => {
      vi.spyOn(PlannerClient.prototype, "resolveTaskKey").mockResolvedValue({ projectId: "p2", taskId: "x" });

      await expect(run({ parent: "OTHER-7" })).rejects.toThrow(/is not on MY-APP/);
      expect(page).not.toHaveBeenCalled();
    });
  });

  describe("fields", () => {
    it("are named the way a person reads them and sent as ids", async () => {
      await run({ fields: { size: "L" } });

      expect(sent()[2]).toEqual(["f1:opt-l"]);
    });

    it("send a multiselect given several options as one condition per option", async () => {
      vi.mocked(PlannerClient.prototype.getProjectByKey).mockResolvedValue({
        _id: "p1",
        customFields: [
          { _id: "f2", name: "Platforms", fieldType: "multiselect", options: [{ id: "o-ios", value: "iOS" }, { id: "o-web", value: "Web" }] },
          { _id: "f3", name: "Flagged", fieldType: "checkbox" },
        ],
      } as never);

      await run({ fields: { Platforms: ["iOS", "web"], Flagged: false } });

      expect(sent()[2]).toEqual(["f2:o-ios", "f2:o-web", "f3:false"]);
    });

    it("hold a checkbox to true or false, since anything else would filter on the unticked", async () => {
      vi.mocked(PlannerClient.prototype.getProjectByKey).mockResolvedValue({
        _id: "p1",
        customFields: [{ _id: "f3", name: "Flagged", fieldType: "checkbox" }],
      } as never);

      await expect(run({ fields: { Flagged: "yes" } })).rejects.toThrow(/checkbox: filter on true or false/);
      expect(page).not.toHaveBeenCalled();
    });

    it("are refused when the board has no such field, or the field no such option", async () => {
      await expect(run({ fields: { Colour: "red" } })).rejects.toThrow(/Unknown field "Colour".*Size/);
      await expect(run({ fields: { Size: "XXL" } })).rejects.toThrow(/"XXL" is not an option of Size/);
      expect(page).not.toHaveBeenCalled();
    });
  });
});

/**
 * BP-911. Sprints could be created and updated over MCP and nothing else. REST also reads one with its
 * tasks and deletes it — which sends every task back to the backlog — and completing a sprint can carry
 * its unfinished tasks somewhere, which update_sprint did not offer.
 */
describe("sprints", () => {
  const SPRINTS = [
    { _id: "507f1f77bcf86cd799439011", name: "Sprint 4", status: "active", taskCount: 3, doneCount: 1 },
    { _id: "507f1f77bcf86cd799439012", name: "Hardening", status: "planned", taskCount: 0, doneCount: 0 },
    { _id: "507f1f77bcf86cd799439013", name: "Old", status: "completed", taskCount: 4, doneCount: 4 },
  ];
  const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);
  const run = (name: string, args: Record<string, unknown>) =>
    registered().get(name)!.handler({ project: "my-app", ...args }, extra);

  beforeEach(() => {
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({ _id: "p1" } as never);
    vi.spyOn(PlannerClient.prototype, "listSprints").mockResolvedValue(SPRINTS);
  });

  describe("get_sprint", () => {
    it("answers with the sprint and its tasks as short lines, a page at a time", async () => {
      const page = vi.spyOn(PlannerClient.prototype, "pageTasks").mockResolvedValue({
        tasks: [{ taskNumber: 7, title: "Seven", status: "todo", sprint: { name: "Sprint 4" } }],
        total: 3,
        limit: 1,
        offset: 0,
      });

      const answer = parse(await run("get_sprint", { sprint: "SPRINT 4", limit: 1 }));

      expect(page).toHaveBeenCalledWith("p1", { sprint: "507f1f77bcf86cd799439011", limit: "1", offset: "0", view: "summary" });
      expect(answer.sprint).toMatchObject({ id: "507f1f77bcf86cd799439011", name: "Sprint 4", taskCount: 3, doneCount: 1 });
      expect(answer).toMatchObject({ total: 3, returned: 1, nextOffset: 1 });
      expect(answer.tasks[0]).toMatchObject({ key: "MY-APP-7", title: "Seven", sprint: "Sprint 4" });
    });

    it("is refused for a sprint the board does not have, reading no tasks", async () => {
      const page = vi.spyOn(PlannerClient.prototype, "pageTasks");

      await expect(run("get_sprint", { sprint: "Nope" })).rejects.toThrow(/No sprint "Nope"/);
      expect(page).not.toHaveBeenCalled();
    });
  });

  describe("delete_sprint", () => {
    it("deletes only when the name is repeated, and says its tasks went back to the backlog", async () => {
      const del = vi.spyOn(PlannerClient.prototype, "deleteSprint").mockResolvedValue({ message: "Sprint deleted" });

      const answer = parse(await run("delete_sprint", { sprint: "507f1f77bcf86cd799439011", confirmName: "sprint 4" }));

      expect(del).toHaveBeenCalledWith("p1", "507f1f77bcf86cd799439011");
      expect(answer).toEqual({ deleted: "Sprint 4", id: "507f1f77bcf86cd799439011", tasksReturnedToBacklog: 3 });
    });

    it("refuses a confirmation that is not the sprint's name, before anything is deleted", async () => {
      const del = vi.spyOn(PlannerClient.prototype, "deleteSprint").mockResolvedValue({});

      await expect(run("delete_sprint", { sprint: "Sprint 4", confirmName: "Hardening" })).rejects.toThrow(
        /confirmName "Hardening" is not the name of that sprint, "Sprint 4"/
      );
      expect(del).not.toHaveBeenCalled();
    });

    it("needs a sprint that is on the board", async () => {
      const del = vi.spyOn(PlannerClient.prototype, "deleteSprint").mockResolvedValue({});

      await expect(run("delete_sprint", { sprint: "Nope", confirmName: "Nope" })).rejects.toThrow(/No sprint "Nope"/);
      expect(del).not.toHaveBeenCalled();
    });

    it("declares confirmName, so a call without it never reaches the handler", () => {
      expect(registered().get("delete_sprint")!.schema.safeParse({ project: "BP", sprint: "S" }).success).toBe(false);
    });
  });

  describe("update_sprint", () => {
    let wrote: MockInstance<PlannerClient["updateSprint"]>;

    beforeEach(() => {
      wrote = vi.spyOn(PlannerClient.prototype, "updateSprint").mockResolvedValue({});
    });

    it("takes the sprint by name and acts on its id", async () => {
      await run("update_sprint", { sprintId: "hardening", goal: "Fewer bugs" });

      expect(wrote).toHaveBeenCalledWith("p1", "507f1f77bcf86cd799439012", { goal: "Fewer bugs" });
    });

    it("carries unfinished tasks to the backlog or to another sprint as it completes", async () => {
      await run("update_sprint", { sprintId: "Sprint 4", status: "completed", moveIncomplete: "backlog" });
      await run("update_sprint", { sprintId: "Sprint 4", status: "completed", moveIncomplete: "Hardening" });

      expect(wrote.mock.calls.map((c) => c[2])).toEqual([
        { status: "completed", moveIncompleteToBacklog: true },
        { status: "completed", moveIncompleteToSprint: "507f1f77bcf86cd799439012" },
      ]);
    });

    it("refuses moveIncomplete without completing, and an unusable destination, writing nothing", async () => {
      await expect(run("update_sprint", { sprintId: "Sprint 4", goal: "x", moveIncomplete: "backlog" })).rejects.toThrow(
        /goes with status completed/
      );
      await expect(run("update_sprint", { sprintId: "Sprint 4", status: "completed", moveIncomplete: "Old" })).rejects.toThrow(
        /is completed/
      );
      await expect(run("update_sprint", { sprintId: "Sprint 4", status: "completed", moveIncomplete: "Sprint 4" })).rejects.toThrow(
        /own destination/
      );
      await expect(run("update_sprint", { sprintId: "Nope", goal: "x" })).rejects.toThrow(/No sprint "Nope"/);
      expect(wrote).not.toHaveBeenCalled();
    });

    it("still refuses a call that names nothing to change, before any lookup", async () => {
      const project = vi.mocked(PlannerClient.prototype.getProjectByKey);
      const lookup = vi.spyOn(PlannerClient.prototype, "listSprints");
      project.mockClear();

      await expect(run("update_sprint", { sprintId: "Sprint 4" })).rejects.toThrow(/nothing to change/);
      expect(project).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    });

    it("says moveIncomplete needs a completion when that is all it was given", async () => {
      await expect(run("update_sprint", { sprintId: "Sprint 4", moveIncomplete: "backlog" })).rejects.toThrow(
        /goes with status completed/
      );
    });

    // The route moves the unfinished tasks before it writes the sprint, so a write it then refuses would
    // leave the sprint open with its tasks gone
    it("refuses a blank name and a day that is not one before anything is looked up or moved", async () => {
      const lookup = vi.spyOn(PlannerClient.prototype, "listSprints");

      await expect(run("update_sprint", { sprintId: "Sprint 4", status: "completed", moveIncomplete: "backlog", name: "  " })).rejects.toThrow(/needs a name/);
      await expect(run("update_sprint", { sprintId: "Sprint 4", status: "completed", moveIncomplete: "backlog", startDate: "next monday" })).rejects.toThrow(
        /Invalid startDate "next monday"/
      );
      expect(lookup).not.toHaveBeenCalled();
      expect(wrote).not.toHaveBeenCalled();
    });
  });
});

/**
 * BP-905. The task object carried a due date, a sprint and a recurrence an agent could read and not
 * write, and a watch could only be flipped. The write path already took all of them.
 */
describe("due date, sprint, recurrence and watching", () => {
  const SPRINTS = [
    { _id: "507f1f77bcf86cd799439011", name: "Sprint 4", status: "active" },
    { _id: "507f1f77bcf86cd799439012", name: "Hardening", status: "planned" },
    { _id: "507f1f77bcf86cd799439013", name: "Old", status: "completed" },
  ];

  beforeEach(() => {
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({ _id: "p1" } as never);
    vi.spyOn(PlannerClient.prototype, "listSprints").mockResolvedValue(SPRINTS);
  });

  describe("create_task", () => {
    const create = (args: Record<string, unknown>) =>
      registered().get("create_task")!.handler({ project: "BP", title: "T", ...args }, extra);

    it("writes all three, with the sprint resolved to its id", async () => {
      const made = vi.spyOn(PlannerClient.prototype, "createTask").mockResolvedValue({});

      await create({
        dueDate: "2026-10-10",
        sprint: "hardening",
        recurrence: { frequency: "weekly", interval: 2, endDate: "2026-12-31" },
      });

      expect(made).toHaveBeenCalledWith("p1", {
        title: "T",
        dueDate: "2026-10-10",
        sprint: "507f1f77bcf86cd799439012",
        recurrence: { frequency: "weekly", interval: 2, endDate: "2026-12-31" },
      });
    });

    it("refuses a sprint the board does not have, and writes nothing", async () => {
      const made = vi.spyOn(PlannerClient.prototype, "createTask").mockResolvedValue({});

      await expect(create({ sprint: "Nope" })).rejects.toThrow(/No sprint "Nope".*Sprint 4, Hardening/);
      await expect(create({ dueDate: "2026-02-31" })).rejects.toThrow(/Invalid dueDate/);
      expect(made).not.toHaveBeenCalled();
    });

    it("puts a new task in no sprint on backlog", async () => {
      const made = vi.spyOn(PlannerClient.prototype, "createTask").mockResolvedValue({});

      await create({ sprint: "backlog" });

      expect(made).toHaveBeenCalledWith("p1", { title: "T" });
    });
  });

  describe("update_task", () => {
    const update = (args: Record<string, unknown>) =>
      registered().get("update_task")!.handler({ taskKey: "BP-1", ...args }, extra);

    it("sets each, and any one of them alone is something to change", async () => {
      const wrote = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

      await update({ dueDate: "2026-10-10" });
      await update({ sprint: "Sprint 4" });
      await update({ recurrence: { frequency: "monthly", interval: 1 } });

      expect(wrote.mock.calls.map((c) => c[2])).toEqual([
        { dueDate: "2026-10-10" },
        { sprint: "507f1f77bcf86cd799439011" },
        { recurrence: { frequency: "monthly", interval: 1 } },
      ]);
    });

    it("clears each: an empty due date, the backlog (or an empty sprint), a null recurrence", async () => {
      const wrote = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

      await update({ dueDate: "" });
      await update({ sprint: "backlog" });
      await update({ sprint: "" });
      await update({ recurrence: null });

      expect(wrote.mock.calls.map((c) => c[2])).toEqual([
        { dueDate: null },
        { sprint: null },
        { sprint: null },
        { recurrence: null },
      ]);
    });

    it("refuses what the route would refuse, before writing", async () => {
      const wrote = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

      await expect(update({ sprint: "507f1f77bcf86cd7994390ff" })).rejects.toThrow(/No sprint "507f1f77bcf86cd7994390ff"/);
      await expect(update({ sprint: "Old" })).rejects.toThrow(/is completed/);
      await expect(update({ dueDate: "soon" })).rejects.toThrow(/Invalid dueDate/);
      expect(wrote).not.toHaveBeenCalled();
    });

    it("declares recurrence so that a series outside what the route accepts never leaves", () => {
      const { schema } = registered().get("update_task")!;
      const parse = (recurrence: unknown) => schema.safeParse({ taskKey: "BP-1", recurrence }).success;

      expect(parse({ frequency: "weekly", interval: 2 })).toBe(true);
      expect(parse(null)).toBe(true);
      expect(parse({ frequency: "yearly", interval: 1 })).toBe(false);
      expect(parse({ frequency: "daily", interval: 0 })).toBe(false);
      expect(parse({ frequency: "daily", interval: 366 })).toBe(false);
      // A stray key would be dropped and the series would run forever under a 200
      expect(parse({ frequency: "daily", interval: 1, until: "2026-12-31" })).toBe(false);
      expect(parse({ frequency: "daily", interval: 1, endDate: null })).toBe(true);
    });

    it("does not look the sprints up just to clear the sprint", async () => {
      const lookup = vi.spyOn(PlannerClient.prototype, "listSprints");
      vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

      await update({ sprint: "backlog" });
      await update({ sprint: "" });

      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe("watch_task and unwatch_task", () => {
    let set: MockInstance<PlannerClient["setWatching"]>;

    beforeEach(() => {
      set = vi.spyOn(PlannerClient.prototype, "setWatching").mockImplementation(async (_p, _t, watching) => ({ watching }));
    });

    const run = (name: string) => registered().get(name)!.handler({ taskKey: "bp-1" }, extra);
    const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);

    it("asks for the state, not for a flip, so a retry cannot undo it", async () => {
      expect(parse(await run("watch_task"))).toEqual({ taskKey: "BP-1", watching: true });
      expect(parse(await run("unwatch_task"))).toEqual({ taskKey: "BP-1", watching: false });

      expect(set.mock.calls.map((c) => c[2])).toEqual([true, false]);
    });

    it("reports the state the route settled on, not the one it asked for", async () => {
      set.mockResolvedValue({ watching: false });

      expect(parse(await run("watch_task")).watching).toBe(false);
    });
  });
});

/**
 * BP-908. A whole checklist was one string: updating one line minted every item anew and read done
 * off the text, so resending a list with a line reworded un-ticked everything that had been ticked.
 */
describe("checklist tools and acceptanceCriteria", () => {
  const A = "507f1f77bcf86cd799439011";
  const B = "507f1f77bcf86cd799439012";
  const C = "507f1f77bcf86cd799439013";
  // The one that is ticked has an unticked neighbour on each side: a change applied to every item shows
  const HELD = [
    { _id: A, text: "first", done: false },
    { _id: B, text: "second", done: true },
    { _id: C, text: "third", done: false },
  ];
  const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);
  const stored = HELD.map((item) => ({ ...item }));

  beforeEach(() => {
    vi.spyOn(PlannerClient.prototype, "getTask").mockResolvedValue({ checklist: HELD });
  });

  const run = (name: string, args: Record<string, unknown>) =>
    registered().get(name)!.handler({ taskKey: "BP-1", ...args }, extra);

  it("add_checklist_item adds one in one update and answers with the list and every id", async () => {
    const add = vi.spyOn(PlannerClient.prototype, "addChecklistItem").mockResolvedValue({
      checklist: [...stored, { _id: "507f1f77bcf86cd799439014", text: "fourth", done: false }],
    });

    const answer = parse(await run("add_checklist_item", { text: "fourth" }));

    expect(add).toHaveBeenCalledWith("p1", "t1", { text: "fourth", done: false });
    expect(answer.checklist).toHaveLength(4);
    expect(answer.checklist[3]).toEqual({ id: "507f1f77bcf86cd799439014", text: "fourth", done: false });
  });

  it("set_checklist_item changes the one criterion by its id, taken from its text in any case", async () => {
    const set = vi.spyOn(PlannerClient.prototype, "setChecklistItem").mockResolvedValue({ checklist: stored });

    await run("set_checklist_item", { item: "FIRST", done: true });

    expect(set).toHaveBeenCalledWith("p1", "t1", A, { done: true });
  });

  it("set_checklist_item rewords by id and sends nothing it was not given", async () => {
    const set = vi.spyOn(PlannerClient.prototype, "setChecklistItem").mockResolvedValue({ checklist: stored });

    await run("set_checklist_item", { item: C, text: "third, reworded" });

    expect(set).toHaveBeenCalledWith("p1", "t1", C, { text: "third, reworded" });
  });

  it("set_checklist_item with nothing to change is refused before the task is read", async () => {
    const read = vi.spyOn(PlannerClient.prototype, "getTask");
    const set = vi.spyOn(PlannerClient.prototype, "setChecklistItem").mockResolvedValue({ checklist: stored });

    await expect(run("set_checklist_item", { item: A })).rejects.toThrow(/nothing to change/);
    expect(read).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("remove_checklist_item removes the one criterion by its id", async () => {
    const remove = vi.spyOn(PlannerClient.prototype, "removeChecklistItem").mockResolvedValue({ checklist: [stored[0], stored[2]] });

    const answer = parse(await run("remove_checklist_item", { item: "second" }));

    expect(remove).toHaveBeenCalledWith("p1", "t1", B);
    expect(answer.checklist.map((c: { id: string }) => c.id)).toEqual([A, C]);
  });

  it("refuses an item the task does not have, writing nothing", async () => {
    const set = vi.spyOn(PlannerClient.prototype, "setChecklistItem");
    const remove = vi.spyOn(PlannerClient.prototype, "removeChecklistItem");

    await expect(run("set_checklist_item", { item: "fourth", done: true })).rejects.toThrow(/No criterion "fourth"/);
    await expect(run("remove_checklist_item", { item: "fourth" })).rejects.toThrow(/No criterion "fourth"/);
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  describe("acceptanceCriteria on update_task", () => {
    let wrote: MockInstance<PlannerClient["updateTask"]>;

    beforeEach(() => {
      wrote = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});
    });

    it("keeps the id and the tick of a line whose text is unchanged, and sends a list, not the string", async () => {
      await run("update_task", { acceptanceCriteria: "first\nsecond\nthird, reworded\n- a new one" });

      const data = wrote.mock.calls[0][2];
      expect(data).not.toHaveProperty("acceptanceCriteria");
      expect(data.checklist).toEqual([
        { _id: A, text: "first", done: false },
        { _id: B, text: "second", done: true },
        { text: "third, reworded", done: false },
        { text: "a new one", done: false },
      ]);
    });

    it("still lets a line state its own box", async () => {
      await run("update_task", { acceptanceCriteria: "- [x] first\n- [ ] second" });

      expect(wrote.mock.calls[0][2].checklist).toEqual([
        { _id: A, text: "first", done: true },
        { _id: B, text: "second", done: false },
      ]);
    });

    it("reads the task once when it also changes a project field", async () => {
      const read = vi.spyOn(PlannerClient.prototype, "getTask");
      vi.spyOn(PlannerClient.prototype, "getProject").mockResolvedValue({
        _id: "p1",
        customFields: [{ _id: "f9", name: "Notes", fieldType: "text" }],
      } as never);

      await run("update_task", { acceptanceCriteria: "first", fields: { Notes: "hi" } });

      expect(read).toHaveBeenCalledTimes(1);
      expect(wrote.mock.calls[0][2]).toHaveProperty("customFieldValues");
      expect(wrote.mock.calls[0][2]).toHaveProperty("checklist");
    });
  });
});

/**
 * BP-910. create_task and update_task refuse an assignee who is not on the board, and nothing told a
 * caller who is; update_task names an agent and nothing listed them.
 */
describe("people and agents", () => {
  const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);
  const run = (name: string, args: Record<string, unknown> = {}) => registered().get(name)!.handler(args, extra);

  beforeEach(() => {
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({ _id: "p1" } as never);
  });

  it("list_members answers with names only, from the board's own roster", async () => {
    const roster = vi
      .spyOn(PlannerClient.prototype, "listAssignableUsers")
      .mockResolvedValue([{ _id: "u1", username: "rafal", fullName: "Rafal", email: "x@example.com" }]);

    expect(parse(await run("list_members", { project: "bp" }))).toEqual([{ username: "rafal", fullName: "Rafal" }]);
    expect(roster).toHaveBeenCalledWith("p1");
  });

  it("whoami says who the connection is, without the address the account route also carries", async () => {
    vi.spyOn(PlannerClient.prototype, "getMe").mockResolvedValue({
      _id: "u1",
      username: "rafal",
      fullName: "Rafal",
      email: "r@example.com",
      role: "admin",
    } as never);

    expect(parse(await run("whoami"))).toEqual({ username: "rafal", fullName: "Rafal", role: "admin" });
  });

  it("my_tasks leaves finished work out, and pages", async () => {
    vi.spyOn(PlannerClient.prototype, "listMyTasks").mockResolvedValue([
      { taskNumber: 2, title: "Open", statusRole: "active", project: { key: "BP", name: "BP" } },
      { taskNumber: 1, title: "Shipped", statusRole: "done", project: { key: "BP", name: "BP" } },
    ]);

    const answer = parse(await run("my_tasks"));
    expect(answer).toMatchObject({ total: 1, returned: 1, nextOffset: null });
    expect(answer.tasks[0].key).toBe("BP-2");
    expect(parse(await run("my_tasks", { includeDone: true })).total).toBe(2);
  });

  it("list_agents offers what update_task could choose on this board", async () => {
    vi.spyOn(PlannerClient.prototype, "listAgents").mockResolvedValue([
      { _id: "a1", name: "Default", scope: "global", projectId: null, composition: { steps: [{}] } },
      { _id: "a2", name: "Other board", scope: "project", projectId: "p2", composition: { steps: [{}] } },
      { _id: "a3", name: "Here", scope: "project", projectId: "p1", composition: { steps: [{}] } },
    ]);

    // The board is asked for by its id, not by the key the caller typed
    expect(parse(await run("list_agents", { project: "BP" })).map((a: { name: string }) => a.name)).toEqual(["Default", "Here"]);
  });

  it("my_tasks refuses a page bigger than it will build", () => {
    expect(registered().get("my_tasks")!.schema.safeParse({ limit: 101 }).success).toBe(false);
    expect(registered().get("my_tasks")!.schema.safeParse({ limit: 100 }).success).toBe(true);
  });
});

/**
 * BP-912. Comments could be added and read and not corrected, and the history a person reads on the
 * task page could not be read at all. Who may edit or delete a comment is decided by the API (its
 * author), and is not widened here.
 */
describe("comments and history", () => {
  const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);
  const run = (name: string, args: Record<string, unknown> = {}) =>
    registered().get(name)!.handler({ taskKey: "BP-1", ...args }, extra);
  const comments = Array.from({ length: 5 }, (_, i) => ({
    _id: `c${i + 1}`,
    author: { username: "rafal" },
    body: `comment ${i + 1}`,
    createdAt: "2026-10-05T10:00:00.000Z",
    reactions: [],
  }));

  it("list_comments pages, oldest first, and carries the id each comment is addressed by", async () => {
    vi.spyOn(PlannerClient.prototype, "listComments").mockResolvedValue(comments);

    const first = parse(await run("list_comments", { limit: 2 }));
    expect(first).toMatchObject({ total: 5, returned: 2, offset: 0, nextOffset: 2 });
    expect(first.comments.map((c: { id: string }) => c.id)).toEqual(["c1", "c2"]);

    const last = parse(await run("list_comments", { limit: 2, offset: 4 }));
    expect(last.comments.map((c: { id: string }) => c.id)).toEqual(["c5"]);
    expect(last.nextOffset).toBeNull();
    expect(Object.keys(first.comments[0]).sort()).toEqual(["author", "body", "createdAt", "id", "reactions"]);
  });

  it("list_comments refuses a page bigger than it will build", () => {
    const { schema } = registered().get("list_comments")!;

    expect(schema.safeParse({ taskKey: "BP-1", limit: 101 }).success).toBe(false);
    expect(schema.safeParse({ taskKey: "BP-1", limit: 100 }).success).toBe(true);
  });

  it("edit_comment sends the new text for that comment and answers with it as a line", async () => {
    const edit = vi.spyOn(PlannerClient.prototype, "editComment").mockResolvedValue({ ...comments[0], body: "changed" });

    const answer = parse(await run("edit_comment", { commentId: "c1", body: "changed" }));

    expect(edit).toHaveBeenCalledWith("p1", "t1", "c1", "changed");
    expect(answer).toMatchObject({ id: "c1", body: "changed" });
  });

  it("edit_comment and delete_comment pass the API's refusal on, not a success of their own", async () => {
    vi.spyOn(PlannerClient.prototype, "editComment").mockRejectedValue(new Error("Forbidden"));
    vi.spyOn(PlannerClient.prototype, "deleteComment").mockRejectedValue(new Error("Forbidden"));

    await expect(run("edit_comment", { commentId: "c1", body: "x" })).rejects.toThrow("Forbidden");
    await expect(run("delete_comment", { commentId: "c1" })).rejects.toThrow("Forbidden");
  });

  it("delete_comment deletes that comment and says which", async () => {
    const del = vi.spyOn(PlannerClient.prototype, "deleteComment").mockResolvedValue({ message: "Comment deleted" });

    expect(parse(await run("delete_comment", { commentId: "c3" }))).toEqual({ deleted: "c3", taskKey: "BP-1" });
    expect(del).toHaveBeenCalledWith("p1", "t1", "c3");
  });

  it("get_task_activity answers with the newest entries as lines, and says how many there were", async () => {
    vi.spyOn(PlannerClient.prototype, "getTaskActivity").mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => ({
        user: { username: "rafal" },
        action: "updated",
        field: "title",
        oldValue: `v${i}`,
        newValue: `v${i + 1}`,
        createdAt: "2026-10-05T10:00:00.000Z",
      }))
    );

    const answer = parse(await run("get_task_activity"));
    expect(answer.total).toBe(40);
    expect(answer.entries).toHaveLength(30);
    expect(answer.entries[0]).toEqual({ at: "2026-10-05T10:00:00.000Z", by: "rafal", action: "updated", field: "title", from: "v0", to: "v1" });

    expect(parse(await run("get_task_activity", { limit: 5 })).entries).toHaveLength(5);
    expect(registered().get("get_task_activity")!.schema.safeParse({ taskKey: "BP-1", limit: 101 }).success).toBe(false);
  });
});

/**
 * BP-913. The read-only surface a person uses daily and an MCP client could not reach.
 */
describe("looking around", () => {
  const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);
  const run = (name: string, args: Record<string, unknown> = {}) => registered().get(name)!.handler(args, extra);

  beforeEach(() => {
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({ _id: "p1", canAdmin: true } as never);
  });

  it("list_runs is for a board's admins, as the app is, and reads nothing for anybody else", async () => {
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({ _id: "p1", canAdmin: false } as never);
    const runs = vi.spyOn(PlannerClient.prototype, "listRuns").mockResolvedValue([]);

    await expect(run("list_runs", { project: "bp" })).rejects.toThrow(/Run history is for the admins of BP/);
    expect(runs).not.toHaveBeenCalled();
  });

  it("search_tasks says when a full answer may be the first page of more", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ taskNumber: i + 1, title: "t", project: { key: "BP", name: "BP" } }));
    const found = vi.spyOn(PlannerClient.prototype, "searchTasks");

    found.mockResolvedValue(many);
    expect(parse(await run("search_tasks", { query: "t1" })).truncated).toBe(true);
    found.mockResolvedValue(many.slice(0, 3));
    expect(parse(await run("search_tasks", { query: "t1" })).truncated).toBe(false);
  });

  it("search_tasks sends the query as given and answers with lines", async () => {
    const found = vi.spyOn(PlannerClient.prototype, "searchTasks").mockResolvedValue([
      { taskNumber: 1, title: "Login", project: { key: "BP", name: "BP" } },
    ]);

    const answer = parse(await run("search_tasks", { query: "login flow" }));

    expect(found).toHaveBeenCalledWith("login flow");
    expect(answer).toMatchObject({ returned: 1 });
    expect(answer.tasks[0].key).toBe("BP-1");
    expect(registered().get("search_tasks")!.schema.safeParse({ query: "a" }).success).toBe(false);
  });

  it("get_project_stats reads the board it was asked for", async () => {
    const stats = vi.spyOn(PlannerClient.prototype, "getProjectStats").mockResolvedValue({ total: 3, done: 1, customFieldUsage: [] });

    const answer = parse(await run("get_project_stats", { project: "bp" }));

    expect(stats).toHaveBeenCalledWith("p1");
    expect(answer).toMatchObject({ total: 3, done: 1 });
    expect(answer).not.toHaveProperty("customFieldUsage");
  });

  it("list_runs asks for twenty unless told otherwise, and never for more than a hundred", async () => {
    const runs = vi.spyOn(PlannerClient.prototype, "listRuns").mockResolvedValue([{ taskKey: "BP-1", outcome: "refused" }]);

    expect(parse(await run("list_runs", { project: "bp" }))[0]).toMatchObject({ taskKey: "BP-1", outcome: "refused" });
    await run("list_runs", { project: "bp", limit: 5 });

    expect(runs.mock.calls.map((c) => c[1])).toEqual([20, 5]);
    expect(registered().get("list_runs")!.schema.safeParse({ project: "BP", limit: 101 }).success).toBe(false);
  });

  it("list_notifications pages by a cursor and says what is unread", async () => {
    const list = vi.spyOn(PlannerClient.prototype, "listNotifications").mockResolvedValue([
      { _id: "n1", title: "Assigned", read: false, createdAt: "2026-10-05T10:00:00.000Z", task: { taskNumber: 4 }, project: { key: "BP" } },
    ]);

    const answer = parse(await run("list_notifications", { limit: 1, before: "2026-10-06T00:00:00.000Z" }));

    expect(list).toHaveBeenCalledWith(1, "2026-10-06T00:00:00.000Z");
    await run("list_notifications");
    expect(list).toHaveBeenLastCalledWith(30, undefined);
    expect(registered().get("list_notifications")!.schema.safeParse({ before: "last week" }).success).toBe(false);
    expect(registered().get("list_notifications")!.schema.safeParse({ before: "2026-10-05T10:00:00.000Z" }).success).toBe(true);
    expect(answer).toMatchObject({ returned: 1, unreadOnPage: 1, nextBefore: "2026-10-05T10:00:00.000Z" });
    expect(answer.notifications[0].task).toBe("BP-4");
  });

  it("mark_notifications_read marks one by its id, or all when given none", async () => {
    const mark = vi.spyOn(PlannerClient.prototype, "markNotificationsRead").mockResolvedValue({ ok: true });

    expect(parse(await run("mark_notifications_read", { id: "n1" }))).toEqual({ read: "n1" });
    expect(parse(await run("mark_notifications_read"))).toEqual({ read: "all" });
    expect(mark.mock.calls.map((c) => c[0])).toEqual(["n1", undefined]);
  });
});

/**
 * BP-909. Seeding a board of 85 tasks and about a hundred links was 185 tool calls, each paying for its own
 * lookups. The batch tools run each item through the tool of the same name, report per item, and make the
 * lookups once per call.
 */
describe("batch tools", () => {
  const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);
  const run = (name: string, args: Record<string, unknown>) => registered().get(name)!.handler(args, extra);
  let made: string[];
  let links: unknown[][];

  beforeEach(() => {
    made = [];
    links = [];
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({ _id: "p1", customFields: [] } as never);
    vi.spyOn(PlannerClient.prototype, "createTask").mockImplementation(async (_p, data) => {
      if (String(data.title).startsWith("FAIL")) throw new Error(`refused ${data.title}`);
      made.push(String(data.title));
      return { taskNumber: made.length, title: data.title, status: "todo", priority: "medium", assignee: null };
    });
    // A key is a number on board p1; the id is the number, so a link can be read back as keys
    vi.spyOn(PlannerClient.prototype, "resolveTaskKey").mockImplementation(async (key: string) => {
      if (key.toUpperCase().startsWith("OTHER-")) return { projectId: "p2", taskId: key };
      return { projectId: "p1", taskId: key.toUpperCase() };
    });
    vi.spyOn(PlannerClient.prototype, "addTaskLink").mockImplementation(async (...args) => {
      links.push(args);
      return { message: "Dependency added" };
    });
  });

  describe("create_tasks", () => {
    it("makes each item as create_task does, in order, and answers one line per item", async () => {
      const answer = parse(await run("create_tasks", { project: "bp", tasks: [{ title: "One", priority: "high" }, { title: "Two" }] }));

      expect(made).toEqual(["One", "Two"]);
      expect(answer).toMatchObject({ requested: 2, created: 2, failed: 0 });
      expect(answer.results.map((r: { n: number; key: string }) => [r.n, r.key])).toEqual([[1, "BP-1"], [2, "BP-2"]]);
      expect(answer.results[0]).toMatchObject({ title: "One", status: "todo", url: "https://board.example.com/projects/BP/tasks/1" });
    });

    it("links an item to an earlier one by #n, so an epic and its children are one call", async () => {
      const answer = parse(
        await run("create_tasks", {
          project: "bp",
          tasks: [{ title: "Epic" }, { title: "Child", parent: "#1" }, { title: "Blocked", blockedBy: ["#1", "BP-99"] }],
        })
      );

      expect(answer.failed).toBe(0);
      expect(links).toEqual([
        ["p1", "BP-1", "BP-2", "parent_of"],
        ["p1", "BP-3", "BP-1", "blocked_by"],
        ["p1", "BP-3", "BP-99", "blocked_by"],
      ]);
    });

    it("carries on past an item that fails, and says why, without undoing what was made", async () => {
      const answer = parse(
        await run("create_tasks", { project: "bp", tasks: [{ title: "One" }, { title: "FAIL two" }, { title: "Three" }] })
      );

      expect(made).toEqual(["One", "Three"]);
      expect(answer).toMatchObject({ requested: 3, created: 2, failed: 1 });
      expect(answer.results[1]).toEqual({ n: 2, error: "refused FAIL two" });
      expect(answer.results[2].key).toBe("BP-2");
    });

    it("refuses an item whose reference points at nothing before it makes anything", async () => {
      const answer = parse(
        await run("create_tasks", {
          project: "bp",
          tasks: [{ title: "FAIL one" }, { title: "Two", parent: "#1" }, { title: "Three", parent: "#3" }, { title: "Four", parent: "#9" }],
        })
      );

      expect(made).toEqual([]);
      expect(answer.results[1].error).toMatch(/#1 did not create a task/);
      expect(answer.results[2].error).toMatch(/#3 must name an earlier item.*item #3/);
      expect(answer.results[3].error).toMatch(/#9 must name an earlier item/);
    });

    it("keeps a task that was made when only its link fails, and reports the link on the item", async () => {
      vi.mocked(PlannerClient.prototype.addTaskLink).mockRejectedValue(new Error("Task not found"));

      const answer = parse(await run("create_tasks", { project: "bp", tasks: [{ title: "Epic" }, { title: "Child", parent: "#1" }] }));

      expect(answer).toMatchObject({ created: 2, failed: 0 });
      expect(answer.results[1].linkErrors).toEqual(["parent BP-1: Task not found"]);
    });

    it("runs every item through the same refusals as create_task", async () => {
      vi.spyOn(PlannerClient.prototype, "listSprints").mockResolvedValue([]);

      const answer = parse(await run("create_tasks", { project: "bp", tasks: [{ title: "One", sprint: "Nope" }, { title: "Two", dueDate: "2026-02-31" }] }));

      expect(answer.results[0].error).toMatch(/No sprint "Nope"/);
      expect(answer.results[1].error).toMatch(/Invalid dueDate/);
      expect(made).toEqual([]);
    });

    it("bounds the links as well as the items, since each link is several requests", () => {
      const { schema } = registered().get("create_tasks")!;
      const blockers = (n: number) => Array.from({ length: n }, () => "#1");

      expect(schema.safeParse({ project: "BP", tasks: [{ title: "T", blockedBy: blockers(10) }] }).success).toBe(true);
      expect(schema.safeParse({ project: "BP", tasks: [{ title: "T", blockedBy: blockers(11) }] }).success).toBe(false);
      // 7 items of 10 blockers + a parent: 77 links, over the 60 a call may carry
      const heavy = Array.from({ length: 7 }, () => ({ title: "T", parent: "#1", blockedBy: blockers(10) }));
      expect(schema.safeParse({ project: "BP", tasks: heavy }).success).toBe(false);
      expect(schema.safeParse({ project: "BP", tasks: heavy.slice(0, 5) }).success).toBe(true);
    });

    it("stops starting items when the client has gone, and says which were not attempted", async () => {
      const gone = new AbortController();
      const extraWithSignal = { ...(extra as object), signal: gone.signal } as never;
      vi.mocked(PlannerClient.prototype.createTask).mockImplementation(async (_p, data) => {
        made.push(String(data.title));
        if (made.length === 2) gone.abort();
        return { taskNumber: made.length, title: data.title };
      });

      const answer = parse(
        await registered().get("create_tasks")!.handler(
          { project: "bp", tasks: [{ title: "One" }, { title: "Two" }, { title: "Three" }, { title: "Four" }] },
          extraWithSignal
        )
      );

      expect(made).toEqual(["One", "Two"]);
      expect(answer).toMatchObject({ requested: 4, created: 2, failed: 2, cancelled: true });
      expect(answer.results[2]).toEqual({ n: 3, error: "not attempted: the call was cancelled" });
    });

    it("is an error to the caller when not one item worked, with the reasons still in the answer", async () => {
      const result = (await run("create_tasks", { project: "bp", tasks: [{ title: "FAIL a" }, { title: "FAIL b" }] })) as { isError?: boolean };

      expect(result.isError).toBe(true);
      expect(parse(result)).toMatchObject({ requested: 2, created: 0, failed: 2 });
    });

    it("is not an error when some did", async () => {
      const result = (await run("create_tasks", { project: "bp", tasks: [{ title: "FAIL a" }, { title: "ok" }] })) as { isError?: boolean };

      expect(result.isError).toBeUndefined();
    });

    it("refuses an item that names a field create_task has not, such as a status of its own or minimal", () => {
      const { schema } = registered().get("create_tasks")!;

      expect(schema.safeParse({ project: "BP", tasks: [{ title: "T", minimal: false }] }).success).toBe(false);
      expect(schema.safeParse({ project: "BP", tasks: [{ title: "T", taskKey: "BP-1" }] }).success).toBe(false);
    });

    it("takes at most the batch limit, at least one, and no key the item does not declare", () => {
      const { schema } = registered().get("create_tasks")!;
      const item = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `T${i}` }));

      expect(schema.safeParse({ project: "BP", tasks: item(30) }).success).toBe(true);
      expect(schema.safeParse({ project: "BP", tasks: item(31) }).success).toBe(false);
      expect(schema.safeParse({ project: "BP", tasks: [] }).success).toBe(false);
      expect(schema.safeParse({ project: "BP", tasks: [{ title: "T", status_id: "x" }] }).success).toBe(false);
      expect(schema.safeParse({ project: "BP", tasks: [{ title: "T", parent: "#1", blockedBy: ["BP-2"] }] }).success).toBe(true);
    });
  });

  describe("update_tasks", () => {
    it("updates each item as update_task does and carries on past one that fails", async () => {
      const wrote = vi.spyOn(PlannerClient.prototype, "updateTask").mockImplementation(async (_p, id, data) => {
        if (id === "BP-2") throw new Error("Task not found");
        return { taskNumber: Number(String(id).slice(3)), title: data.title ?? "t", status: "todo" };
      });

      const answer = parse(
        await run("update_tasks", { updates: [{ taskKey: "bp-1", title: "A" }, { taskKey: "BP-2", title: "B" }, { taskKey: "BP-3", priority: "high" }] })
      );

      expect(wrote.mock.calls.map((c) => [c[1], c[2]])).toEqual([["BP-1", { title: "A" }], ["BP-2", { title: "B" }], ["BP-3", { priority: "high" }]]);
      expect(answer).toMatchObject({ requested: 3, updated: 2, failed: 1 });
      expect(answer.results[0]).toMatchObject({ n: 1, key: "BP-1", title: "A" });
      expect(answer.results[1]).toEqual({ n: 2, taskKey: "BP-2", error: "Task not found" });
    });

    it("refuses an item that names nothing to change, as update_task does, and the rest still run", async () => {
      vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({ taskNumber: 2, title: "t" });

      const answer = parse(await run("update_tasks", { updates: [{ taskKey: "BP-1" }, { taskKey: "BP-2", title: "x" }] }));

      expect(answer.results[0].error).toMatch(/nothing to change/);
      expect(answer.results[1].key).toBe("BP-2");
    });

    it("takes at most the batch limit", () => {
      const { schema } = registered().get("update_tasks")!;

      expect(schema.safeParse({ updates: Array.from({ length: 31 }, () => ({ taskKey: "BP-1", title: "x" })) }).success).toBe(false);
      expect(schema.safeParse({ updates: [{ taskKey: "BP-1", nope: 1 }] }).success).toBe(false);
    });
  });

  describe("link_task_pairs", () => {
    it("links each pair as link_tasks does, naming what was linked", async () => {
      const answer = parse(
        await run("link_task_pairs", {
          links: [
            { taskKey: "BP-1", targetTaskKey: "BP-2", type: "parent_of" },
            { taskKey: "BP-3", targetTaskKey: "BP-1", type: "blocked_by" },
          ],
        })
      );

      expect(links).toEqual([["p1", "BP-1", "BP-2", "parent_of"], ["p1", "BP-3", "BP-1", "blocked_by"]]);
      expect(answer).toMatchObject({ requested: 2, linked: 2, failed: 0 });
      expect(answer.results[0]).toMatchObject({ n: 1, message: "Linked: BP-1 is the parent of BP-2" });
    });

    it("reports a pair on two boards by name and carries on with the rest", async () => {
      const answer = parse(
        await run("link_task_pairs", {
          links: [
            { taskKey: "BP-1", targetTaskKey: "OTHER-1", type: "relates" },
            { taskKey: "BP-1", targetTaskKey: "BP-2", type: "relates" },
          ],
        })
      );

      expect(answer).toMatchObject({ linked: 1, failed: 1 });
      expect(answer.results[0].error).toMatch(/BP-1 and OTHER-1 are on different boards/);
      expect(links).toHaveLength(1);
    });

    it("takes at most the batch limit and only the four link types", () => {
      const { schema } = registered().get("link_task_pairs")!;
      const pair = { taskKey: "BP-1", targetTaskKey: "BP-2", type: "relates" };

      expect(schema.safeParse({ links: Array.from({ length: 60 }, () => pair) }).success).toBe(true);
      expect(schema.safeParse({ links: Array.from({ length: 61 }, () => pair) }).success).toBe(false);
      expect(schema.safeParse({ links: [{ ...pair, type: "friends" }] }).success).toBe(false);
    });
  });
});

/**
 * BP-915. A member can take a task off every list and bring it back; only the board's owner can
 * delete one, and the call has to repeat the task's key.
 */
describe("archiving and deleting a task", () => {
  const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);
  const run = (name: string, args: Record<string, unknown>) => registered().get(name)!.handler(args, extra);

  describe("archive_task and unarchive_task", () => {
    it("archive by key and answer with the task's key and link", async () => {
      const archive = vi
        .spyOn(PlannerClient.prototype, "archiveTask")
        .mockResolvedValue({ taskNumber: 7, title: "T", status: "todo", priority: "high" });

      const answer = parse(await run("archive_task", { taskKey: "bp-7" }));

      expect(archive).toHaveBeenCalledWith("p1", "t1");
      expect(answer).toMatchObject({ archived: true, key: "BP-7", title: "T" });
    });

    it("restore by key", async () => {
      const restore = vi.spyOn(PlannerClient.prototype, "unarchiveTask").mockResolvedValue({ taskNumber: 7 });

      const answer = parse(await run("unarchive_task", { taskKey: "BP-7" }));

      expect(restore).toHaveBeenCalledWith("p1", "t1");
      expect(answer).toMatchObject({ archived: false, key: "BP-7" });
    });

    it("say who may, and that restoring is possible", () => {
      const said = descriptions();

      expect(said.get("archive_task")).toMatch(/Any member/);
      expect(said.get("archive_task")).toMatch(/unarchive_task/);
      expect(said.get("unarchive_task")).toMatch(/Any member/);
    });
  });

  describe("delete_task", () => {
    beforeEach(() => {
      vi.spyOn(PlannerClient.prototype, "getProject").mockResolvedValue({ _id: "p1", canAdmin: true });
    });

    it("deletes for the owner when the key is repeated, whatever the case of the prefix", async () => {
      const del = vi.spyOn(PlannerClient.prototype, "deleteTask").mockResolvedValue({ message: "Task deleted" });

      const answer = parse(await run("delete_task", { taskKey: "BP-7", confirmKey: "bp-7" }));

      expect(del).toHaveBeenCalledWith("p1", "t1");
      expect(answer).toEqual({ deleted: "BP-7" });
    });

    it("refuses a confirmKey that is another task's, before reading or writing anything", async () => {
      const del = vi.spyOn(PlannerClient.prototype, "deleteTask").mockResolvedValue({});
      const resolve = vi.mocked(PlannerClient.prototype.resolveTaskKey);

      await expect(run("delete_task", { taskKey: "BP-7", confirmKey: "BP-8" })).rejects.toThrow(
        /confirmKey "BP-8" is not the key of the task to delete, "BP-7". Nothing was written/
      );
      expect(resolve).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
    });

    it.each(["", "7", "BP", "OTHER-7"])("refuses the confirmKey %j", async (confirmKey) => {
      const del = vi.spyOn(PlannerClient.prototype, "deleteTask").mockResolvedValue({});

      await expect(run("delete_task", { taskKey: "BP-7", confirmKey })).rejects.toThrow(/Not deleted/);
      expect(del).not.toHaveBeenCalled();
    });

    it("refuses a member who is not the owner, pointing at archive_task, and deletes nothing", async () => {
      vi.spyOn(PlannerClient.prototype, "getProject").mockResolvedValue({ _id: "p1", canAdmin: false });
      const del = vi.spyOn(PlannerClient.prototype, "deleteTask").mockResolvedValue({});

      await expect(run("delete_task", { taskKey: "BP-7", confirmKey: "BP-7" })).rejects.toThrow(/only the board's owner[\s\S]*archive_task[\s\S]*BP-7/);
      expect(del).not.toHaveBeenCalled();
    });

    it("declares confirmKey, so a call without it never reaches the handler", () => {
      expect(registered().get("delete_task")!.schema.safeParse({ taskKey: "BP-1" }).success).toBe(false);
    });

    it("says who may, that it is for good and that a worker's run is never forced", () => {
      const said = descriptions().get("delete_task")!;

      expect(said).toMatch(/Only the board's owner/);
      expect(said).toMatch(/archive_task/);
      expect(said).toMatch(/cannot be undone/);
      expect(said).toMatch(/never forced/);
    });
  });

  describe("list_tasks", () => {
    it("passes archived on, and offers only the two values that mean something", async () => {
      vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({ _id: "p1" } as never);
      const page = vi
        .spyOn(PlannerClient.prototype, "pageTasks")
        .mockResolvedValue({ tasks: [], total: 0, limit: 50, offset: 0 });

      await run("list_tasks", { project: "BP", archived: "only" });

      expect(page.mock.calls[0][1]).toMatchObject({ archived: "only" });
      const schema = registered().get("list_tasks")!.schema;
      expect(schema.safeParse({ project: "BP", archived: "include" }).success).toBe(true);
      expect(schema.safeParse({ project: "BP", archived: "exclude" }).success).toBe(false);
    });

    it("sends nothing about archived by default, so archived tasks stay out", async () => {
      vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({ _id: "p1" } as never);
      const page = vi
        .spyOn(PlannerClient.prototype, "pageTasks")
        .mockResolvedValue({ tasks: [], total: 0, limit: 50, offset: 0 });

      await run("list_tasks", { project: "BP" });

      expect(page.mock.calls[0][1]).not.toHaveProperty("archived");
    });
  });
});
