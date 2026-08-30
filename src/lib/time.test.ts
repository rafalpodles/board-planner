import { describe, it, expect } from "vitest";
import { dayKeyInTimezone, startOfDayInTimezone } from "./time";

/**
 * BP-453. The PM turn cap counted from the server's midnight, so a Warsaw board on a UTC host
 * turned its allowance over at 02:00 local and a 23:00 session was already spending tomorrow's.
 */
describe("startOfDayInTimezone", () => {
  /**
   * Written as expectations in UTC rather than "the same as `new Date().setHours(0,0,0,0)`", which
   * would be the server's answer and therefore agree with the bug.
   */
  const CASES: [string, string, string][] = [
    ["Europe/Warsaw in summer, UTC+2", "2026-08-30T09:00:00Z", "2026-08-29T22:00:00.000Z"],
    ["Europe/Warsaw in winter, UTC+1", "2026-01-15T09:00:00Z", "2026-01-14T23:00:00.000Z"],
    // Just before the Warsaw day turns over: still the 29th there, not the 30th
    ["a late-evening instant, the case the bug was about", "2026-08-29T21:59:00Z", "2026-08-28T22:00:00.000Z"],
    ["Pacific/Kiritimati, UTC+14", "2026-08-30T09:00:00Z", "2026-08-29T10:00:00.000Z"],
    ["Pacific/Niue, UTC-11", "2026-08-30T23:00:00Z", "2026-08-30T11:00:00.000Z"],
    ["Australia/Lord_Howe, whose DST step is 30 minutes", "2026-10-04T06:00:00Z", "2026-10-03T13:30:00.000Z"],
    // Chile springs forward AT midnight: 00:00 does not exist that day, and the arithmetic answer
    // — wall midnight minus the offset — lands an hour into the previous day.
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

  /**
   * The property the hand-written rows above are examples of, swept across every three hours of
   * eighteen months so both DST transitions in every zone are crossed. It is what caught the
   * arithmetic version: subtracting the offset from wall midnight violated `sameDay` seven times,
   * all of them in Santiago on the day its midnight does not exist.
   */
  /**
   * Two instants the search's lower bound used to fall inside. Juneau's 1867 transfer from Russia
   * moved the date line and the calendar; Apia repeated 4 July 1892 outright, so that day is about
   * 48 hours long. Neither is reachable from the cap — both callers pass `new Date()` — but the
   * function is exported, and it used to hand back an instant from the middle of the day.
   */
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

  /**
   * The formatter cache is bounded, and emptying it mid-run must not change an answer. The zones
   * here are the same one in different casings, which `Intl` accepts and `isValidTimezone`
   * therefore agrees with — the very reason the bound exists.
   */
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

  it("is always the first instant of that zone's day containing the given one", () => {
    const zones = [
      "UTC", "Europe/Warsaw", "America/New_York", "Asia/Kolkata", "Pacific/Kiritimati",
      "Pacific/Niue", "Australia/Lord_Howe", "America/Santiago", "Asia/Beirut",
      "Pacific/Chatham", "Pacific/Apia", "Asia/Tehran", "America/Sao_Paulo",
    ];
    const violations: string[] = [];

    for (const zone of zones) {
      for (let t = Date.UTC(2025, 9, 1); t < Date.UTC(2027, 3, 1); t += 3 * 60 * 60 * 1000) {
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
