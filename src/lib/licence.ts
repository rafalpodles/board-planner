import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { ENTITLEMENT_GRACE_MS, type Plan } from "./entitlements";
import { e2eOnlyMounted } from "./e2e-only";
import { LICENCE_PUBLIC_KEYS, type LicencePublicKey } from "./licence-keys";
import type { IOrganisationEntitlements } from "@/models/organisation";

export interface LicencePayload {
  // 2 for a key bound to an organisation, so a release that predates the claim refuses it rather
  // than reading it as floating
  v: 1 | 2;
  customer: string;
  plan: Plan;
  features: string[];
  issuedAt: string;
  expiresAt: string;
  keyId: string;
  organisation?: string;
}

export type LicenceVerdict =
  | "valid"
  | "grace"
  | "expired"
  | "invalid_signature"
  | "unknown_key"
  | "malformed"
  | "wrong_organisation";

export type LicenceRefusal = "invalid_signature" | "unknown_key" | "malformed" | "wrong_organisation";

export type LicenceCheck =
  | { verdict: "valid" | "grace" | "expired"; payload: LicencePayload }
  | { verdict: LicenceRefusal; payload?: undefined };

export interface LicenceSigningKey {
  keyId: string;
  d: string;
  x: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ED25519_SIGNATURE_BYTES = 64;

function canonicalPayload(payload: LicencePayload): string {
  return JSON.stringify({
    v: payload.v,
    customer: payload.customer,
    plan: payload.plan,
    features: payload.features,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    keyId: payload.keyId,
    ...(payload.organisation === undefined ? {} : { organisation: payload.organisation }),
  });
}

export function parseSigningKey(raw: string): LicenceSigningKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The signing key is not JSON; expected the line generate-licence-keypair printed");
  }
  const { keyId, d, x } = (parsed ?? {}) as Record<string, unknown>;
  if (typeof keyId !== "string" || typeof d !== "string" || typeof x !== "string" || !keyId) {
    throw new Error("The signing key needs keyId, d and x");
  }
  return { keyId, d, x };
}

export function signLicence(
  payload: Omit<LicencePayload, "v" | "keyId">,
  signingKey: LicenceSigningKey
): string {
  const body = Buffer.from(
    canonicalPayload({ ...payload, v: payload.organisation === undefined ? 1 : 2, keyId: signingKey.keyId }),
    "utf8"
  );
  const privateKey = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: signingKey.d, x: signingKey.x },
    format: "jwk",
  });
  const signature = sign(null, body, privateKey);
  return `${body.toString("base64url")}.${signature.toString("base64url")}`;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function asPayload(value: unknown): LicencePayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (p.v !== 1 && p.v !== 2) return null;
  if ((p.v === 2) !== (p.organisation !== undefined)) return null;
  if (typeof p.customer !== "string" || !p.customer.trim()) return null;
  if (p.plan !== "free" && p.plan !== "pro") return null;
  if (!Array.isArray(p.features) || !p.features.every((f) => typeof f === "string")) return null;
  if (!isIsoDate(p.issuedAt) || !isIsoDate(p.expiresAt)) return null;
  if (typeof p.keyId !== "string" || !p.keyId) return null;
  if (p.organisation !== undefined && (typeof p.organisation !== "string" || !/^[0-9a-f]{24}$/.test(p.organisation))) return null;
  return {
    v: p.v,
    customer: p.customer,
    plan: p.plan,
    features: p.features as string[],
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
    keyId: p.keyId,
    ...(p.organisation === undefined ? {} : { organisation: p.organisation }),
  };
}

export interface LicenceReader {
  keys?: readonly LicencePublicKey[];
  now?: number;
  // The organisation reading the key: a key naming another is refused
  organisation?: string;
  // A key stored on an organisation must name it; only the environment's key may float
  bound?: boolean;
}

export function verifyLicenceKey(
  key: string,
  { keys = LICENCE_PUBLIC_KEYS, now = Date.now(), organisation, bound = false }: LicenceReader = {}
): LicenceCheck {
  const parts = key.trim().split(".");
  if (parts.length !== 2 || !parts.every((part) => BASE64URL.test(part))) {
    return { verdict: "malformed" };
  }
  const body = Buffer.from(parts[0], "base64url");
  const signature = Buffer.from(parts[1], "base64url");
  if (signature.length !== ED25519_SIGNATURE_BYTES) return { verdict: "malformed" };

  let payload: LicencePayload | null;
  try {
    payload = asPayload(JSON.parse(body.toString("utf8")));
  } catch {
    payload = null;
  }
  if (!payload) return { verdict: "malformed" };

  const publicKey = keys.find((k) => k.keyId === payload.keyId);
  if (!publicKey) return { verdict: "unknown_key" };

  let signed: boolean;
  try {
    signed = verify(
      null,
      body,
      createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey.x }, format: "jwk" }),
      signature
    );
  } catch {
    signed = false;
  }
  if (!signed) return { verdict: "invalid_signature" };
  if (bound && payload.organisation === undefined) return { verdict: "wrong_organisation" };
  if (payload.organisation !== undefined && payload.organisation !== organisation) return { verdict: "wrong_organisation" };

  const expiresAt = Date.parse(payload.expiresAt);
  if (now <= expiresAt) return { verdict: "valid", payload };
  if (now <= expiresAt + ENTITLEMENT_GRACE_MS) return { verdict: "grace", payload };
  return { verdict: "expired", payload };
}

declare global {
  // Survives Turbopack giving each route its own copy of this module
  var __bpE2eLicenceKey: { key: string | undefined } | undefined;
}

export function setE2eLicenceKey(key: string | undefined): void {
  globalThis.__bpE2eLicenceKey = { key };
}

// Build-inlined on purpose: `next start` keeps an exported NODE_ENV, so `env.NODE_ENV` would let an operator in
export function licenceKeysInEffect(
  env: NodeJS.ProcessEnv = process.env,
  nodeEnv: string | undefined = process.env.NODE_ENV
): readonly LicencePublicKey[] {
  if (e2eOnlyMounted(env.E2E, nodeEnv) && env.E2E_LICENCE_PUBLIC_KEY) {
    return [...LICENCE_PUBLIC_KEYS, { keyId: "e2e", x: env.E2E_LICENCE_PUBLIC_KEY }];
  }
  return LICENCE_PUBLIC_KEYS;
}

function licenceKeyInEffect(env: NodeJS.ProcessEnv, nodeEnv: string | undefined): string | undefined {
  const override = e2eOnlyMounted(env.E2E, nodeEnv) ? globalThis.__bpE2eLicenceKey : undefined;
  const key = override ? override.key : env.LICENCE_KEY;
  return key?.trim() ? key : undefined;
}

// `null` when no LICENCE_KEY is set, so the caller can tell "no key" from "a key that failed"
// The environment's key floats: one naming an organisation is refused, because the default
// organisation has the same id on every instance and a cloud key for it would unlock them all
export function currentLicence(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
  nodeEnv: string | undefined = process.env.NODE_ENV
): LicenceCheck | null {
  const key = licenceKeyInEffect(env, nodeEnv);
  if (!key) return null;
  return verifyLicenceKey(key, { keys: licenceKeysInEffect(env, nodeEnv), now });
}

// A key the licence service stored on the organisation: it must name that organisation, so a key
// copied onto another one does not verify
export function storedLicence(
  key: string | undefined | null,
  organisation: string,
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
  nodeEnv: string | undefined = process.env.NODE_ENV
): LicenceCheck | null {
  if (!key?.trim()) return null;
  return verifyLicenceKey(key, { keys: licenceKeysInEffect(env, nodeEnv), now, organisation, bound: true });
}

// `null` means the licence grants nothing and the stored entitlements stand
export function entitlementsFromLicence(
  check: LicenceCheck | null,
  source: "env" | "service" = "env"
): IOrganisationEntitlements | null {
  if (!check?.payload) return null;
  if (check.verdict === "expired") {
    return { plan: "free", features: [], source };
  }
  return {
    plan: check.payload.plan,
    features: check.payload.features,
    customer: check.payload.customer,
    issuedAt: new Date(check.payload.issuedAt),
    expiresAt: new Date(check.payload.expiresAt),
    source,
  };
}

export function describeLicenceAtStartup(check: LicenceCheck | null): string {
  if (!check) return "LICENCE_KEY is not set — Free plan";
  switch (check.verdict) {
    case "valid":
      return `LICENCE_KEY: ${check.payload.plan} plan for ${check.payload.customer}, expires ${check.payload.expiresAt}`;
    case "grace":
      return `LICENCE_KEY expired ${check.payload.expiresAt} and stays in force until ${new Date(
        Date.parse(check.payload.expiresAt) + ENTITLEMENT_GRACE_MS
      ).toISOString()} — renew it before then`;
    case "expired":
      return `LICENCE_KEY expired ${check.payload.expiresAt}, past its grace period — Free plan`;
    case "unknown_key":
      return "LICENCE_KEY was signed by a key this build does not know — Free plan";
    case "invalid_signature":
      return "LICENCE_KEY has a signature that does not match its contents — Free plan";
    case "malformed":
      return "LICENCE_KEY is not a licence key (truncated or mistyped?) — Free plan";
    case "wrong_organisation":
      return "LICENCE_KEY was issued for another organisation — Free plan";
  }
}
