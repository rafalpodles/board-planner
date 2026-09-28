import { describe, it, expect } from "vitest";
import { dateOnlyKey, daysUntil, dueUrgency, formatDateOnly } from "./date-only";
import { pinTimezone } from "./testing/pin-timezone";

const STORED_15TH = "2026-10-15T00:00:00.000Z";

describe.each(["America/Los_Angeles", "Pacific/Kiritimati", "UTC"])("a picked day, read in %s", (zone) => {
  pinTimezone(zone);

  it("is the day that was picked", () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset(), "the timezone did not actually change").toBe(
      { "America/Los_Angeles": 480, "Pacific/Kiritimati": -840, UTC: 0 }[zone]
    );
    expect(dateOnlyKey(STORED_15TH)).toBe("2026-10-15");
    expect(dateOnlyKey("2026-10-15")).toBe("2026-10-15");
    expect(formatDateOnly(STORED_15TH, { month: "short", day: "numeric" })).toMatch(/\b15\b/);
    expect(formatDateOnly("2026-10-15", { day: "numeric", month: "short", year: "numeric" })).toMatch(
      /\b15\b/
    );
  });

  it("counts calendar days from the viewer's today, at either end of the viewer's day", () => {
    const earlyOn14th = new Date(2026, 9, 14, 0, 30);
    const lateOn14th = new Date(2026, 9, 14, 23, 30);
    const lateOn15th = new Date(2026, 9, 15, 23, 30);
    const earlyOn16th = new Date(2026, 9, 16, 0, 30);

    expect(daysUntil(STORED_15TH, earlyOn14th)).toBe(1);
    expect(daysUntil(STORED_15TH, lateOn14th)).toBe(1);
    expect(daysUntil(STORED_15TH, lateOn15th)).toBe(0);
    expect(daysUntil(STORED_15TH, earlyOn16th)).toBe(-1);
  });

  it("is overdue only once the day itself has passed", () => {
    expect(dueUrgency(STORED_15TH, new Date(2026, 9, 15, 23, 59))).toBe("soon");
    expect(dueUrgency(STORED_15TH, new Date(2026, 9, 16, 0, 1))).toBe("overdue");
    expect(dueUrgency(STORED_15TH, new Date(2026, 9, 13, 12))).toBe("soon");
    expect(dueUrgency(STORED_15TH, new Date(2026, 9, 12, 12))).toBe("later");
  });
});

describe("a value that is not a date", () => {
  it("has no day and no urgency to speak of", () => {
    expect(dateOnlyKey("not a date")).toBeNull();
    expect(daysUntil("not a date", new Date(2026, 9, 15))).toBeNaN();
  });
});
