import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import crypto from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import { ADMIN_PASSWORD, ADMIN_USERNAME, E2E_MONGODB_URI, seed } from "./seed";

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}
function pkce() {
  const verifier = base64url(crypto.randomBytes(32));
  return { verifier, challenge: base64url(crypto.createHash("sha256").update(verifier).digest()) };
}

async function redirectReceiver() {
  let land!: (params: URLSearchParams) => void;
  const captured = new Promise<URLSearchParams>((resolve) => (land = resolve));
  const server = createServer((req, res) => {
    land(new URL(req.url ?? "/", "http://127.0.0.1").searchParams);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<p>ok</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`,
    waitForRedirect: () => captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function authorize(page: Page, request: APIRequestContext) {
  const receiver = await redirectReceiver();
  try {
    const registration = await request.post("/oauth/register", {
      data: { client_name: "BP444 probe", redirect_uris: [receiver.url] },
    });
    const { client_id: clientId } = await registration.json();
    const { verifier, challenge } = pkce();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: receiver.url,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
      state: "probe",
    });
    await page.goto(`/oauth/authorize?${query.toString()}`);
    await page.fill("#u", ADMIN_USERNAME);
    await page.fill("#p", ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.check('input[name="access"][value="all"]');
    await page.click('button[name="decision"][value="allow"]');
    const params = await receiver.waitForRedirect();
    const token = await request.post("/oauth/token", {
      form: {
        grant_type: "authorization_code",
        code: params.get("code") ?? "",
        redirect_uri: receiver.url,
        client_id: clientId,
        code_verifier: verifier,
      },
    });
    expect(token.status(), await token.text()).toBe(200);
    const issued = await token.json();
    return { ...issued, clientId, redirectUri: receiver.url };
  } finally {
    await receiver.close();
  }
}

const results: string[] = [];
function record(label: string, status: number | string, note = "") {
  results.push(`${label.padEnd(52)} ${String(status).padEnd(6)} ${note}`);
}

async function db() {
  if (mongoose.connection.readyState !== 1) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

async function mcp(request: APIRequestContext, token: string, body: unknown, extra: Record<string, string> = {}) {
  const res = await request.post("/api/mcp", {
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}`, ...extra },
    data: body as never,
  });
  return { status: res.status(), text: (await res.text()).slice(0, 200) };
}

test("BP-444 probe matrix", async ({ page, request }) => {
  test.setTimeout(300_000);
  await seed();
  const issued = await authorize(page, request);
  const token: string = issued.access_token;
  const refresh: string = issued.refresh_token;
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "p", version: "0" } } };

  // A — the control: a live token
  record("A valid token / initialize", (await mcp(request, token, init)).status);

  const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  record("A2 valid token / tools/list", (await mcp(request, token, list)).status);

  const callList = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: {} } };
  const a3 = await mcp(request, token, callList);
  record("A3 valid token / tools/call list_projects", a3.status, a3.text.slice(0, 80).replace(/\n/g, " "));

  // D–F — tokens that resolve to nothing
  record("D cpat_ that never existed", (await mcp(request, "cpat_" + "0".repeat(64), init)).status);
  record("E cp_ that never existed", (await mcp(request, "cp_" + "0".repeat(40), init)).status);
  record("F bearer with no known prefix", (await mcp(request, "garbage-token", init)).status);

  // C — the row is gone (rotation, TTL reap, revocation)
  const conn = await db();
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const row = await conn.collection("oauthtokens").findOne({ accessTokenHash: hash });
  await conn.collection("oauthtokens").deleteOne({ accessTokenHash: hash });
  record("C row deleted (revoked/rotated away)", (await mcp(request, token, init)).status);

  // Q — the row is there but the expiry field is not (a row written by an older shape)
  await conn.collection("oauthtokens").insertOne({ ...row!, _id: undefined as never });
  await conn.collection("oauthtokens").updateOne({ accessTokenHash: hash }, { $unset: { accessExpiresAt: "" } });
  record("Q row present, accessExpiresAt missing", (await mcp(request, token, init)).status);

  // B — plain expiry
  await conn.collection("oauthtokens").updateOne(
    { accessTokenHash: hash },
    { $set: { accessExpiresAt: new Date(Date.now() - 60_000) } }
  );
  record("B access token expired", (await mcp(request, token, init)).status);

  // P — the user behind a live token is gone
  await conn.collection("oauthtokens").updateOne(
    { accessTokenHash: hash },
    { $set: { accessExpiresAt: new Date(Date.now() + 600_000), user: new mongoose.Types.ObjectId() } }
  );
  record("P live token, user row deleted", (await mcp(request, token, init)).status);
  await conn.collection("oauthtokens").updateOne({ accessTokenHash: hash }, { $set: { user: row!.user } });

  // J–M — transport-level shapes a client can produce
  const j = await request.post("/api/mcp", {
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
    data: "{not json" as never,
  });
  record("J valid token, body is not JSON", j.status(), (await j.text()).slice(0, 80).replace(/\n/g, " "));

  const k = await request.post("/api/mcp", {
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "text/plain", Authorization: `Bearer ${token}` },
    data: "hello" as never,
  });
  record("K valid token, content-type text/plain", k.status(), (await k.text()).slice(0, 80).replace(/\n/g, " "));

  const l = await request.get("/api/mcp", { headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` } });
  record("L GET /api/mcp", l.status(), (await l.text()).slice(0, 60).replace(/\n/g, " "));

  const m = await request.delete("/api/mcp", { headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` } });
  record("M DELETE /api/mcp", m.status(), (await m.text()).slice(0, 60).replace(/\n/g, " "));

  const n = await request.post("/api/mcp", {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    data: init as never,
  });
  record("N valid token, no Accept header", n.status(), (await n.text()).slice(0, 80).replace(/\n/g, " "));

  // G–I — the token endpoint, which is what a client hits when its access token lapses
  const g = await request.post("/oauth/token", {
    headers: { "Content-Type": "application/json" },
    data: { grant_type: "refresh_token", refresh_token: refresh },
  });
  record("G /oauth/token with a JSON body", g.status(), (await g.text()).slice(0, 80).replace(/\n/g, " "));

  const g2 = await request.post("/oauth/token", {
    headers: { "Content-Type": "text/plain" },
    data: "grant_type=refresh_token" as never,
  });
  record("G2 /oauth/token with a text/plain body", g2.status(), (await g2.text()).slice(0, 80).replace(/\n/g, " "));

  const g3 = await request.post("/oauth/token", { headers: { "Content-Type": "application/json" }, data: {} as never });
  record("G3 /oauth/token empty JSON body", g3.status(), (await g3.text()).slice(0, 80).replace(/\n/g, " "));

  const h = await request.post("/oauth/token", {
    form: { grant_type: "refresh_token", refresh_token: "cprt_" + "0".repeat(64) },
  });
  record("H refresh token that never existed", h.status(), (await h.text()).slice(0, 60).replace(/\n/g, " "));

  const i1 = await request.post("/oauth/token", { form: { grant_type: "refresh_token", refresh_token: refresh } });
  record("I1 refresh, first use", i1.status());
  const i2 = await request.post("/oauth/token", { form: { grant_type: "refresh_token", refresh_token: refresh } });
  record("I2 refresh, replayed", i2.status(), (await i2.text()).slice(0, 60).replace(/\n/g, " "));

  // O — the authorize endpoint's own POST
  const o = await request.post("/oauth/authorize", {
    headers: { "Content-Type": "application/json" },
    data: { decision: "allow" },
  });
  record("O /oauth/authorize POST with a JSON body", o.status(), (await o.text()).slice(0, 80).replace(/\n/g, " "));

  await mongoose.disconnect();
  console.log("\n=== BP-444 PROBE ===\n" + results.join("\n") + "\n=== END ===\n");
});
