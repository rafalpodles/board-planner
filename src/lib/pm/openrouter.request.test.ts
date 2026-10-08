import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chatCompletion } from "./openrouter";

/**
 * BP-568. What reaches the provider, read off the request body rather than off the arguments —
 * the breakpoints and the sticky key are added inside `chatCompletion`, so an assertion on what
 * the agent passed in cannot see either of them.
 */

const bodies: Record<string, unknown>[] = [];
const authorizations: (string | undefined)[] = [];

function captureRequests() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      authorizations.push((init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    })
  );
}

const MESSAGES = [
  { role: "system", content: "the standing rules" },
  { role: "user", content: "the question" },
];

const send = (over: Record<string, unknown> = {}) =>
  chatCompletion({ model: "deepseek/deepseek-v4-flash-0731", apiKey: "test-key", messages: MESSAGES, tools: [], ...over });

beforeEach(() => {
  bodies.length = 0;
  authorizations.length = 0;
  captureRequests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the key the call is made with", () => {
  /**
   * BP-652. The key is the caller's: an organisation's own key, or the instance's for one that may
   * use it. The environment must not leak in underneath, or a Free organisation's call is billed
   * to the operator.
   */
  it("is the one passed in, whatever the environment holds", async () => {
    process.env.OPENROUTER_API_KEY = "the-operators-key";

    await send({ apiKey: "the-organisations-own-key" });

    expect(authorizations).toEqual(["Bearer the-organisations-own-key"]);
    delete process.env.OPENROUTER_API_KEY;
  });
});

describe("a refusal of the key", () => {
  // The answer lands in a thread every member of the project reads, and a provider may quote the key back
  it("does not carry the key into the error it reports", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid key sk-or-secret-0123456789" } }), { status: 401 }))
    );

    const result = await send({ apiKey: "sk-or-secret-0123456789" });

    expect(result).toMatchObject({ type: "error", error: expect.stringContaining("OpenRouter HTTP 401") });
    expect(JSON.stringify(result)).not.toContain("sk-or-secret-0123456789");
  });
});

describe("the other ways a provider's answer can quote the key", () => {
  const KEY = "sk-or-secret-0123456789";

  it("is not repeated from a 200 that carries an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: `bad ${KEY}` } }), { status: 200 })));

    expect(JSON.stringify(await send({ apiKey: KEY }))).not.toContain(KEY);
  });

  it("is not repeated from a failure to connect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error(`connect failed for ${KEY}`))));

    expect(JSON.stringify(await send({ apiKey: KEY }))).not.toContain(KEY);
  });
});

describe("the sticky-routing key on the wire", () => {
  it("is sent when the caller names a session", async () => {
    await send({ sessionId: "abc123" });

    expect(bodies[0].session_id).toBe("abc123");
  });

  /**
   * The control. OpenRouter treats `session_id` as the routing key outright, so an empty or
   * absent one must not become the string "undefined" and pin every conversation on the instance
   * to a single endpoint.
   */
  it("is left out entirely when there is none", async () => {
    await send();

    expect(bodies[0]).not.toHaveProperty("session_id");
  });
});

describe("breakpoints on the wire", () => {
  it("are absent for a provider that caches on its own, whose content stays a plain string", async () => {
    await send();

    expect(bodies[0].messages).toEqual(MESSAGES);
  });

  it("are present for a provider that caches only what is marked", async () => {
    await send({ model: "anthropic/claude-sonnet-4.6" });

    expect(bodies[0].messages).toMatchObject([
      { role: "system", content: [{ type: "text", cache_control: { type: "ephemeral" } }] },
      { role: "user", content: [{ type: "text", cache_control: { type: "ephemeral" } }] },
    ]);
  });

  /**
   * The checklist item, at the layer that decides it: two calls of one turn hand `chatCompletion`
   * a growing array and the same `cachePrefixLength`, and what goes on the wire in front of that
   * mark has to be the same bytes both times — a prefix that differs by one character is a cache
   * miss and is billed as a cold prompt.
   */
  it("put the same prefix bytes on the wire on the second call as on the first", async () => {
    // Built twice rather than spread from one array, so the two requests share no objects. That is
    // hygiene and not a guard: this comparison cannot catch an in-place `marked()` either way,
    // because a mutation marks each array at its own indices and the two serialised prefixes still
    // agree. `prompt-cache.test.ts` is what catches that — three of its cases redden on it, which
    // I checked by making the mutation rather than by reasoning about it (BP-568 review).
    const conversation = () => [
      { role: "system", content: "the standing rules" },
      { role: "user", content: "the question" },
    ];
    const first = conversation();
    const second = [
      ...conversation(),
      { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
      { role: "tool", content: "the tool's answer" },
    ];

    await send({ model: "anthropic/claude-sonnet-4.6", messages: first, cachePrefixLength: MESSAGES.length });
    await send({ model: "anthropic/claude-sonnet-4.6", messages: second, cachePrefixLength: MESSAGES.length });

    const prefixOf = (body: Record<string, unknown>) =>
      JSON.stringify((body.messages as unknown[]).slice(0, MESSAGES.length));

    expect(prefixOf(bodies[1])).toBe(prefixOf(bodies[0]));
    // The control: the second request really was the longer one, so the comparison had something
    // to be wrong about
    expect((bodies[1].messages as unknown[]).length).toBe(4);
  });

  // Tool definitions are cached as part of the prefix that precedes the breakpoint; marking the
  // array itself is not something any provider reads, and a stray field there is a request error
  it("never marks the tools array", async () => {
    await send({
      model: "anthropic/claude-sonnet-4.6",
      tools: [{ name: "change_status", description: "", parameters: {} }],
    });

    expect(JSON.stringify(bodies[0].tools)).not.toContain("cache_control");
  });
});

// BP-766. A published image is built once for every self-hoster; the referer names the instance
// the request came from, which only the runtime environment knows
describe("the referer the provider is told", () => {
  const referers: (string | null)[] = [];

  beforeEach(() => {
    referers.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        referers.push(new Headers(init.headers).get("HTTP-Referer"));
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      })
    );
  });
  afterEach(() => {
    delete process.env.PUBLIC_ORIGIN;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("is this instance's PUBLIC_ORIGIN, not NEXT_PUBLIC_APP_URL", async () => {
    process.env.PUBLIC_ORIGIN = "https://board.example.org";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    await send();

    expect(referers).toEqual(["https://board.example.org"]);
  });

  it("falls back to the product's own domain when the origin is not configured", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    await send();

    expect(referers).toEqual(["https://board-planner.com"]);
  });
});
