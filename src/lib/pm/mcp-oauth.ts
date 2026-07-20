import crypto from "crypto";
import { isAllowedMcpServerUrl } from "@/lib/url-validation";

const DISCOVERY_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 15_000;

export interface McpOauthConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  scopes: string[];
  tokenAuthMethod: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
}

function assertAllowedUrl(url: string, what: string): void {
  if (!isAllowedMcpServerUrl(url)) {
    throw new Error(`${what} URL is not allowed: ${url}`);
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// RFC 8414 / RFC 9728 path-aware well-known URL: the suffix goes between the
// origin and the path component of the identifier.
function wellKnownUrls(identifier: string, suffix: string): string[] {
  const u = new URL(identifier);
  const urls = [];
  if (u.pathname && u.pathname !== "/") {
    urls.push(`${u.origin}/.well-known/${suffix}${u.pathname}`);
  }
  urls.push(`${u.origin}/.well-known/${suffix}`);
  return urls;
}

async function probeResourceMetadataUrl(mcpUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claudeplanner-pm", version: "1.0" } } }),
      signal: controller.signal,
    });
    if (res.status !== 401) return null;
    const header = res.headers.get("www-authenticate") || "";
    const match = header.match(/resource_metadata="([^"]+)"/i);
    return match ? match[1] : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverOauthConfig(mcpUrl: string): Promise<McpOauthConfig> {
  // 1. Protected resource metadata (RFC 9728): WWW-Authenticate hint, then well-known fallbacks
  const candidates: string[] = [];
  const hinted = await probeResourceMetadataUrl(mcpUrl);
  if (hinted) candidates.push(hinted);
  candidates.push(...wellKnownUrls(mcpUrl, "oauth-protected-resource"));

  let authServerIssuer: string | null = null;
  let resourceScopes: string[] = [];
  for (const candidate of candidates) {
    assertAllowedUrl(candidate, "Resource metadata");
    const prm = await fetchJson(candidate, { headers: { Accept: "application/json" } });
    const servers = prm?.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === "string") {
      authServerIssuer = servers[0];
      if (Array.isArray(prm?.scopes_supported)) {
        resourceScopes = prm.scopes_supported.filter((s: unknown) => typeof s === "string");
      }
      break;
    }
  }
  // Last resort: assume the MCP origin is its own authorization server
  if (!authServerIssuer) {
    authServerIssuer = new URL(mcpUrl).origin;
  }
  assertAllowedUrl(authServerIssuer, "Authorization server");

  // 2. AS metadata (RFC 8414, OIDC fallback)
  const metadataCandidates = [
    ...wellKnownUrls(authServerIssuer, "oauth-authorization-server"),
    ...wellKnownUrls(authServerIssuer, "openid-configuration"),
  ];
  for (const candidate of metadataCandidates) {
    const meta = await fetchJson(candidate, { headers: { Accept: "application/json" } });
    if (!meta) continue;
    const authorizationEndpoint = String(meta.authorization_endpoint ?? "");
    const tokenEndpoint = String(meta.token_endpoint ?? "");
    if (!authorizationEndpoint || !tokenEndpoint) continue;
    assertAllowedUrl(authorizationEndpoint, "Authorization endpoint");
    assertAllowedUrl(tokenEndpoint, "Token endpoint");
    const registrationEndpoint = String(meta.registration_endpoint ?? "");
    if (registrationEndpoint) assertAllowedUrl(registrationEndpoint, "Registration endpoint");
    const methods = Array.isArray(meta.token_endpoint_auth_methods_supported)
      ? (meta.token_endpoint_auth_methods_supported as string[])
      : [];
    return {
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      scopes: resourceScopes,
      tokenAuthMethod: methods.includes("none") ? "none" : methods[0] || "client_secret_basic",
    };
  }
  throw new Error("Could not discover OAuth authorization server metadata for this MCP server");
}

export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string
): Promise<{ clientId: string; clientSecret: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const res = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "ClaudePlanner PM Agent",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Dynamic client registration failed (${res.status}): ${body.slice(0, 200)}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as any;
    if (!data.client_id) throw new Error("Registration response has no client_id");
    return { clientId: String(data.client_id), clientSecret: String(data.client_secret ?? "") };
  } finally {
    clearTimeout(timer);
  }
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizationUrl(opts: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
}): string {
  const url = new URL(opts.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", opts.resource);
  if (opts.scopes.length > 0) url.searchParams.set("scope", opts.scopes.join(" "));
  return url.toString();
}

interface TokenRequestOpts {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  tokenAuthMethod: string;
  params: Record<string, string>;
}

async function tokenRequest(opts: TokenRequestOpts): Promise<TokenSet> {
  const body = new URLSearchParams(opts.params);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (opts.clientSecret && opts.tokenAuthMethod !== "client_secret_post") {
    headers.Authorization =
      "Basic " + Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
  } else {
    body.set("client_id", opts.clientId);
    if (opts.clientSecret) body.set("client_secret", opts.clientSecret);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const res = await fetch(opts.tokenEndpoint, {
      method: "POST",
      headers,
      body: body.toString(),
      signal: controller.signal,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || !data.access_token) {
      throw new Error(
        `Token request failed (${res.status}): ${String(data.error ?? "no access_token")}`
      );
    }
    const expiresIn = Number(data.expires_in);
    return {
      accessToken: String(data.access_token),
      refreshToken: String(data.refresh_token ?? ""),
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function exchangeCode(opts: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  tokenAuthMethod: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
}): Promise<TokenSet> {
  return tokenRequest({
    tokenEndpoint: opts.tokenEndpoint,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    tokenAuthMethod: opts.tokenAuthMethod,
    params: {
      grant_type: "authorization_code",
      code: opts.code,
      code_verifier: opts.codeVerifier,
      redirect_uri: opts.redirectUri,
      resource: opts.resource,
    },
  });
}

export function refreshTokens(opts: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  tokenAuthMethod: string;
  refreshToken: string;
  resource: string;
}): Promise<TokenSet> {
  return tokenRequest({
    tokenEndpoint: opts.tokenEndpoint,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    tokenAuthMethod: opts.tokenAuthMethod,
    params: {
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      resource: opts.resource,
    },
  });
}

export function requestBaseUrl(request?: Request): string | null {
  if (!request) return null;
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!host) return null;
  const proto =
    request.headers.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export function getPmOauthRedirectUri(request?: Request): string {
  const base =
    requestBaseUrl(request) || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/api/pm/oauth/callback`;
}
