import { connectDB } from "@/lib/db";
import { getClientIp, verifyCredentials } from "@/lib/auth";
import {
  buildSessionCookie,
  checkProvenance,
  createSession,
  legacySessionCookies,
  readSessionCookie,
  resolveSession,
} from "@/lib/session";
import {
  isRateLimited,
  lockoutKey,
  recordFailedAttempt,
  sourceKey,
  withLockout,
} from "@/lib/rate-limit";
import { accessibleProjectIds } from "@/lib/grants";
import { notifyCredentialCreated } from "@/lib/security-mail";
import { User } from "@/models/user";
import { OAuthClient } from "@/models/oauthClient";
import { OAuthCode } from "@/models/oauthCode";
import { OAuthConsent } from "@/models/oauthConsent";
import { Project } from "@/models/project";
import {
  randomToken,
  readFormBody,
  sha256,
  isValidRedirectUri,
  AUTH_CODE_TTL_SECONDS,
} from "@/lib/oauth";
import { IOAuthClient, IOAuthConsent, IUser } from "@/types";
import { APP_NAME } from "@/lib/brand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONSENT_TTL_SECONDS = 600; // 10 min to log in + pick projects
const CONSENTS_PER_WINDOW = 60;

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

function htmlPage(body: string, status = 200, head = ""): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}<title>${APP_NAME} — Authorize</title><style>
      body{font-family:system-ui,-apple-system,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
      .card{background:#1a1d24;border:1px solid #2a2e37;border-radius:12px;padding:32px;width:100%;max-width:380px}
      h1{font-size:18px;margin:0 0 4px}.sub{color:#9aa0aa;font-size:13px;margin:0 0 20px;line-height:1.5}
      label{display:block;font-size:13px;margin:14px 0 6px;color:#c3c8d1}
      input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;background:#0f1115;border:1px solid #2a2e37;border-radius:8px;color:#e6e6e6;font-size:14px}
      button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
      .primary{background:#5b7cfa;color:#fff}
      .secondary{background:#22262f;color:#c3c8d1;border:1px solid #2a2e37}
      /* Authorize is first in the markup so implicit submission — Enter — activates it rather
         than the destructive button; the visual order is restored here (BP-383 review). */
      .row{display:flex;flex-direction:row-reverse;gap:10px}
      .err{background:#3a1d1d;border:1px solid #6b2b2b;color:#f0b0b0;padding:8px 12px;border-radius:8px;font-size:13px;margin-bottom:12px}
      .app{color:#5b7cfa;font-weight:600}
      .mode{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:14px;cursor:pointer;border:1px solid #2a2e37;border-radius:8px;padding:10px 12px}
      .mode:has(input:checked){border-color:#5b7cfa;background:#171c2e}
      .projects{margin-top:10px;border:1px solid #2a2e37;border-radius:8px;padding:10px;max-height:220px;overflow-y:auto}
      .projects[data-ignored=true]{opacity:.4}
      .proj{display:flex;align-items:center;gap:8px;font-size:14px;padding:5px 0;cursor:pointer}
      .projects[data-ignored=true] .proj{cursor:not-allowed}
      /* A disabled control dispatches no click and bubbles nothing, so without this the square
         itself — the thing a person aims at — is the one dead spot in the list (BP-383 review). */
      .projects[data-ignored=true] input{pointer-events:none}
      a{color:#5b7cfa}
      .key{color:#9aa0aa;font-family:ui-monospace,monospace;font-size:12px}
      .hint{color:#9aa0aa;font-size:12px;margin-top:10px;line-height:1.5}
      .dest{background:#0f1115;border:1px solid #2a2e37;border-radius:8px;padding:10px 12px;margin:0 0 16px;font-size:12px;color:#9aa0aa;line-height:1.6}
      .dest b{display:block;color:#c3c8d1;font-weight:600;margin-bottom:2px}
      .dest code{font-family:ui-monospace,monospace;color:#e6e6e6;word-break:break-all}
      .warn{background:#3a2f1d;border:1px solid #6b552b;color:#f0d9a8;padding:8px 12px;border-radius:8px;font-size:12px;margin-bottom:12px;line-height:1.5}
      input[type=radio],input[type=checkbox]{accent-color:#5b7cfa}
    </style></head><body><div class="card">${body}</div></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        vary: "Cookie",
      },
    }
  );
}

function errorPage(message: string, status = 400): Response {
  return htmlPage(`<h1>Authorization error</h1><p class="sub">${escapeHtml(message)}</p>`, status);
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

function provenance(clientName: string, redirectUri: string): string {
  const label = clientName ? escapeHtml(clientName) : "An application";
  return `
    <div class="dest">
      <b>Sends your authorization to</b>
      <code>${escapeHtml(originOf(redirectUri))}</code>
    </div>
    <div class="warn">
      ${label} registered itself with this ${APP_NAME} instance. Nobody has reviewed it. Continue only if
      you started this yourself and recognise the address above.
    </div>`;
}

function originOf(redirectUri: string): string {
  try {
    return new URL(redirectUri).origin;
  } catch {
    return redirectUri;
  }
}

function loginForm(p: AuthParams, clientName: string, error?: string): Response {
  const label = clientName ? escapeHtml(clientName) : "An application";
  return htmlPage(`
    <h1>Sign in to ${APP_NAME}</h1>
    <p class="sub"><span class="app">${label}</span> wants to access your ${APP_NAME} account.</p>
    ${provenance(clientName, p.redirectUri)}
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

const CONSENT_SCRIPT = `
  (function () {
    var form = document.getElementById("consent");
    if (!form) return;
    var all = form.querySelector('input[name="access"][value="all"]');
    var limited = form.querySelector('input[name="access"][value="limited"]');
    if (!all || !limited || limited.disabled) return;
    var list = document.getElementById("projects");
    var boxes = list ? list.querySelectorAll('input[name="projects"]') : [];
    function sync() {
      if (list) list.setAttribute("data-ignored", String(all.checked));
      Array.prototype.forEach.call(boxes, function (box) { box.disabled = all.checked; });
    }
    Array.prototype.forEach.call(form.querySelectorAll('input[name="access"]'), function (radio) {
      radio.addEventListener("change", sync);
    });
    // A disabled checkbox fires nothing, so the way back from "All projects" is a click anywhere on
    // the list it deactivated.
    if (list) list.addEventListener("click", function () {
      if (all.checked) { limited.checked = true; sync(); }
    });
    // Restoring a page from history reinstates the radios without firing "change", so a page that
    // ran sync() only at parse time came back with "All projects" picked and the list live again.
    window.addEventListener("pageshow", sync);
    sync();
  })();`;

function consentForm(
  ticket: string,
  clientName: string,
  redirectUri: string,
  projects: { _id: string; name: string; key: string }[],
  options: { signedInAs?: string; switchAccountHref?: string; error?: string } = {}
): Response {
  const label = clientName ? escapeHtml(clientName) : "An application";
  const empty = projects.length === 0;
  const rows = projects
    .map(
      (p) => `<label class="proj"><input type="checkbox" name="projects" value="${escapeHtml(p._id)}">
        <span>${escapeHtml(p.name)}</span><span class="key">${escapeHtml(p.key)}</span></label>`
    )
    .join("");
  const identity = options.signedInAs
    ? `<p class="hint">Signed in as <b>${escapeHtml(options.signedInAs)}</b>${
        options.switchAccountHref
          ? ` — <a href="${escapeHtml(options.switchAccountHref)}">use a different account</a>`
          : ""
      }</p>`
    : "";
  return htmlPage(`
    <h1>Grant access</h1>
    <p class="sub">Choose what <span class="app">${label}</span> may access.</p>
    ${provenance(clientName, redirectUri)}
    ${options.error ? `<div class="err">${escapeHtml(options.error)}</div>` : ""}
    <form id="consent" method="post" action="/oauth/authorize">
      <input type="hidden" name="phase" value="consent">
      <input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
      <label class="mode"><input type="radio" name="access" value="limited"${
        empty ? " disabled" : " checked"
      }> Only selected projects</label>
      <label class="mode"><input type="radio" name="access" value="all"> All projects — full account access</label>
      <div class="projects" id="projects" data-ignored="${empty}">${
        rows || '<span class="key">No projects</span>'
      }</div>
      <p class="hint">${
        empty
          ? "This account can reach no boards, so a limited connection would have nothing in it."
          : "If you pick specific projects, this connection is limited to them (tasks, comments, sprints) and cannot perform admin actions."
      }</p>
      <div class="row">
        <button class="primary" type="submit" name="decision" value="allow">Authorize</button>
        <button class="secondary" type="submit" name="decision" value="deny">Deny</button>
      </div>
    </form>
    ${identity}
    <script>${CONSENT_SCRIPT}</script>`);
}

function returnToClient(target: string, clientName: string, headline = "Authorized"): Response {
  if (!isValidRedirectUri(target)) {
    return errorPage("This client's redirect address is not a web address.");
  }

  const href = escapeHtml(target);
  const label = clientName ? escapeHtml(clientName) : "the application";
  return htmlPage(
    `<h1>${headline}</h1>
    <p class="sub">Returning you to ${label}…</p>
    <p class="hint"><a id="return" href="${href}">Continue</a> if nothing happens.</p>
    <script>location.replace(document.getElementById("return").href);</script>`,
    200,
    `<meta http-equiv="refresh" content="0;url=${href}">`
  );
}

async function validateClientAndRedirect(p: AuthParams): Promise<IOAuthClient | null> {
  if (!p.clientId || !p.redirectUri) return null;
  if (!isValidRedirectUri(p.redirectUri)) return null;
  const client = await OAuthClient.findOne({ clientId: p.clientId });
  if (!client) return null;
  if (!client.redirectUris.includes(p.redirectUri)) return null;
  return client;
}

async function accessibleProjects(user: IUser): Promise<{ _id: string; name: string; key: string }[]> {
  const accessible = await accessibleProjectIds(user);
  const filter = accessible === null ? {} : { _id: { $in: accessible } };
  const projects = await Project.find(filter).select("_id name key").sort({ key: 1 }).lean();
  return projects.map((p) => ({ _id: String(p._id), name: p.name as string, key: p.key as string }));
}

async function browserSession(req: Request): Promise<{ sessionId: string; userId: string } | null> {
  const token = readSessionCookie(req.headers.get("cookie"));
  if (!token) return null;
  const session = await resolveSession(token);
  if (!session) return null;
  return { sessionId: String(session.sessionId), userId: String(session.userId) };
}

function consentKey(userId: string): string {
  return sourceKey(`user:${userId}`, "oauth_consent");
}

async function issueTicket(p: AuthParams, user: IUser, sessionId: string): Promise<string> {
  const ticket = randomToken("cpct_");
  await OAuthConsent.create({
    ticketHash: sha256(ticket),
    clientId: p.clientId,
    user: user._id,
    session: sessionId,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    state: p.state,
    scope: p.scope,
    expiresAt: new Date(Date.now() + CONSENT_TTL_SECONDS * 1000),
  });
  return ticket;
}

function paramsOfConsent(consent: IOAuthConsent): AuthParams {
  return {
    clientId: consent.clientId,
    redirectUri: consent.redirectUri,
    state: consent.state,
    codeChallenge: consent.codeChallenge,
    codeChallengeMethod: "S256",
    responseType: "code",
    scope: consent.scope,
  };
}

function authorizeHref(p: AuthParams, extra: Record<string, string> = {}): string {
  const sp = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod,
    response_type: p.responseType,
    scope: p.scope,
    ...extra,
  });
  if (p.state) sp.set("state", p.state);
  return `/oauth/authorize?${sp.toString()}`;
}

function switchAccountHref(p: AuthParams): string {
  return authorizeHref(p, { prompt: "login" });
}

export async function GET(req: Request) {
  await connectDB();
  const query = new URL(req.url).searchParams;
  const p = readParamsFromQuery(query);

  const client = await validateClientAndRedirect(p);
  if (!client) return errorPage("Unknown client or unregistered redirect_uri.");
  if (p.responseType !== "code") return errorPage("Unsupported response_type (only 'code').");
  if (!p.codeChallenge || p.codeChallengeMethod !== "S256") {
    return errorPage("PKCE required: code_challenge with code_challenge_method=S256.");
  }

  if (query.get("prompt") !== "login") {
    const session = await browserSession(req);
    const user = session ? await User.findById(session.userId) : null;
    if (session && user) {
      if (await isRateLimited(consentKey(session.userId), CONSENTS_PER_WINDOW)) {
        return errorPage("Too many authorization attempts on this account. Try again later.", 429);
      }
      await recordFailedAttempt(consentKey(session.userId));

      return consentForm(
        await issueTicket(p, user, session.sessionId),
        client.clientName,
        p.redirectUri,
        await accessibleProjects(user),
        { signedInAs: user.username, switchAccountHref: switchAccountHref(p) }
      );
    }
  }

  return loginForm(p, client.clientName);
}

export async function POST(req: Request) {
  if (!checkProvenance(req).ok) {
    return errorPage(
      "This form was submitted from another site, so it was refused. Start again from this instance.",
      403
    );
  }

  await connectDB();
  const form = await readFormBody(req);
  if (!form) return errorPage("This form was submitted with a body that is not a form.");
  const phase = String(form.get("phase") || "login");

  if (phase === "consent") {
    return handleConsent(req, form);
  }

  const p = readParamsFromForm(form);
  const client = await validateClientAndRedirect(p);
  if (!client) return errorPage("Unknown client or unregistered redirect_uri.");
  if (p.responseType !== "code") return errorPage("Unsupported response_type (only 'code').");
  if (!p.codeChallenge || p.codeChallengeMethod !== "S256") {
    return errorPage("PKCE required: code_challenge with code_challenge_method=S256.");
  }

  const username = String(form.get("username") || "");
  const password = String(form.get("password") || "");
  const clientIp = getClientIp(req);
  const { lockedOut, result: user } = await withLockout(
    lockoutKey(clientIp ?? "-", username),
    () => verifyCredentials(username, password),
    clientIp ? sourceKey(clientIp) : undefined
  );
  if (lockedOut) {
    return loginForm(p, client.clientName, "Too many failed attempts. Try again later.");
  }
  if (!user) return loginForm(p, client.clientName, "Invalid username or password.");

  const session = await createSession({
    userId: user._id,
    userAgent: req.headers.get("user-agent"),
    ip: clientIp,
  });
  const headers = new Headers({
    location: authorizeHref(p),
    "cache-control": "private, no-store",
  });
  headers.append("set-cookie", buildSessionCookie(session.token, session.absoluteExpiresAt));
  for (const stale of legacySessionCookies()) headers.append("set-cookie", stale);
  return new Response(null, { status: 303, headers });
}

async function handleConsent(req: Request, form: FormData): Promise<Response> {
  const ticket = String(form.get("ticket") || "");
  const wide = String(form.get("access") || "") === "all";
  const selected = form.getAll("projects").map((v) => String(v));

  const consent = await OAuthConsent.findOne({ ticketHash: sha256(ticket) });
  if (!consent || consent.expiresAt.getTime() < Date.now()) {
    return errorPage("Your session expired. Please start the authorization again.");
  }

  const holder = await browserSession(req);
  if (!consent.session || !holder || holder.sessionId !== String(consent.session)) {
    await OAuthConsent.deleteOne({ _id: consent._id });
    return errorPage("This authorization belongs to a different sign-in. Start it again.", 403);
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

  if (String(form.get("decision") || "") !== "allow") {
    const refused = await OAuthConsent.deleteOne({ _id: consent._id });
    if (refused?.deletedCount !== 1) {
      return errorPage("This authorization was already completed. Start it again.");
    }
    const denied = new URL(consent.redirectUri);
    denied.searchParams.set("error", "access_denied");
    if (consent.state) denied.searchParams.set("state", consent.state);
    return returnToClient(denied.toString(), client.clientName, "Not authorized");
  }

  let allowedProjects: string[] = [];
  let scopeLabel = "every board this account can reach";
  if (!wide) {
    const accessible = await accessibleProjects(user);
    const accessibleIds = new Set(accessible.map((p) => p._id));
    allowedProjects = [...new Set(selected)].filter((id) => accessibleIds.has(id));
    scopeLabel = accessible
      .filter((p) => allowedProjects.includes(p._id))
      .map((p) => p.key)
      .join(", ");
    if (allowedProjects.length === 0) {
      await recordFailedAttempt(consentKey(String(consent.user)));
      return consentForm(ticket, client.clientName, consent.redirectUri, accessible, {
        signedInAs: user.username,
        switchAccountHref: switchAccountHref(paramsOfConsent(consent)),
        error: accessible.length
          ? "Select at least one project, or choose “All projects”."
          : "This account can reach no boards, so full account access is the only connection available.",
      });
    }
  }

  const claimed = await OAuthConsent.deleteOne({ _id: consent._id });
  if (claimed?.deletedCount !== 1) {
    return errorPage("This authorization was already completed. Start it again.");
  }

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

  void notifyCredentialCreated({
    email: user.email,
    username: user.username,
    kind: "oauth",
    name: client.clientName,
    scope: scopeLabel,
  });

  const url = new URL(consent.redirectUri);
  url.searchParams.set("code", code);
  if (consent.state) url.searchParams.set("state", consent.state);

  return returnToClient(url.toString(), client.clientName);
}
