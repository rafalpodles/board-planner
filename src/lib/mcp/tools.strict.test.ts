import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { registerPlannerTools } from "./tools";
import { PlannerClient } from "./planner-client";

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
    expect(resolve).not.toHaveBeenCalled();
  });

  it("says to use acceptanceCriteria for a checklist", async () => {
    stubTheWriteThatShouldNotHappen();

    const { said } = await call("update_task", { taskKey: "BP-1", title: "renamed", checklist: [] });

    expect(said).toContain("acceptanceCriteria");
  });

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

  it("does not render Object.prototype into the message for a key named after it", async () => {
    stubTheWriteThatShouldNotHappen();

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
    expect(write.refused).toBe(true);
    expect(write.said).toContain("Nothing was written");
  });

  it("holds for every tool, not just the two that were reported", () => {
    const schemas = registeredSchemas();

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

  it("is refused rather than sent as an empty write", async () => {
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    const { refused, said } = await call("update_task", { taskKey: "BP-1" });

    expect(refused).toBe(true);
    expect(said).toContain("nothing to change");
    expect(update).not.toHaveBeenCalled();
  });

  it("counts an empty fields object as naming nothing, before any lookup", async () => {
    const resolve = vi.spyOn(PlannerClient.prototype, "resolveTaskKey");
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});

    const { refused, said } = await call("update_task", { taskKey: "BP-1", fields: {} });

    expect(refused).toBe(true);
    expect(said).toContain("nothing to change");
    expect(resolve).not.toHaveBeenCalled();
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
