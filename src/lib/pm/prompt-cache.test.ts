import { describe, it, expect } from "vitest";
import { needsCacheBreakpoints, withCacheBreakpoints, pmSessionId } from "./prompt-cache";

/**
 * BP-568. Which providers are sent `cache_control` is the whole decision here, and it is one no
 * downstream test can see: everything below `chatCompletion` mocks it, and the e2e stub answers
 * whatever it is asked. Getting the list wrong is silent in both directions — a missed family
 * pays for the same prefix fifteen times, and a family that cannot read the marking is handed a
 * request whose `content` was rewritten from a string into an array of parts for nothing.
 */

const PREFIX = [
  { role: "system", content: "the standing rules" },
  { role: "user", content: "older turn" },
  { role: "assistant", content: "older answer" },
  { role: "user", content: "what this turn asks" },
];

// What the loop appends as the turn runs. Never part of the stable prefix.
const GROWTH = [
  { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
  { role: "tool", content: "the tool's answer" },
];

const cacheControlsIn = (messages: Record<string, unknown>[]) =>
  messages.map((m) =>
    Array.isArray(m.content)
      ? (m.content as Record<string, unknown>[]).filter((part) => part.cache_control).length
      : 0
  );

describe("which providers get breakpoints", () => {
  it.each(["anthropic/claude-sonnet-4.6", "qwen/qwen3-max", "google/gemini-2.5-pro"])(
    "%s caches only what is marked, so it is marked",
    (model) => {
      expect(needsCacheBreakpoints(model)).toBe(true);
    }
  );

  /**
   * The control, and the half that matters more: these cache on their own. The instance runs the
   * DeepSeek one, so a list that swept it in would rewrite every production request for a provider
   * that was already caching.
   */
  it.each([
    "deepseek/deepseek-v4-flash-0731",
    "moonshotai/kimi-k2.6",
    "openai/gpt-5.6",
    "x-ai/grok-4",
    "z-ai/glm-5",
  ])("%s caches automatically, so nothing is added to its request", (model) => {
    expect(needsCacheBreakpoints(model)).toBe(false);
  });
});

describe("where the breakpoints land", () => {
  it("leaves an automatic-caching provider's messages exactly as they were", () => {
    const messages = [...PREFIX, ...GROWTH];

    const sent = withCacheBreakpoints("deepseek/deepseek-v4-flash-0731", messages, PREFIX.length);

    expect(sent).toBe(messages);
    // Not just identical by reference: a string content must still be a string on the wire
    expect(typeof sent[0].content).toBe("string");
  });

  it("marks the system prompt and the end of the stable prefix, and nothing the turn grew", () => {
    const sent = withCacheBreakpoints("anthropic/claude-sonnet-4.6", [...PREFIX, ...GROWTH], PREFIX.length);

    expect(cacheControlsIn(sent)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  /**
   * The second breakpoint is the one with the money in it — the replayed history is most of the
   * prefix — and it is placed by an index, which is the kind of thing that is off by one. Marking
   * the growth instead would cache a prefix that changes on every call, which is worse than not
   * caching: every call would pay a cache write.
   */
  it("does not follow the conversation as the turn grows", () => {
    const grown = [...PREFIX, ...GROWTH, { role: "assistant", content: "and again" }];

    const sent = withCacheBreakpoints("anthropic/claude-sonnet-4.6", grown, PREFIX.length);

    expect(cacheControlsIn(sent)).toEqual([1, 0, 0, 1, 0, 0, 0]);
  });

  it("marks the last part of a multi-part message, not the picture in front of it", () => {
    const withImage = [
      { role: "system", content: "rules" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          { type: "text", text: "what is this" },
        ],
      },
    ];

    const sent = withCacheBreakpoints("anthropic/claude-sonnet-4.6", withImage, withImage.length);
    const parts = sent[1].content as Record<string, unknown>[];

    expect(parts[0].cache_control).toBeUndefined();
    expect(parts[1]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
  });

  // An empty block is not cacheable, and wrapping it would send `[{ type: "text", text: "" }]` —
  // which some providers refuse outright
  it("leaves an empty message alone rather than wrapping it in an empty text part", () => {
    const sent = withCacheBreakpoints("anthropic/claude-sonnet-4.6", [{ role: "system", content: "   " }], 1);

    expect(sent[0].content).toBe("   ");
  });

  it("does not mark the system prompt twice when it is the whole prefix", () => {
    const sent = withCacheBreakpoints("anthropic/claude-sonnet-4.6", [{ role: "system", content: "rules" }], 1);

    expect(cacheControlsIn(sent)).toEqual([1]);
  });

  // The caller's own bookkeeping must not be able to point past the end of the array
  it("survives a prefix longer than the conversation", () => {
    const sent = withCacheBreakpoints("anthropic/claude-sonnet-4.6", PREFIX, 99);

    expect(cacheControlsIn(sent)).toEqual([1, 0, 0, 1]);
  });

  it("does not mutate the messages it was given", () => {
    const messages = [{ role: "system", content: "rules" }];

    withCacheBreakpoints("anthropic/claude-sonnet-4.6", messages, 1);

    expect(messages[0].content).toBe("rules");
  });
});

describe("the sticky-routing key", () => {
  it("is the same for the same conversation, so the endpoint stays warm across the turn", () => {
    expect(pmSessionId("p1", "u1")).toBe(pmSessionId("p1", "u1"));
  });

  /**
   * A thread is per project AND per reader, so two readers of one board are two conversations with
   * two prefixes. One key for both would keep sending them to an endpoint holding the other's
   * cache.
   */
  it("separates readers, and boards", () => {
    expect(pmSessionId("p1", "u1")).not.toBe(pmSessionId("p1", "u2"));
    expect(pmSessionId("p1", "u1")).not.toBe(pmSessionId("p2", "u1"));
  });

  // OpenRouter caps the key at 256 characters, and the ids themselves are not what it needs
  it("is opaque and short", () => {
    const key = pmSessionId("69a52e3b399b27d3cbb2c5a5", "69a52b0b903d41d473ae02f6");

    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain("69a52e3b399b27d3cbb2c5a5");
  });
});
