import { createServer } from "node:http";

/**
 * A stand-in for OpenRouter, so a PM turn can be driven end to end without a model, a network
 * call or a bill. `OPENROUTER_BASE_URL` points the real client here (src/lib/pm/openrouter.ts),
 * and everything downstream of the response — tool dispatch, updateTask, the activity entry, the
 * SSE stream and the page — is the production code path.
 *
 * The script it plays is fixed: ask for one tool call, then, once the tool's result comes back in
 * the conversation, answer in prose and end the turn. That is the shortest exchange that still
 * exercises the whole loop.
 *
 * What the agent "decides" to do is carried in the user's own message, between << and >>, so each
 * test scripts its own turn while still typing into the real chat box. PM_STUB_TOOL_CALL is the
 * fallback when a message carries no directive.
 */

// Loopback only, on a machine several agents share.
const LOOPBACK = "127.0.0.1";

const PORT = Number(process.env.PM_STUB_PORT ?? 3988);

function reply(res, body) {
  const payload = JSON.stringify(body);
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

const server = createServer((req, res) => {
  // Playwright waits on this before it starts the dev server
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
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
      // A malformed request is the app's problem to report, not something to paper over
    }

    // The tool has already run when its result is in the history; anything else is the first pass
    const toolHasRun = messages.some((m) => m?.role === "tool");
    if (toolHasRun) {
      reply(res, {
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done." } }],
      });
      return;
    }

    const said = [...messages].reverse().find((m) => m?.role === "user");
    const text = typeof said?.content === "string"
      ? said.content
      : (said?.content ?? []).map((part) => part?.text ?? "").join(" ");
    const directive = /<<([\s\S]*?)>>/.exec(text ?? "");
    const call = JSON.parse(directive?.[1] ?? process.env.PM_STUB_TOOL_CALL ?? "{}");
    reply(res, {
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
  });
});

server.listen(PORT, LOOPBACK, () => console.log(`openrouter stub listening on ${PORT}`));
