import { createServer } from "node:http";

/**
 * A stand-in for OpenAI, so AI task generation runs end to end without a model, a network call or
 * a bill. `OPENAI_BASE_URL` points the real SDK here (`new OpenAI()` in src/lib/ai.ts reads it),
 * and everything downstream of the answer — the JSON parse, the category and dependency
 * sanitising, resolveGeneratedFields, the form the fields land in — is the production path.
 *
 * What the model "answers" travels in the prompt the test types, between << and >>, the same
 * convention openrouter-stub.mjs uses: each test scripts its own generation while still typing
 * into the real AI Assist box. A prompt with no directive gets OPENAI_STUB_TASK, and failing that
 * an answer that is not JSON at all — the error path, which a stub that always succeeds cannot
 * reach.
 *
 * GET /last-request returns what the app actually sent. A generation asserted only on its result
 * cannot tell a prompt built from this project's own fields from a hardcoded one.
 */

// Loopback only. Bound to every interface on a machine several agents share, `/last-request`
// hands anybody on the network the system prompt this app last sent a model — project name,
// README, and up to fifty open task titles.
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
      // A malformed request is the app's problem to report, not something to paper over
    }
    lastRequest = request;

    const messages = request.messages ?? [];
    const system = messages.find((m) => m?.role === "system")?.content ?? "";
    const said = messages.find((m) => m?.role === "user")?.content ?? "";
    const directive = /<<([\s\S]*?)>>/.exec(typeof said === "string" ? said : "");

    // Returned verbatim, including a body that is not JSON: src/lib/ai.ts parses this string, and
    // the route's 500 is a behaviour with its own assertion
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
