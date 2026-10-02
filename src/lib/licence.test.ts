import { describe, it, expect } from "vitest";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import {
  currentLicence,
  entitlementsFromLicence,
  licenceKeysInEffect,
  parseSigningKey,
  signLicence,
  verifyLicenceKey,
  type LicenceSigningKey,
} from "./licence";
import { ENTITLEMENT_GRACE_MS } from "./entitlements";
import { LICENCE_PUBLIC_KEYS, type LicencePublicKey } from "./licence-keys";

function keypair(keyId: string): { signing: LicenceSigningKey; public: LicencePublicKey } {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return { signing: { keyId, d: jwk.d!, x: jwk.x! }, public: { keyId, x: jwk.x! } };
}

const OLD = keypair("old");
const NEW = keypair("new");
const BOTH = [OLD.public, NEW.public];

const EXPIRES = Date.parse("2027-01-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function licence(signing = OLD.signing, overrides: Partial<{ customer: string; expiresAt: string }> = {}) {
  return signLicence(
    {
      customer: "Acme Ltd",
      plan: "pro",
      features: [],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: new Date(EXPIRES).toISOString(),
      ...overrides,
    },
    signing
  );
}

function flipLastSignatureChar(key: string): string {
  const [body, signature] = key.split(".");
  // The second-to-last char: the last one of 86 carries only 4 significant bits of the 64 bytes
  const i = signature.length - 2;
  const flipped = signature[i] === "A" ? "B" : "A";
  return `${body}.${signature.slice(0, i)}${flipped}${signature.slice(i + 1)}`;
}

describe("verifyLicenceKey", () => {
  const before = EXPIRES - 10 * DAY;

  it("accepts a key it signed and returns the payload", () => {
    const check = verifyLicenceKey(licence(), { keys: BOTH, now: before });

    expect(check.verdict).toBe("valid");
    expect(check.payload).toMatchObject({ v: 1, customer: "Acme Ltd", plan: "pro", keyId: "old" });
  });

  it("verifies a licence signed by either key in the list", () => {
    expect(verifyLicenceKey(licence(OLD.signing), { keys: BOTH, now: before }).verdict).toBe("valid");
    expect(verifyLicenceKey(licence(NEW.signing), { keys: BOTH, now: before }).verdict).toBe("valid");
  });

  it("calls a licence unknown_key once its signing key is removed from the list", () => {
    expect(verifyLicenceKey(licence(OLD.signing), { keys: [NEW.public], now: before }).verdict).toBe(
      "unknown_key"
    );
    expect(verifyLicenceKey(licence(NEW.signing), { keys: [NEW.public], now: before }).verdict).toBe(
      "valid"
    );
  });

  it("refuses a signature with one character changed", () => {
    const key = licence();
    expect(verifyLicenceKey(key, { keys: BOTH, now: before }).verdict).toBe("valid");

    expect(verifyLicenceKey(flipLastSignatureChar(key), { keys: BOTH, now: before })).toEqual({
      verdict: "invalid_signature",
    });
  });

  it("refuses a payload edited to another customer while keeping the old signature", () => {
    const [, signature] = licence().split(".");
    const [forgedBody] = licence(OLD.signing, { customer: "Someone Else" }).split(".");

    expect(verifyLicenceKey(`${forgedBody}.${signature}`, { keys: BOTH, now: before })).toEqual({
      verdict: "invalid_signature",
    });
  });

  it("refuses a payload whose keyId was swapped to another trusted key", () => {
    const [body, signature] = licence(OLD.signing).split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const swapped = Buffer.from(JSON.stringify({ ...payload, keyId: "new" })).toString("base64url");

    expect(verifyLicenceKey(`${swapped}.${signature}`, { keys: BOTH, now: before }).verdict).toBe(
      "invalid_signature"
    );
  });

  it("calls a truncated key malformed", () => {
    const key = licence();

    expect(verifyLicenceKey(key.slice(0, -5), { keys: BOTH, now: before })).toEqual({ verdict: "malformed" });
    expect(verifyLicenceKey(key.slice(0, 40), { keys: BOTH, now: before })).toEqual({ verdict: "malformed" });
  });

  it.each([
    ["an empty string", ""],
    ["no separator", "abc"],
    ["three parts", "a.b.c"],
    ["characters outside base64url", "a+b.c/d"],
  ])("calls %s malformed", (_label, key) => {
    expect(verifyLicenceKey(key, { keys: BOTH, now: before })).toEqual({ verdict: "malformed" });
  });

  it("calls a correctly signed payload that is not a licence malformed", () => {
    const body = Buffer.from(JSON.stringify({ v: 2, keyId: "old" }));
    const privateKey = createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", d: OLD.signing.d, x: OLD.signing.x },
      format: "jwk",
    });
    const key = `${body.toString("base64url")}.${sign(null, body, privateKey).toString("base64url")}`;

    expect(verifyLicenceKey(key, { keys: BOTH, now: before })).toEqual({ verdict: "malformed" });
  });

  it("tolerates whitespace around the key, as an env file leaves it", () => {
    expect(verifyLicenceKey(`  ${licence()}\n`, { keys: BOTH, now: before }).verdict).toBe("valid");
  });

  it("is valid up to the expiry instant, in grace for 14 days after it, then expired", () => {
    const key = licence();

    expect(verifyLicenceKey(key, { keys: BOTH, now: EXPIRES }).verdict).toBe("valid");
    expect(verifyLicenceKey(key, { keys: BOTH, now: EXPIRES + 1 }).verdict).toBe("grace");
    expect(verifyLicenceKey(key, { keys: BOTH, now: EXPIRES + ENTITLEMENT_GRACE_MS }).verdict).toBe("grace");
    expect(verifyLicenceKey(key, { keys: BOTH, now: EXPIRES + ENTITLEMENT_GRACE_MS + 1 }).verdict).toBe(
      "expired"
    );
  });

  it("checks the signature before the clock, so an expired forgery is still a forgery", () => {
    const forged = flipLastSignatureChar(licence());

    expect(verifyLicenceKey(forged, { keys: BOTH, now: EXPIRES + 100 * DAY }).verdict).toBe(
      "invalid_signature"
    );
  });
});

describe("parseSigningKey", () => {
  it("reads the line generate-licence-keypair prints and signs with it", () => {
    const signing = parseSigningKey(JSON.stringify(OLD.signing));

    expect(verifyLicenceKey(licence(signing), { keys: BOTH, now: 0 }).verdict).toBe("valid");
  });

  it.each([["not JSON", "{"], ["missing d", JSON.stringify({ keyId: "a", x: "b" })]])(
    "refuses %s",
    (_label, raw) => {
      expect(() => parseSigningKey(raw)).toThrow();
    }
  );
});

describe("entitlementsFromLicence", () => {
  const valid = verifyLicenceKey(licence(), { keys: BOTH, now: EXPIRES - DAY });

  it("derives pro from a valid licence, marked as coming from the environment", () => {
    expect(entitlementsFromLicence(valid)).toEqual({
      plan: "pro",
      features: [],
      customer: "Acme Ltd",
      issuedAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date(EXPIRES),
      source: "env",
    });
  });

  it("keeps pro, with its expiry, through the grace period", () => {
    const grace = verifyLicenceKey(licence(), { keys: BOTH, now: EXPIRES + DAY });

    expect(entitlementsFromLicence(grace)).toMatchObject({ plan: "pro", expiresAt: new Date(EXPIRES) });
  });

  it("reports free once the grace period is over", () => {
    const expired = verifyLicenceKey(licence(), { keys: BOTH, now: EXPIRES + ENTITLEMENT_GRACE_MS + DAY });

    expect(entitlementsFromLicence(expired)).toEqual({ plan: "free", features: [], source: "env" });
  });

  it.each(["invalid_signature", "unknown_key", "malformed"] as const)(
    "grants nothing for %s, leaving the stored entitlements in force",
    (verdict) => {
      expect(entitlementsFromLicence({ verdict })).toBeNull();
    }
  );

  it("grants nothing when no key is set", () => {
    expect(entitlementsFromLicence(null)).toBeNull();
  });
});

describe("currentLicence", () => {
  const E2E = keypair("e2e");

  it("is null with no LICENCE_KEY, and with one that is only whitespace", () => {
    expect(currentLicence({ NODE_ENV: "production" })).toBeNull();
    expect(currentLicence({ NODE_ENV: "production", LICENCE_KEY: "  " })).toBeNull();
  });

  it("verifies LICENCE_KEY against the compiled-in keys", () => {
    expect(currentLicence({ NODE_ENV: "production", LICENCE_KEY: licence(E2E.signing) })).toEqual({
      verdict: "unknown_key",
    });
  });

  it("accepts the end-to-end suite's key only where the suite's surfaces are mounted", () => {
    const env = { E2E: "1", E2E_LICENCE_PUBLIC_KEY: E2E.public.x, LICENCE_KEY: licence(E2E.signing) };

    expect(currentLicence({ ...env, NODE_ENV: "development" }, EXPIRES - DAY)?.verdict).toBe("valid");
    expect(currentLicence({ ...env, NODE_ENV: "production" }, EXPIRES - DAY)?.verdict).toBe("unknown_key");
    expect(currentLicence({ ...env, E2E: undefined, NODE_ENV: "development" }, EXPIRES - DAY)?.verdict).toBe(
      "unknown_key"
    );
  });

  it("never drops the compiled-in keys when the suite's key is added", () => {
    const keys = licenceKeysInEffect({ E2E: "1", NODE_ENV: "development", E2E_LICENCE_PUBLIC_KEY: "x" });

    expect(keys.slice(0, LICENCE_PUBLIC_KEYS.length)).toEqual(LICENCE_PUBLIC_KEYS);
  });
});
