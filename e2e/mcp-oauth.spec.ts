import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
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
  SIBLING_TASK_KEY,
  expireAccessToken,
  seed,
  stripAccessExpiry,
  seedSecondProject,
} from "./seed";
import {
  MCP_HEADERS,
  McpSession,
  authorize,
  pkce,
  redirectReceiver,
  type RedirectReceiver,
} from "./mcp";

async function authorizationCode(
  page: Page,
  request: APIRequestContext,
  receiver: Pick<RedirectReceiver, "url" | "waitForRedirect">
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

    const challenge = response.headers()["www-authenticate"] ?? "";
    const pointer = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(pointer, challenge).toBe(`${baseURL}/.well-known/oauth-protected-resource`);

    const resourceDoc = await request.get(new URL(pointer!).pathname);
    expect(resourceDoc.status()).toBe(200);
    const resource = await resourceDoc.json();
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

    const projects = await session.callTool("list_projects");
    const keys = ((projects.parsed ?? []) as { key: string }[]).map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining([PROJECT_KEY, SECOND_PROJECT_KEY]));
  });

  test("a parameter the tool does not declare is refused, and nothing moves", async ({
    page,
    request,
  }) => {
    const { accessToken } = await authorize(page, request, { projects: "all" });
    const session = new McpSession(request, accessToken);
    await session.open();

    const before = await session.callTool("get_task", { taskKey: SIBLING_TASK_KEY });

    const refused = await session.callTool("update_task", {
      taskKey: SIBLING_TASK_KEY,
      description: "should not land either",
      checklist: [{ text: "written by nobody" }],
    });

    expect(refused.raw.result?.isError, refused.text).toBe(true);
    expect(refused.text).toContain("checklist");
    expect(refused.text).toContain("acceptanceCriteria");

    const after = await session.callTool("get_task", { taskKey: SIBLING_TASK_KEY });
    expect(after.parsed.updatedAt).toBe(before.parsed.updatedAt);
    expect(after.parsed.description).toBe(before.parsed.description);

    const written = await session.callTool("update_task", {
      taskKey: SIBLING_TASK_KEY,
      description: "written through a parameter it does declare",
    });
    expect(written.raw.result?.isError ?? false, written.text).toBe(false);

    const readBack = await session.callTool("get_task", { taskKey: SIBLING_TASK_KEY });
    expect(readBack.parsed.description).toBe("written through a parameter it does declare");
    expect(readBack.parsed.updatedAt).not.toBe(before.parsed.updatedAt);
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
    expect(keys).toContain(PROJECT_KEY);
    expect(keys).not.toContain(SECOND_PROJECT_KEY);

    const byKey = await session.callTool("list_tasks", { project: SECOND_PROJECT_KEY });
    expect(byKey.raw.result?.isError ?? byKey.raw.error).toBeTruthy();
    expect(JSON.stringify(byKey.raw)).not.toContain(SECOND_PROJECT_NAME);

    const byId = await session.callTool("get_project", { identifier: String(SECOND_PROJECT_ID) });
    expect(byId.raw.result?.isError ?? byId.raw.error).toBeTruthy();
    expect(JSON.stringify(byId.raw)).not.toContain(SECOND_PROJECT_NAME);

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
      await expect(page.locator("#u")).toHaveCount(0);

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
    expect(challenge).toContain("resource_metadata=");
  });

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
