import { describe, it, expect, vi, beforeEach } from "vitest";

const safeFetch = vi.fn();

vi.mock("@/lib/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safe-fetch")>()),
  safeFetch,
}));
vi.mock("@/lib/url-validation", () => ({ isAllowedMcpServerUrl: () => true }));

const { McpClient } = await import("./mcp-client");

function sse(chunks: string[], onCancel?: () => void): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) return controller.close();
      controller.enqueue(encoder.encode(chunks[index++]));
    },
    cancel: onCancel,
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function json(chunks: string[]) {
  const encoder = new TextEncoder();
  const pulled = { count: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.count >= chunks.length) return controller.close();
      controller.enqueue(encoder.encode(chunks[pulled.count++]));
    },
  });
  return {
    pulled,
    response: new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  };
}

function client() {
  return new McpClient("https://mcp.example.com/mcp");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reading a streamed MCP response", () => {
  it("reads a well-formed event and returns its result", async () => {
    safeFetch.mockResolvedValue(
      sse([`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })}\n\n`])
    );

    await expect(client().listTools()).resolves.toEqual([]);
  });

  it("refuses a stream that never completes an event, rather than buffering it", async () => {
    const filler = "data: " + "x".repeat(1024 * 1024);
    safeFetch.mockResolvedValue(sse([filler, filler, filler, filler, filler]));

    await expect(client().listTools()).rejects.toThrow(/exceeded .* bytes/);
  });

  it("cancels the stream it gave up on", async () => {
    const cancelled = vi.fn();
    const filler = "data: " + "x".repeat(1024 * 1024);
    safeFetch.mockResolvedValue(sse([filler, filler, filler, filler, filler], cancelled));

    await client()
      .listTools()
      .catch(() => {});

    expect(cancelled).toHaveBeenCalled();
  });

  it("still accepts an event that is big but finite", async () => {
    const big = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "x".repeat(500_000) }] } };
    safeFetch.mockResolvedValue(sse([`data: ${JSON.stringify(big)}\n\n`]));

    await expect(client().listTools()).resolves.toHaveLength(1);
  });
});

describe("reading a non-streamed MCP response", () => {
  it("reads an ordinary JSON result", async () => {
    safeFetch.mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(client().listTools()).resolves.toEqual([]);
  });

  it("does not buffer a body the server never finishes", async () => {
    const { pulled, response } = json(Array.from({ length: 10_000 }, () => "x".repeat(1024)));
    safeFetch.mockResolvedValue(response);

    await expect(client().listTools()).rejects.toThrow();
    expect(pulled.count).toBeLessThanOrEqual(4097);
    expect(pulled.count).toBeLessThan(10_000);
  });
});
