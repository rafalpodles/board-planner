import { describe, it, expect, vi, afterEach } from "vitest";
import { isAllowedWebhookUrl } from "./url-validation";

async function destinationUnder(env: { E2E?: string; NODE_ENV: string }) {
  vi.resetModules();
  vi.stubEnv("E2E", env.E2E ?? "");
  vi.stubEnv("NODE_ENV", env.NODE_ENV);
  return (await import("./url-validation")).WEBHOOK_DESTINATION;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isAllowedWebhookUrl", () => {
  it("accepts a public https address with or without the loopback allowance", () => {
    expect(isAllowedWebhookUrl("https://hooks.slack.com/services/T/B/x")).toBe(true);
    expect(isAllowedWebhookUrl("https://hooks.slack.com/services/T/B/x", { allowLoopback: true })).toBe(true);
  });

  it.each(["http://127.0.0.1:3990/hook", "http://localhost:3990/hook", "https://127.0.0.1/hook", "http://[::1]:3990/hook"])(
    "refuses loopback %s by default and accepts it only when allowed",
    (url) => {
      expect(isAllowedWebhookUrl(url)).toBe(false);
      expect(isAllowedWebhookUrl(url, { allowLoopback: true })).toBe(true);
    }
  );

  it.each(["http://10.0.0.5/hook", "https://192.168.1.1/hook", "https://metadata.internal/hook", "ftp://127.0.0.1/hook", "http://hooks.slack.com/x"])(
    "keeps refusing %s even with the loopback allowance",
    (url) => {
      expect(isAllowedWebhookUrl(url, { allowLoopback: true })).toBe(false);
    }
  );
});

describe("WEBHOOK_DESTINATION", () => {
  it("allows loopback only under the e2e suite outside a production build", async () => {
    expect((await destinationUnder({ E2E: "1", NODE_ENV: "development" })).allowLoopback).toBe(true);
    expect((await destinationUnder({ E2E: "1", NODE_ENV: "production" })).allowLoopback).toBe(false);
    expect((await destinationUnder({ NODE_ENV: "development" })).allowLoopback).toBe(false);
  });
});
