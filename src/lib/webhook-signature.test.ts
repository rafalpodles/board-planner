import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { Types } from "mongoose";
import {
  signatureHeaders,
  signWebhook,
  isWebhookSigningConfigured,
  webhookSigningSecret,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "./webhook-signature";

const ORIGINAL = process.env.WEBHOOK_SIGNING_SECRET;
const ACME = new Types.ObjectId("0000000000000000000000a1");
const GLOBEX = new Types.ObjectId("0000000000000000000000b2");

beforeEach(() => {
  process.env.WEBHOOK_SIGNING_SECRET = "shhh";
});

afterEach(() => {
  delete process.env.ORGANISATION_DOMAIN;
  if (ORIGINAL === undefined) delete process.env.WEBHOOK_SIGNING_SECRET;
  else process.env.WEBHOOK_SIGNING_SECRET = ORIGINAL;
});

// BP-306: deliveries were unsigned and carried no timestamp, so a receiver could not tell one
// from anybody else who learned the URL, and a captured delivery replayed forever
describe("signatureHeaders", () => {
  it("signs the body and states when it was signed", () => {
    const headers = signatureHeaders('{"event":"task_created"}', ACME, 1_700_000_000_000);

    expect(headers[TIMESTAMP_HEADER]).toBe("1700000000");
    expect(headers[SIGNATURE_HEADER]).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  // The timestamp is inside the MAC, so rewriting the header to a fresh one breaks the signature
  it("covers the timestamp, not just the body", () => {
    const body = '{"event":"task_created"}';
    const expected = crypto
      .createHmac("sha256", "shhh")
      .update(`1700000000.${body}`)
      .digest("hex");

    expect(signWebhook(body, "1700000000", ACME)).toBe(`t=1700000000,v1=${expected}`);
    expect(signWebhook(body, "1700000001", ACME)).not.toContain(expected);
  });

  it("gives a different signature for a different body", () => {
    expect(signWebhook("a", "1", ACME)).not.toBe(signWebhook("b", "1", ACME));
  });

  // An instance that never configured a secret has receivers that do not check one; dropping
  // their deliveries would be the worse bug
  it("sends unsigned rather than not at all when no secret is configured", () => {
    delete process.env.WEBHOOK_SIGNING_SECRET;

    expect(isWebhookSigningConfigured()).toBe(false);
    expect(signatureHeaders("{}", ACME)).toEqual({});
    expect(signWebhook("{}", "1", ACME)).toBeNull();
  });
});

describe("webhookSigningSecret (BP-669)", () => {
  it("is the instance's secret as set on a single-organisation instance, so existing receivers keep verifying", () => {
    expect(webhookSigningSecret(ACME)).toBe("shhh");
    expect(webhookSigningSecret(GLOBEX)).toBe("shhh");
  });

  it("is each organisation's own with organisations on subdomains, derived from the instance's", () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.test";

    const acme = webhookSigningSecret(ACME);
    expect(acme).toMatch(/^[0-9a-f]{64}$/);
    expect(acme).not.toBe("shhh");
    expect(acme).not.toBe(webhookSigningSecret(GLOBEX));
    expect(acme).toBe(webhookSigningSecret(ACME));
    expect(signWebhook("{}", "1", ACME)).not.toBe(signWebhook("{}", "1", GLOBEX));

    process.env.WEBHOOK_SIGNING_SECRET = "rotated";
    expect(webhookSigningSecret(ACME)).not.toBe(acme);
  });

  it("is empty for every organisation when the instance has no secret, so nothing is signed", () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.test";
    delete process.env.WEBHOOK_SIGNING_SECRET;

    expect(webhookSigningSecret(ACME)).toBe("");
    expect(signatureHeaders("{}", ACME)).toEqual({});
  });
});
