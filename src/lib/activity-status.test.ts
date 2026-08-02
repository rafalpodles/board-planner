import { describe, it, expect } from "vitest";
import { activityStatus, ACTIVITY_WINDOW_MS } from "./activity-status";

const NOW = new Date("2026-08-02T12:00:00Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("activityStatus", () => {
  it("is working inside the window", () => {
    expect(activityStatus(ago(0), NOW)).toBe("working");
    expect(activityStatus(ago(60_000), NOW)).toBe("working");
    expect(activityStatus(ago(ACTIVITY_WINDOW_MS - 1), NOW)).toBe("working");
  });

  it("is idle at and past the window", () => {
    expect(activityStatus(ago(ACTIVITY_WINDOW_MS), NOW)).toBe("idle");
    expect(activityStatus(ago(ACTIVITY_WINDOW_MS + 1), NOW)).toBe("idle");
    expect(activityStatus(ago(24 * 60 * 60_000), NOW)).toBe("idle");
  });

  // A project with no tasks has no activity to report — not "idle", which would
  // imply Claude looked at it and stopped
  it("has no status without a last update", () => {
    expect(activityStatus(null, NOW)).toBeNull();
    expect(activityStatus(undefined, NOW)).toBeNull();
    expect(activityStatus("", NOW)).toBeNull();
  });

  it("has no status for an unparseable date", () => {
    expect(activityStatus("not-a-date", NOW)).toBeNull();
  });

  // The board page passes a raw timestamp; the sidebar passes the API's ISO string
  it("accepts a Date, an ISO string and a timestamp alike", () => {
    expect(activityStatus(new Date(NOW - 1000), NOW)).toBe("working");
    expect(activityStatus(NOW - 1000, NOW)).toBe("working");
    expect(activityStatus(NOW - ACTIVITY_WINDOW_MS, NOW)).toBe("idle");
  });

  // Clock skew between server and browser can put a timestamp slightly ahead
  it("treats a future timestamp as working", () => {
    expect(activityStatus(new Date(NOW + 5_000), NOW)).toBe("working");
  });
});
