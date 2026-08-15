import { describe, it, expect, vi, beforeEach } from "vitest";

const safeFetch = vi.fn();

vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));
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

function client() {
  return new McpClient("https://mcp.example.com/mcp");
}

beforeEach(() => {
  vi.clearAllMocks();
});

// BP-317: one event without a separator grew this buffer forever, so a hostile MCP server could
// hold the connection open and stream until the process died. No test file existed for this module.
describe("reading a streamed MCP response", () => {
  it("reads a well-formed event and returns its result", async () => {
    safeFetch.mockResolvedValue(
      sse([`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })}\n\n`])
    );

    await expect(client().listTools()).resolves.toEqual([]);
  });

  it("refuses a stream that never completes an event, rather than buffering it", async () => {
    // Well past the cap, and no separator anywhere in it
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

  // The cap must not bite on an ordinary payload — a tool result of a few hundred kilobytes is
  // large but real, and refusing it would be a worse bug than the one this closes
  it("still accepts an event that is big but finite", async () => {
    const big = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "x".repeat(500_000) }] } };
    safeFetch.mockResolvedValue(sse([`data: ${JSON.stringify(big)}\n\n`]));

    await expect(client().listTools()).resolves.toHaveLength(1);
  });
});
