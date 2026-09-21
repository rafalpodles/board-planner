import { describe, it, expect, vi, afterEach } from "vitest";
import { can, FEATURE_KEYS, ENTITLEMENT_GRACE_MS, EntitlementGate } from "./entitlements";

function tenant(overrides: Partial<EntitlementGate["entitlements"]>): EntitlementGate {
  return { entitlements: { plan: "free", features: [], ...overrides } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("can", () => {
  it("returns false for every feature on a free tenant with no features granted", () => {
    const free = tenant({});
    for (const feature of FEATURE_KEYS) {
      expect(can(free, feature)).toBe(false);
    }
  });

  it("returns true for every feature on a pro tenant", () => {
    const pro = tenant({ plan: "pro" });
    for (const feature of FEATURE_KEYS) {
      expect(can(pro, feature)).toBe(true);
    }
  });

  it("grants a free tenant only the features explicitly listed", () => {
    const free = tenant({ features: ["integrations.coda"] });
    expect(can(free, "integrations.coda")).toBe(true);
    expect(can(free, "integrations.jira")).toBe(false);
  });

  it("has no expiry when expiresAt is unset", () => {
    const pro = tenant({ plan: "pro", expiresAt: undefined });
    expect(can(pro, "ai.byok")).toBe(true);
  });

  it("stays entitled through most of the grace window and refuses once it has fully passed", () => {
    const now = Date.now();
    const withinGrace = tenant({
      plan: "pro",
      expiresAt: new Date(now - (ENTITLEMENT_GRACE_MS - 1000)),
    });
    expect(can(withinGrace, "ai.byok")).toBe(true);

    const pastGrace = tenant({
      plan: "pro",
      expiresAt: new Date(now - (ENTITLEMENT_GRACE_MS + 1000)),
    });
    expect(can(pastGrace, "ai.byok")).toBe(false);
  });

  it("is still entitled on the last instant of the grace window and refused the instant after", () => {
    const expiredAt = new Date("2026-01-01T00:00:00.000Z");
    const pro = tenant({ plan: "pro", expiresAt: expiredAt });
    const cutoff = expiredAt.getTime() + ENTITLEMENT_GRACE_MS;

    vi.useFakeTimers();

    vi.setSystemTime(cutoff);
    expect(can(pro, "ai.byok")).toBe(true);

    vi.setSystemTime(cutoff + 1);
    expect(can(pro, "ai.byok")).toBe(false);
  });

  it("a plan is a named set of keys, not a mode: a free tenant with pro's own feature list stays granted only what it lists", () => {
    const withOneFeature = tenant({ plan: "free", features: ["audit.export"] });
    expect(can(withOneFeature, "audit.export")).toBe(true);
    expect(FEATURE_KEYS.filter((f) => can(withOneFeature, f))).toEqual(["audit.export"]);
  });
});
