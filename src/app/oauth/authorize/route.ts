import { connectDB } from "@/lib/db";
import { verifyCredentials } from "@/lib/auth";
import { User } from "@/models/user";
import { OAuthClient } from "@/models/oauthClient";
import { OAuthCode } from "@/models/oauthCode";
import { OAuthConsent } from "@/models/oauthConsent";
import { Project } from "@/models/project";
import { randomToken, sha256, AUTH_CODE_TTL_SECONDS } from "@/lib/oauth";
import { IOAuthClient, IUser } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONSENT_TTL_SECONDS = 600; // 10 min to log in + pick projects

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

function readParamsFromQuery(sp: URLSearchParams): AuthParams {
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

function readParamsFromForm(form: FormData): AuthParams {
  return {
    clientId: String(form.get("client_id") || ""),
    redirectUri: String(form.get("redirect_uri") || ""),
    state: String(form.get("state") || ""),
    codeChallenge: String(form.get("code_challenge") || ""),
    codeChallengeMethod: String(form.get("code_challenge_method") || ""),
    responseType: String(form.get("response_type") || ""),
    scope: String(form.get("scope") || "mcp"),
  };
}

function htmlPage(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ClaudePlanner — Authorize</title><style>
      body{font-family:system-ui,-apple-system,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
      .card{background:#1a1d24;border:1px solid #2a2e37;border-radius:12px;padding:32px;width:100%;max-width:380px}
      h1{font-size:18px;margin:0 0 4px}.sub{color:#9aa0aa;font-size:13px;margin:0 0 20px;line-height:1.5}
      label{display:block;font-size:13px;margin:14px 0 6px;color:#c3c8d1}
      input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;background:#0f1115;border:1px solid #2a2e37;border-radius:8px;color:#e6e6e6;font-size:14px}
      button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
      .primary{background:#5b7cfa;color:#fff}
      .err{background:#3a1d1d;border:1px solid #6b2b2b;color:#f0b0b0;padding:8px 12px;border-radius:8px;font-size:13px;margin-bottom:12px}
      .app{color:#5b7cfa;font-weight:600}
      .mode{display:flex;align-items:center;gap:8px;margin:6px 0;font-size:14px;cursor:pointer}
      .projects{margin-top:10px;border:1px solid #2a2e37;border-radius:8px;padding:10px;max-height:220px;overflow-y:auto}
      .proj{display:flex;align-items:center;gap:8px;font-size:14px;padding:5px 0;cursor:pointer}
      .key{color:#9aa0aa;font-family:ui-monospace,monospace;font-size:12px}
      .hint{color:#9aa0aa;font-size:12px;margin-top:10px;line-height:1.5}
      input[type=radio],input[type=checkbox]{accent-color:#5b7cfa}
    </style></head><body><div class="card">${body}</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function errorPage(message: string): Response {
  return htmlPage(`<h1>Authorization error</h1><p class="sub">${escapeHtml(message)}</p>`, 400);
}

function hiddenFields(p: AuthParams): string {
  return [
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
}

function loginForm(p: AuthParams, clientName: string, error?: string): Response {
  const label = clientName ? escapeHtml(clientName) : "An application";
  return htmlPage(`
    <h1>Sign in to ClaudePlanner</h1>
    <p class="sub"><span class="app">${label}</span> wants to access your ClaudePlanner account.</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="phase" value="login">
      ${hiddenFields(p)}
      <label for="u">Username</label>
      <input id="u" type="text" name="username" autocomplete="username" autofocus required>
      <label for="p">Password</label>
      <input id="p" type="password" name="password" autocomplete="current-password" required>
      <button class="primary" type="submit">Continue</button>
    </form>`);
}

function consentForm(
  ticket: string,
  clientName: string,
  projects: { _id: string; name: string; key: string }[],
  error?: string
): Response {
  const label = clientName ? escapeHtml(clientName) : "An application";
  const rows = projects
    .map(
      (p) => `<label class="proj"><input type="checkbox" name="projects" value="${escapeHtml(p._id)}">
        <span>${escapeHtml(p.name)}</span><span class="key">${escapeHtml(p.key)}</span></label>`
    )
    .join("");
  return htmlPage(`
    <h1>Grant access</h1>
    <p class="sub">Choose what <span class="app">${label}</span> may access.</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="phase" value="consent">
      <input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
      <label class="mode"><input type="radio" name="access" value="all" checked> All projects — full account access</label>
      <label class="mode"><input type="radio" name="access" value="limited"> Only selected projects</label>
      <div class="projects">${rows || '<span class="key">No projects</span>'}</div>
      <p class="hint">If you pick specific projects, this connection is limited to them (tasks, comments, sprints) and cannot perform admin actions.</p>
      <button class="primary" type="submit">Authorize</button>
    </form>`);
}

async function validateClientAndRedirect(p: AuthParams): Promise<IOAuthClient | null> {
  if (!p.clientId || !p.redirectUri) return null;
  const client = await OAuthClient.findOne({ clientId: p.clientId });
  if (!client) return null;
  if (!client.redirectUris.includes(p.redirectUri)) return null;
  return client;
}

async function accessibleProjects(user: IUser): Promise<{ _id: string; name: string; key: string }[]> {
  const filter = user.role === "admin" ? {} : { _id: { $in: user.allowedProjects || [] } };
  const projects = await Project.find(filter).select("_id name key").sort({ key: 1 }).lean();
  return projects.map((p) => ({ _id: String(p._id), name: p.name as string, key: p.key as string }));
}

export async function GET(req: Request) {
  await connectDB();
  const p = readParamsFromQuery(new URL(req.url).searchParams);

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
  const phase = String(form.get("phase") || "login");

  if (phase === "consent") {
    return handleConsent(form);
  }

  // --- Login phase ---
  const p = readParamsFromForm(form);
  const client = await validateClientAndRedirect(p);
  if (!client) return errorPage("Unknown client or unregistered redirect_uri.");
  if (!p.codeChallenge || p.codeChallengeMethod !== "S256") {
    return errorPage("PKCE required: code_challenge with code_challenge_method=S256.");
  }

  const user = await verifyCredentials(String(form.get("username") || ""), String(form.get("password") || ""));
  if (!user) return loginForm(p, client.clientName, "Invalid username or password.");

  const ticket = randomToken("cpct_");
  await OAuthConsent.create({
    ticketHash: sha256(ticket),
    clientId: p.clientId,
    user: user._id,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    state: p.state,
    scope: p.scope,
    expiresAt: new Date(Date.now() + CONSENT_TTL_SECONDS * 1000),
  });

  return consentForm(ticket, client.clientName, await accessibleProjects(user));
}

async function handleConsent(form: FormData): Promise<Response> {
  const ticket = String(form.get("ticket") || "");
  const access = String(form.get("access") || "all");
  const selected = form.getAll("projects").map((v) => String(v));

  const consent = await OAuthConsent.findOne({ ticketHash: sha256(ticket) });
  if (!consent || consent.expiresAt.getTime() < Date.now()) {
    return errorPage("Your session expired. Please start the authorization again.");
  }

  const client = await OAuthClient.findOne({ clientId: consent.clientId });
  if (!client || !client.redirectUris.includes(consent.redirectUri)) {
    await OAuthConsent.deleteOne({ _id: consent._id });
    return errorPage("Client is no longer valid.");
  }

  const user = await User.findById(consent.user);
  if (!user) {
    await OAuthConsent.deleteOne({ _id: consent._id });
    return errorPage("Account no longer exists.");
  }

  let allowedProjects: string[] = [];
  if (access === "limited") {
    const accessible = await accessibleProjects(user);
    const accessibleIds = new Set(accessible.map((p) => p._id));
    allowedProjects = [...new Set(selected)].filter((id) => accessibleIds.has(id));
    if (allowedProjects.length === 0) {
      return consentForm(ticket, client.clientName, accessible, "Select at least one project, or choose “All projects”.");
    }
  }

  await OAuthConsent.deleteOne({ _id: consent._id });

  const code = randomToken("cpac_");
  await OAuthCode.create({
    codeHash: sha256(code),
    clientId: consent.clientId,
    user: user._id,
    redirectUri: consent.redirectUri,
    codeChallenge: consent.codeChallenge,
    scope: consent.scope,
    allowedProjects,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000),
  });

  const url = new URL(consent.redirectUri);
  url.searchParams.set("code", code);
  if (consent.state) url.searchParams.set("state", consent.state);

  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}
