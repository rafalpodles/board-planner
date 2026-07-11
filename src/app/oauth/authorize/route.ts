import { connectDB } from "@/lib/db";
import { verifyCredentials } from "@/lib/auth";
import { OAuthClient } from "@/models/oauthClient";
import { OAuthCode } from "@/models/oauthCode";
import { randomToken, sha256, AUTH_CODE_TTL_SECONDS } from "@/lib/oauth";
import { IOAuthClient } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface AuthParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
  scope: string;
}

function readParams(sp: URLSearchParams): AuthParams {
  return {
    clientId: sp.get("client_id") || "",
    redirectUri: sp.get("redirect_uri") || "",
    state: sp.get("state") || "",
    codeChallenge: sp.get("code_challenge") || "",
    codeChallengeMethod: sp.get("code_challenge_method") || "",
    responseType: sp.get("response_type") || "",
    scope: sp.get("scope") || "mcp",
  };
}

function htmlPage(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ClaudePlanner — Authorize</title><style>
      body{font-family:system-ui,-apple-system,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
      .card{background:#1a1d24;border:1px solid #2a2e37;border-radius:12px;padding:32px;width:100%;max-width:360px}
      h1{font-size:18px;margin:0 0 4px}.sub{color:#9aa0aa;font-size:13px;margin:0 0 20px}
      label{display:block;font-size:13px;margin:14px 0 6px;color:#c3c8d1}
      input{width:100%;box-sizing:border-box;padding:10px 12px;background:#0f1115;border:1px solid #2a2e37;border-radius:8px;color:#e6e6e6;font-size:14px}
      button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
      .primary{background:#5b7cfa;color:#fff}.err{background:#3a1d1d;border:1px solid #6b2b2b;color:#f0b0b0;padding:8px 12px;border-radius:8px;font-size:13px;margin-bottom:12px}
      .app{color:#5b7cfa;font-weight:600}
    </style></head><body><div class="card">${body}</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function errorPage(message: string): Response {
  return htmlPage(`<h1>Authorization error</h1><p class="sub">${escapeHtml(message)}</p>`, 400);
}

function loginForm(p: AuthParams, clientName: string, error?: string): Response {
  const hidden = [
    ["client_id", p.clientId],
    ["redirect_uri", p.redirectUri],
    ["state", p.state],
    ["code_challenge", p.codeChallenge],
    ["code_challenge_method", p.codeChallengeMethod],
    ["response_type", p.responseType],
    ["scope", p.scope],
  ]
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join("");
  const label = clientName ? escapeHtml(clientName) : "An application";
  return htmlPage(`
    <h1>Sign in to ClaudePlanner</h1>
    <p class="sub"><span class="app">${label}</span> wants to access your ClaudePlanner account.</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <label for="u">Username</label>
      <input id="u" name="username" autocomplete="username" autofocus required>
      <label for="p">Password</label>
      <input id="p" name="password" type="password" autocomplete="current-password" required>
      <button class="primary" type="submit" name="decision" value="approve">Authorize</button>
    </form>`);
}

async function validateClientAndRedirect(p: AuthParams): Promise<IOAuthClient | null> {
  if (!p.clientId || !p.redirectUri) return null;
  const client = await OAuthClient.findOne({ clientId: p.clientId });
  if (!client) return null;
  if (!client.redirectUris.includes(p.redirectUri)) return null;
  return client;
}

export async function GET(req: Request) {
  await connectDB();
  const p = readParams(new URL(req.url).searchParams);

  const client = await validateClientAndRedirect(p);
  if (!client) return errorPage("Unknown client or unregistered redirect_uri.");

  if (p.responseType !== "code") return errorPage("Unsupported response_type (only 'code').");
  if (!p.codeChallenge || p.codeChallengeMethod !== "S256") {
    return errorPage("PKCE required: code_challenge with code_challenge_method=S256.");
  }

  return loginForm(p, client.clientName);
}

export async function POST(req: Request) {
  await connectDB();
  const form = await req.formData();
  const p: AuthParams = {
    clientId: String(form.get("client_id") || ""),
    redirectUri: String(form.get("redirect_uri") || ""),
    state: String(form.get("state") || ""),
    codeChallenge: String(form.get("code_challenge") || ""),
    codeChallengeMethod: String(form.get("code_challenge_method") || ""),
    responseType: String(form.get("response_type") || ""),
    scope: String(form.get("scope") || "mcp"),
  };

  const client = await validateClientAndRedirect(p);
  if (!client) return errorPage("Unknown client or unregistered redirect_uri.");
  if (!p.codeChallenge || p.codeChallengeMethod !== "S256") {
    return errorPage("PKCE required: code_challenge with code_challenge_method=S256.");
  }

  const username = String(form.get("username") || "");
  const password = String(form.get("password") || "");
  const user = await verifyCredentials(username, password);
  if (!user) return loginForm(p, client.clientName, "Invalid username or password.");

  const code = randomToken("cpac_");
  await OAuthCode.create({
    codeHash: sha256(code),
    clientId: p.clientId,
    user: user._id,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    scope: p.scope,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000),
  });

  const url = new URL(p.redirectUri);
  url.searchParams.set("code", code);
  if (p.state) url.searchParams.set("state", p.state);

  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}
