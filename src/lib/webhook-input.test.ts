import { describe, it, expect } from "vitest";
import { WEBHOOK_EVENTS } from "@/types";
import {
  parseWebhookUrl,
  parseWebhookEvents,
  MAX_WEBHOOK_URL_LENGTH,
} from "./webhook-input";

/**
 * Both parsers answer `null` for "no", never a partial value — which is the property the two
 * routes that use them depend on. `webhooks/route.ts` and `notifications/route.ts` branch on
 * `=== null` and answer 400; anything else they store.
 */
describe("parseWebhookUrl", () => {
  it("accepts an http and an https address, trimmed", () => {
    expect(parseWebhookUrl("  https://hooks.example.com/a  ")).toBe("https://hooks.example.com/a");
    expect(parseWebhookUrl("http://hooks.example.com/a")).toBe("http://hooks.example.com/a");
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
    ["an object", { url: "https://hooks.example.com" }],
    ["something that is not a URL", "hooks.example.com/a"],
    ["a bare path", "/a"],
  ])("refuses %s", (_name, value) => {
    expect(parseWebhookUrl(value)).toBeNull();
  });

  it("refuses a URL past the stored length, and accepts one exactly at it", () => {
    const pad = (length: number) =>
      `https://e.example/${"x".repeat(length - "https://e.example/".length)}`;

    expect(parseWebhookUrl(pad(MAX_WEBHOOK_URL_LENGTH))).toHaveLength(MAX_WEBHOOK_URL_LENGTH);
    expect(parseWebhookUrl(pad(MAX_WEBHOOK_URL_LENGTH + 1))).toBeNull();
  });

  /**
   * The length is measured after trimming, because the trimmed string is what gets stored and the
   * schema's own maxlength is what would otherwise refuse it — a 400 from the parser reads better
   * than a validation error from Mongoose.
   */
  it("measures the length after trimming, not before", () => {
    const exactly = `https://e.example/${"x".repeat(MAX_WEBHOOK_URL_LENGTH - 18)}`;

    expect(parseWebhookUrl(`   ${exactly}   `)).toBe(exactly);
  });

  /**
   * `new URL` accepts any scheme, so this parser alone does not decide what may be dialled —
   * `mailto:` and `file:` pass here. What a webhook may actually reach is decided at delivery
   * time by the SSRF guard (`url-validation.ts`), which is where the network is.
   */
  it("does not decide the scheme — that is the delivery guard's job", () => {
    expect(parseWebhookUrl("mailto:someone@example.com")).toBe("mailto:someone@example.com");
  });
});

describe("parseWebhookEvents", () => {
  it("accepts a list of known events", () => {
    const some = WEBHOOK_EVENTS.slice(0, 2);

    expect(parseWebhookEvents([...some])).toEqual(some);
  });

  it("accepts an empty list", () => {
    expect(parseWebhookEvents([])).toEqual([]);
  });

  /**
   * All or nothing, deliberately: filtering the unknown ones out and storing the rest would answer
   * 200 for a request that asked for an event it will never receive, and the operator would be
   * waiting on a delivery nothing was ever going to make.
   */
  it("refuses the whole list when one event is unknown", () => {
    expect(parseWebhookEvents([WEBHOOK_EVENTS[0], "task_exploded"])).toBeNull();
  });

  it.each([
    ["a string", WEBHOOK_EVENTS[0]],
    ["null", null],
    ["undefined", undefined],
    ["an object", { events: [] }],
  ])("refuses %s, which is not a list at all", (_name, value) => {
    expect(parseWebhookEvents(value)).toBeNull();
  });

  // A duplicate is kept rather than refused: it names a real event, and the set the dispatcher
  // builds from it does not care how many times it was asked for.
  it("keeps a repeated event rather than refusing the list", () => {
    expect(parseWebhookEvents([WEBHOOK_EVENTS[0], WEBHOOK_EVENTS[0]])).toEqual([
      WEBHOOK_EVENTS[0],
      WEBHOOK_EVENTS[0],
    ]);
  });
});
