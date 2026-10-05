import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/models/rateLimit", () => ({ RateLimit: { create } }));

const { platformRequestKeys, signPlatformRequest, verifyPlatformRequest, PLATFORM_REQUEST_WINDOW_MS } = await import("./platform-request");

function keyPair(keyId: string) {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return { keyId, d: jwk.d!, x: jwk.x! };
}

const SERVICE = keyPair("service-2026-10");
const STRANGER = keyPair("service-2026-10");
const KEYS = [{ keyId: SERVICE.keyId, x: SERVICE.x }];
const URL_ = "https://board-planner.test/api/platform/organisations/0000000000000000000000a1/licence";
const BODY = new TextEncoder().encode(JSON.stringify({ licenceKey: "k" }));
const NOW = Date.parse("2027-01-01T12:00:00Z");

function request(headers: Record<string, string>, body: Uint8Array = BODY, url = URL_) {
  return new Request(url, { method: "POST", headers, body: Buffer.from(body) });
}

const signed = (key = SERVICE, at = NOW, body = BODY) =>
  signPlatformRequest({ method: "POST", path: new URL(URL_).pathname, body, now: at }, key);

beforeEach(() => {
  create.mockReset().mockResolvedValue({});
});

describe("verifyPlatformRequest", () => {
  it("accepts a request signed by a listed key, and claims its nonce", async () => {
    expect(await verifyPlatformRequest(request(signed()), BODY, { keys: KEYS, now: NOW })).toEqual({ ok: true, keyId: SERVICE.keyId });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ _id: expect.stringMatching(/^platform-nonce:service-2026-10:/) }));
  });

  it("refuses a request signed by another key under the same key id", async () => {
    expect(await verifyPlatformRequest(request(signed(STRANGER)), BODY, { keys: KEYS, now: NOW })).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("refuses a body changed after signing", async () => {
    const tampered = new TextEncoder().encode(JSON.stringify({ licenceKey: "other" }));
    expect(await verifyPlatformRequest(request(signed(), tampered), tampered, { keys: KEYS, now: NOW })).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("refuses a request sent to another path than the one signed", async () => {
    const elsewhere = request(signed(), BODY, URL_.replace("0000000000000000000000a1", "0000000000000000000000b2"));
    expect(await verifyPlatformRequest(elsewhere, BODY, { keys: KEYS, now: NOW })).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("refuses a timestamp more than five minutes off, either way", async () => {
    for (const at of [NOW - PLATFORM_REQUEST_WINDOW_MS - 1, NOW + PLATFORM_REQUEST_WINDOW_MS + 1]) {
      expect(await verifyPlatformRequest(request(signed(SERVICE, at)), BODY, { keys: KEYS, now: NOW })).toMatchObject({ ok: false, reason: "stale_timestamp" });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a nonce it has seen", async () => {
    create.mockRejectedValue(Object.assign(new Error("E11000 duplicate key"), { code: 11000, keyPattern: { _id: 1 } }));
    expect(await verifyPlatformRequest(request(signed()), BODY, { keys: KEYS, now: NOW })).toMatchObject({ ok: false, reason: "replayed_nonce" });
  });

  it("refuses an unknown key id and missing headers without touching the nonce store", async () => {
    expect(await verifyPlatformRequest(request(signed(keyPair("other"))), BODY, { keys: KEYS, now: NOW })).toMatchObject({ ok: false, reason: "unknown_key" });
    expect(await verifyPlatformRequest(request({}), BODY, { keys: KEYS, now: NOW })).toMatchObject({ ok: false, reason: "missing_headers" });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses everything when no key is configured", async () => {
    expect(await verifyPlatformRequest(request(signed()), BODY, { keys: [], now: NOW })).toMatchObject({ ok: false, reason: "unknown_key" });
  });
});

describe("platformRequestKeys", () => {
  it("reads keyId:x pairs and skips anything malformed", () => {
    expect(platformRequestKeys({ PLATFORM_REQUEST_KEYS: ` a:abc_-1 , broken, b:c:d, c:xyz ` } as unknown as NodeJS.ProcessEnv)).toEqual([
      { keyId: "a", x: "abc_-1" },
      { keyId: "c", x: "xyz" },
    ]);
    expect(platformRequestKeys({} as unknown as NodeJS.ProcessEnv)).toEqual([]);
  });
});
