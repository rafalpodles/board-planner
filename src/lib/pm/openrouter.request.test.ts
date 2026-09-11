import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chatCompletion } from "./openrouter";

/**
 * BP-568. What reaches the provider, read off the request body rather than off the arguments —
 * the breakpoints and the sticky key are added inside `chatCompletion`, so an assertion on what
 * the agent passed in cannot see either of them.
 */

const bodies: Record<string, unknown>[] = [];

function captureRequests() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    })
  );
}

const MESSAGES = [
  { role: "system", content: "the standing rules" },
  { role: "user", content: "the question" },
];

const send = (over: Record<string, unknown> = {}) =>
  chatCompletion({ model: "deepseek/deepseek-v4-flash-0731", messages: MESSAGES, tools: [], ...over });

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
  bodies.length = 0;
  captureRequests();
});
afterEach(() => {
  vi.unstubAllGlobals();
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
