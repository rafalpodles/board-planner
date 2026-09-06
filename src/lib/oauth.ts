import crypto from "crypto";
import { MAX_JSON_BODY_BYTES, readFormBody as readBoundedFormBody } from "./request-body";

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

export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false;
  const computed = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

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

export async function readFormBody(req: Request): Promise<FormData | null> {
  const read = await readBoundedFormBody(req, MAX_JSON_BODY_BYTES);
  return read.ok ? read.value : null;
}
