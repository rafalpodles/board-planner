import { readBody, serve } from "./stub-guard.mjs";

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
 *
 * The directive also scripts how the *provider* behaves, which is the only way to reach the
 * branches a real outage would:
 *
 *   name, arguments  the tool call to ask for. Without a name the stub answers in prose instead,
 *                    which is what an ordinary conversational turn looks like.
 *   say              the prose to answer with.
 *   status           answer with this HTTP status instead of a completion.
 *   failTimes        answer 500 for the first N requests carrying this directive, then behave.
 *                    Keyed by the directive text, so a Retry of the same message is the second.
 *   delayMs          hold the response, so a test can see the turn while it is still running.
 *
 * It also serves /models, which `modelAcceptsImages` reads before it accepts an attachment.
 * `e2e/vision-model` takes images and `e2e/text-only-model` does not; anything else is absent
 * from the list, which the app treats as unknown and lets through.
 */

// Loopback only, on a machine several agents share.
const LOOPBACK = "127.0.0.1";

const PORT = Number(process.env.PM_STUB_PORT ?? 3988);

// The models `modelAcceptsImages` will find. A model that is not here is unknown, not text-only.
// It is also the list the model pickers offer and a saved model is checked against (BP-1024): a model a spec saves
// has to be listed, and a name that is not is what a typo looks like.
const LISTED = [
  ["e2e/vision-model", "E2E: Vision"],
  ["e2e/instance-default", "E2E: Instance default"],
  ["e2e/governed-model", "E2E: Governed"],
  ["anthropic/e2e-stub-model", "E2E: Marking provider"],
  ["openai/gpt-6-luna", "OpenAI: GPT-6 Luna"],
  ["openai/gpt-4o", "OpenAI: GPT-4o"],
  ["openai/gpt-4o-mini", "OpenAI: GPT-4o Mini"],
  ["openai/gpt-4o-mini-2026", "OpenAI: GPT-4o Mini 2026"],
  ["openai/gpt-oss-120b", "OpenAI: gpt-oss-120b"],
  ["anthropic/claude-haiku", "Anthropic: Claude Haiku"],
  ["anthropic/claude-haiku-5.5", "Anthropic: Claude Haiku 5.5"],
  ["google/gemini-2.5-flash", "Google: Gemini 2.5 Flash"],
  ["mistralai/mistral-large", "Mistral: Large"],
  ["moonshotai/kimi-k2.6", "MoonshotAI: Kimi K2.6"],
];
const MODELS = {
  data: [
    ...LISTED.map(([id, name]) => ({ id, name, architecture: { input_modalities: ["text", "image"] } })),
    { id: "e2e/text-only-model", name: "E2E: Text only", architecture: { input_modalities: ["text"] } },
  ],
};

// How many times each directive has been seen, so `failTimes` can stop failing
const seen = new Map();

function reply(res, body) {
  const payload = JSON.stringify(body);
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

// The shape of the last completion request, for /last
let received = null;

// The Authorization header of the last completion request, for /last-authorization (BP-652): which
// key a call was made with is only visible on the wire
let lastAuthorization = null;

// AI Assist goes through OpenRouter too (src/lib/ai.ts), and what tells its request from the PM's is
// the JSON mode it asks for. What it sent, and the key it sent it with, are kept apart from the PM's:
// /last-assist-request and /last-assist-authorization
let lastAssistRequest = null;
let lastAssistAuthorization = null;

// The Pro AI features (BP-855) ask for prose with no tools and their material in a <data> block.
// The answer lists every "title" and "key" in that material, so a spec can see what reached the model,
// and the request is kept for /last-write
let lastWrite = null;

// Duplicate detection (BP-872) asks for JSON. The stub names every key a "stub-duplicate: KEY" line
// in the draft's description gives, whether or not it was a candidate, so a spec can check that only
// the shortlist's keys are kept.
function duplicatesAnswer(material) {
  const keys = material.draft.description.match(/^stub-duplicate: (.+)$/gm)?.map((l) => l.slice("stub-duplicate: ".length).trim()) ?? [];
  return JSON.stringify({ duplicates: keys.map((key) => ({ key, reason: "The stub was told to" })) });
}

function titlesIn(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => titlesIn(v, out));
  else if (value && typeof value === "object") {
    if (typeof value.title === "string") out.push(value.key ? `${value.title} (${value.key})` : value.title);
    Object.values(value).forEach((v) => titlesIn(v, out));
  }
  return out;
}

/**
 * One entry per completion request, for /requests (BP-568). What a turn's second call sends in
 * front of the cache breakpoint has to be the same bytes as its first, and no assertion on the
 * app's own objects can see that: the agent hands `chatCompletion` one array and mutates it, so
 * the arguments of call 1 and call 2 are the same object. These are the bodies as they arrived.
 */
let requests = [];

const isMarked = (m) =>
  Array.isArray(m?.content) && m.content.some((part) => part?.cache_control);

/**
 * A message's text whether its content is a plain string or an array of parts.
 *
 * The array branch is the guarded one, not the default: this runs OUTSIDE the body-parse try/catch,
 * and a throw here is answered 500 with a crash marker rather than a completion. `String()` never
 * threw on a number or a bare object, and this must not either — BP-575 is about exactly that kind
 * of throw in this handler.
 */
const textOf = (m) =>
  Array.isArray(m?.content)
    ? m.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ")
    : String(m?.content ?? "");

// The roles carrying a breakpoint, in order — a count alone cannot say WHERE the second one
// landed, which is the whole question about the prefix boundary
const markedRolesIn = (messages) => messages.filter(isMarked).map((m) => m?.role);

/**
 * Everything up to and including the last marked message — the run of bytes the app has told the
 * provider to cache. It is the app's OWN claim, and that is the point: a prefix the stub worked out
 * for itself from the shape of the conversation would agree across a turn's calls however the app
 * behaved, so a test on that could not fail.
 */
function markedPrefixOf(messages) {
  let last = -1;
  messages.forEach((m, i) => {
    if (isMarked(m)) last = i;
  });
  return last === -1 ? null : JSON.stringify(messages.slice(0, last + 1));
}

/**
 * What a provider that caches reports. The first call of a turn writes the prefix into the cache
 * and the rest read it back, which is the whole shape the ticket is about — a stub that always
 * reported the same numbers could not tell the two apart.
 */
const usageWith = (fromCache) => ({
  prompt_tokens: 1000,
  completion_tokens: 200,
  total_tokens: 1200,
  prompt_tokens_details: fromCache
    ? { cached_tokens: 900, cache_write_tokens: 0 }
    : { cached_tokens: 0, cache_write_tokens: 900 },
});

serve({
  name: "openrouter stub",
  port: PORT,
  host: LOOPBACK,
  handler: async (req, res) => {
    // `failTimes` counts attempts per directive, and this process outlives every test in the run —
    // including a Playwright retry, which would otherwise start at attempt 2 and never fail.
    if (req.url === "/reset") {
      seen.clear();
      received = null;
      lastAuthorization = null;
      lastAssistRequest = null;
      lastAssistAuthorization = null;
      lastWrite = null;
      requests = [];
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }

    // What the model was actually handed on the last turn. A turn carrying only an image has no text
    // to put a directive in, so this is the only way a test can assert the image was in the request
    // rather than merely that a turn ran (BP-451 review).
    if (req.url === "/last") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(received));
      return;
    }

    if (req.url === "/last-write") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(lastWrite ?? {}));
      return;
    }

    if (req.url === "/last-assist-request") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(lastAssistRequest ?? {}));
      return;
    }

    if (req.url === "/last-assist-authorization") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ authorization: lastAssistAuthorization }));
      return;
    }

    if (req.url === "/last-authorization") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ authorization: lastAuthorization }));
      return;
    }

    // Every completion request of the run, in order, so a test can compare one against the next
    if (req.url === "/requests") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(requests));
      return;
    }

    // Playwright waits on this before it starts the dev server
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }

    if (req.url?.endsWith("/models")) {
      reply(res, MODELS);
      return;
    }

    // Whether OpenRouter knows the key being saved: one that says "rejected" is refused, as a revoked one would be
    if (req.url?.endsWith("/key")) {
      if ((req.headers.authorization ?? "").includes("rejected")) {
        res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "No auth credentials found" } }));
        return;
      }
      reply(res, { data: { label: "e2e", limit: null } });
      return;
    }

    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }

    const raw = await readBody(req);

    // AI Assist: what the answer is travels in the prompt between << and >>, as for the PM below. A
    // prompt with no directive gets OPENAI_STUB_TASK, and failing that an answer that is not JSON at
    // all, which is the error path a stub that always succeeds cannot reach.
    let assist = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.response_format?.type === "json_object") assist = parsed;
    } catch {
      // Not JSON: the PM branch below reports it
    }
    if (assist) {
      lastAssistAuthorization = req.headers.authorization ?? null;
      lastAssistRequest = assist;
      const asked = assist.messages ?? [];
      const system = asked.find((m) => m?.role === "system")?.content ?? "";
      const said = asked.find((m) => m?.role === "user")?.content ?? "";
      const directive = /<<([\s\S]*?)>>/.exec(typeof said === "string" ? said : "");
      const content = directive?.[1] ?? process.env.OPENAI_STUB_TASK ?? "not json at all";
      reply(res, {
        id: "chatcmpl-e2e",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: assist.model ?? "stub",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
        usage: { prompt_tokens: system.length, completion_tokens: content.length, total_tokens: 0 },
      });
      return;
    }

    let writing = null;
    try {
      const parsed = JSON.parse(raw);
      const data = parsed?.messages?.[1]?.content;
      if (!parsed?.tools && typeof data === "string" && data.startsWith("<data>\n")) writing = parsed;
    } catch {
      // Not a write request; handled below
    }
    if (writing) {
      lastWrite = { model: writing.model, tools: writing.tools ?? null, messages: writing.messages };
      const material = JSON.parse(writing.messages[1].content.slice("<data>\n".length, -"\n</data>".length));
      const content = material.draft && material.candidates ? duplicatesAnswer(material) : ["## Written by the stub", ...titlesIn(material).map((t) => `- ${t}`)].join("\n");
      reply(res, {
        id: "chatcmpl-e2e-write",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: writing.model ?? "stub",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
        usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
      });
      return;
    }

    lastAuthorization = req.headers.authorization ?? null;
    let messages = [];
    let offeredTools = [];
    let provider = null;
    try {
      const body = JSON.parse(raw);
      messages = body.messages ?? [];
      provider = body.provider ?? null;
      const markedRoles = markedRolesIn(messages);
      requests.push({
        model: body.model ?? null,
        sessionId: body.session_id ?? null,
        messageCount: messages.length,
        cacheControls: markedRoles.length,
        markedRoles,
        markedPrefix: markedPrefixOf(messages),
        lastRole: messages[messages.length - 1]?.role ?? null,
      });
      // The names the model was OFFERED, which is the whole subject of BP-569 and is carried
      // beside the conversation rather than inside it — no assertion on messages can see it.
      offeredTools = (body.tools ?? []).map((t) => t?.function?.name).filter(Boolean);
    } catch {
      // A malformed request is the app's problem to report, not something to paper over
    }

    // An empty text *part* has to be as visible as an empty string content: reporting it as plain
    // "text" made the assertion written to catch the empty-block regression unfailable.
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
      offeredTools,
      provider,
      userBlocks: kindsOf(users[users.length - 1]),
      // Across the whole request, so a follow-up turn shows whether history replayed the picture
      images: messages.reduce(
        (n, m) => n + kindsOf(m).filter((k) => k === "image_url").length,
        0
      ),
      // The contents, not a count: a count cannot say whether a particular instruction was sent.
      // Since BP-321 the record of past board actions is NOT among these — it is a user-role DATA
      // message — which is exactly what pm-trust-boundary.spec.ts asserts.
      // textOf, not String(): since BP-568 a marked message carries an array of parts, and
      // stringifying that gives "[object Object]" — which would empty every assertion other specs
      // make about what the system prompt said
      systems: messages.filter((m) => m?.role === "system").map((m) => textOf(m).slice(0, 200)),
      roles: messages.map((m) => m?.role),
      // Every message, whole and untruncated, so a test can ask which CHANNEL a given string
      // arrived in rather than only whether it arrived. Text parts only; images are counted above.
      contents: messages.map((m) => ({ role: m?.role, text: textOf(m) })),
    };

    const toolHasRun = messages.some((m) => m?.role === "tool");

    const said = [...messages].reverse().find((m) => m?.role === "user");
    const text = typeof said?.content === "string"
      ? said.content
      : (said?.content ?? []).map((part) => part?.text ?? "").join(" ");
    // The one turn a test cannot script from the chat box: an autonomous review is prompted by
    // the server (buildNeedsHumanReviewPrompt), so there is nowhere to put a directive. The rule
    // is keyed on that prompt's own opening line and does the one thing the turn is allowed to.
    const escalated = /^Task (\S+) was just moved to "needs_human_review"/m.exec(text ?? "");
    if (escalated && !toolHasRun) {
      reply(res, {
        usage: usageWith(false),
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

    // A board review, scheduled or started by hand, is prompted by the server too. It asks for the
    // one thing the review is not allowed to do, so a spec can see the turn refuse it (BP-471).
    const reviewing = /^Scheduled board review for (\S+)\./m.exec(text ?? "");
    const flagged = /^- (\S+-\d+) \[/m.exec(text ?? "");
    if (reviewing && flagged && !toolHasRun) {
      // A task titled with this holds the review open, so a spec can ask for a second one meanwhile
      if (/\(hold the review\)/.test(text)) await new Promise((resolve) => setTimeout(resolve, 15_000));
      reply(res, {
        usage: usageWith(false),
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
                    name: "change_status",
                    arguments: JSON.stringify({ taskKey: flagged[1], status: "done" }),
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
    // NOT `raw`: the request body is already called that in this block, and a `const` shadowing
    // it puts the JSON.parse above into the temporal dead zone — swallowed by its own catch, so
    // every directive silently became {} and every turn answered with the fallback.
    const script = directive?.[1] ?? process.env.PM_STUB_TOOL_CALL ?? "{}";
    const call = JSON.parse(script);

    const attempts = (seen.get(script) ?? 0) + 1;
    seen.set(script, attempts);

    const failing = call.status || (call.failTimes && attempts <= call.failTimes ? 500 : 0);
    const answer = () => {
      // The tool has already run when its result is in the history; anything else is the first
      // pass. Delaying *this* answer is what holds the turn open while its action chips show.
      if (toolHasRun) {
        reply(res, {
          // The turn's later calls read back the prefix its first call wrote (BP-568)
          usage: usageWith(true),
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
          usage: usageWith(false),
          choices: [
            { finish_reason: "stop", message: { role: "assistant", content: call.say ?? "Noted." } },
          ],
        });
        return;
      }
      reply(res, {
        // A real provider reports what the call cost on every answer; BP-284 reads it
        usage: usageWith(false),
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

    if (call.delayMs) await new Promise((resolve) => setTimeout(resolve, call.delayMs));
    answer();
  },
});
