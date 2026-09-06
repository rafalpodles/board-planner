import { describe, it, expect } from "vitest";
import {
  MAX_RECURRENCE_INTERVAL,
  clampInterval,
  nextOccurrence,
  nextRecurrenceDue,
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
      anchorDay: null,
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

  it.each([true, false, [5], [], {}, () => 5])("refuses an interval of %o", (interval) => {
    expect(normaliseRecurrence({ frequency: "daily", interval }).ok).toBe(false);
  });

  it("refuses an interval that is not a whole number of periods", () => {
    expect(normaliseRecurrence({ frequency: "daily", interval: 0 }).ok).toBe(false);
    expect(normaliseRecurrence({ frequency: "daily", interval: -1 }).ok).toBe(false);
    expect(normaliseRecurrence({ frequency: "daily", interval: 1.5 }).ok).toBe(false);
    expect(normaliseRecurrence({ frequency: "daily", interval: "many" }).ok).toBe(false);
  });

  it("takes an interval written as a number in a string", () => {
    expect(ok({ frequency: "daily", interval: "2" })?.interval).toBe(2);
  });

  it("reads an end date the series stops after", () => {
    expect(ok({ frequency: "weekly", interval: 1, endDate: "2026-12-31" })?.endDate).toEqual(
      new Date("2026-12-31")
    );
  });

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

  it("produces the occurrence that lands exactly on the end date", () => {
    const at = nextOccurrence(
      { ...weekly, endDate: "2026-06-08" },
      new Date("2026-06-01T00:00:00.000Z")
    );

    expect(at.ended).toBe(false);
    expect(at.dueDate?.toISOString()).toBe("2026-06-08T00:00:00.000Z");

    expect(nextOccurrence({ ...weekly, endDate: "2026-06-08" }, at.dueDate).ended).toBe(true);
  });

  it("keeps an occurrence due on the end day's final millisecond", () => {
    const at = nextOccurrence(
      { frequency: "daily", interval: 1, endDate: "2026-06-08" },
      new Date("2026-06-07T23:59:59.999Z")
    );

    expect(at.ended).toBe(false);
    expect(at.dueDate?.toISOString()).toBe("2026-06-08T23:59:59.999Z");
  });

  it("keeps an occurrence due later in the day the series ends", () => {
    const at = nextOccurrence(
      { frequency: "daily", interval: 1, endDate: "2026-06-08" },
      new Date("2026-06-07T09:00:00.000Z")
    );

    expect(at.ended).toBe(false);
    expect(at.dueDate?.toISOString()).toBe("2026-06-08T09:00:00.000Z");
  });

  it("does not end an undated series partway through the day it ends", () => {
    const config = { ...weekly, endDate: "2026-12-31" };

    expect(nextOccurrence(config, null, new Date("2026-12-31T10:00:00.000Z")).ended).toBe(false);
    expect(nextOccurrence(config, null, new Date("2026-12-31T23:59:59.000Z")).ended).toBe(false);
    expect(nextOccurrence(config, null, new Date("2027-01-01T00:00:01.000Z")).ended).toBe(true);
  });

  it("counts from the occurrence's own due date", () => {
    const from = new Date("2026-06-03T12:00:00.000Z");
    expect(nextOccurrence(weekly, from).dueDate?.toISOString()).toBe("2026-06-10T12:00:00.000Z");
    expect(nextOccurrence({ frequency: "daily", interval: 2 }, from).dueDate?.toISOString()).toBe(
      "2026-06-05T12:00:00.000Z"
    );
    expect(nextOccurrence({ frequency: "monthly", interval: 1 }, from).dueDate?.toISOString()).toBe(
      "2026-07-03T12:00:00.000Z"
    );
  });

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

  it("judges an undated series against the day it reaches", () => {
    const ends = { ...weekly, endDate: "2026-06-08" };
    expect(nextOccurrence(ends, null, new Date("2026-06-07")).ended).toBe(false);
    expect(nextOccurrence(ends, null, new Date("2026-06-09")).ended).toBe(true);
  });
});

describe("advancing a recurring series' due date", () => {
  const ymd = (d: Date) => [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];

  const stored = (isoDay: string) => new Date(isoDay);

  const inZone = <T,>(timeZone: string, run: () => T): T => {
    const wasTz = process.env.TZ;
    process.env.TZ = timeZone;
    try {
      return run();
    } finally {
      if (wasTz === undefined) delete process.env.TZ;
      else process.env.TZ = wasTz;
    }
  };

  it("gives the same answer whatever timezone the server runs in", () => {
    const zones = [
      "UTC",
      "Europe/Warsaw",
      "America/New_York",
      "America/Los_Angeles",
      "Pacific/Honolulu",
      "Australia/Sydney",
      "Asia/Kolkata",
    ];

    const answers = zones.map((zone) =>
      inZone(zone, () => nextRecurrenceDue(stored("2026-01-31"), "monthly", 1).toISOString())
    );

    expect(new Set(answers).size, `zones disagreed: ${JSON.stringify(answers)}`).toBe(1);
    expect(answers[0]).toBe("2026-02-28T00:00:00.000Z");
  });

  it.each([
    { frequency: "daily" as const, interval: 3, from: "2026-03-06", to: "2026-03-09" },
    { frequency: "weekly" as const, interval: 2, from: "2026-03-01", to: "2026-03-15" },
  ])("$frequency is the same in every timezone too", ({ frequency, interval, from, to }) => {
    const answers = ["UTC", "America/Los_Angeles", "Australia/Sydney"].map((zone) =>
      inZone(zone, () => nextRecurrenceDue(stored(from), frequency, interval).toISOString())
    );

    expect(new Set(answers).size, `zones disagreed: ${JSON.stringify(answers)}`).toBe(1);
    expect(answers[0]).toBe(`${to}T00:00:00.000Z`);
  });

  it.each([
    { from: "2026-01-31", interval: 1, to: [2026, 2, 28], why: "31 Jan lands on the last of February" },
    { from: "2026-01-29", interval: 1, to: [2026, 2, 28], why: "so does the 29th" },
    { from: "2026-01-30", interval: 1, to: [2026, 2, 28], why: "and the 30th" },
    { from: "2026-03-31", interval: 1, to: [2026, 4, 30], why: "31 March lands on 30 April" },
    { from: "2028-01-31", interval: 1, to: [2028, 2, 29], why: "a leap year gets its 29th" },
    { from: "2026-12-31", interval: 2, to: [2027, 2, 28], why: "the clamp survives a year boundary" },
    { from: "2026-01-31", interval: 3, to: [2026, 4, 30], why: "and an interval above one" },
    { from: "2026-05-15", interval: 2, to: [2026, 7, 15], why: "a day the target month can hold is kept" },
  ])("monthly: $why", ({ from, interval, to }) => {
    expect(ymd(nextRecurrenceDue(stored(from), "monthly", interval))).toEqual(to);
  });

  it("climbs back to the chosen day once a month is long enough", () => {
    let due: Date | null = new Date("2026-01-31");
    let anchor: number | null = null;
    const series: string[] = [];

    for (let i = 0; i < 5; i++) {
      const at = nextOccurrence({ frequency: "monthly", interval: 1, anchorDay: anchor }, due);
      due = at.dueDate;
      anchor = at.anchorDay;
      series.push(due!.toISOString().slice(0, 10));
    }

    expect(series).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
    ]);
    expect(anchor).toBe(31);
  });

  it("takes the new day when somebody retargets the series", () => {
    const retargeted = nextOccurrence(
      { frequency: "monthly", interval: 1, anchorDay: null },
      new Date("2026-03-05")
    );

    expect(retargeted.dueDate?.toISOString().slice(0, 10)).toBe("2026-04-05");
    expect(retargeted.anchorDay).toBe(5);
  });

  it.each(["daily", "weekly"] as const)("stores no anchor for a %s series", (frequency) => {
    expect(nextOccurrence({ frequency, interval: 1 }, new Date("2026-01-31")).anchorDay).toBeNull();
  });

  it("settles on a day and stays there, instead of walking forward month after month", () => {
    let due = stored("2026-01-31");
    const series: number[][] = [];
    for (let i = 0; i < 4; i++) {
      due = nextRecurrenceDue(due, "monthly", 1);
      series.push(ymd(due));
    }

    expect(series).toEqual([
      [2026, 2, 28],
      [2026, 3, 28],
      [2026, 4, 28],
      [2026, 5, 28],
    ]);
  });

  it.each([
    { frequency: "daily" as const, interval: 3, to: [2026, 3, 3] },
    { frequency: "weekly" as const, interval: 2, to: [2026, 3, 14] },
  ])("$frequency every $interval still counts days across the month boundary", ({ frequency, interval, to }) => {
    expect(ymd(nextRecurrenceDue(stored("2026-02-28"), frequency, interval))).toEqual(to);
  });

  it("keeps the time of day, so a series does not walk around the clock", () => {
    const next = nextRecurrenceDue(new Date("2026-01-31T09:30:00Z"), "monthly", 1);
    expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([9, 30]);
  });

  it("keeps UTC time across a DST transition, and lets the local clock move", () => {
    inZone("Australia/Sydney", () => {
      const base = new Date("2028-09-15T02:30:00Z");
      const next = nextRecurrenceDue(base, "monthly", 1);

      expect(next.toISOString()).toBe("2028-10-15T02:30:00.000Z");
      expect(base.getTimezoneOffset()).toBe(-600);
      expect(next.getTimezoneOffset()).toBe(-660);
    });
  });

  it("adds a string interval rather than concatenating it", () => {
    const next = nextRecurrenceDue(stored("2026-01-31"), "monthly", "2" as unknown as number);
    expect(ymd(next)).toEqual([2026, 3, 31]);
  });
});
