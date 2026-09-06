import { describe, it, expect } from "vitest";
import { dayKeyInTimezone, startOfDayInTimezone } from "./time";

describe("startOfDayInTimezone", () => {
  const CASES: [string, string, string][] = [
    ["Europe/Warsaw in summer, UTC+2", "2026-08-30T09:00:00Z", "2026-08-29T22:00:00.000Z"],
    ["Europe/Warsaw in winter, UTC+1", "2026-01-15T09:00:00Z", "2026-01-14T23:00:00.000Z"],
    ["a late-evening instant, the case the bug was about", "2026-08-29T21:59:00Z", "2026-08-28T22:00:00.000Z"],
    ["Pacific/Kiritimati, UTC+14", "2026-08-30T09:00:00Z", "2026-08-29T10:00:00.000Z"],
    ["Pacific/Niue, UTC-11", "2026-08-30T23:00:00Z", "2026-08-30T11:00:00.000Z"],
    ["Australia/Lord_Howe, whose DST step is 30 minutes", "2026-10-04T06:00:00Z", "2026-10-03T13:30:00.000Z"],
    ["America/Santiago on the day its midnight does not exist", "2026-09-06T12:00:00Z", "2026-09-06T04:00:00.000Z"],
    ["UTC itself", "2026-08-30T09:00:00Z", "2026-08-30T00:00:00.000Z"],
  ];

  const ZONE_OF: Record<string, string> = {
    "Europe/Warsaw in summer, UTC+2": "Europe/Warsaw",
    "Europe/Warsaw in winter, UTC+1": "Europe/Warsaw",
    "a late-evening instant, the case the bug was about": "Europe/Warsaw",
    "Pacific/Kiritimati, UTC+14": "Pacific/Kiritimati",
    "Pacific/Niue, UTC-11": "Pacific/Niue",
    "Australia/Lord_Howe, whose DST step is 30 minutes": "Australia/Lord_Howe",
    "America/Santiago on the day its midnight does not exist": "America/Santiago",
    "UTC itself": "UTC",
  };

  it.each(CASES)("%s", (label, at, expected) => {
    expect(startOfDayInTimezone(new Date(at), ZONE_OF[label]).toISOString()).toBe(expected);
  });

  it.each([
    ["America/Juneau, 1867", "1867-10-19T12:00:00Z", "America/Juneau"],
    ["Pacific/Apia repeating 4 July 1892", "1892-07-04T12:00:00Z", "Pacific/Apia"],
  ])("is still the day's own start for %s", (_label, at, zone) => {
    const start = startOfDayInTimezone(new Date(at), zone);
    expect(dayKeyInTimezone(start, zone)).toBe(dayKeyInTimezone(new Date(at), zone));
    expect(dayKeyInTimezone(new Date(start.getTime() - 1), zone)).not.toBe(
      dayKeyInTimezone(start, zone)
    );
  });

  it("gives the same answer after the formatter cache has been emptied", () => {
    const at = new Date("2026-08-30T09:00:00Z");
    const expected = startOfDayInTimezone(at, "Europe/Warsaw").toISOString();

    for (let i = 0; i < 200; i += 1) {
      const cased = "Europe/Warsaw"
        .split("")
        .map((c, n) => ((i >> n % 8) & 1 ? c.toUpperCase() : c.toLowerCase()))
        .join("");
      expect(startOfDayInTimezone(at, cased).toISOString()).toBe(expected);
    }

    expect(startOfDayInTimezone(at, "Europe/Warsaw").toISOString()).toBe(expected);
  });

  it("is always the first instant of that zone's day containing the given one", { timeout: 30_000 }, () => {
    const zones = [
      "UTC", "Europe/Warsaw", "America/New_York", "Asia/Kolkata", "Pacific/Kiritimati",
      "Pacific/Niue", "Australia/Lord_Howe", "America/Santiago", "Asia/Beirut",
      "Pacific/Chatham", "Pacific/Apia", "Asia/Tehran", "America/Sao_Paulo",
    ];
    const violations: string[] = [];

    for (const zone of zones) {
      for (let t = Date.UTC(2025, 9, 1); t < Date.UTC(2027, 3, 1); t += 6 * 60 * 60 * 1000) {
        const now = new Date(t);
        const start = startOfDayInTimezone(now, zone);
        const key = dayKeyInTimezone(now, zone);
        const sameDay = dayKeyInTimezone(start, zone) === key;
        const notAfter = start.getTime() <= t;
        const minimal = dayKeyInTimezone(new Date(start.getTime() - 1), zone) !== key;
        if (!(sameDay && notAfter && minimal)) {
          violations.push(`${zone} ${now.toISOString()} -> ${start.toISOString()}`);
        }
      }
    }

    expect(violations.slice(0, 5)).toEqual([]);
  });
});
