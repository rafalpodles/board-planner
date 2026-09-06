import { createServer } from "node:http";

/**
 * An external MCP server the PM agent connects OUT to, which is the opposite direction from
 * e2e/mcp.ts (that one is a client of this app's own /api/mcp).
 *
 * It exists for BP-569: how many tools a turn carries is decided by the remote server, so the
 * only honest way to test the picker and the budget warning is to have a server that really
 * offers a lot of them. `wide` offers more than the budget, `narrow` offers three.
 */

const PORT = Number(process.env.MCP_SERVER_STUB_PORT ?? 3993);

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

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }

  const which = req.url?.startsWith("/narrow") ? "narrow" : "wide";

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let message = {};
    try {
      message = JSON.parse(raw);
    } catch {
      // A malformed request is the caller's problem to report
    }

    const reply = (result) =>
      res
        .writeHead(200, { "Content-Type": "application/json", "mcp-session-id": `stub-${which}` })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 1, result }));

    if (message.method === "initialize") {
      reply({
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: `stub-${which}`, version: "1.0" },
      });
      return;
    }

    if (message.method === "tools/list") {
      reply({ tools: CATALOGUES[which] });
      return;
    }

    if (message.method === "tools/call") {
      reply({ content: [{ type: "text", text: `stub ${which} answered` }] });
      return;
    }

    // notifications/initialized and anything else: acknowledged, nothing to say
    res.writeHead(202).end();
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mcp server stub on ${PORT}`));
