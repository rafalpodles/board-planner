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
  PROJECT_NAME,
  SECOND_PROJECT_ID,
  SECOND_PROJECT_KEY,
  SECOND_PROJECT_NAME,
  expireAccessToken,
  seed,
  stripAccessExpiry,
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
  waitForRedirect: (ms?: number) => Promise<URLSearchParams>;
  close: () => Promise<void>;
}> {
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
    /**
     * A flow that never redirects — a consent screen that re-renders with an error, say — would
     * otherwise hang until the test's own timeout, which says nothing about where it stopped.
     *
     * The clock starts here rather than when the receiver is built: everything before this point
     * is Turbopack compiling /oauth/register, /oauth/authorize and the login POST on first use,
     * which is why the config allows 90s for a navigation. A timer armed at construction would
     * expire during a legitimate cold start and report it as a missing redirect.
     */
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

/** The transport answers JSON or an SSE frame depending on the call; both carry one JSON-RPC message. */
function rpcMessage(body: string): { result?: Record<string, unknown>; error?: { message: string } } {
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
    // A refusal's body is composed by mcp-handler, not by this repo, and a test that only wants
    // the status must not die parsing it
    return {};
  }
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

/**
 * Registration and consent, stopping at the code. Separate from `authorize()` because the token
 * endpoint claims a code on its first sight of it, spent or not — so any test about what that
 * endpoint refuses needs a code of its own.
 */
async function authorizationCode(
  page: Page,
  request: APIRequestContext,
  receiver: { url: string; waitForRedirect: (ms?: number) => Promise<URLSearchParams> }
): Promise<{ code: string; clientId: string; verifier: string }> {
  const registration = await request.post("/oauth/register", {
    data: { client_name: "E2E MCP Client", redirect_uris: [receiver.url] },
  });
  expect(registration.status(), await registration.text()).toBe(201);
  const { client_id: clientId } = await registration.json();

  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: receiver.url,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp",
    state: "unspent",
  });

  await page.goto(`/oauth/authorize?${query.toString()}`);
  await page.fill("#u", ADMIN_USERNAME);
  await page.fill("#p", ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.check('input[name="access"][value="all"]');
  await page.click('button[name="decision"][value="allow"]');

  const code = (await receiver.waitForRedirect()).get("code") ?? "";
  expect(code).not.toBe("");
  return { code, clientId, verifier };
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
      // Every board this account reaches is offered. Asserted rather than assumed: the point of
      // ticking one is that another was there to leave unticked. The count is seed() plus
      // seedSecondProject() — a project added to seed() itself belongs in this number.
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

    // The control for the limited-token test below: authorized for everything, this account
    // reaches both seeded boards
    const projects = await session.callTool("list_projects");
    const keys = ((projects.parsed ?? []) as { key: string }[]).map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining([PROJECT_KEY, SECOND_PROJECT_KEY]));
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
    // This account is an instance admin and reaches both boards — the test above proves it with
    // the same call. Only the one ticked on the consent screen may come back here.
    expect(keys).toContain(PROJECT_KEY);
    expect(keys).not.toContain(SECOND_PROJECT_KEY);

    // Naming the board by key only re-tests the filter above — `getProjectByKey` resolves through
    // the listing (`PlannerClient`), so a key it cannot see is a key it cannot use. Worth one
    // assertion for the user-visible outcome, no more than that.
    const byKey = await session.callTool("list_tasks", { project: SECOND_PROJECT_KEY });
    expect(byKey.raw.result?.isError ?? byKey.raw.error).toBeTruthy();
    expect(JSON.stringify(byKey.raw)).not.toContain(SECOND_PROJECT_NAME);

    // Naming it by id is the independent one: `get_project` tries /api/projects/:id first, which is
    // the per-project route and its own access check, reached without the listing having any say.
    const byId = await session.callTool("get_project", { identifier: String(SECOND_PROJECT_ID) });
    expect(byId.raw.result?.isError ?? byId.raw.error).toBeTruthy();
    expect(JSON.stringify(byId.raw)).not.toContain(SECOND_PROJECT_NAME);

    // The same two calls at the granted board work, so the refusals are the scope and not a broken
    // tool
    const grantedTasks = await session.callTool("list_tasks", { project: PROJECT_KEY });
    expect(grantedTasks.text).toContain(HELD_TASK_TITLE);
    const grantedProject = await session.callTool("get_project", { identifier: String(PROJECT_ID) });
    expect(grantedProject.text).toContain(PROJECT_NAME);
  });

  test("an authorization naming a redirect address the client never registered is refused", async ({
    page,
    request,
  }) => {
    const receiver = await redirectReceiver();
    try {
      const registration = await request.post("/oauth/register", {
        data: { client_name: "E2E MCP Client", redirect_uris: [receiver.url] },
      });
      const { client_id: clientId } = await registration.json();

      const elsewhere = `${new URL(receiver.url).origin.replace(/:\d+$/, ":1")}/callback`;
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: elsewhere,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        scope: "mcp",
        state: "stolen",
      });

      await page.goto(`/oauth/authorize?${query.toString()}`);
      await expect(page.getByRole("heading", { name: "Authorization error" })).toBeVisible();
      await expect(page.getByText("Unknown client or unregistered redirect_uri.")).toBeVisible();
      // Not a sign-in form: the refusal comes before anybody is asked for a password
      await expect(page.locator("#u")).toHaveCount(0);

      // The control: the same request with the registered address gets the sign-in form
      query.set("redirect_uri", receiver.url);
      await page.goto(`/oauth/authorize?${query.toString()}`);
      await expect(page.locator("#u")).toBeVisible();
    } finally {
      await receiver.close();
    }
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
      const { code, clientId } = await authorizationCode(page, request, receiver);

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

  test("a code exchanged against a different redirect address is refused", async ({
    page,
    request,
  }) => {
    const receiver = await redirectReceiver();
    try {
      const { code, clientId, verifier } = await authorizationCode(page, request, receiver);

      // RFC 6749 §4.1.3. The authorization was issued for one address; an exchange naming another
      // is the shape of a stolen code being redeemed from somewhere else.
      const elsewhere = `${new URL(receiver.url).origin.replace(/:\d+$/, ":1")}/callback`;
      const exchanged = await request.post("/oauth/token", {
        form: {
          grant_type: "authorization_code",
          code,
          redirect_uri: elsewhere,
          client_id: clientId,
          code_verifier: verifier,
        },
      });
      expect(exchanged.status()).toBe(400);
      expect(await exchanged.json()).toMatchObject({
        error: "invalid_grant",
        error_description: "redirect_uri mismatch",
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

  test("an expired access token stops working, and the row is still there to prove why", async ({
    page,
    request,
  }) => {
    const { accessToken } = await authorize(page, request);

    const working = new McpSession(request, accessToken);
    await working.open();

    expect(await expireAccessToken(accessToken), "the row was reaped, so the 401 proves nothing").toBe(
      true
    );

    const expired = new McpSession(request, accessToken);
    const { status } = await expired.call("tools/list");
    expect(status).toBe(401);
  });

  /**
   * BP-444 reported every MCP call answering 500 while a credential was stale, and the refusal
   * paths measure 401 throughout — including this one, but only because mcp-handler catches
   * everything `verifyToken` throws. `error_description` is what tells the two apart: a refusal
   * this instance decided says "No authorization provided", a throw the library rescued says
   * "Invalid token". Asserting it is the difference between a test that watches the fix and one
   * that only watches the status code, which is identical either way.
   */
  test("a token row with no expiry is refused as a credential, not rescued from a throw", async ({
    page,
    request,
  }) => {
    const { accessToken } = await authorize(page, request);

    const working = new McpSession(request, accessToken);
    await working.open();

    expect(await stripAccessExpiry(accessToken), "the row was reaped, so the 401 proves nothing").toBe(
      true
    );

    const response = await request.post("/api/mcp", {
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${accessToken}` },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(response.status()).toBe(401);
    const challenge = response.headers()["www-authenticate"] ?? "";
    expect(challenge, challenge).toContain('error_description="No authorization provided"');
    // The pointer a client follows to re-authorise has to survive the refusal
    expect(challenge).toContain("resource_metadata=");
  });

  /**
   * The endpoint a client reaches by itself the moment its access token lapses. `formData()` throws
   * on anything that is not a form, and the throw was uncaught: an empty 500 where RFC 6749 §5.2
   * has a 400 naming `invalid_request`. A client acts on the second and not on the first, which is
   * what turned a lapsed credential into a person's problem (BP-444).
   */
  test("the token endpoint refuses a body it cannot parse with 400, not 500", async ({
    page,
    request,
  }) => {
    const { refreshToken, clientId } = await authorize(page, request);

    for (const [label, headers, body] of [
      ["json", { "content-type": "application/json" }, JSON.stringify({ grant_type: "refresh_token" })],
      ["text", { "content-type": "text/plain" }, "grant_type=refresh_token"],
    ] as const) {
      const refused = await request.post("/oauth/token", { headers, data: body });
      expect(refused.status(), `${label}: ${await refused.text()}`).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "invalid_request" });
    }

    // The control: the refusal is about the encoding, and a real refresh still rotates
    const refreshed = await request.post("/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId },
    });
    expect(refreshed.status(), await refreshed.text()).toBe(200);
    expect((await refreshed.json()).access_token).toMatch(/^cpat_/);
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

      const params = await receiver.waitForRedirect();
      expect(params.get("code")).toBeNull();
      expect(params.get("error")).toBe("access_denied");
      expect(params.get("state")).toBe("denied");
    } finally {
      await receiver.close();
    }
  });
});
