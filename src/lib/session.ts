import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "./db";
import { randomToken, sha256 } from "./oauth";
import { Session } from "@/models/session";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { ApiToken } from "@/models/apiToken";
import { DeviceEnrolment } from "@/models/deviceEnrolment";
import { EmailChangeToken } from "@/models/emailChangeToken";
import { EnrolmentToken } from "@/models/enrolmentToken";
import { OAuthCode } from "@/models/oauthCode";
import { OAuthToken } from "@/models/oauthToken";
import { Worker } from "@/models/worker";

export const SESSION_TOKEN_PREFIX = "cps_";
export const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const SESSION_SLIDE_THROTTLE_MS = 24 * 60 * 60 * 1000;

const UNPREFIXED_COOKIE_NAME = "bp_session";
const HOST_COOKIE_NAME = `__Host-${UNPREFIXED_COOKIE_NAME}`;
const KNOWN_COOKIE_NAMES = [HOST_COOKIE_NAME, UNPREFIXED_COOKIE_NAME];

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// "1" is the operator's explicit opt-in. "auto" is what docker-compose.yml passes: plain HTTP only
// while PUBLIC_ORIGIN and every APP_ORIGIN are http:// and the sign-in itself did not arrive over
// https, so the same compose file serves localhost out of the box and a TLS deployment that never
// set PUBLIC_ORIGIN still gets the secure cookie (BP-773). Anything else, empty included, is the
// secure default.
export function allowsInsecureCookie(request?: Request): boolean {
  const flag = process.env.COOKIE_ALLOW_INSECURE;
  if (flag === "1") return true;
  if (flag === "auto") return servedOverPlainHttp() && !(request && signedInOverHttps(request));
  return false;
}

function autoMode(): boolean {
  return process.env.COOKIE_ALLOW_INSECURE === "auto" && servedOverPlainHttp();
}

// The Origin header, because the browser writes it and no page script can: a sign-in is a POST,
// which always carries it. The request URL is the last hop's, plain http behind a TLS proxy, and
// X-Forwarded-Proto is whatever the caller typed on a deployment with nothing in front. A
// non-browser caller can forge Origin, but only to choose the attributes of its own cookie.
function signedInOverHttps(request: Request): boolean {
  return request.headers.get("origin")?.trim().toLowerCase().startsWith("https://") === true;
}

function servedOverPlainHttp(): boolean {
  const origins = appOrigins();
  return (
    selfOrigin()?.startsWith("http://") === true &&
    origins.length > 0 &&
    origins.every((origin) => origin.startsWith("http://"))
  );
}

export function sessionCookieName(request?: Request): string {
  return allowsInsecureCookie(request) ? UNPREFIXED_COOKIE_NAME : HOST_COOKIE_NAME;
}

function normaliseOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

export function appOrigins(): string[] {
  return (process.env.APP_ORIGIN ?? "")
    .split(",")
    .map(normaliseOrigin)
    .filter((origin) => origin.length > 0);
}

/**
 * This instance's own origin, from configuration only.
 *
 * Never from a request header. `x-forwarded-host` is client-supplied on a deployment with no
 * proxy in front, and reading it turned the MCP tool client into a reader of whatever address a
 * token holder named, and the PM OAuth callback into an open redirect (BP-316). Returns null
 * rather than guessing, so every caller has to decide what "not configured" means for it.
 *
 * `APP_ORIGIN` is an allowlist rather than an address — the compose file's own default lists
 * localhost, and a deployment that accepts both a LAN and a public origin has no reason to order
 * them. So it is a source only when it names exactly one origin; anything else needs
 * `PUBLIC_ORIGIN`, which is a single value and settable at runtime.
 *
 * `NEXT_PUBLIC_APP_URL` is deliberately NOT a source. Next.js inlines it at build time, so in the
 * shipped bundle it is a literal from the build machine — as a fallback it was always truthy and
 * turned the intended fail-closed 500 into a discovery document advertising localhost, cached for
 * an hour (BP-316 review). The published image serves every instance, so nothing reads it (BP-766).
 *
 * Every candidate is parsed, and the scheme is checked. `new URL()` accepts `board.example.com:8443`
 * as an opaque URL whose `.origin` is the string "null" — truthy, so every "not configured" guard
 * would pass and the endpoints would read `null/oauth/token`.
 */
export const ORIGIN_REQUIRED =
  "This instance's own origin is not configured. Set PUBLIC_ORIGIN to an http(s) URL (or give APP_ORIGIN exactly one origin): the MCP endpoint publishes it to clients and calls this instance's own API with it, so it must not come from a request header.";

export function selfOrigin(): string | null {
  const allowlist = appOrigins();
  return (
    parseOrigin(process.env.PUBLIC_ORIGIN) ??
    (allowlist.length === 1 ? parseOrigin(allowlist[0]) : null)
  );
}

function parseOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return normaliseOrigin(url.origin);
  } catch {
    return null;
  }
}

export function assertSessionConfig(): void {
  if (!allowsInsecureCookie()) return;

  const origins = appOrigins();
  const own = selfOrigin();
  if (process.env.COOKIE_ALLOW_INSECURE === "1" && own && !own.startsWith("http://")) {
    throw new Error(
      `COOKIE_ALLOW_INSECURE=1 requires PUBLIC_ORIGIN to be an http:// origin; got ${own}. The session cookie is issued without Secure and without the __Host- prefix in this mode. Set COOKIE_ALLOW_INSECURE to 0 (or auto), or fix PUBLIC_ORIGIN.`
    );
  }
  if (origins.length === 0) {
    throw new Error(
      "APP_ORIGIN is required when COOKIE_ALLOW_INSECURE=1: without it every mutating request, including login, is refused"
    );
  }

  // The compose stack ships the flag on so a localhost deployment works out of the box, which makes
  // "still insecure once it moved behind TLS" the likely mistake rather than an exotic one.
  // Allowlisted, not blocklisted: a schemeless APP_ORIGIN is a plausible typo and would slip past a
  // startsWith("https://") test, waving the flag through on exactly the deployment it guards.
  const notPlainHttp = origins.filter((origin) => !origin.startsWith("http://"));
  if (notPlainHttp.length > 0) {
    throw new Error(
      `COOKIE_ALLOW_INSECURE=1 requires every APP_ORIGIN to be an http:// origin; got ${notPlainHttp.join(", ")}. The session cookie is issued without Secure and without the __Host- prefix in this mode, so on anything else it is injectable from a sibling subdomain. Set COOKIE_ALLOW_INSECURE to 0 (or auto), or fix APP_ORIGIN.`
    );
  }

  console.warn(
    process.env.COOKIE_ALLOW_INSECURE === "auto"
      ? "COOKIE_ALLOW_INSECURE=auto and this instance's origins are plain http:// — a sign-in that does not arrive over https gets a session cookie without Secure and without the __Host- prefix. Set PUBLIC_ORIGIN and APP_ORIGIN to the https:// address once the instance is behind TLS."
      : "COOKIE_ALLOW_INSECURE=1 — session cookies are issued without Secure and without the __Host- prefix. Set it to 0 once this instance is behind TLS."
  );
}

assertSessionConfig();

function cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (name.startsWith("__Host-") || !allowsInsecureCookie()) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

// Max-Age tracks the ABSOLUTE cap, not the idle window. The idle window slides server-side on every
// use, but nothing re-sends Set-Cookie, so pinning the cookie to it would have the browser discard a
// live session 30 days after login however often it was used — the very logout this work removes.
// A cookie outliving its row is harmless: the server is the authority and answers 401.
export function buildSessionCookie(
  token: string,
  absoluteExpiresAt: Date,
  request?: Request
): string {
  const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - Date.now()) / 1000));
  return cookieHeader(sessionCookieName(request), token, maxAge);
}

export function clearSessionCookies(): string[] {
  return KNOWN_COOKIE_NAMES.map((name) => cookieHeader(name, "", 0));
}

export function legacySessionCookies(request?: Request): string[] {
  const active = sessionCookieName(request);
  return KNOWN_COOKIE_NAMES.filter((name) => name !== active).map((name) =>
    cookieHeader(name, "", 0)
  );
}

/**
 * Every session token this request carries, the prefixed name first.
 *
 * Under auto a sign-in over https was issued the prefixed cookie and one over http the plain one,
 * and each is a row of its own. Both are read — the prefixed first, since only a secure context
 * can have set it and nothing on a sibling subdomain can shadow it — so a reader whose prefixed
 * session was revoked elsewhere is not logged out while a live plain one is still in the jar, and
 * logout can revoke both rather than leaving the exposed one alive for its full 90 days.
 */
export function sessionCookieTokens(header: string | null): string[] {
  if (!header) return [];
  const names = autoMode() ? KNOWN_COOKIE_NAMES : [sessionCookieName()];
  const tokens: string[] = [];
  for (const name of names) {
    const values = cookieValues(header, name);
    // Two cookies of one name mean one was set for a parent domain — the shadowing the __Host-
    // prefix exists to prevent. Taking either is a coin flip on whose session wins, and so is
    // reading past it to the other name, so the request carries nothing.
    if (values.length > 1) return [];
    const value = soleValue(values);
    if (value && !tokens.includes(value)) tokens.push(value);
  }
  return tokens;
}

export function readSessionCookie(header: string | null): string | null {
  return sessionCookieTokens(header)[0] ?? null;
}

function cookieValues(header: string, name: string): string[] {
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    values.push(part.slice(separator + 1).trim());
  }
  return values;
}

function soleValue(values: string[]): string | null {
  if (values.length !== 1) return null;
  return values[0].length > 0 ? values[0] : null;
}

export type ProvenanceRefusal = "cross-site" | "origin-mismatch" | "no-provenance";
export type ProvenanceVerdict = { ok: true } | { ok: false; reason: ProvenanceRefusal };

export class ProvenanceError extends Error {
  readonly reason: ProvenanceRefusal;

  constructor(reason: ProvenanceRefusal) {
    super("Request provenance rejected");
    this.reason = reason;
  }
}

export function checkProvenance(request: Request): ProvenanceVerdict {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) return { ok: true };

  const site = request.headers.get("sec-fetch-site");
  if (site) {
    return site === "same-origin" || site === "none"
      ? { ok: true }
      : { ok: false, reason: "cross-site" };
  }

  const origin = request.headers.get("origin");
  if (!origin) return { ok: false, reason: "no-provenance" };

  warnOnceSecFetchMissing();
  const own = selfOrigin();
  const allowed = own ? [...appOrigins(), own] : appOrigins();
  return allowed.includes(normaliseOrigin(origin))
    ? { ok: true }
    : { ok: false, reason: "origin-mismatch" };
}

// Once, not per request: a browser always sends Sec-Fetch-Site, so its absence may mean a stripping proxy
let warnedSecFetchMissing = false;
function warnOnceSecFetchMissing(): void {
  if (warnedSecFetchMissing) return;
  warnedSecFetchMissing = true;
  console.warn(
    "A request arrived with an Origin header but no Sec-Fetch-Site. If a proxy or CDN strips Sec-Fetch-* headers, CSRF protection falls back to comparing Origin against APP_ORIGIN and PUBLIC_ORIGIN."
  );
}

export function provenanceRefusal(request: Request): NextResponse | null {
  if (checkProvenance(request).ok) return null;
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function createSession(params: {
  userId: Types.ObjectId | string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<{
  token: string;
  sessionId: Types.ObjectId;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}> {
  await connectDB();

  const token = randomToken(SESSION_TOKEN_PREFIX);
  const now = Date.now();
  const absoluteExpiresAt = new Date(now + SESSION_ABSOLUTE_TTL_MS);
  const expiresAt = new Date(Math.min(now + SESSION_IDLE_TTL_MS, absoluteExpiresAt.getTime()));

  const row = await Session.create({
    tokenHash: sha256(token),
    user: params.userId,
    expiresAt,
    absoluteExpiresAt,
    lastUsedAt: new Date(now),
    userAgent: (params.userAgent ?? "").slice(0, 512),
    ip: (params.ip ?? "").slice(0, 128),
  });

  return { token, sessionId: row._id, expiresAt, absoluteExpiresAt };
}

export async function resolveSession(
  token: string
): Promise<{ sessionId: Types.ObjectId; userId: Types.ObjectId; expiresAt: Date } | null> {
  if (!token) return null;
  await connectDB();

  const row = await Session.findOne({ tokenHash: sha256(token) }).lean();
  if (!row) return null;

  const now = Date.now();
  const expiresAt = new Date(row.expiresAt).getTime();
  const absoluteExpiresAt = new Date(row.absoluteExpiresAt).getTime();
  if (expiresAt <= now || absoluteExpiresAt <= now) return null;

  const sessionId = row._id;
  const userId = row.user as Types.ObjectId;
  const extended = new Date(Math.min(now + SESSION_IDLE_TTL_MS, absoluteExpiresAt));

  if (extended.getTime() - expiresAt > SESSION_SLIDE_THROTTLE_MS) {
    await Session.updateOne(
      { _id: sessionId },
      { $set: { expiresAt: extended, lastUsedAt: new Date(now) } }
    );
    return { sessionId, userId, expiresAt: extended };
  }

  return { sessionId, userId, expiresAt: new Date(expiresAt) };
}

export async function revokeSession(token: string): Promise<boolean> {
  if (!token) return false;
  await connectDB();
  const result = await Session.deleteOne({ tokenHash: sha256(token) });
  return (result?.deletedCount ?? 0) > 0;
}

// Everything a stolen password could have minted that outlives a session (BP-325)
export async function revokeUserCredentials(
  userId: Types.ObjectId | string,
  exceptSessionId?: Types.ObjectId | string | null
): Promise<void> {
  await revokeUserSessions(userId, exceptSessionId);
  await ApiToken.deleteMany({ user: userId });
  await OAuthToken.deleteMany({ user: userId });
  await OAuthCode.deleteMany({ user: userId });
  await EnrolmentToken.deleteMany({ createdBy: userId, usedAt: null });
  await DeviceEnrolment.deleteMany({ enrolledBy: userId, deliveredAt: null });
  // A pending address change is a link somebody else may hold: confirmed after the recovery, it
  // would move the address back to them and hand them the next reset (BP-359 review)
  await EmailChangeToken.deleteMany({ user: userId, usedAt: null });
  // A machine keeps its identity and owner; only the credential it holds stops matching
  const unmatchable = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  await Worker.updateMany({ owner: userId }, { $set: { credentialHash: unmatchable } });
}

export async function revokeUserSessions(
  userId: Types.ObjectId | string,
  exceptSessionId?: Types.ObjectId | string | null
): Promise<number> {
  await connectDB();
  const filter: Record<string, unknown> = { user: userId };
  if (exceptSessionId) {
    filter._id = { $ne: exceptSessionId };
  }
  const result = await Session.deleteMany(filter);
  return result?.deletedCount ?? 0;
}
