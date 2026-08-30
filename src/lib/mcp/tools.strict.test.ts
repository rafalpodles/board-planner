import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

describe("a parameter the tool does not declare is refused, not dropped", () => {
  it("names the parameter and writes nothing", async () => {
    const update = vi.spyOn(PlannerClient.prototype, "updateTask").mockResolvedValue({});
    const resolve = vi.spyOn(PlannerClient.prototype, "resolveTaskKey");

    const { refused, said } = await call("update_task", { taskKey: "BP-1", checklist: [] });

    expect(refused).toBe(true);
    expect(said).toContain("checklist");
    expect(update).not.toHaveBeenCalled();
    // the refusal lands before the tool runs, so nothing is even looked up
    expect(resolve).not.toHaveBeenCalled();
  });

  it("says to use acceptanceCriteria for a checklist", async () => {
    const { said } = await call("update_task", { taskKey: "BP-1", checklist: [] });
    expect(said).toContain("acceptanceCriteria");
  });

  // The same call that lost `checklist` also carried status: "done", and status is a different tool
  it("says to use change_task_status for a status", async () => {
    const { refused, said } = await call("update_task", { taskKey: "BP-1", status: "done" });
    expect(refused).toBe(true);
    expect(said).toContain("change_task_status");
  });

  // CP-214 removed these two parameters and a client still passing them got nothing set
  it("points difficulty at the fields parameter on create_task", async () => {
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

  it("advertises the refusal in every tool's schema, so a client can see it first", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();

    // guards the guard: an empty list would satisfy the assertion below without proving anything
    expect(tools).toHaveLength(12);
    expect(
      tools.filter((t) => (t.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false)
    ).toEqual([]);
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
