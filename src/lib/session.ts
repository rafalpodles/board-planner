import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "./db";
import { randomToken, sha256 } from "./oauth";
import { Session } from "@/models/session";

export const SESSION_TOKEN_PREFIX = "cps_";
export const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const SESSION_SLIDE_THROTTLE_MS = 24 * 60 * 60 * 1000;

const UNPREFIXED_COOKIE_NAME = "bp_session";
const HOST_COOKIE_NAME = `__Host-${UNPREFIXED_COOKIE_NAME}`;
const KNOWN_COOKIE_NAMES = [HOST_COOKIE_NAME, UNPREFIXED_COOKIE_NAME];

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function allowsInsecureCookie(): boolean {
  return process.env.COOKIE_ALLOW_INSECURE === "1";
}

export function sessionCookieName(): string {
  return allowsInsecureCookie() ? UNPREFIXED_COOKIE_NAME : HOST_COOKIE_NAME;
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
 */
export function selfOrigin(): string | null {
  const configured = appOrigins()[0];
  if (configured) return configured;

  const built = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!built) return null;
  try {
    return normaliseOrigin(new URL(built).origin);
  } catch {
    return null;
  }
}

export function assertSessionConfig(): void {
  if (!allowsInsecureCookie()) return;

  const origins = appOrigins();
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
      `COOKIE_ALLOW_INSECURE=1 requires every APP_ORIGIN to be an http:// origin; got ${notPlainHttp.join(", ")}. The session cookie is issued without Secure and without the __Host- prefix in this mode, so on anything else it is injectable from a sibling subdomain. Unset COOKIE_ALLOW_INSECURE, or fix APP_ORIGIN.`
    );
  }

  console.warn(
    "COOKIE_ALLOW_INSECURE=1 — session cookies are issued without Secure and without the __Host- prefix. Unset it once this instance is behind TLS."
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
  if (!allowsInsecureCookie() || name.startsWith("__Host-")) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

// Max-Age tracks the ABSOLUTE cap, not the idle window. The idle window slides server-side on every
// use, but nothing re-sends Set-Cookie, so pinning the cookie to it would have the browser discard a
// live session 30 days after login however often it was used — the very logout this work removes.
// A cookie outliving its row is harmless: the server is the authority and answers 401.
export function buildSessionCookie(token: string, absoluteExpiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - Date.now()) / 1000));
  return cookieHeader(sessionCookieName(), token, maxAge);
}

export function clearSessionCookies(): string[] {
  return KNOWN_COOKIE_NAMES.map((name) => cookieHeader(name, "", 0));
}

export function legacySessionCookies(): string[] {
  const active = sessionCookieName();
  return KNOWN_COOKIE_NAMES.filter((name) => name !== active).map((name) =>
    cookieHeader(name, "", 0)
  );
}

export function readSessionCookie(header: string | null): string | null {
  if (!header) return null;
  const name = sessionCookieName();
  const values: string[] = [];

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    values.push(part.slice(separator + 1).trim());
  }

  // Two cookies of one name mean one was set for a parent domain — the shadowing the __Host- prefix
  // exists to prevent, and which the unprefixed name cannot. Taking either is a coin flip on whose
  // session wins, so take neither.
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

  return appOrigins().includes(normaliseOrigin(origin))
    ? { ok: true }
    : { ok: false, reason: "origin-mismatch" };
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
