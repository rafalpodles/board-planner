import { describe, it, expect } from "vitest";
import {
  MAX_RECURRENCE_INTERVAL,
  advance,
  clampInterval,
  nextOccurrence,
  normaliseRecurrence,
} from "./recurrence";

const ok = (raw: unknown) => {
  const result = normaliseRecurrence(raw);
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.value;
};

describe("what a client may say about a repeating task", () => {
  it("reads no recurrence at all as no recurrence", () => {
    expect(ok(null)).toBeNull();
    expect(ok(undefined)).toBeNull();
    expect(ok("")).toBeNull();
  });

  it("keeps a frequency and interval it recognises", () => {
    expect(ok({ frequency: "monthly", interval: 3 })).toEqual({
      frequency: "monthly",
      interval: 3,
      endDate: null,
    });
  });

  it("refuses a frequency nothing can act on", () => {
    expect(normaliseRecurrence({ frequency: "fortnightly", interval: 1 }).ok).toBe(false);
  });

  it("refuses an interval past the maximum both editors advertise", () => {
    expect(normaliseRecurrence({ frequency: "daily", interval: MAX_RECURRENCE_INTERVAL }).ok).toBe(true);
    expect(normaliseRecurrence({ frequency: "daily", interval: MAX_RECURRENCE_INTERVAL + 1 }).ok).toBe(false);
    expect(normaliseRecurrence({ frequency: "daily", interval: 100000 }).ok).toBe(false);
  });

  it("refuses an interval that is not a whole number of periods", () => {
    expect(normaliseRecurrence({ frequency: "daily", interval: 0 }).ok).toBe(false);
    expect(normaliseRecurrence({ frequency: "daily", interval: -1 }).ok).toBe(false);
    expect(normaliseRecurrence({ frequency: "daily", interval: 1.5 }).ok).toBe(false);
    expect(normaliseRecurrence({ frequency: "daily", interval: "many" }).ok).toBe(false);
  });

  // A form field arrives as a string, and refusing it would refuse the form
  it("takes an interval written as a number in a string", () => {
    expect(ok({ frequency: "daily", interval: "2" })?.interval).toBe(2);
  });

  it("reads an end date the series stops after", () => {
    expect(ok({ frequency: "weekly", interval: 1, endDate: "2026-12-31" })?.endDate).toEqual(
      new Date("2026-12-31")
    );
  });

  // It used to be neither stored nor rejected: 200, and a series that ran forever
  it("refuses an end date it cannot read rather than discarding it", () => {
    expect(normaliseRecurrence({ frequency: "weekly", interval: 1, endDate: "soon" }).ok).toBe(false);
    expect(normaliseRecurrence({ frequency: "weekly", interval: 1, endDate: {} }).ok).toBe(false);
  });

  it("takes an absent or null end as a series with no end", () => {
    expect(ok({ frequency: "weekly", interval: 1, endDate: null })?.endDate).toBeNull();
    expect(ok({ frequency: "weekly", interval: 1, endDate: "" })?.endDate).toBeNull();
  });
});

describe("clamping what an editor's number input hands over", () => {
  it("holds to the same bounds the server does", () => {
    expect(clampInterval("400")).toBe(MAX_RECURRENCE_INTERVAL);
    expect(clampInterval("0")).toBe(1);
    expect(clampInterval("")).toBe(1);
    expect(clampInterval("7")).toBe(7);
  });
});

describe("when the next occurrence falls", () => {
  const weekly = { frequency: "weekly", interval: 1 } as const;

  it("counts from the occurrence's own due date", () => {
    expect(advance(new Date("2026-06-03T12:00:00.000Z"), "weekly", 1).toISOString()).toBe(
      "2026-06-10T12:00:00.000Z"
    );
    expect(advance(new Date("2026-06-03T12:00:00.000Z"), "daily", 2).toISOString()).toBe(
      "2026-06-05T12:00:00.000Z"
    );
    expect(advance(new Date("2026-06-03T12:00:00.000Z"), "monthly", 1).toISOString()).toBe(
      "2026-07-03T12:00:00.000Z"
    );
  });

  // The anchor used to be the moment somebody clicked, so a "weekly" series closed on a Tuesday
  // and then a Friday landed eleven days later, and kept sliding
  it("leaves an undated task undated rather than anchoring it to now", () => {
    expect(nextOccurrence(weekly, null).dueDate).toBeNull();
    expect(nextOccurrence(weekly, null).ended).toBe(false);
  });

  it("is over once the end is behind the occurrence that would come next", () => {
    const ends = { ...weekly, endDate: "2026-06-08" };
    expect(nextOccurrence(ends, "2026-06-03T12:00:00.000Z").ended).toBe(true);
    expect(nextOccurrence({ ...weekly, endDate: "2026-12-31" }, "2026-06-03T12:00:00.000Z").ended).toBe(
      false
    );
  });

  // An undated series has no clock of its own, so an end date on one would otherwise mean nothing
  it("judges an undated series against the day it reaches", () => {
    const ends = { ...weekly, endDate: "2026-06-08" };
    expect(nextOccurrence(ends, null, new Date("2026-06-07")).ended).toBe(false);
    expect(nextOccurrence(ends, null, new Date("2026-06-09")).ended).toBe(true);
  });
});
