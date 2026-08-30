import { describe, it, expect, vi } from "vitest";

/**
 * BP-497 review. The standalone stdio server was asserted about by reading its source text, which
 * a local `const strictInput = (shape) => z.object(shape)` shim would have passed with the suite
 * green. It also runs a different zod major from the app — 4 rather than 3 — and the two spell the
 * error hook `error` and `errorMap` respectively, so the app's tests exercise only one of the two
 * hooks the shared helper passes. This drives the real thing: mcp-server's own SDK, its own zod,
 * its own registrations.
 */

async function standalone() {
  const sdk = "../../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm";
  const { McpServer } = await import(`${sdk}/server/mcp.js`);
  const { Client } = await import(`${sdk}/client/index.js`);
  const { InMemoryTransport } = await import(`${sdk}/inMemory.js`);
  const { registerTools } = await import("../../../mcp-server/src/tools");
  return { McpServer, Client, InMemoryTransport, registerTools };
}

function stubClient() {
  return {
    getProjectByKey: vi.fn(async () => ({ _id: "p1", key: "BP", customFields: [] })),
    listTasks: vi.fn(async () => [{ _id: "t1", taskNumber: 1 }]),
    getProject: vi.fn(async () => ({ _id: "p1", customFields: [] })),
    updateTask: vi.fn(async () => ({ _id: "t1" })),
    listAssignableUsers: vi.fn(async () => []),
    listAgents: vi.fn(async () => []),
  };
}

async function connected(client: ReturnType<typeof stubClient>) {
  const { McpServer, Client, InMemoryTransport, registerTools } = await standalone();
  const server = new McpServer({ name: "boardplanner", version: "1.0.0" });
  registerTools(server, client as never);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

  return async (name: string, args: Record<string, unknown>) => {
    const result = (await mcp.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { refused: result.isError === true, said: result.content.map((c) => c.text).join("\n") };
  };
}

describe("the standalone MCP server, driven rather than read", () => {
  it("refuses an undeclared parameter and keeps the hint its own zod major produces", async () => {
    const client = stubClient();
    const call = await connected(client);

    const { refused, said } = await call("update_task", {
      taskKey: "BP-1",
      title: "renamed",
      checklist: [],
    });

    expect(refused).toBe(true);
    expect(said).toContain("checklist");
    // The hint arrives through zod 4's `error` hook. zod 3 ignores that key entirely, so nothing
    // in the app's suite can tell whether it still works here
    expect(said).toContain("acceptanceCriteria");
    expect(client.updateTask).not.toHaveBeenCalled();
  });

  // The control. A registration that refused everything would satisfy the assertions above
  it("still writes a parameter it does declare", async () => {
    const client = stubClient();
    const call = await connected(client);

    const { refused } = await call("update_task", { taskKey: "BP-1", title: "renamed" });

    expect(refused).toBe(false);
    expect(client.updateTask).toHaveBeenCalledWith("p1", "t1", { title: "renamed" });
  });

  it("refuses an update that names nothing to change, before it looks the task up", async () => {
    const client = stubClient();
    const call = await connected(client);

    const { refused, said } = await call("update_task", { taskKey: "BP-1" });

    expect(refused).toBe(true);
    expect(said).toContain("nothing to change");
    expect(client.listTasks).not.toHaveBeenCalled();
  });

  it("holds for every tool it registers, not only the one that was reported", async () => {
    const { registerTools } = await standalone();
    const schemas = new Map<string, { safeParse: (v: unknown) => { success: boolean; error?: { issues: { code: string }[] } } }>();
    const server = {
      registerTool: (name: string, config: { inputSchema: never }) => schemas.set(name, config.inputSchema),
    };
    registerTools(server as never, stubClient() as never);

    // guards the guard: an empty map would satisfy the filter below without proving anything
    expect(schemas.size).toBe(12);

    const permissive = [...schemas.entries()].filter(([, schema]) => {
      const result = schema.safeParse({ __stray__: 1 });
      return result.success || !result.error!.issues.some((i) => i.code === "unrecognized_keys");
    });

    expect(permissive.map(([name]) => name)).toEqual([]);
  });
});
