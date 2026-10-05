import crypto from "crypto";
import type { Types } from "mongoose";

// AES-256-GCM encryption for secrets at rest (e.g. project GitHub tokens).
// ENCRYPTION_KEY is the key new secrets are written with; ENCRYPTION_KEYS_OLD
// is a comma-separated list of retired keys kept so a rotation can still read
// what they wrote. Both are 32 bytes, hex or base64.
//
// The v2 envelope carries a key id, so a value names the key that wrote it.
// v1 values carry no id and are tried against every configured key.
// v3 (BP-898) is v2 under the organisation's own data key, derived from the instance key and the
// organisation's id: a secret copied onto another organisation's row does not decrypt there.

const PREFIX_V1 = "enc:v1:";
const PREFIX_V2 = "enc:v2:";
const PREFIX_V3 = "enc:v3:";

interface EncryptionKey {
  id: string;
  material: Buffer;
}

const CONVERT_TO_HEX = `node -e 'console.log(Buffer.from(process.env.ENCRYPTION_KEY.trim(), "base64").toString("hex"))'`;

function parseKeyMaterial(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const key = Buffer.from(trimmed, "base64");
  // Node's decoder is lenient, so only a value that re-encodes to itself was ever base64
  if (key.length !== 32 || key.toString("base64").replace(/=$/, "") !== trimmed.replace(/=$/, "")) {
    return null;
  }
  return key;
}

function keyIdOf(material: Buffer): string {
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 8);
}

function toKey(raw: string): EncryptionKey | null {
  const material = parseKeyMaterial(raw);
  return material ? { id: keyIdOf(material), material } : null;
}

function retiredRaw(): string[] {
  return (process.env.ENCRYPTION_KEYS_OLD ?? "").split(",").map((k) => k.trim()).filter(Boolean);
}

function primaryKey(): EncryptionKey | null {
  return process.env.ENCRYPTION_KEY ? toKey(process.env.ENCRYPTION_KEY) : null;
}

function allKeys(): EncryptionKey[] {
  const keys = [primaryKey(), ...retiredRaw().map(toKey)];
  return keys.filter((k): k is EncryptionKey => k !== null);
}

/**
 * A malformed key used to yield null and be treated as "not configured", so a
 * deployment that fumbled the variable was indistinguishable from one that never
 * set it — and wrote plaintext either way.
 */
export function assertEncryptionConfig(): void {
  const raw = process.env.ENCRYPTION_KEY?.trim();

  if (raw && !parseKeyMaterial(raw)) {
    throw new Error(
      `ENCRYPTION_KEY is set but is not 32 bytes of hex or base64. base64url, a passphrase, or a value with spaces or quotes inside is refused. If secrets were already saved with this value, keep the same bytes rather than generating a new key — ${CONVERT_TO_HEX} prints them as hex to set instead.`
    );
  }

  const badRetired = retiredRaw().filter((k) => !parseKeyMaterial(k));
  if (badRetired.length > 0) {
    throw new Error(
      `ENCRYPTION_KEYS_OLD contains ${badRetired.length} value(s) that are not 32 bytes of hex or base64. Every retired key must parse, or a secret it wrote can no longer be read — convert each to hex the way the ENCRYPTION_KEY message describes.`
    );
  }

  if (!raw) {
    if (retiredRaw().length > 0) {
      throw new Error(
        "ENCRYPTION_KEYS_OLD is set without ENCRYPTION_KEY. Retired keys only make sense alongside the key that replaced them."
      );
    }
    console.warn(
      "ENCRYPTION_KEY is not configured — integration tokens (GitHub, GitLab, Coda, MCP) and chat webhook URLs (a project's team channels, and each person's own) cannot be stored. Set it to 32 bytes of hex or base64: openssl rand -hex 32"
    );
  }
}

assertEncryptionConfig();

export function isEncryptionConfigured(): boolean {
  return primaryKey() !== null;
}

/**
 * Stored values whose envelope names a key configured now, as patterns a query can match:
 * plaintext, a v2 value by its key id, and any v1 value once some key exists, since v1 carries no
 * id. A match is not a promise that `decryptSecret` succeeds — a corrupt payload matches too.
 */
export function readableSecretPatterns(): RegExp[] {
  const keys = allKeys();
  return [
    new RegExp(`^(?!${PREFIX_V1}|${PREFIX_V2}|${PREFIX_V3})`),
    ...(keys.length > 0 ? [new RegExp(`^${PREFIX_V1}`)] : []),
    ...keys.map((key) => new RegExp(`^${PREFIX_V2}${key.id}:`)),
    ...keys.map((key) => new RegExp(`^${PREFIX_V3}${key.id}:`)),
  ];
}

export function isEncryptedSecret(value: string | undefined | null): boolean {
  return !!value && (value.startsWith(PREFIX_V1) || value.startsWith(PREFIX_V2) || value.startsWith(PREFIX_V3));
}

// Written before BP-898 under the instance key itself, and so readable for any organisation
export function isInstanceKeySecret(value: string | undefined | null): boolean {
  return !!value && (value.startsWith(PREFIX_V1) || value.startsWith(PREFIX_V2));
}

function organisationKey(material: Buffer, organisation: Types.ObjectId): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", material, Buffer.alloc(0), `board-planner:organisation:${organisation.toHexString()}`, 32));
}

export function encryptSecret(plaintext: string, organisation: Types.ObjectId): string {
  if (!plaintext) return plaintext;
  const key = primaryKey();
  if (!key) {
    throw new Error(
      "ENCRYPTION_KEY is not configured, so this secret cannot be stored. Set it to 32 bytes of hex or base64 and try again."
    );
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", organisationKey(key.material, organisation), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX_V3 + key.id + ":" + Buffer.concat([iv, tag, enc]).toString("base64");
}

function open(payload: string, material: Buffer): string {
  const buf = Buffer.from(payload, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", material, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

export function decryptSecret(value: string, organisation: Types.ObjectId): string {
  if (!value) return value;

  if (value.startsWith(PREFIX_V3)) {
    const rest = value.slice(PREFIX_V3.length);
    const separator = rest.indexOf(":");
    const id = rest.slice(0, separator);
    const key = allKeys().find((k) => k.id === id);
    if (!key) {
      throw new Error(
        `No configured encryption key matches id ${id}. Add the key that wrote this secret to ENCRYPTION_KEYS_OLD, or re-enter the secret.`
      );
    }
    try {
      return open(rest.slice(separator + 1), organisationKey(key.material, organisation));
    } catch {
      throw new Error("This secret belongs to another organisation, or was altered. Re-enter it.");
    }
  }

  if (value.startsWith(PREFIX_V2)) {
    const rest = value.slice(PREFIX_V2.length);
    const separator = rest.indexOf(":");
    const id = rest.slice(0, separator);
    const key = allKeys().find((k) => k.id === id);
    if (!key) {
      throw new Error(
        `No configured encryption key matches id ${id}. Add the key that wrote this secret to ENCRYPTION_KEYS_OLD, or re-enter the secret.`
      );
    }
    return open(rest.slice(separator + 1), key.material);
  }

  if (!value.startsWith(PREFIX_V1)) return value; // legacy plaintext

  // v1 carries no key id, so every configured key is a candidate
  const keys = allKeys();
  if (keys.length === 0) {
    throw new Error("ENCRYPTION_KEY is required to decrypt a stored secret");
  }
  for (const key of keys) {
    try {
      return open(value.slice(PREFIX_V1.length), key.material);
    } catch {
      // GCM rejected this key — try the next
    }
  }
  throw new Error(
    "No configured encryption key can read this secret. Add the key that wrote it to ENCRYPTION_KEYS_OLD, or re-enter the secret."
  );
}
