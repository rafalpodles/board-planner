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
