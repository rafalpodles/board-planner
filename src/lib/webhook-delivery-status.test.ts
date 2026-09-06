import { describe, it, expect } from "vitest";
import { webhookDeliveryStatus } from "./webhook-delivery-status";

const NEVER = { lastAttemptAt: null, lastStatus: null, lastError: "" };

describe("webhookDeliveryStatus", () => {
  it("reads as never delivered before any attempt", () => {
    expect(webhookDeliveryStatus(NEVER)).toEqual({ tone: "none", text: "Not delivered yet" });
  });

  it("reports a successful delivery", () => {
    const status = webhookDeliveryStatus({
      lastAttemptAt: new Date().toISOString(),
      lastStatus: "ok",
      lastError: "",
    });
    expect(status.tone).toBe("ok");
    expect(status.text).toContain("Last delivered");
  });

  it("reports a failed delivery with its error", () => {
    const status = webhookDeliveryStatus({
      lastAttemptAt: new Date().toISOString(),
      lastStatus: "failed",
      lastError: "connect ECONNREFUSED",
    });
    expect(status.tone).toBe("failed");
    expect(status.text).toContain("Last delivery failed");
    expect(status.text).toContain("connect ECONNREFUSED");
  });

  it("omits the dash when there is no error text", () => {
    const status = webhookDeliveryStatus({
      lastAttemptAt: new Date().toISOString(),
      lastStatus: "failed",
      lastError: "",
    });
    expect(status.text).not.toContain("—");
  });
});
