import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import {
  signatureHeaders,
  signWebhook,
  isWebhookSigningConfigured,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "./webhook-signature";

const ORIGINAL = process.env.WEBHOOK_SIGNING_SECRET;

beforeEach(() => {
  process.env.WEBHOOK_SIGNING_SECRET = "shhh";
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WEBHOOK_SIGNING_SECRET;
  else process.env.WEBHOOK_SIGNING_SECRET = ORIGINAL;
});

describe("signatureHeaders", () => {
  it("signs the body and states when it was signed", () => {
    const headers = signatureHeaders('{"event":"task_created"}', 1_700_000_000_000);

    expect(headers[TIMESTAMP_HEADER]).toBe("1700000000");
    expect(headers[SIGNATURE_HEADER]).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  it("covers the timestamp, not just the body", () => {
    const body = '{"event":"task_created"}';
    const expected = crypto
      .createHmac("sha256", "shhh")
      .update(`1700000000.${body}`)
      .digest("hex");

    expect(signWebhook(body, "1700000000")).toBe(`t=1700000000,v1=${expected}`);
    expect(signWebhook(body, "1700000001")).not.toContain(expected);
  });

  it("gives a different signature for a different body", () => {
    expect(signWebhook("a", "1")).not.toBe(signWebhook("b", "1"));
  });

  it("sends unsigned rather than not at all when no secret is configured", () => {
    delete process.env.WEBHOOK_SIGNING_SECRET;

    expect(isWebhookSigningConfigured()).toBe(false);
    expect(signatureHeaders("{}")).toEqual({});
    expect(signWebhook("{}", "1")).toBeNull();
  });
});
