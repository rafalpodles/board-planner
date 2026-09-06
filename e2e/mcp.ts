import { expect, type APIRequestContext, type Page } from "@playwright/test";
import crypto from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "./seed";

export const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  return {
    verifier,
    challenge: base64url(crypto.createHash("sha256").update(verifier).digest()),
  };
}

export type RedirectReceiver = {
  url: string;
  waitForRedirect: (ms?: number) => Promise<URLSearchParams>;
  close: () => Promise<void>;
};

export async function redirectReceiver(): Promise<RedirectReceiver> {
  let land!: (params: URLSearchParams) => void;
  const captured = new Promise<URLSearchParams>((resolve) => (land = resolve));

  const server = createServer((req, res) => {
    land(new URL(req.url ?? "/", "http://127.0.0.1").searchParams);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><p id="landed">the client has the authorization</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`,
    waitForRedirect: (ms = 30_000) =>
      Promise.race([
        captured,
        new Promise<URLSearchParams>((_, reject) =>
          setTimeout(
            () => reject(new Error("the client was never redirected back to its redirect_uri")),
            ms
          ).unref()
        ),
      ]),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type RpcMessage = {
  result?: Record<string, unknown>;
  error?: { message: string };
};

export function rpcMessage(body: string): RpcMessage {
  const trimmed = body.trim();
  const payload = trimmed.startsWith("{")
    ? trimmed
    : trimmed
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

export type ToolCall = {
  status: number;
  raw: RpcMessage;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parsed: any;
};

export class McpSession {
  private id = "";
  private nextId = 1;

  constructor(
    private readonly request: APIRequestContext,
    private readonly token: string
  ) {}

  private headers(): Record<string, string> {
    return {
      ...MCP_HEADERS,
      Authorization: `Bearer ${this.token}`,
      ...(this.id ? { "mcp-session-id": this.id } : {}),
    };
  }

  async call(method: string, params: Record<string, unknown> = {}) {
    const response = await this.request.post("/api/mcp", {
      headers: this.headers(),
      data: { jsonrpc: "2.0", id: this.nextId++, method, params },
    });
    const sessionId = response.headers()["mcp-session-id"];
    if (sessionId) this.id = sessionId;
    const text = await response.text();
    return { status: response.status(), body: rpcMessage(text), text, headers: response.headers() };
  }

  async notify(method: string) {
    await this.request.post("/api/mcp", {
      headers: this.headers(),
      data: { jsonrpc: "2.0", method, params: {} },
    });
  }

  async open() {
    const { status, body } = await this.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e-mcp-client", version: "0.0.0" },
    });
    expect(status, JSON.stringify(body)).toBe(200);
    await this.notify("notifications/initialized");
    return body;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
    const { status, body } = await this.call("tools/call", { name, arguments: args });
    const content = (body.result?.content ?? []) as { type: string; text: string }[];
    const text = content.map((part) => part.text ?? "").join("");
    return {
      status,
      raw: body,
      text,
      parsed: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : null,
    };
  }
}

export async function authorize(
  page: Page,
  request: APIRequestContext,
  options: { projects: "all" | string[] } = { projects: "all" }
): Promise<{ accessToken: string; refreshToken: string; code: string; redirectUri: string; clientId: string; verifier: string }> {
  const receiver = await redirectReceiver();
  try {
    const registration = await request.post("/oauth/register", {
      data: { client_name: "E2E MCP Client", redirect_uris: [receiver.url] },
    });
    expect(registration.status(), await registration.text()).toBe(201);
    const { client_id: clientId } = await registration.json();

    const { verifier, challenge } = pkce();
    const state = crypto.randomBytes(8).toString("hex");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: receiver.url,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
      state,
    });

    await page.goto(`/oauth/authorize?${query.toString()}`);
    await page.fill("#u", ADMIN_USERNAME);
    await page.fill("#p", ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "Grant access" })).toBeVisible();
    if (options.projects === "all") {
      await page.check('input[name="access"][value="all"]');
    } else {
      await page.check('input[name="access"][value="limited"]');
      await expect(page.locator('input[name="projects"]')).toHaveCount(2);
      for (const projectId of options.projects) {
        await page.check(`input[name="projects"][value="${projectId}"]`);
      }
    }
    await page.click('button[name="decision"][value="allow"]');

    const params = await receiver.waitForRedirect();
    expect(params.get("error"), params.toString()).toBeNull();
    expect(params.get("state")).toBe(state);
    const code = params.get("code") ?? "";
    expect(code).not.toBe("");

    const token = await request.post("/oauth/token", {
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: receiver.url,
        client_id: clientId,
        code_verifier: verifier,
      },
    });
    expect(token.status(), await token.text()).toBe(200);
    const issued = await token.json();
    expect(issued.token_type).toBe("Bearer");
    expect(issued.access_token).toMatch(/^cpat_/);

    return {
      accessToken: issued.access_token,
      refreshToken: issued.refresh_token,
      code,
      redirectUri: receiver.url,
      clientId,
      verifier,
    };
  } finally {
    await receiver.close();
  }
}
