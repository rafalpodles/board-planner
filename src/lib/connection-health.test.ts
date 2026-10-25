import { describe, expect, it } from "vitest";
import { connectionHealth, healthBadge } from "./connection-health";

const now = new Date("2026-10-25T12:00:00Z");
const connection = (over: Record<string, unknown> = {}) => ({
  rejectedAt: null,
  login: "octo",
  expiresAt: null,
  lastSyncAt: null,
  lastSyncLinked: 0,
  lastSyncTasks: 0,
  ...over,
});

describe("what a provider token's state reads as", () => {
  it("is rejected once GitHub said 401, whatever its expiry says", () => {
    const health = connectionHealth(connection({ rejectedAt: "2026-10-18T07:12:00Z", expiresAt: "2027-01-01T00:00:00Z" }), now);
    expect(health).toEqual({ state: "rejected", since: new Date("2026-10-18T07:12:00Z") });
    expect(healthBadge(health)).toEqual({ label: "Token rejected", tone: "danger" });
  });

  it("warns a week ahead of the expiry, counting partial days up", () => {
    const health = connectionHealth(connection({ expiresAt: "2026-10-31T00:00:00Z" }), now);
    expect(health).toMatchObject({ state: "expiring", daysLeft: 6 });
    expect(healthBadge(health)).toEqual({ label: "Expires in 6 days", tone: "warning" });
    expect(healthBadge(connectionHealth(connection({ expiresAt: "2026-10-25T13:00:00Z" }), now))?.label).toBe("Expires in 1 day");
  });

  it("is fine eight days out, and expired once the moment has passed", () => {
    expect(connectionHealth(connection({ expiresAt: "2026-11-02T12:00:01Z" }), now)).toEqual({ state: "ok" });
    expect(connectionHealth(connection({ expiresAt: "2026-10-25T11:59:59Z" }), now)).toMatchObject({ state: "expired" });
  });

  it("knows nothing about a token saved before the board recorded any of this", () => {
    expect(connectionHealth(undefined, now)).toEqual({ state: "unknown" });
    expect(connectionHealth(connection({ login: "" }), now)).toEqual({ state: "unknown" });
    expect(healthBadge({ state: "unknown" })).toBeNull();
  });
});
