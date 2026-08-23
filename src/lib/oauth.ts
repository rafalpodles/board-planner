import crypto from "crypto";

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1h
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30d
export const AUTH_CODE_TTL_SECONDS = 60;

export function randomToken(prefix: string): string {
  return `${prefix}${crypto.randomBytes(32).toString("hex")}`;
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// RFC 7636 — verify PKCE with method S256
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false;
  const computed = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  // constant-time compare
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // Anchored at both ends: 127.0.0.1.attacker.example starts with "127." and is not loopback
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * RFC 8252: `http` only for loopback. Anything else must be `https`, or the
 * authorization code travels in cleartext to a host the user never sees.
 *
 * Registration is not the only place this has to hold. Rows written before BP-302 accepted `http`
 * on any host, and nothing purged them — so the authorization endpoint checks the stored URI again
 * rather than trusting that whatever wrote it was as strict as this.
 */
export function isValidRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const u = new URL(value);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && isLoopback(u.hostname);
  } catch {
    return false;
  }
}

export function newClientId(): string {
  return `cpc_${crypto.randomBytes(16).toString("hex")}`;
}
