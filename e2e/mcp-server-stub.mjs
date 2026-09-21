import { readBody, serve } from "./stub-guard.mjs";
import { handleOauth } from "./mcp-oauth-stub.mjs";

/**
 * An external MCP server the PM agent connects OUT to, which is the opposite direction from
 * e2e/mcp.ts (that one is a client of this app's own /api/mcp).
 *
 * It exists for BP-569: how many tools a turn carries is decided by the remote server, so the
 * only honest way to test the picker and the budget warning is to have a server that really
 * offers a lot of them. `wide` offers more than the budget, `narrow` offers three.
 *
 * `/oauth/<tenant>/mcp` is the same server behind an authorization server — see mcp-oauth-stub.mjs.
 */

const PORT = Number(process.env.MCP_SERVER_STUB_PORT ?? 3993);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const wideTools = Array.from({ length: 45 }, (_, i) => ({
  name: `list_wide_thing_${i}`,
  description: `Read wide thing number ${i}`,
}));

const narrowTools = [
  { name: "list_narrow_alpha", description: "Read the alpha record" },
  { name: "list_narrow_beta", description: "Read the beta record" },
  { name: "create_narrow_gamma", description: "Write a gamma record" },
];

const CATALOGUES = { wide: wideTools, narrow: narrowTools };

async function answerRpc(req, res, catalogue, serverName) {
  const raw = await readBody(req);
  let message = {};
  try {
    message = JSON.parse(raw);
  } catch {
    // A malformed request is the caller's problem to report
  }

  const reply = (result) =>
    res
      .writeHead(200, { "Content-Type": "application/json", "mcp-session-id": serverName })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 1, result }));

  if (message.method === "initialize") {
    reply({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: serverName, version: "1.0" },
    });
    return;
  }

  if (message.method === "tools/list") {
    reply({ tools: catalogue });
    return;
  }

  if (message.method === "tools/call") {
    reply({ content: [{ type: "text", text: `${serverName} answered` }] });
    return;
  }

  // notifications/initialized and anything else: acknowledged, nothing to say
  res.writeHead(202).end();
}

serve({
  name: "mcp server stub",
  port: PORT,
  handler: async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }

    if (await handleOauth(req, res, ORIGIN, answerRpc)) return;

    const which = req.url?.startsWith("/narrow") ? "narrow" : "wide";
    await answerRpc(req, res, CATALOGUES[which], `stub-${which}`);
  },
});
