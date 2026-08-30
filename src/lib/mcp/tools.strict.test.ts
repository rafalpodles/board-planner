import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { registerPlannerTools } from "./tools";
import { PlannerClient } from "./planner-client";

/**
 * BP-497. `update_task` was called with `checklist` — a parameter it does not declare — and
 * answered 200 with the task unchanged and `updatedAt` bumped. Nothing in the response said the
 * write had not happened.
 *
 * These drive the real SDK rather than the tool callbacks: the stripping happened in the parse
 * step, which calling a callback directly skips entirely, so a test that reaches past it could
 * not have caught this and cannot catch it coming back.
 */

const authInfo = {
  token: "cp_x",
  clientId: "test",
  scopes: [],
  extra: { baseUrl: "https://board.example.com" },
};

function registeredSchemas(): Map<string, z.ZodObject<z.ZodRawShape>> {
  const schemas = new Map<string, z.ZodObject<z.ZodRawShape>>();
  const server = {
    registerTool: (name: string, config: { inputSchema: z.ZodObject<z.ZodRawShape> }) =>
      schemas.set(name, config.inputSchema),
  } as unknown as McpServer;
  registerPlannerTools(server);
  return schemas;
}

async function connectedClient(): Promise<Client> {
  const server = new McpServer({ name: "boardplanner", version: "1.0.0" });
  registerPlannerTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // authInfo reaches a tool from the transport, not from the request, so it is injected here the
  // way withMcpAuth injects it in production
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = ((message: unknown, options?: Record<string, unknown>) =>
    send(message as never, { ...options, authInfo })) as typeof clientTransport.send;

  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(name: string, args: Record<string, unknown>) {
  const client = await connectedClient();
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  return { refused: result.isError === true, said: result.content.map((c) => c.text).join("\n") };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubTheWriteThatShouldNotHappen() {
  vi.spyOn(PlannerClient.prototype, "resolveTaskKey").mockResolvedValue({
    projectId: "p1",
    taskId: "t1",
  });
  vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});
}

describe("a parameter the tool does not declare is refused, not dropped", () => {
  // Every stray key below travels with a parameter the tool DOES declare. Without one the write
  // is empty either way and the refusal below it — "named nothing to change" — answers instead,
  // which reads as this passing while the strictness it names is gone.
  it("names the parameter and writes nothing", async () => {
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});
    const resolve = vi.spyOn(PlannerClient.prototype, "resolveTaskKey").mockResolvedValue({
      projectId: "p1",
      taskId: "t1",
    });

    const { refused, said } = await call("update_task", {
      taskKey: "BP-1",
      title: "renamed",
      checklist: [],
    });

    expect(refused).toBe(true);
    expect(said).toContain("checklist");
    expect(update).not.toHaveBeenCalled();
    // the refusal lands before the tool runs, so nothing is even looked up
    expect(resolve).not.toHaveBeenCalled();
  });

  // Stubbed even though the refusal lands first: without it a regression stops being a failed
  // assertion and starts being a real outbound request
  it("says to use acceptanceCriteria for a checklist", async () => {
    stubTheWriteThatShouldNotHappen();

    const { said } = await call("update_task", { taskKey: "BP-1", title: "renamed", checklist: [] });

    expect(said).toContain("acceptanceCriteria");
  });

  // The same call that lost `checklist` also carried status: "done", and status is a different tool
  it("says to use change_task_status for a status", async () => {
    stubTheWriteThatShouldNotHappen();

    const { refused, said } = await call("update_task", {
      taskKey: "BP-1",
      title: "renamed",
      status: "done",
    });

    expect(refused).toBe(true);
    expect(said).toContain("change_task_status");
  });

  // CP-214 removed these two parameters and a client still passing them got nothing set
  it("points difficulty at the fields parameter on create_task", async () => {
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({
      _id: "p1",
      key: "BP",
      customFields: [],
    } as never);
    const create = vi.spyOn(PlannerClient.prototype, "createTask").mockResolvedValue({});

    const { refused, said } = await call("create_task", { project: "BP", title: "x", difficulty: "L" });

    expect(refused).toBe(true);
    expect(said).toContain("difficulty");
    expect(said).toContain("fields");
    expect(create).not.toHaveBeenCalled();
  });

  // The control. Without it a mis-wired transport refuses everything and reads as a passing suite
  it("still writes a parameter it does declare", async () => {
    vi.spyOn(PlannerClient.prototype, "resolveTaskKey").mockResolvedValue({
      projectId: "p1",
      taskId: "t1",
    });
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    const { refused } = await call("update_task", { taskKey: "BP-1", title: "renamed" });

    expect(refused).toBe(false);
    expect(update).toHaveBeenCalledWith("p1", "t1", { title: "renamed" });
  });

  // hints is an object literal, so an unguarded hints[key] finds Object.prototype's members —
  // and "__proto__" and "constructor" are exactly the stray keys a confused client sends
  it("does not render Object.prototype into the message for a key named after it", async () => {
    stubTheWriteThatShouldNotHappen();

    // `constructor` cannot be used here: the SDK's own params schema rejects an arguments object
    // carrying it before any tool schema sees it, so the reachable cases are the other inherited
    // members. JSON.parse is how a real transport builds this — an object literal with __proto__
    // sets the prototype instead of an own key
    const { refused, said } = await call(
      "update_task",
      JSON.parse('{"taskKey":"BP-1","title":"renamed","toString":1,"__proto__":1,"hasOwnProperty":1}')
    );

    expect(refused).toBe(true);
    expect(said).toContain('"toString"');
    expect(said).not.toContain("native code");
    expect(said).not.toContain("[object Object]");
    expect(said).not.toMatch(/use function|use \[object/);
  });

  // "Nothing was written" on a tool that never writes invites the reader to think one was tried
  it("claims nothing was written only where something could have been", async () => {
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({
      _id: "p1",
      key: "BP",
    } as never);
    vi.spyOn(PlannerClient.prototype, "listTasks").mockResolvedValue([]);

    const read = await call("list_tasks", { project: "BP", sprint: "s1" });
    const write = await call("add_comment", { taskKey: "BP-1", body: "x", author: "nobody" });

    expect(read.refused).toBe(true);
    expect(read.said).not.toContain("Nothing was written");
    // the control: the same helper does say it where a write was the point
    expect(write.refused).toBe(true);
    expect(write.said).toContain("Nothing was written");
  });

  // Not asserted through tools/list: zod-to-json-schema emits additionalProperties: false for a
  // stripping object too, so the advertised schema reads identically either way and cannot carry
  // this. The schemas themselves can, and there are twelve of them to keep honest.
  it("holds for every tool, not just the two that were reported", () => {
    const schemas = registeredSchemas();

    // guards the guard: an empty map would satisfy the loop below without proving anything
    expect(schemas.size).toBe(12);

    const permissive = [...schemas.entries()].filter(([, schema]) => {
      const result = schema.safeParse({ __stray__: 1 });
      return result.success || !result.error.issues.some((i) => i.code === "unrecognized_keys");
    });

    expect(permissive.map(([name]) => name)).toEqual([]);
  });
});

describe("an update that names nothing to change", () => {
  beforeEach(() => {
    vi.spyOn(PlannerClient.prototype, "resolveTaskKey").mockResolvedValue({
      projectId: "p1",
      taskId: "t1",
    });
  });

  // updatedAt is the one field an empty PATCH moves, and it is the field that reads as proof
  it("is refused rather than sent as an empty write", async () => {
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    const { refused, said } = await call("update_task", { taskKey: "BP-1" });

    expect(refused).toBe(true);
    expect(said).toContain("nothing to change");
    expect(update).not.toHaveBeenCalled();
  });

  it("is refused for a sprint too", async () => {
    vi.spyOn(PlannerClient.prototype, "getProjectByKey").mockResolvedValue({
      _id: "p1",
      key: "BP",
    } as never);
    const update = vi.spyOn(PlannerClient.prototype, "updateSprint").mockResolvedValue({});

    const { refused, said } = await call("update_sprint", { project: "BP", sprintId: "s1" });

    expect(refused).toBe(true);
    expect(said).toContain("nothing to change");
    expect(update).not.toHaveBeenCalled();
  });
});
