import { createServer } from "node:http";

const LOOPBACK = "127.0.0.1";

const PORT = Number(process.env.AI_STUB_PORT ?? 3989);

let lastRequest = null;

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }

  if (req.url === "/last-request") {
    json(res, lastRequest ?? {});
    return;
  }

  if (req.url === "/reset") {
    lastRequest = null;
    json(res, { ok: true });
    return;
  }

  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let request = {};
    try {
      request = JSON.parse(raw);
    } catch {
    }
    lastRequest = request;

    const messages = request.messages ?? [];
    const system = messages.find((m) => m?.role === "system")?.content ?? "";
    const said = messages.find((m) => m?.role === "user")?.content ?? "";
    const directive = /<<([\s\S]*?)>>/.exec(typeof said === "string" ? said : "");

    const content = directive?.[1] ?? process.env.OPENAI_STUB_TASK ?? "not json at all";

    json(res, {
      id: "chatcmpl-e2e",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model ?? "stub",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: system.length, completion_tokens: content.length, total_tokens: 0 },
    });
  });
});

server.listen(PORT, LOOPBACK, () => console.log(`openai stub listening on ${PORT}`));
