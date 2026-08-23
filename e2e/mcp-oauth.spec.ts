import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import crypto from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  HELD_TASK_TITLE,
  PROJECT_ID,
  PROJECT_KEY,
  SECOND_PROJECT_KEY,
  seed,
  seedSecondProject,
} from "./seed";

/**
 * BP-396 — the MCP handshake an editor performs against this instance, driven the way a client
 * performs it rather than the way it is easiest to assert: the 401 first, the discovery documents
 * that 401 points at, dynamic registration, the consent screen in a real browser, the code
 * exchanged with PKCE, and finally tools called over the credential that came out of it.
 *
 * Nothing is stubbed. This instance is its own authorization server, and the MCP tools call its
 * own API back over the same token (`PlannerClient(baseUrl, auth.token)`), so the scope granted on
 * the consent screen is still load-bearing three hops later — which is what the second project
 * exists to prove.
 */

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  return {
    verifier,
    challenge: base64url(crypto.createHash("sha256").update(verifier).digest()),
  };
}

/**
 * A real OAuth client's redirect endpoint. The consent page hands the code over by navigating the
 * browser there itself (BP-383), so something has to be listening: a dead port would leave the
 * test reading a code out of a Chrome error page, which is not what a client does.
 */
async function redirectReceiver(): Promise<{
  url: string;
  captured: Promise<URLSearchParams>;
  close: () => Promise<void>;
}> {
  let land!: (params: URLSearchParams) => void;
  let giveUp!: (reason: Error) => void;
  const captured = new Promise<URLSearchParams>((resolve, reject) => {
    land = resolve;
    giveUp = reject;
  });
  // A flow that never redirects — a consent screen that re-renders with an error, say — would
  // otherwise hang here until the test's own 3-minute timeout, which says nothing about where it
  // stopped
  const abandon = setTimeout(
    () => giveUp(new Error("the client was never redirected back to its redirect_uri")),
    30_000
  );
  captured.catch(() => {}).finally(() => clearTimeout(abandon));

  const server = createServer((req, res) => {
    land(new URL(req.url ?? "/", "http://127.0.0.1").searchParams);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><p id="landed">the client has the authorization</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The transport answers JSON or an SSE frame depending on the call; both carry one JSON-RPC message. */
function rpcMessage(body: string): { result?: Record<string, unknown>; error?: { message: string } } {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  return JSON.parse(data);
}

class McpSession {
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
    return { status: response.status(), body: rpcMessage(await response.text()) };
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

  /** Tool results arrive as text content; every planner tool puts JSON in it. */
  async callTool(name: string, args: Record<string, unknown> = {}) {
    const { body } = await this.call("tools/call", { name, arguments: args });
    const content = (body.result?.content ?? []) as { type: string; text: string }[];
    const text = content.map((part) => part.text ?? "").join("");
    return { raw: body, text, parsed: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : null };
  }
}

/** Registration, consent and the code exchange — the flow a client walks once, per test that needs a token. */
async function authorize(
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
      for (const projectId of options.projects) {
        await page.check(`input[name="projects"][value="${projectId}"]`);
      }
    }
    await page.click('button[name="decision"][value="allow"]');

    const params = await receiver.captured;
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

test.beforeEach(async () => {
  await seed();
  await seedSecondProject();
});

test.describe("MCP OAuth handshake", () => {
  test("an unauthenticated call is refused and points at the discovery documents", async ({
    request,
    baseURL,
  }) => {
    const response = await request.post("/api/mcp", {
      headers: MCP_HEADERS,
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(response.status()).toBe(401);

    // Followed rather than pattern-matched: this header is the only thing a client is given, and a
    // pointer that parses but does not resolve would pass a `toContain`.
    const challenge = response.headers()["www-authenticate"] ?? "";
    const pointer = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(pointer, challenge).toBe(`${baseURL}/.well-known/oauth-protected-resource`);

    const resourceDoc = await request.get(new URL(pointer!).pathname);
    expect(resourceDoc.status()).toBe(200);
    const resource = await resourceDoc.json();
    // BP-316: both fields are configuration, never x-forwarded-host
    expect(resource.resource).toBe(baseURL);
    expect(resource.authorization_servers).toContain(baseURL);

    const serverDoc = await request.get("/.well-known/oauth-authorization-server");
    expect(serverDoc.status()).toBe(200);
    expect(await serverDoc.json()).toMatchObject({
      issuer: baseURL,
      authorization_endpoint: `${baseURL}/oauth/authorize`,
      token_endpoint: `${baseURL}/oauth/token`,
      registration_endpoint: `${baseURL}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
  });

  test("a forged host header cannot move the authorization server a client is sent to", async ({
    request,
    baseURL,
  }) => {
    const forged = { "x-forwarded-host": "evil.example", forwarded: "host=evil.example" };

    const refusal = await request.post("/api/mcp", {
      headers: { ...MCP_HEADERS, ...forged },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(refusal.headers()["www-authenticate"]).toContain(baseURL);
    expect(refusal.headers()["www-authenticate"]).not.toContain("evil.example");

    const resource = await (
      await request.get("/.well-known/oauth-protected-resource", { headers: forged })
    ).json();
    expect(resource.resource).toBe(baseURL);
    expect(JSON.stringify(resource)).not.toContain("evil.example");

    const server = await (
      await request.get("/.well-known/oauth-authorization-server", { headers: forged })
    ).json();
    expect(server.issuer).toBe(baseURL);
    expect(JSON.stringify(server)).not.toContain("evil.example");
  });

  test("registration, consent and PKCE produce a token the MCP tools accept", async ({
    page,
    request,
  }) => {
    const { accessToken } = await authorize(page, request, { projects: "all" });

    // The client landed back on its own redirect endpoint rather than on an error page
    await expect(page.locator("#landed")).toBeVisible();

    const session = new McpSession(request, accessToken);
    const opened = await session.open();
    expect(opened.result?.serverInfo).toMatchObject({ name: "boardplanner" });

    const { body: listed } = await session.call("tools/list");
    const toolNames = ((listed.result?.tools ?? []) as { name: string }[]).map((t) => t.name);
    expect(toolNames).toContain("list_tasks");
    expect(toolNames).toContain("list_projects");

    const tasks = await session.callTool("list_tasks", { project: PROJECT_KEY });
    expect(tasks.text).toContain(HELD_TASK_TITLE);
  });

  test("a token limited to one project reaches only that project's board", async ({
    page,
    request,
  }) => {
    const { accessToken } = await authorize(page, request, {
      projects: [String(PROJECT_ID)],
    });

    const session = new McpSession(request, accessToken);
    await session.open();

    const projects = await session.callTool("list_projects");
    const keys = ((projects.parsed ?? []) as { key: string }[]).map((p) => p.key);
    // The control: this account is an instance admin and reaches both boards. Only the one ticked
    // on the consent screen may come back.
    expect(keys).toContain(PROJECT_KEY);
    expect(keys).not.toContain(SECOND_PROJECT_KEY);
  });

  test("the authorization code is single-use and PKCE is verified", async ({ page, request }) => {
    const { code, redirectUri, clientId, verifier } = await authorize(page, request);

    const replay = await request.post("/oauth/token", {
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      },
    });
    expect(replay.status()).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
  });

  test("a code exchanged with the wrong verifier is refused", async ({ page, request }) => {
    const receiver = await redirectReceiver();
    try {
      const registration = await request.post("/oauth/register", {
        data: { client_name: "E2E MCP Client", redirect_uris: [receiver.url] },
      });
      const { client_id: clientId } = await registration.json();

      const { challenge } = pkce();
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: receiver.url,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "mcp",
        state: "wrong-verifier",
      });

      await page.goto(`/oauth/authorize?${query.toString()}`);
      await page.fill("#u", ADMIN_USERNAME);
      await page.fill("#p", ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.check('input[name="access"][value="all"]');
      await page.click('button[name="decision"][value="allow"]');

      const code = (await receiver.captured).get("code") ?? "";
      expect(code).not.toBe("");

      const exchanged = await request.post("/oauth/token", {
        form: {
          grant_type: "authorization_code",
          code,
          redirect_uri: receiver.url,
          client_id: clientId,
          code_verifier: pkce().verifier,
        },
      });
      expect(exchanged.status()).toBe(400);
      expect(await exchanged.json()).toMatchObject({
        error: "invalid_grant",
        error_description: "PKCE verification failed",
      });
    } finally {
      await receiver.close();
    }
  });

  test("a refreshed token keeps working and the spent refresh token does not", async ({
    page,
    request,
  }) => {
    const { refreshToken, clientId } = await authorize(page, request);

    const refreshed = await request.post("/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId },
    });
    expect(refreshed.status(), await refreshed.text()).toBe(200);
    const rotated = await refreshed.json();

    const session = new McpSession(request, rotated.access_token);
    await session.open();
    const tasks = await session.callTool("list_tasks", { project: PROJECT_KEY });
    expect(tasks.text).toContain(HELD_TASK_TITLE);

    const replayed = await request.post("/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId },
    });
    expect(replayed.status()).toBe(400);
    expect((await replayed.json()).error).toBe("invalid_grant");
  });

  test("a credential that was never issued is refused", async ({ request }) => {
    const session = new McpSession(request, "cpat_not_a_real_token");
    const { status } = await session.call("tools/list");
    expect(status).toBe(401);
  });

  test("denying on the consent screen returns an error to the client and issues nothing", async ({
    page,
    request,
  }) => {
    const receiver = await redirectReceiver();
    try {
      const registration = await request.post("/oauth/register", {
        data: { client_name: "E2E MCP Client", redirect_uris: [receiver.url] },
      });
      const { client_id: clientId } = await registration.json();

      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: receiver.url,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        scope: "mcp",
        state: "denied",
      });

      await page.goto(`/oauth/authorize?${query.toString()}`);
      await page.fill("#u", ADMIN_USERNAME);
      await page.fill("#p", ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.click('button[name="decision"][value="deny"]');

      const params = await receiver.captured;
      expect(params.get("code")).toBeNull();
      expect(params.get("error")).toBe("access_denied");
      expect(params.get("state")).toBe("denied");
    } finally {
      await receiver.close();
    }
  });
});
