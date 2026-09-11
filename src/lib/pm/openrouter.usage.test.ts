import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chatCompletion } from "./openrouter";

/**
 * BP-284. The provider reports what each round-trip cost and the client threw it away. Everything
 * downstream mocks `chatCompletion`, so nothing exercised this parsing — removing it from the text
 * arm left the whole PM suite green, which is why this file exists at all.
 */
const call = () => chatCompletion({ model: "m", messages: [], tools: [] });

function respondWith(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  );
}

const TEXT = { choices: [{ message: { content: "hello" } }] };
const TOOLS = {
  choices: [
    { message: { content: "", tool_calls: [{ id: "c1", function: { name: "t", arguments: "{}" } }] } },
  ],
};
const USAGE = { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 };

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what chatCompletion reports about the call's cost", () => {
  it("carries usage back from a text answer", async () => {
    respondWith({ ...TEXT, usage: USAGE });

    const result = await call();

    expect(result).toMatchObject({
      type: "text",
      usage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 },
    });
  });

  // The arm a working turn spends most of its calls on
  it("carries it back from a tool-call answer too", async () => {
    respondWith({ ...TOOLS, usage: USAGE });

    expect(await call()).toMatchObject({ type: "tool_calls", usage: { totalTokens: 1500 } });
  });

  /**
   * Absent is not zero. A provider that reports nothing must leave the number unknown, so the
   * day's total does not quietly read as free — the calls are still counted upstream.
   */
  it("reports no usage rather than zero when the response carries none", async () => {
    respondWith(TEXT);

    const result = await call();

    expect(result.type).toBe("text");
    expect("usage" in result ? result.usage : "missing").toBeUndefined();
  });

  it("adds the two halves when the provider omits the total", async () => {
    respondWith({ ...TEXT, usage: { prompt_tokens: 40, completion_tokens: 2 } });

    expect(await call()).toMatchObject({ usage: { totalTokens: 42 } });
  });

  // The control: a malformed usage block must not become NaN in a number the operator reads
  it("ignores a usage block that carries no numbers at all", async () => {
    respondWith({ ...TEXT, usage: { prompt_tokens: "lots" } });

    const result = await call();

    expect("usage" in result ? result.usage : "missing").toBeUndefined();
  });
});

/**
 * BP-568. The same block carries what the provider served from its cache, in
 * `prompt_tokens_details`, and this client dropped it — so Settings reported every token as a cold
 * prompt and the number an operator sets a budget from could not tell a cache hit from a miss.
 */
describe("what it reports about the cache", () => {
  it("carries the cache read and write counts back", async () => {
    respondWith({
      ...TEXT,
      usage: { ...USAGE, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 200 } },
    });

    expect(await call()).toMatchObject({
      usage: { promptTokens: 1200, cachedPromptTokens: 1000, cacheWriteTokens: 200 },
    });
  });

  /**
   * A subset, never an addition. If the cache read were added to the prompt count the day's total
   * would jump the moment caching started working, and the operator would read a saving as a
   * fifty-percent overspend.
   */
  it("leaves the prompt total alone — a cached token was already counted once", async () => {
    respondWith({
      ...TEXT,
      usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1100 } },
    });

    expect(await call()).toMatchObject({ usage: { promptTokens: 1200, totalTokens: 1500 } });
  });

  // The degradation the ticket is about: a provider that caches nothing, or reports nothing about
  // it, still produces a correct turn — with zeros, not with NaN and not with a missing field
  it("reads a provider that says nothing about caching as nothing cached", async () => {
    respondWith({ ...TEXT, usage: USAGE });

    expect(await call()).toMatchObject({ usage: { cachedPromptTokens: 0, cacheWriteTokens: 0 } });
  });

  /**
   * The two guards meet here. `usageOf` returns `undefined` when no token count parses, and the
   * cache figures ride on that object — so a block carrying detail but no countable tokens reports
   * nothing at all rather than a cache read against an unknown total. Untested until now, and the
   * arm where the two rules could have disagreed (BP-568 review).
   */
  it("reports nothing when the only parseable numbers are the cache ones", async () => {
    respondWith({
      ...TEXT,
      usage: { prompt_tokens: "lots", prompt_tokens_details: { cached_tokens: 900 } },
    });

    const result = await call();

    expect("usage" in result ? result.usage : "missing").toBeUndefined();
  });

  it("does not let a non-numeric or negative count through", async () => {
    respondWith({
      ...TEXT,
      usage: { ...USAGE, prompt_tokens_details: { cached_tokens: "some", cache_write_tokens: -5 } },
    });

    expect(await call()).toMatchObject({ usage: { cachedPromptTokens: 0, cacheWriteTokens: 0 } });
  });
});
