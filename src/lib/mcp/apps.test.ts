import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { APP_URI, plannerAppRegistration, registerPlannerAppResources } from "./apps";
import { registerPlannerTools } from "./tools";
import { readFile } from "node:fs/promises";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
beforeEach(() => vi.mocked(readFile).mockResolvedValue("<!doctype html><html>Bundled view</html>"));
async function connect() {
  const server = new McpServer({ name: "planner", version: "1" });
  registerPlannerTools(server);
  registerPlannerAppResources(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "text-client", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// Explicit expected names: removing a tool from the production map must turn its case red.
const names = ["get_task", "list_tasks", "my_tasks", "search_tasks", "get_project_stats", "get_sprint", "list_sprints", "create_task", "update_task", "change_task_status"];
describe("MCP Apps discovery and resources", () => {
  it.each(names)("%s advertises a real deny-by-default HTML resource", async (name) => {
    const client = await connect();
    try {
      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === name)?._meta?.ui).toEqual({ resourceUri: APP_URI });
      const resource = await client.readResource({ uri: APP_URI });
      expect(resource.contents[0]).toMatchObject({ uri: APP_URI, mimeType: "text/html;profile=mcp-app", text: "<!doctype html><html>Bundled view</html>", _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } });
      expect(readFile).toHaveBeenCalledWith(expect.stringMatching(/mcp-apps\/dist\/index\.html$/), "utf8");
    } finally { await client.close(); }
  });
  it("leaves the evaluated text-only tools alone and lists the resource", async () => {
    const client = await connect();
    try {
      const tools = await client.listTools();
      for (const name of ["list_comments", "get_task_activity", "list_notifications", "list_runs"]) {
        expect(tools.tools.find((tool) => tool.name === name)?._meta?.ui).toBeUndefined();
      }
      expect((await client.listResources()).resources).toEqual([expect.objectContaining({ uri: APP_URI, mimeType: "text/html;profile=mcp-app" })]);
    } finally { await client.close(); }
  });
  it("keeps the exact text result and exposes only safe context to the view", async () => {
    const capture = vi.fn();
    const server = { registerTool: capture } as unknown as McpServer;
    const handler = vi.fn().mockResolvedValue({ content: [{ type: "text", text: '{ "original": true }' }], _meta: { existing: 1 } });
    const register = plannerAppRegistration(server);
    register("get_task", { inputSchema: { taskKey: z.string() } }, handler);
    const extra = { authInfo: { token: "secret", extra: { baseUrl: "https://board.example", username: "private" } } };
    const result = await capture.mock.calls[0][2]({ taskKey: "BP-1" }, extra);
    expect(result).toEqual({ content: [{ type: "text", text: '{ "original": true }' }], _meta: { existing: 1, "boardplanner/view": { tool: "get_task", arguments: { taskKey: "BP-1" }, origin: "https://board.example" } } });
    expect(handler).toHaveBeenCalledExactlyOnceWith({ taskKey: "BP-1" }, extra);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("does not turn a refused write into success", async () => {
    const capture = vi.fn();
    const handler = vi.fn().mockRejectedValue(new Error("Held by a worker"));
    plannerAppRegistration({ registerTool: capture } as unknown as McpServer)("change_task_status", {}, handler);
    await expect(capture.mock.calls[0][2]({}, {})).rejects.toThrow("Held by a worker");
  });
});
