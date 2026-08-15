import { safeFetch } from "@/lib/safe-fetch";

// Mirrors the carve-out isAllowedMcpServerUrl makes for local MCP servers outside production
const MCP_DESTINATION = { allowLoopback: process.env.NODE_ENV !== "production" };

const PROTOCOL_VERSION = "2025-03-26";
const DISCOVERY_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_TOOLS_PER_SERVER = 200;

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown };
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRpcMessage = { jsonrpc: "2.0"; id?: number; result?: any; error?: { code: number; message: string } };

export class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(private url: string, private token?: string) {}

  async initialize(): Promise<void> {
    await this.rpc(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "boardplanner-pm", version: "1.0" },
      },
      DISCOVERY_TIMEOUT_MS
    );
    await this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.rpc(
        "tools/list",
        cursor ? { cursor } : {},
        DISCOVERY_TIMEOUT_MS
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      )) as any;
      for (const tool of result?.tools ?? []) {
        if (tool && typeof tool.name === "string") tools.push(tool);
      }
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    } while (cursor && tools.length < MAX_TOOLS_PER_SERVER);
    return tools.slice(0, MAX_TOOLS_PER_SERVER);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.rpc(
      "tools/call",
      { name, arguments: args },
      CALL_TIMEOUT_MS
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any;
    const parts: string[] = [];
    for (const item of result?.content ?? []) {
      if (item?.type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      } else if (item?.type) {
        parts.push(`[unsupported content type: ${item.type}]`);
      }
    }
    return { text: parts.join("\n"), isError: result?.isError === true };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  private async rpc(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await safeFetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      }, MCP_DESTINATION);
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (!res.ok) {
        throw new Error(`MCP server responded ${res.status}`);
      }
      const contentType = res.headers.get("content-type") || "";
      const message = contentType.includes("text/event-stream")
        ? await readSseResponse(res, id)
        : ((await res.json()) as JsonRpcMessage);
      if (message?.error) {
        throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
      }
      return message?.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async notify(method: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    try {
      await safeFetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", method }),
        signal: controller.signal,
      }, MCP_DESTINATION);
    } catch {
      // Notifications are best-effort; some servers reject them entirely.
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * One event without a separator grows this buffer forever, so a hostile MCP server could hold the
 * connection open and stream until the process died. The cap is far above any real tool result
 * (BP-317).
 */
const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;

async function readSseResponse(res: Response, id: number): Promise<JsonRpcMessage> {
  if (!res.body) throw new Error("Empty SSE response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER_BYTES) {
        throw new Error(
          `SSE response exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a complete event`
        );
      }
      let sep;
      while ((sep = buffer.match(/\r?\n\r?\n/))) {
        const rawEvent = buffer.slice(0, sep.index);
        buffer = buffer.slice((sep.index ?? 0) + sep[0].length);
        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data) continue;
        try {
          const message = JSON.parse(data) as JsonRpcMessage;
          if (message && message.id === id) return message;
        } catch {
          // Ignore non-JSON events
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new Error("SSE stream ended without a response");
}
