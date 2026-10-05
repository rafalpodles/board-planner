import { Types } from "mongoose";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";

const TEST_ORGANISATION = new Types.ObjectId("000000000000000000000001");


const KEY_A = crypto.randomBytes(32).toString("hex");
const KEY_B = crypto.randomBytes(32).toString("base64");

async function load() {
  vi.resetModules();
  return import("./encryption");
}

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEYS_OLD;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("encryptSecret", () => {
  it("round-trips a secret", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const { encryptSecret, decryptSecret } = await load();

    const sealed = encryptSecret("ghp_supersecret", TEST_ORGANISATION);

    expect(sealed).not.toContain("ghp_supersecret");
    expect(decryptSecret(sealed, TEST_ORGANISATION)).toBe("ghp_supersecret");
  });

  // BP-282: with no key it used to return the plaintext, which was then stored as-is.
  // A deployment that forgot the variable was indistinguishable from an encrypted one.
  it("refuses to hand back plaintext when no key is configured", async () => {
    const { encryptSecret } = await load();

    expect(() => encryptSecret("ghp_supersecret", TEST_ORGANISATION)).toThrowError(/ENCRYPTION_KEY is not configured/);
  });

  it("stamps the envelope with the id of the key that wrote it", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const { encryptSecret } = await load();

    expect(encryptSecret("x", TEST_ORGANISATION)).toMatch(/^enc:v3:[0-9a-f]{8}:/);
  });
});

describe("assertEncryptionConfig", () => {
  // BP-282: a wrong-length key yielded null and was treated as "no key", so it failed
  // open in exactly the same silent way as a missing one
  it("refuses a key that is not 32 bytes rather than treating it as absent", async () => {
    process.env.ENCRYPTION_KEY = "too-short";

    await expect(load()).rejects.toThrowError(/not 32 bytes/);
  });

  // BP-324: a 43-character phrase decodes to 32 bytes under Node's lenient decoder
  it("refuses a passphrase that merely decodes to 32 bytes", async () => {
    process.env.ENCRYPTION_KEY = "correct-horse-battery-staple-please-work-ok";
    expect(Buffer.from(process.env.ENCRYPTION_KEY, "base64")).toHaveLength(32);

    await expect(load()).rejects.toThrowError(/not 32 bytes of hex or base64/);
  });

  // Valid alphabet and 32 bytes; only the set trailing bits show no key was ever encoded as this
  it("refuses base64 whose unused trailing bits are set", async () => {
    const canonical = KEY_B.replace(/=$/, "");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const last = alphabet.indexOf(canonical[42]);
    process.env.ENCRYPTION_KEY = canonical.slice(0, 42) + alphabet[last | 1];
    expect(Buffer.from(process.env.ENCRYPTION_KEY, "base64")).toHaveLength(32);

    await expect(load()).rejects.toThrowError(/not 32 bytes of hex or base64/);
  });

  it("still accepts genuine base64, padded or not, and genuine hex", async () => {
    for (const key of [KEY_A, KEY_B, KEY_B.replace(/=$/, "")]) {
      process.env.ENCRYPTION_KEY = key;
      const { encryptSecret, decryptSecret } = await load();
      expect(decryptSecret(encryptSecret("ghp_supersecret", TEST_ORGANISATION), TEST_ORGANISATION)).toBe("ghp_supersecret");
    }
  });

  it("refuses a retired key that does not parse", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    process.env.ENCRYPTION_KEYS_OLD = "nonsense";

    await expect(load()).rejects.toThrowError(/ENCRYPTION_KEYS_OLD/);
  });

  it("refuses retired keys with no current key", async () => {
    process.env.ENCRYPTION_KEYS_OLD = KEY_B;

    await expect(load()).rejects.toThrowError(/only make sense alongside/);
  });

  it("warns, and starts, when no key is configured at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { isEncryptionConfigured } = await load();

    expect(isEncryptionConfigured()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ENCRYPTION_KEY is not configured"));
    warn.mockRestore();
  });
});

describe("rotation", () => {
  it("reads a secret written by a key that has since been retired", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const before = await load();
    const sealed = before.encryptSecret("gitlab-token", TEST_ORGANISATION);

    process.env.ENCRYPTION_KEY = KEY_B;
    process.env.ENCRYPTION_KEYS_OLD = KEY_A;
    const after = await load();

    expect(after.decryptSecret(sealed, TEST_ORGANISATION)).toBe("gitlab-token");
  });

  // Without the key id this was the whole failure mode: every stored secret threw at
  // use time, inside a sync or a token refresh rather than at deploy
  it("names the missing key id when the key that wrote a secret is gone", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const before = await load();
    const sealed = before.encryptSecret("gitlab-token", TEST_ORGANISATION);
    const id = sealed.split(":")[2];

    process.env.ENCRYPTION_KEY = KEY_B;
    const after = await load();

    expect(() => after.decryptSecret(sealed, TEST_ORGANISATION)).toThrowError(new RegExp(`key matches id ${id}`));
  });

  it("still reads a v1 envelope written before key ids existed", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const { decryptSecret } = await load();

    const material = Buffer.from(KEY_A, "hex");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", material, iv);
    const enc = Buffer.concat([cipher.update("legacy", "utf8"), cipher.final()]);
    const v1 = "enc:v1:" + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");

    expect(decryptSecret(v1, TEST_ORGANISATION)).toBe("legacy");
  });

  it("tries every configured key against a v1 envelope, which carries no id", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const { decryptSecret } = await load();

    const material = Buffer.from(KEY_B, "base64");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", material, iv);
    const enc = Buffer.concat([cipher.update("legacy", "utf8"), cipher.final()]);
    const v1 = "enc:v1:" + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");

    expect(() => decryptSecret(v1, TEST_ORGANISATION)).toThrowError(/No configured encryption key can read/);

    process.env.ENCRYPTION_KEYS_OLD = KEY_B;
    const after = await load();
    expect(after.decryptSecret(v1, TEST_ORGANISATION)).toBe("legacy");
  });
});

describe("decryptSecret", () => {
  it("passes a value that was never encrypted straight through", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const { decryptSecret } = await load();

    expect(decryptSecret("plain-legacy-token", TEST_ORGANISATION)).toBe("plain-legacy-token");
    expect(decryptSecret("", TEST_ORGANISATION)).toBe("");
  });
});

/**
 * BP-372. This predicate is the only thing standing between a value written before that change
 * and a second pass of `encryptSecret` over its own envelope, so each branch is named rather than
 * reached through `encryptSecret`, which only ever writes v2.
 */
describe("isEncryptedSecret", () => {
  it("recognises both envelopes, including the v1 one nothing writes any more", async () => {
    const { isEncryptedSecret, encryptSecret } = await load();
    process.env.ENCRYPTION_KEY = KEY_A;

    expect(isEncryptedSecret("enc:v1:" + Buffer.from("anything").toString("base64"))).toBe(true);
    expect(isEncryptedSecret("enc:v2:deadbeef:" + Buffer.from("anything").toString("base64"))).toBe(true);
    expect(isEncryptedSecret(encryptSecret("https://hooks.slack.com/services/T/B/x", TEST_ORGANISATION))).toBe(true);
  });

  it("says no to a plaintext URL, to a near-miss prefix, and to nothing at all", async () => {
    const { isEncryptedSecret } = await load();

    expect(isEncryptedSecret("https://hooks.slack.com/services/T/B/x")).toBe(false);
    expect(isEncryptedSecret("enc:v4:deadbeef:zzz")).toBe(false);
    expect(isEncryptedSecret("enc:")).toBe(false);
    expect(isEncryptedSecret("")).toBe(false);
    expect(isEncryptedSecret(undefined)).toBe(false);
    expect(isEncryptedSecret(null)).toBe(false);
  });
});

// BP-735. The board feed asks the database which stored webhooks are deliverable, so these
// patterns have to agree with what decryptSecret will actually open.
describe("readableSecretPatterns", () => {
  const readable = (patterns: RegExp[], value: string) => patterns.some((p) => p.test(value));

  it("agrees with decryptSecret on plaintext, the current key's envelope and a lost key's", async () => {
    process.env.ENCRYPTION_KEY = KEY_B;
    const lost = (await load()).encryptSecret("https://hooks.example.com/lost", TEST_ORGANISATION);
    process.env.ENCRYPTION_KEY = KEY_A;
    const current = (await load()).encryptSecret("https://hooks.example.com/current", TEST_ORGANISATION);
    const { readableSecretPatterns, decryptSecret } = await load();
    const patterns = readableSecretPatterns();

    for (const value of [current, lost, "https://hooks.example.com/plain"]) {
      let opens = true;
      try {
        decryptSecret(value, TEST_ORGANISATION);
      } catch {
        opens = false;
      }
      expect(readable(patterns, value), value).toBe(opens);
    }
    expect(readable(patterns, lost)).toBe(false);
  });

  it("admits a retired key's envelope while that key stays configured", async () => {
    process.env.ENCRYPTION_KEY = KEY_B;
    const retired = (await load()).encryptSecret("x", TEST_ORGANISATION);
    process.env.ENCRYPTION_KEY = KEY_A;
    process.env.ENCRYPTION_KEYS_OLD = KEY_B;
    const { readableSecretPatterns } = await load();

    expect(readable(readableSecretPatterns(), retired)).toBe(true);
  });

  it("admits no envelope at all when no key is configured", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const sealed = (await load()).encryptSecret("x", TEST_ORGANISATION);
    delete process.env.ENCRYPTION_KEY;
    const { readableSecretPatterns } = await load();
    const patterns = readableSecretPatterns();

    expect(readable(patterns, sealed)).toBe(false);
    expect(readable(patterns, "enc:v1:abc")).toBe(false);
    expect(readable(patterns, "https://hooks.example.com/plain")).toBe(true);
  });
});

describe("a data key per organisation (BP-898)", () => {
  const OTHER = new Types.ObjectId("0000000000000000000000b2");

  // The v2 envelope as the release before wrote it: the instance key itself, no organisation
  function legacyV2(plaintext: string, raw: string): string {
    const material = /^[0-9a-f]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    const id = crypto.createHash("sha256").update(material).digest("hex").slice(0, 8);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", material, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `enc:v2:${id}:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64")}`;
  }

  it("does not open one organisation's secret for another, though both hold the same instance key", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const { encryptSecret, decryptSecret } = await load();
    const sealed = encryptSecret("ghp_acme", TEST_ORGANISATION);

    expect(decryptSecret(sealed, TEST_ORGANISATION)).toBe("ghp_acme");
    expect(() => decryptSecret(sealed, OTHER)).toThrow(/another organisation/);
  });

  it("is not the instance key: the same secret seals differently for two organisations, and not as v2", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const { encryptSecret, isInstanceKeySecret } = await load();

    const sealed = encryptSecret("ghp", TEST_ORGANISATION);
    expect(sealed.startsWith("enc:v3:")).toBe(true);
    expect(isInstanceKeySecret(sealed)).toBe(false);
  });

  it("still reads a secret written under the instance key before, for any organisation", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const { decryptSecret, isInstanceKeySecret } = await load();
    const old = legacyV2("ghp_old", KEY_A);

    expect(isInstanceKeySecret(old)).toBe(true);
    expect(decryptSecret(old, TEST_ORGANISATION)).toBe("ghp_old");
    expect(decryptSecret(old, OTHER)).toBe("ghp_old");
  });

  it("survives a rotation: a v3 secret written under a retired key opens once that key is in ENCRYPTION_KEYS_OLD", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const sealed = (await load()).encryptSecret("ghp_rotated", TEST_ORGANISATION);

    process.env.ENCRYPTION_KEY = KEY_B;
    process.env.ENCRYPTION_KEYS_OLD = KEY_A;
    const after = await load();
    expect(after.decryptSecret(sealed, TEST_ORGANISATION)).toBe("ghp_rotated");
    expect(after.readableSecretPatterns().some((pattern) => pattern.test(sealed))).toBe(true);

    delete process.env.ENCRYPTION_KEYS_OLD;
    const lost = await load();
    expect(() => lost.decryptSecret(sealed, TEST_ORGANISATION)).toThrow(/No configured encryption key/);
    expect(lost.readableSecretPatterns().some((pattern) => pattern.test(sealed))).toBe(false);
  });
});
