import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { RateLimit } from "@/models/rateLimit";
import { duplicateKeyField } from "./mongo-errors";

export const PLATFORM_REQUEST_WINDOW_MS = 5 * 60 * 1000;

export const PLATFORM_HEADERS = {
  keyId: "x-bp-key-id",
  timestamp: "x-bp-timestamp",
  nonce: "x-bp-nonce",
  signature: "x-bp-signature",
} as const;

export interface PlatformRequestKey {
  keyId: string;
  x: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const ED25519_SIGNATURE_BYTES = 64;

// `keyId:x` pairs, comma-separated: the licence service's request keys, public halves only
export function platformRequestKeys(env: NodeJS.ProcessEnv = process.env): PlatformRequestKey[] {
  return (env.PLATFORM_REQUEST_KEYS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [keyId, x, ...rest] = entry.split(":");
      return keyId && x && rest.length === 0 && BASE64URL.test(x) ? [{ keyId, x }] : [];
    });
}

export function platformSigningString(method: string, path: string, timestamp: string, nonce: string, body: Uint8Array): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return [method.toUpperCase(), path, timestamp, nonce, digest].join("\n");
}

export function signPlatformRequest(
  { method, path, body, now = Date.now() }: { method: string; path: string; body: Uint8Array; now?: number },
  key: { keyId: string; d: string; x: string }
): Record<string, string> {
  const timestamp = String(now);
  const nonce = randomBytes(18).toString("base64url");
  const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: key.d, x: key.x }, format: "jwk" });
  const signature = sign(null, Buffer.from(platformSigningString(method, path, timestamp, nonce, body)), privateKey);
  return {
    [PLATFORM_HEADERS.keyId]: key.keyId,
    [PLATFORM_HEADERS.timestamp]: timestamp,
    [PLATFORM_HEADERS.nonce]: nonce,
    [PLATFORM_HEADERS.signature]: signature.toString("base64url"),
  };
}

export type PlatformRefusal =
  | "missing_headers"
  | "unknown_key"
  | "bad_signature"
  | "stale_timestamp"
  | "replayed_nonce";

export type PlatformVerdict = { ok: true; keyId: string } | { ok: false; reason: PlatformRefusal; keyId: string | null };

function signatureMatches(signingString: string, signature: string, key: PlatformRequestKey): boolean {
  if (!BASE64URL.test(signature)) return false;
  const bytes = Buffer.from(signature, "base64url");
  if (bytes.length !== ED25519_SIGNATURE_BYTES) return false;
  try {
    return verify(null, Buffer.from(signingString), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }), bytes);
  } catch {
    return false;
  }
}

async function claimNonce(keyId: string, nonce: string, now: number): Promise<boolean> {
  try {
    await RateLimit.create({
      _id: `platform-nonce:${keyId}:${nonce}`,
      count: 1,
      resetAt: new Date(now + 2 * PLATFORM_REQUEST_WINDOW_MS),
    });
    return true;
  } catch (error) {
    if (duplicateKeyField(error) === "_id") return false;
    throw error;
  }
}

export async function verifyPlatformRequest(
  request: Request,
  body: Uint8Array,
  { keys = platformRequestKeys(), now = Date.now() }: { keys?: readonly PlatformRequestKey[]; now?: number } = {}
): Promise<PlatformVerdict> {
  const keyId = request.headers.get(PLATFORM_HEADERS.keyId);
  const timestamp = request.headers.get(PLATFORM_HEADERS.timestamp);
  const nonce = request.headers.get(PLATFORM_HEADERS.nonce);
  const signature = request.headers.get(PLATFORM_HEADERS.signature);
  if (!keyId || !timestamp || !nonce || !signature || !NONCE.test(nonce) || !/^\d{1,16}$/.test(timestamp)) {
    return { ok: false, reason: "missing_headers", keyId };
  }

  const key = keys.find((candidate) => candidate.keyId === keyId);
  if (!key) return { ok: false, reason: "unknown_key", keyId };

  const url = new URL(request.url);
  const path = url.pathname + url.search;
  if (!signatureMatches(platformSigningString(request.method, path, timestamp, nonce, body), signature, key)) {
    return { ok: false, reason: "bad_signature", keyId };
  }
  if (Math.abs(now - Number(timestamp)) > PLATFORM_REQUEST_WINDOW_MS) return { ok: false, reason: "stale_timestamp", keyId };
  if (!(await claimNonce(keyId, nonce, now))) return { ok: false, reason: "replayed_nonce", keyId };
  return { ok: true, keyId };
}
