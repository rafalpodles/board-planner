import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

export const APP_URI = "ui://boardplanner/view-v1.html";
export const APP_TOOLS = new Set([
  "get_task", "list_tasks", "my_tasks", "search_tasks", "get_project_stats",
  "get_sprint", "list_sprints", "create_task", "update_task", "change_task_status",
]);

/** Add a view without changing the text, API calls, credential or errors of any handler. */
export function plannerAppRegistration(server: McpServer): McpServer["registerTool"] {
  return ((name, config, handler) => {
    if (!APP_TOOLS.has(name)) return server.registerTool(name, config, handler);
    return registerAppTool(server, name, {
      ...config,
      _meta: { ...config._meta, ui: { resourceUri: APP_URI } },
    } as never, (async (args: Record<string, unknown>, extra: { authInfo?: { extra?: Record<string, unknown> } }) => {
      const invoke = handler as (args: Record<string, unknown>, extra: { authInfo?: { extra?: Record<string, unknown> } }) => CallToolResult | Promise<CallToolResult>;
      const result = await invoke(args, extra);
      return {
        ...result,
        _meta: {
          ...result._meta,
          // View-only context: never a token, and no duplicate task body in the model's context.
          "boardplanner/view": { tool: name, arguments: args, origin: extra.authInfo?.extra?.baseUrl },
        },
      };
    }) as never);
  }) as McpServer["registerTool"];
}

export function registerPlannerAppResources(server: McpServer) {
  const metadata = { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } };
  registerAppResource(server, "Board Planner", APP_URI, { _meta: metadata }, async () => ({
    contents: [{
      uri: APP_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(join(process.cwd(), "mcp-apps/dist/index.html"), "utf8"),
      _meta: metadata,
    }],
  }));
}
