import { createHash, randomBytes } from "node:crypto";
import { readBody } from "./stub-guard.mjs";

/**
 * An OAuth-protected MCP server, served from the MCP stub's own process (BP-707).
 *
 * Every path carries a tenant — `/oauth/<tenant>/mcp` — and each tenant is a separate
 * authorization server with its own clients, codes, tokens and request log, so tests sharing
 * this one process for the whole run cannot see each other's state.
 *
 * Discovery is the path-aware kind `mcp-oauth.ts` performs: a 401 naming the protected-resource
 * metadata, whose `authorization_servers` points at `/oauth/<tenant>`, whose own metadata lives at
 * `/.well-known/oauth-authorization-server/oauth/<tenant>`.
 *
 * `/_control/oauth/<tenant>/…` is the test's side door: pre-register a client (the one an admin
 * types by hand), revoke every token, and read back what each token request carried.
 */

export const OAUTH_TOOLS = [
  { name: "list_oauth_record", description: "Read the record only a signed-in client may see" },
];

const tenants = new Map();

function tenantOf(name) {
  let t = tenants.get(name);
  if (!t) {
    t = {
      clients: new Map(),
      codes: new Map(),
      accessTokens: new Set(),
      refreshTokens: new Map(),
      revoked: false,
      log: [],
    };
    tenants.set(name, t);
  }
  return t;
}

const token = (prefix) => `${prefix}-${randomBytes(16).toString("hex")}`;
const sha256url = (s) => createHash("sha256").update(s).digest("base64url");

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(res, status, title, body) {
  res
    .writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
    .end(`<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`);
}

function clientCredentials(req, form) {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const [id, ...rest] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
    return { method: "client_secret_basic", clientId: id, secret: rest.join(":") };
  }
  const secret = form.get("client_secret");
  return {
    method: secret ? "client_secret_post" : "none",
    clientId: form.get("client_id") ?? "",
    secret: secret ?? "",
  };
}

function issue(t, clientId) {
  const accessToken = token("at");
  const refreshToken = token("rt");
  t.accessTokens.add(accessToken);
  t.refreshTokens.set(refreshToken, clientId);
  return { accessToken, refreshToken };
}

async function handleToken(req, res, t, resource) {
  const form = new URLSearchParams(await readBody(req));
  const creds = clientCredentials(req, form);
  const grantType = form.get("grant_type");
  const entry = {
    type: "token",
    grantType,
    authMethod: creds.method,
    clientId: creds.clientId,
    secret: creds.secret,
    outcome: "",
  };
  t.log.push(entry);
  const refuse = (status, error) => {
    entry.outcome = error;
    json(res, status, { error });
  };

  const client = t.clients.get(creds.clientId);
  if (!client) return refuse(401, "invalid_client");
  if (creds.method !== client.authMethod) return refuse(401, "invalid_client");
  if (client.secret && creds.secret !== client.secret) return refuse(401, "invalid_client");
  if (form.get("resource") !== resource) return refuse(400, "invalid_target");

  if (grantType === "authorization_code") {
    const code = t.codes.get(form.get("code") ?? "");
    t.codes.delete(form.get("code") ?? "");
    if (!code || code.clientId !== creds.clientId) return refuse(400, "invalid_grant");
    if (code.redirectUri !== form.get("redirect_uri")) return refuse(400, "invalid_grant");
    if (sha256url(form.get("code_verifier") ?? "") !== code.codeChallenge) {
      entry.pkce = "mismatch";
      return refuse(400, "invalid_grant");
    }
    entry.pkce = "verified";
  } else if (grantType === "refresh_token") {
    const owner = t.refreshTokens.get(form.get("refresh_token") ?? "");
    if (t.revoked || owner !== creds.clientId) return refuse(400, "invalid_grant");
    t.refreshTokens.delete(form.get("refresh_token") ?? "");
  } else {
    return refuse(400, "unsupported_grant_type");
  }

  const issued = issue(t, creds.clientId);
  entry.outcome = "issued";
  entry.accessToken = issued.accessToken;
  entry.refreshToken = issued.refreshToken;
  json(res, 200, {
    access_token: issued.accessToken,
    refresh_token: issued.refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
  });
}

/**
 * Answers the request if it belongs to the OAuth tenant space, and returns whether it did.
 * `answerRpc(req, res, catalogue, name)` is the plain MCP server, reached only with a live token.
 */
export async function handleOauth(req, res, origin, answerRpc) {
  const url = new URL(req.url ?? "/", origin);
  const path = url.pathname;
  let m;

  if ((m = path.match(/^\/\.well-known\/oauth-protected-resource\/oauth\/([\w-]+)\/mcp$/))) {
    json(res, 200, {
      resource: `${origin}/oauth/${m[1]}/mcp`,
      authorization_servers: [`${origin}/oauth/${m[1]}`],
      scopes_supported: ["records:read"],
    });
    return true;
  }

  if ((m = path.match(/^\/\.well-known\/oauth-authorization-server\/oauth\/([\w-]+)$/))) {
    const base = `${origin}/oauth/${m[1]}`;
    json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    });
    return true;
  }

  if ((m = path.match(/^\/_control\/oauth\/([\w-]+)\/(client|revoke|revoke-access|log)$/))) {
    const t = tenantOf(m[1]);
    if (m[2] === "client") {
      const body = JSON.parse((await readBody(req)) || "{}");
      t.clients.set(body.client_id, {
        secret: body.client_secret ?? "",
        redirectUris: body.redirect_uris ?? [],
        authMethod: body.token_endpoint_auth_method ?? "client_secret_basic",
      });
      json(res, 200, { ok: true });
    } else if (m[2] === "revoke") {
      t.revoked = true;
      t.accessTokens.clear();
      json(res, 200, { ok: true });
    } else if (m[2] === "revoke-access") {
      // Only the access token: the refresh token stays valid, unlike plain "revoke". Models a
      // provider revoking early — the client's own, still-unexpired record does not know anything
      // changed until it actually calls the server and gets a 401 (BP-750).
      t.accessTokens.clear();
      json(res, 200, { ok: true });
    } else {
      json(res, 200, t.log);
    }
    return true;
  }

  m = path.match(/^\/oauth\/([\w-]+)\/(mcp|register|authorize|approve|token)$/);
  if (!m) return false;
  const t = tenantOf(m[1]);
  const resource = `${origin}/oauth/${m[1]}/mcp`;
  const badAuthorizationRequest = (q) =>
    q.get("response_type") !== "code" ||
    q.get("code_challenge_method") !== "S256" ||
    !q.get("code_challenge") ||
    q.get("resource") !== resource;

  switch (m[2]) {
    case "mcp": {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!t.accessTokens.has(bearer)) {
        await readBody(req);
        res
          .writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/oauth/${m[1]}/mcp"`,
          })
          .end(JSON.stringify({ error: "invalid_token" }));
        return true;
      }
      await answerRpc(req, res, OAUTH_TOOLS, `oauth-${m[1]}`);
      return true;
    }

    case "register": {
      const body = JSON.parse((await readBody(req)) || "{}");
      const clientId = token("dcr");
      t.clients.set(clientId, { secret: "", redirectUris: body.redirect_uris ?? [], authMethod: "none" });
      t.log.push({ type: "register", clientId, redirectUris: body.redirect_uris ?? [] });
      json(res, 201, {
        client_id: clientId,
        redirect_uris: body.redirect_uris ?? [],
        token_endpoint_auth_method: "none",
      });
      return true;
    }

    case "authorize": {
      const q = url.searchParams;
      const client = t.clients.get(q.get("client_id") ?? "");
      t.log.push({ type: "authorize", clientId: q.get("client_id") ?? "" });
      // An unknown client or a redirect it never registered is shown here, never redirected to
      if (!client) {
        page(res, 400, "Unknown client", `<h1>Unknown client</h1><p>${escapeHtml(q.get("client_id"))}</p>`);
        return true;
      }
      if (!client.redirectUris.includes(q.get("redirect_uri"))) {
        page(res, 400, "Unregistered redirect", "<h1>Unregistered redirect</h1>");
        return true;
      }
      if (badAuthorizationRequest(q)) {
        page(res, 400, "Bad request", "<h1>A code request with PKCE S256 for this resource is required</h1>");
        return true;
      }
      const hidden = [...q.entries()]
        .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
        .join("");
      page(
        res,
        200,
        "Authorize",
        `<h1>Authorize BoardPlanner PM Agent</h1><form method="get" action="/oauth/${m[1]}/approve">${hidden}<button type="submit">Approve</button></form>`
      );
      return true;
    }

    case "approve": {
      const q = url.searchParams;
      const client = t.clients.get(q.get("client_id") ?? "");
      if (!client || !client.redirectUris.includes(q.get("redirect_uri"))) {
        page(res, 400, "Unknown client", "<h1>Unknown client</h1>");
        return true;
      }
      if (badAuthorizationRequest(q)) {
        page(res, 400, "Bad request", "<h1>A code request with PKCE S256 for this resource is required</h1>");
        return true;
      }
      const code = token("code");
      t.codes.set(code, {
        clientId: q.get("client_id"),
        redirectUri: q.get("redirect_uri"),
        codeChallenge: q.get("code_challenge"),
      });
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state") ?? "");
      res.writeHead(302, { Location: back.toString() }).end();
      return true;
    }

    case "token":
      await handleToken(req, res, t, resource);
      return true;
  }
  return false;
}
