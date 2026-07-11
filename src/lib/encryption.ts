import crypto from "crypto";

// AES-256-GCM encryption for secrets at rest (e.g. project GitHub tokens).
// Key comes from the ENCRYPTION_KEY env var (32 bytes, hex or base64).
// Backward compatible: values without the prefix are treated as legacy
// plaintext, and if no key is configured, values are stored as-is.

const PREFIX = "enc:v1:";

function getKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export function isEncryptionConfigured(): boolean {
  return getKey() !== null;
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return plaintext;
  const key = getKey();
  if (!key) return plaintext; // not configured — keep as-is
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(value: string): string {
  if (!value || !value.startsWith(PREFIX)) return value; // legacy plaintext or empty
  const key = getKey();
  if (!key) throw new Error("ENCRYPTION_KEY is required to decrypt a stored secret");
  const buf = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
