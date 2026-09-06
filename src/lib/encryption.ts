import crypto from "crypto";

const PREFIX_V1 = "enc:v1:";
const PREFIX_V2 = "enc:v2:";

interface EncryptionKey {
  id: string;
  material: Buffer;
}

function parseKeyMaterial(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  return key.length === 32 ? key : null;
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

export function assertEncryptionConfig(): void {
  const raw = process.env.ENCRYPTION_KEY?.trim();

  if (raw && !parseKeyMaterial(raw)) {
    throw new Error(
      "ENCRYPTION_KEY is set but is not 32 bytes of hex or base64. Fix it or unset it — a malformed key is not the same as no key, and must not be treated as one."
    );
  }

  const badRetired = retiredRaw().filter((k) => !parseKeyMaterial(k));
  if (badRetired.length > 0) {
    throw new Error(
      `ENCRYPTION_KEYS_OLD contains ${badRetired.length} value(s) that are not 32 bytes of hex or base64. Every retired key must parse, or a secret it wrote can no longer be read.`
    );
  }

  if (!raw) {
    if (retiredRaw().length > 0) {
      throw new Error(
        "ENCRYPTION_KEYS_OLD is set without ENCRYPTION_KEY. Retired keys only make sense alongside the key that replaced them."
      );
    }
    console.warn(
      "ENCRYPTION_KEY is not configured — integration tokens (GitHub, GitLab, Coda, MCP) cannot be stored. Set it to 32 bytes of hex or base64: openssl rand -hex 32"
    );
  }
}

assertEncryptionConfig();

export function isEncryptionConfigured(): boolean {
  return primaryKey() !== null;
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return plaintext;
  const key = primaryKey();
  if (!key) {
    throw new Error(
      "ENCRYPTION_KEY is not configured, so this secret cannot be stored. Set it to 32 bytes of hex or base64 and try again."
    );
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key.material, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX_V2 + key.id + ":" + Buffer.concat([iv, tag, enc]).toString("base64");
}

function open(payload: string, material: Buffer): string {
  const buf = Buffer.from(payload, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", material, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

export function decryptSecret(value: string): string {
  if (!value) return value;

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

  const keys = allKeys();
  if (keys.length === 0) {
    throw new Error("ENCRYPTION_KEY is required to decrypt a stored secret");
  }
  for (const key of keys) {
    try {
      return open(value.slice(PREFIX_V1.length), key.material);
    } catch {
    }
  }
  throw new Error(
    "No configured encryption key can read this secret. Add the key that wrote it to ENCRYPTION_KEYS_OLD, or re-enter the secret."
  );
}
