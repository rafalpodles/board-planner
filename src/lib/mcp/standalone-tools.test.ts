import { describe, it, expect, vi } from "vitest";

/**
 * BP-497 review. The standalone stdio server was asserted about by reading its source text, which
 * a local `const strictInput = (shape) => z.object(shape)` shim would have passed with the suite
 * green. It also runs a different zod major from the app — 4 rather than 3 — and the two spell the
 * error hook `error` and `errorMap` respectively, so the app's tests exercise only one of the two
 * hooks the shared helper passes. This drives the real thing: mcp-server's own SDK, its own zod,
 * its own registrations.
 */

// Every path into the sibling package's node_modules is built rather than written, because
// tsconfig globs **/*.ts and `next build` type-checks what it globs: a literal specifier here is
// resolved at build time, and .dockerignore drops **/node_modules, so the image cannot have it.
// That broke the production build on main and no CI job could see it — the app job installs the
// sibling package before it type-checks (BP-501).
const STANDALONE_MODULES = "../../../mcp-server/node_modules";

async function standalone() {
  const sdk = `${STANDALONE_MODULES}/@modelcontextprotocol/sdk/dist/esm`;
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
  // Guards the instrument. `mcp-server/src/*` imports zod by bare specifier, so with the sibling
  // package's dependencies missing it resolves upwards to the app's zod 3 and every assertion
  // below would quietly exercise the hook that is already covered.
  it("is really running the other zod", async () => {
    const [standaloneZod, appZod] = await Promise.all([
      import(`${STANDALONE_MODULES}/zod`),
      import("zod"),
    ]);

    expect(standaloneZod.z).not.toBe(appZod.z);
  });

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

  /**
   * The second copy of the bound (BP-564). `npm test` does not run anything under `mcp-server/`,
   * and the package builds separately, so a bound applied to one copy and not the other compiles
   * clean on both sides and nothing says a word — the reason api-client-drift.test.ts exists.
   * `echo.test.ts` asserts the two helper files are identical; this asserts the standalone
   * *call site* actually uses it.
   */
  it("bounds a caller's parameter name in the standalone copy too", async () => {
    const { unknownParameterMessage } = await import("../../../mcp-server/src/strict-input");

    const said = unknownParameterMessage(["z".repeat(50_000)], {}, true);

    expect(said).toContain(`"${"z".repeat(64)}…"`);
    expect(said.length).toBeLessThan(200);
    expect(unknownParameterMessage(["checklist"], {}, true)).toContain('"checklist"');
  });

  /**
   * The standalone package keeps its **own** `resolveFieldsByName`, distinct from the app's in
   * `src/lib/custom-fields.ts` — which is how the first pass at BP-564 bounded the app's copy and
   * left this one echoing whatever a caller sent. Exactly the failure mode the ticket is about,
   * repeated inside the fix for it.
   */
  it("bounds a field name and an option value in its own resolver", async () => {
    const client = stubClient();
    client.getProject = vi.fn(async () => ({
      _id: "p1",
      customFields: [
        { _id: "f1", name: "Owoce", fieldType: "dropdown", options: [{ id: "a", value: "Apples" }] },
      ],
    })) as never;
    const call = await connected(client);
    const huge = "z".repeat(50_000);

    const unknownField = await call("update_task", { taskKey: "BP-1", fields: { [huge]: "x" } });
    expect(unknownField.refused).toBe(true);
    expect(unknownField.said).toContain(`"${"z".repeat(64)}…"`);
    expect(unknownField.said.length).toBeLessThan(400);

    const unknownOption = await call("update_task", { taskKey: "BP-1", fields: { Owoce: huge } });
    expect(unknownOption.refused).toBe(true);
    expect(unknownOption.said).toContain(`"${"z".repeat(64)}…"`);
    expect(unknownOption.said.length).toBeLessThan(400);

    // Still quoted whole when it is something anybody would really send
    const short = await call("update_task", { taskKey: "BP-1", fields: { Owoce: "Pears" } });
    expect(short.said).toContain('"Pears"');
  });

  /**
   * The mutation audit found every refusal in the standalone `tools.ts` and `api-client.ts` to be a
   * survivor: `npm test` never runs that package, and the drift guard reads request *paths*, not
   * refusal messages. These drive the real module, so reverting a bound there goes red.
   */
  it("bounds the names in its own assignee and agent refusals", async () => {
    const client = stubClient();
    const call = await connected(client);
    const huge = "z".repeat(50_000);

    const assignee = await call("update_task", { taskKey: "BP-1", assignee: huge });
    expect(assignee.refused).toBe(true);
    expect(assignee.said).toContain(`"${"z".repeat(64)}…"`);
    expect(assignee.said.length).toBeLessThan(400);

    const agent = await call("update_task", { taskKey: "BP-1", agent: huge });
    expect(agent.refused).toBe(true);
    expect(agent.said).toContain(`"${"z".repeat(64)}…"`);
    expect(agent.said.length).toBeLessThan(400);
  });

  it("bounds the task key in its own resolver", async () => {
    const call = await connected(stubClient());

    const bad = await call("get_task", { taskKey: `${"z".repeat(50_000)}-1` });
    expect(bad.refused).toBe(true);
    expect(bad.said).toContain(`"${"z".repeat(64)}…"`);
    expect(bad.said.length).toBeLessThan(400);
  });
});
