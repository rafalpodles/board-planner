import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient } from "./api-client.js";
import { registerTools } from "./tools.js";

const APP_NAME = "Board Planner";

const APP_URL = process.env.BOARDPLANNER_URL || "http://localhost:3000";
const TOKEN = process.env.BOARDPLANNER_TOKEN;

if (!TOKEN) {
  console.error("BOARDPLANNER_TOKEN environment variable is required");
  process.exit(1);
}

const client = new ApiClient(APP_URL, { token: TOKEN });

const server = new McpServer({
  name: "boardplanner",
  version: "1.0.0",
});

registerTools(server, client);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${APP_NAME} MCP Server running on stdio`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
