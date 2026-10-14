import { describe, it, expect } from "vitest";
import { formatDuration, formatWeek, niceCeiling } from "./insights-format";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("formatDuration", () => {
  it("says nothing is known with a dash, never 0", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(NaN)).toBe("—");
  });

  it("reads hours under a day and days above it, one decimal below ten", () => {
    expect(formatDuration(10 * 60_000)).toBe("under 1 h");
    expect(formatDuration(5 * HOUR)).toBe("5 h");
    expect(formatDuration(DAY)).toBe("1 d");
    expect(formatDuration(23.6 * HOUR)).toBe("1 d");
    expect(formatDuration(2.25 * DAY)).toBe("2.3 d");
    expect(formatDuration(14.6 * DAY)).toBe("15 d");
  });
});

describe("formatWeek", () => {
  it("is month/day of the week's start, as the dashboard labels its weeks", () => {
    expect(formatWeek(new Date(2026, 9, 7, 12).toISOString())).toBe("10/7");
  });
});

describe("niceCeiling", () => {
  it("rounds an axis top up to 1, 2 or 5 of a power of ten", () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(3)).toBe(5);
    expect(niceCeiling(7)).toBe(10);
    expect(niceCeiling(12)).toBe(20);
    expect(niceCeiling(200)).toBe(200);
  });
});
