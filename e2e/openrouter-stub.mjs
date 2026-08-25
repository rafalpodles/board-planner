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
const MODELS = {
  data: [
    { id: "e2e/vision-model", architecture: { input_modalities: ["text", "image"] } },
    { id: "e2e/text-only-model", architecture: { input_modalities: ["text"] } },
  ],
};

// How many times each directive has been seen, so `failTimes` can stop failing
const seen = new Map();

function reply(res, body) {
  const payload = JSON.stringify(body);
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

const server = createServer((req, res) => {
  // `failTimes` counts attempts per directive, and this process outlives every test in the run —
  // including a Playwright retry, which would otherwise start at attempt 2 and never fail.
  if (req.url === "/reset") {
    seen.clear();
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
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
          choices: [
            { finish_reason: "stop", message: { role: "assistant", content: call.say ?? "Noted." } },
          ],
        });
        return;
      }
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
    };

    if (call.delayMs) setTimeout(answer, call.delayMs);
    else answer();
  });
});

server.listen(PORT, LOOPBACK, () => console.log(`openrouter stub listening on ${PORT}`));
