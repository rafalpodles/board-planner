import { createServer } from "node:http";

const LOOPBACK = "127.0.0.1";

const PORT = Number(process.env.PM_STUB_PORT ?? 3988);

const MODELS = {
  data: [
    { id: "e2e/vision-model", architecture: { input_modalities: ["text", "image"] } },
    { id: "e2e/text-only-model", architecture: { input_modalities: ["text"] } },
  ],
};

const seen = new Map();

function reply(res, body) {
  const payload = JSON.stringify(body);
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

let received = null;

const server = createServer((req, res) => {
  if (req.url === "/reset") {
    seen.clear();
    received = null;
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }

  if (req.url === "/last") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(received));
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }

  if (req.url?.endsWith("/models")) {
    reply(res, MODELS);
    return;
  }

  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let messages = [];
    try {
      messages = JSON.parse(raw).messages ?? [];
    } catch {
    }

    const kindOfPart = (part) =>
      part?.type === "text" && !String(part.text ?? "").trim() ? "empty-text" : part?.type ?? "unknown";
    const kindsOf = (m) =>
      typeof m?.content === "string"
        ? m.content.trim()
          ? ["text"]
          : ["empty-text"]
        : (m?.content ?? []).map(kindOfPart);
    const users = messages.filter((m) => m?.role === "user");
    received = {
      userBlocks: kindsOf(users[users.length - 1]),
      images: messages.reduce(
        (n, m) => n + kindsOf(m).filter((k) => k === "image_url").length,
        0
      ),
      systems: messages
        .filter((m) => m?.role === "system")
        .map((m) => String(m?.content ?? "").slice(0, 200)),
      roles: messages.map((m) => m?.role),
      contents: messages.map((m) => ({
        role: m?.role,
        text:
          typeof m?.content === "string"
            ? m.content
            : (m?.content ?? [])
                .map((part) => (typeof part?.text === "string" ? part.text : ""))
                .join(" "),
      })),
    };

    const toolHasRun = messages.some((m) => m?.role === "tool");

    const said = [...messages].reverse().find((m) => m?.role === "user");
    const text = typeof said?.content === "string"
      ? said.content
      : (said?.content ?? []).map((part) => part?.text ?? "").join(" ");
    const escalated = /^Task (\S+) was just moved to "needs_human_review"/m.exec(text ?? "");
    if (escalated && !toolHasRun) {
      reply(res, {
        usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_0",
                  type: "function",
                  function: {
                    name: "add_comment",
                    arguments: JSON.stringify({
                      taskKey: escalated[1],
                      body: "Reviewed on the way in: this is answerable from the board.",
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
      return;
    }

    const directive = /<<([\s\S]*?)>>/.exec(text ?? "");
    const script = directive?.[1] ?? process.env.PM_STUB_TOOL_CALL ?? "{}";
    const call = JSON.parse(script);

    const attempts = (seen.get(script) ?? 0) + 1;
    seen.set(script, attempts);

    const failing = call.status || (call.failTimes && attempts <= call.failTimes ? 500 : 0);
    const answer = () => {
      if (toolHasRun) {
        reply(res, {
            usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done." } }],
        });
        return;
      }
      if (failing) {
        res.writeHead(failing, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "the stub was told to fail" } }));
        return;
      }
      if (!call.name) {
        reply(res, {
            usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
          choices: [
            { finish_reason: "stop", message: { role: "assistant", content: call.say ?? "Noted." } },
          ],
        });
        return;
      }
      reply(res, {
        usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_0",
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
                },
              ],
            },
          },
        ],
      });
    };

    if (call.delayMs) setTimeout(answer, call.delayMs);
    else answer();
  });
});

server.listen(PORT, LOOPBACK, () => console.log(`openrouter stub listening on ${PORT}`));
