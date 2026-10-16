import { describe, it, expect, vi, afterEach } from "vitest";
import { chatCompletion, type OrStreamDelta } from "./openrouter";

const encoder = new TextEncoder();

const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const text = (content: string) => data({ choices: [{ delta: { content } }] });
const finish = (reason = "stop") => data({ choices: [{ delta: {}, finish_reason: reason }] });
const usage = data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

type Body = (signal?: AbortSignal | null) => ReadableStream;

function streamOf(pieces: string[], { endsOpen = false }: { endsOpen?: boolean } = {}): Body {
  return (signal) =>
    new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        if (!endsOpen) controller.close();
        signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    });
}

function heldBody() {
  let controller!: ReadableStreamDefaultController;
  const body: Body = (signal) =>
    new ReadableStream({
      start(c) {
        controller = c;
        signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
      },
    });
  return { body, push: (piece: string) => controller.enqueue(encoder.encode(piece)), close: () => controller.close() };
}

function respondWith(body: Body) {
  const fetchMock = vi.fn(
    async (_url: string, init: RequestInit) =>
      new Response(body(init.signal), { status: 200, headers: { "Content-Type": "text/event-stream" } })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const ask = (over: Record<string, unknown> = {}) => {
  const deltas: OrStreamDelta[] = [];
  const result = chatCompletion({
    model: "m",
    apiKey: "key",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    onDelta: (d) => deltas.push(d),
    ...over,
  });
  return { result, deltas };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a streamed completion", () => {
  it("asks the provider to stream, with usage", async () => {
    const fetchMock = respondWith(streamOf([text("ok"), finish(), "data: [DONE]\n\n"]));
    await ask().result;

    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("does not stream when nobody listens", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })));
    vi.stubGlobal("fetch", fetchMock);
    await chatCompletion({ model: "m", apiKey: "key", messages: [], tools: [] });

    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).not.toHaveProperty("stream");
  });

  it("reports each piece of text as it arrives and returns the whole", async () => {
    respondWith(streamOf([text("Hel"), text("lo"), finish(), usage, "data: [DONE]\n\n"]));
    const { result, deltas } = ask();

    expect(await result).toEqual({
      type: "text",
      content: "Hello",
      usage: expect.objectContaining({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
    });
    expect(deltas).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
    ]);
  });

  it("reads an event split across network chunks", async () => {
    const whole = text("split");
    respondWith(streamOf([whole.slice(0, 9), whole.slice(9, 20), whole.slice(20), finish(), "data: [DONE]\n\n"]));

    expect(await ask().result).toMatchObject({ type: "text", content: "split" });
  });

  it("assembles a tool call whose arguments arrive in pieces, and names it as soon as it is known", async () => {
    respondWith(
      streamOf([
        text("Creating it. "),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "create_task", arguments: "" } }] } }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"title":"A' } }] } }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' task"}' } }] } }] }),
        finish("tool_calls"),
        "data: [DONE]\n\n",
      ])
    );
    const { result, deltas } = ask();
    const completion = await result;

    expect(completion).toMatchObject({
      type: "tool_calls",
      content: "Creating it. ",
      calls: [{ id: "call_9", name: "create_task", args: { title: "A task" } }],
      assistantMessage: {
        role: "assistant",
        tool_calls: [{ id: "call_9", type: "function", function: { name: "create_task", arguments: '{"title":"A task"}' } }],
      },
    });
    expect(deltas).toEqual([
      { type: "text", text: "Creating it. " },
      { type: "tool", name: "create_task" },
    ]);
  });

  it("keeps two parallel tool calls apart by index", async () => {
    respondWith(
      streamOf([
        data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "get_task", arguments: '{"taskKey":' } }] } }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "list_tasks", arguments: "{}" } }] } }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"BP-1"}' } }] } }] }),
        finish("tool_calls"),
        "data: [DONE]\n\n",
      ])
    );

    expect(await ask().result).toMatchObject({
      calls: [
        { id: "a", name: "get_task", args: { taskKey: "BP-1" } },
        { id: "b", name: "list_tasks", args: {} },
      ],
    });
  });

  it("flags arguments that are not JSON instead of throwing", async () => {
    respondWith(
      streamOf([
        data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "get_task", arguments: '{"taskKey":' } }] } }] }),
        finish("tool_calls"),
        "data: [DONE]\n\n",
      ])
    );

    expect(await ask().result).toMatchObject({ calls: [{ name: "get_task", args: null, parseError: expect.stringMatching(/not valid JSON/) }] });
  });

  it("ignores the provider's keep-alive comments", async () => {
    respondWith(streamOf([": OPENROUTER PROCESSING\n\n", text("ok"), ": OPENROUTER PROCESSING\n\n", finish(), "data: [DONE]\n\n"]));

    expect(await ask().result).toMatchObject({ type: "text", content: "ok" });
  });
});

describe("a stream as providers really send it", () => {
  it("reads CRLF separators", async () => {
    respondWith(streamOf([text("a").replaceAll("\n", "\r\n"), text("b").replaceAll("\n", "\r\n"), finish().replaceAll("\n", "\r\n"), "data: [DONE]\r\n\r\n"]));

    expect(await ask().result).toMatchObject({ type: "text", content: "ab" });
  });

  it("keeps a character that arrives in two network chunks whole", async () => {
    const bytes = encoder.encode(text("zażółć"));
    const cut = bytes.indexOf(0xc5) + 1;
    respondWith(() => new ReadableStream({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.enqueue(encoder.encode(finish() + "data: [DONE]\n\n"));
        c.close();
      },
    }));

    expect(await ask().result).toMatchObject({ content: "zażółć" });
  });

  it("reads the last event when the stream ends without a blank line after it", async () => {
    respondWith(streamOf([text("ok"), finish().trimEnd(), ]));

    expect(await ask().result).toMatchObject({ type: "text", content: "ok" });
  });

  it("counts the usage that comes in an unterminated last event", async () => {
    respondWith(streamOf([text("ok"), finish(), usage.trimEnd()]));

    expect(await ask().result).toMatchObject({ usage: expect.objectContaining({ totalTokens: 15 }) });
  });

  it("hands the provider's reasoning back with the tool calls it belongs to", async () => {
    respondWith(
      streamOf([
        data({ choices: [{ delta: { reasoning: "I should ", reasoning_details: [{ type: "reasoning.encrypted", data: "sig-1" }] } }] }),
        data({ choices: [{ delta: { reasoning: "look.", reasoning_details: [{ type: "reasoning.text", text: "x" }] } }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "list_tasks", arguments: "{}" } }] } }] }),
        finish("tool_calls"),
        "data: [DONE]\n\n",
      ])
    );

    expect(await ask().result).toMatchObject({
      assistantMessage: {
        reasoning: "I should look.",
        reasoning_details: [{ type: "reasoning.encrypted", data: "sig-1" }, { type: "reasoning.text", text: "x" }],
      },
    });
  });

  it("separates two parallel calls from a provider that sends no index", async () => {
    respondWith(
      streamOf([
        data({ choices: [{ delta: { tool_calls: [{ id: "a", function: { name: "get_task", arguments: '{"taskKey":"BP-1"}' } }] } }] }),
        data({ choices: [{ delta: { tool_calls: [{ id: "b", function: { name: "list_tasks", arguments: "{}" } }] } }] }),
        finish("tool_calls"),
        "data: [DONE]\n\n",
      ])
    );

    expect(await ask().result).toMatchObject({
      calls: [
        { id: "a", name: "get_task", args: { taskKey: "BP-1" } },
        { id: "b", name: "list_tasks", args: {} },
      ],
    });
  });

  it("does not double a tool's name that the provider repeats on every fragment", async () => {
    respondWith(
      streamOf([
        data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "get_task", arguments: '{"taskKey":' } }] } }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "get_task", arguments: '"BP-1"}' } }] } }] }),
        finish("tool_calls"),
        "data: [DONE]\n\n",
      ])
    );
    const { result, deltas } = ask();

    expect(await result).toMatchObject({ calls: [{ name: "get_task", args: { taskKey: "BP-1" } }] });
    expect(deltas).toEqual([{ type: "tool", name: "get_task" }]);
  });

  it("echoes a call that took no arguments as an empty object, not an empty string", async () => {
    respondWith(
      streamOf([
        data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "list_tasks" } }] } }] }),
        finish("tool_calls"),
        "data: [DONE]\n\n",
      ])
    );

    expect(await ask().result).toMatchObject({
      calls: [{ name: "list_tasks", args: {} }],
      assistantMessage: { tool_calls: [{ function: { arguments: "{}" } }] },
    });
  });

  it("takes an answer sent as plain JSON from a provider that ignored the request to stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "whole" } }] }), { headers: { "Content-Type": "application/json" } }))
    );
    const { result, deltas } = ask();

    expect(await result).toMatchObject({ type: "text", content: "whole" });
    expect(deltas).toEqual([{ type: "text", text: "whole" }]);
  });
});

describe("a stream that does not finish", () => {
  it("ends as an error that says the request was sent, when the connection closes before a finish", async () => {
    respondWith(streamOf([text("Half an ans")]));
    const { result, deltas } = ask();

    expect(await result).toEqual({ type: "error", error: expect.stringMatching(/cut off/), sent: true });
    expect(deltas).toEqual([{ type: "text", text: "Half an ans" }]);
  });

  it("never returns a half-read tool call for the agent to run", async () => {
    respondWith(
      streamOf([
        data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "create_task", arguments: '{"title":"A' } }] } }] }),
      ])
    );

    expect(await ask().result).toMatchObject({ type: "error", sent: true });
  });

  it("ends as an error when the provider reports one mid-answer", async () => {
    respondWith(streamOf([text("Some"), data({ error: { message: "upstream exploded" } })]));

    expect(await ask().result).toEqual({ type: "error", error: "OpenRouter error: upstream exploded", sent: true });
  });

  it("does not echo the key a provider quotes back", async () => {
    respondWith(streamOf([data({ error: { message: "bad key sk-secret" } })]));

    expect(await ask({ apiKey: "sk-secret" }).result).toMatchObject({ error: "OpenRouter error: bad key [key]" });
  });

  it("gives up on a stream that goes silent", async () => {
    vi.useFakeTimers();
    respondWith(streamOf([text("start")], { endsOpen: true }));
    const { result } = ask({ idleMs: 5_000 });

    await vi.advanceTimersByTimeAsync(5_001);

    expect(await result).toEqual({ type: "error", error: expect.stringMatching(/stopped responding/), sent: true });
  });

  it("does not time out a stream that keeps talking, whether it sends text or only keep-alives", async () => {
    vi.useFakeTimers();
    const held = heldBody();
    respondWith(held.body);
    const { result } = ask({ idleMs: 5_000 });

    for (const piece of [text("a"), ": OPENROUTER PROCESSING\n\n", text("b"), ": OPENROUTER PROCESSING\n\n"]) {
      await vi.advanceTimersByTimeAsync(4_000);
      held.push(piece);
    }
    held.push(finish() + "data: [DONE]\n\n");
    held.close();

    expect(await result).toMatchObject({ type: "text", content: "ab" });
  });

  it("gives up after a minute of silence when the caller names no limit", async () => {
    vi.useFakeTimers();
    respondWith(streamOf([text("start")], { endsOpen: true }));
    const { result } = ask();

    await vi.advanceTimersByTimeAsync(59_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await result).toMatchObject({ type: "error", error: expect.stringMatching(/stopped responding.*60 s/), sent: true });
  });

  it("is a stop, not an error, when the caller aborts", async () => {
    const stop = new AbortController();
    respondWith(streamOf([text("start")], { endsOpen: true }));
    const { result } = ask({ signal: stop.signal });

    await Promise.resolve();
    stop.abort();

    expect(await result).toEqual({ type: "aborted" });
  });
});
