import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";

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

    const sealed = encryptSecret("ghp_supersecret");

    expect(sealed).not.toContain("ghp_supersecret");
    expect(decryptSecret(sealed)).toBe("ghp_supersecret");
  });

  it("refuses to hand back plaintext when no key is configured", async () => {
    const { encryptSecret } = await load();

    expect(() => encryptSecret("ghp_supersecret")).toThrowError(/ENCRYPTION_KEY is not configured/);
  });

  it("stamps the envelope with the id of the key that wrote it", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const { encryptSecret } = await load();

    expect(encryptSecret("x")).toMatch(/^enc:v2:[0-9a-f]{8}:/);
  });
});

describe("assertEncryptionConfig", () => {
  it("refuses a key that is not 32 bytes rather than treating it as absent", async () => {
    process.env.ENCRYPTION_KEY = "too-short";

    await expect(load()).rejects.toThrowError(/not 32 bytes/);
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
    const sealed = before.encryptSecret("gitlab-token");

    process.env.ENCRYPTION_KEY = KEY_B;
    process.env.ENCRYPTION_KEYS_OLD = KEY_A;
    const after = await load();

    expect(after.decryptSecret(sealed)).toBe("gitlab-token");
  });

  it("names the missing key id when the key that wrote a secret is gone", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const before = await load();
    const sealed = before.encryptSecret("gitlab-token");
    const id = sealed.split(":")[2];

    process.env.ENCRYPTION_KEY = KEY_B;
    const after = await load();

    expect(() => after.decryptSecret(sealed)).toThrowError(new RegExp(`key matches id ${id}`));
  });

  it("still reads a v1 envelope written before key ids existed", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const { decryptSecret } = await load();

    const material = Buffer.from(KEY_A, "hex");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", material, iv);
    const enc = Buffer.concat([cipher.update("legacy", "utf8"), cipher.final()]);
    const v1 = "enc:v1:" + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");

    expect(decryptSecret(v1)).toBe("legacy");
  });

  it("tries every configured key against a v1 envelope, which carries no id", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const { decryptSecret } = await load();

    const material = Buffer.from(KEY_B, "base64");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", material, iv);
    const enc = Buffer.concat([cipher.update("legacy", "utf8"), cipher.final()]);
    const v1 = "enc:v1:" + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");

    expect(() => decryptSecret(v1)).toThrowError(/No configured encryption key can read/);

    process.env.ENCRYPTION_KEYS_OLD = KEY_B;
    const after = await load();
    expect(after.decryptSecret(v1)).toBe("legacy");
  });
});

describe("decryptSecret", () => {
  it("passes a value that was never encrypted straight through", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const { decryptSecret } = await load();

    expect(decryptSecret("plain-legacy-token")).toBe("plain-legacy-token");
    expect(decryptSecret("")).toBe("");
  });
});
