import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlannerClient } from "./planner-client";

export type ToolExtra = { authInfo?: AuthInfo; signal?: AbortSignal };

export type RegisterTool = McpServer["registerTool"];

// One client per call, so the lookups a batch repeats for every item — the board list, a roster, the
// sprints — are made once. `extra` is made per request by the SDK, so the client does not outlive its call.
const clients = new WeakMap<object, PlannerClient>();

export function clientFrom(extra: ToolExtra): PlannerClient {
  const auth = extra.authInfo;
  if (!auth) throw new Error("Unauthorized");
  const baseUrl = auth.extra?.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl) {
    throw new Error("Missing base URL in auth context");
  }
  let client = clients.get(extra);
  if (!client) {
    client = new PlannerClient(baseUrl, auth.token);
    clients.set(extra, client);
  }
  return client;
}

export function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
