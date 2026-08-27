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

  // `Number(true)` is 1 and `Number([5])` is 5, so a boolean was accepted as "every 1 day" and a
  // one-element array as its contents — the second looser than the Mongoose cast this stands in
  // for, which refuses an array outright.
  it.each([true, false, [5], [], {}, () => 5])("refuses an interval of %o", (interval) => {
    expect(normaliseRecurrence({ frequency: "daily", interval }).ok).toBe(false);
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

  // The boundary itself, which nothing pinned: `>` versus `>=` passed the whole suite either way,
  // because no fixture put an occurrence exactly ON the end date. It is the case a person is most
  // likely to reach — pick 8 June on a weekly series that lands there — and `endDate` is documented
  // as the day the series stops *after*, so the occurrence is produced.
  it("produces the occurrence that lands exactly on the end date", () => {
    const at = nextOccurrence(
      { ...weekly, endDate: "2026-06-08" },
      new Date("2026-06-01T00:00:00.000Z")
    );

    expect(at.ended).toBe(false);
    expect(at.dueDate?.toISOString()).toBe("2026-06-08T00:00:00.000Z");

    // The control, one week further on: the same series with the same end is over by then
    expect(nextOccurrence({ ...weekly, endDate: "2026-06-08" }, at.dueDate).ended).toBe(true);
  });

  // The operator itself. Once the comparison moved to the end of the day, `>` and `>=` disagree
  // only on the day's very last millisecond — but they do disagree, and the end day is inclusive,
  // so an occurrence due at 23:59:59.999 on it belongs to the series. Without this the mutation
  // `>` -> `>=` passes the whole file.
  it("keeps an occurrence due on the end day's final millisecond", () => {
    const at = nextOccurrence(
      { frequency: "daily", interval: 1, endDate: "2026-06-08" },
      new Date("2026-06-07T23:59:59.999Z")
    );

    expect(at.ended).toBe(false);
    expect(at.dueDate?.toISOString()).toBe("2026-06-08T23:59:59.999Z");
  });

  // The end is a day, and every value it is compared against is an instant. Judged against its
  // midnight the field meant two different things: a due date carrying a time of day — which the
  // REST API accepts even though the date input cannot make one — lost its final occurrence.
  it("keeps an occurrence due later in the day the series ends", () => {
    const at = nextOccurrence(
      { frequency: "daily", interval: 1, endDate: "2026-06-08" },
      new Date("2026-06-07T09:00:00.000Z")
    );

    expect(at.ended).toBe(false);
    expect(at.dueDate?.toISOString()).toBe("2026-06-08T09:00:00.000Z");
  });

  // The undated arm of the same disagreement: `now` is a full timestamp, so any close after
  // midnight UTC on the end day was already past it and "until 31 December" handed out its last
  // occurrence on the 30th.
  it("does not end an undated series partway through the day it ends", () => {
    const config = { ...weekly, endDate: "2026-12-31" };

    expect(nextOccurrence(config, null, new Date("2026-12-31T10:00:00.000Z")).ended).toBe(false);
    expect(nextOccurrence(config, null, new Date("2026-12-31T23:59:59.000Z")).ended).toBe(false);
    // and the control on the far side of it
    expect(nextOccurrence(config, null, new Date("2027-01-01T00:00:01.000Z")).ended).toBe(true);
  });

  // Through `nextOccurrence`, not through the arithmetic directly — that has its own block below.
  // What this pins is the wiring: the next occurrence counts from the closed one's own due date.
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

describe("advancing a recurring series' due date", () => {
  // UTC components, because the arithmetic is UTC (BP-485) and a local reading of the answer would
  // be a different day for half the planet — which is the bug this replaced.
  const ymd = (d: Date) => [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];

  // The shape a real due date has. `<input type="date">` sends "2026-01-31" and Mongoose casts it
  // to UTC midnight, so this is what is actually in the database — not the local-noon `Date` every
  // earlier fixture here built, which is precisely why none of them could see BP-485.
  const stored = (isoDay: string) => new Date(isoDay);

  const inZone = <T,>(timeZone: string, run: () => T): T => {
    const wasTz = process.env.TZ;
    process.env.TZ = timeZone;
    try {
      return run();
    } finally {
      // Not a plain assignment: `process.env.TZ = undefined` stores the string "undefined", which
      // is not a zone, and silently leaves the rest of the run on UTC.
      if (wasTz === undefined) delete process.env.TZ;
      else process.env.TZ = wasTz;
    }
  };

  // THE test for BP-485, and the one no arrangement of fixtures could replace: the same stored
  // value must produce the same answer wherever the server happens to run. Under local getters
  // this returned 28 February in UTC and Warsaw and 1 March in Los Angeles, New York and Honolulu.
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

  // Same claim for the two frequencies the clamp does not touch, so a half-UTC module cannot pass:
  // reverting only the monthly branch leaves this one green, and reverting only these leaves the
  // one above green.
  //
  // Both spans deliberately cross the US transition on 8 March 2026, and that is load-bearing:
  // adding days locally and adding them in UTC give the same instant *except* across a DST
  // boundary. A February span proved nothing — measured, reverting the daily branch to local
  // getters passed every zone.
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

  // BP-461. `setUTCMonth` does not clamp either: 31 January + 1 month is 3 March, so a monthly
  // series skipped February and then kept drifting, because the occurrence after that was computed
  // from the 3rd.
  //
  // Short months in both directions, a year boundary, an interval above one, and both leap-year
  // answers for 29 February, plus one whose day the target month can hold. All but the last are
  // dates where a bare `setUTCMonth` and the clamp disagree; the last guards the other half of
  // `Math.min`, since every row above lands on the target month's last day and a version that
  // discarded `day` would satisfy all of them — measured.
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

  // Measured, and deliberately not what BP-461's description predicted: each occurrence is computed
  // from the one just closed, so once February has clamped 31 to 28 the series settles on the 28th
  // rather than climbing back. That is the price of basing the next occurrence on the previous one,
  // and the previous one is what lets somebody retarget a series by editing its due date. What
  // matters here is that it is stationary — the bug was a series walking forward forever, 31 Jan,
  // 3 Mar, 3 Apr, 3 May, through months nobody chose. See BP-486.
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

  // The control for the clamp: `setUTCDate` overflowing into the next month is exactly what "seven
  // days later" means, so these two must be left alone by it — and the interval has to be carried,
  // or `7 * interval` mutated to a bare `7` goes unnoticed.
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

  // The consequence of choosing UTC, asserted rather than left to be discovered. A series carrying
  // a real time of day keeps its UTC time across a DST transition, so its local wall clock moves by
  // an hour. Invisible for a date-only value — midnight UTC stays midnight UTC — and it is the
  // trade that buys the timezone-independence above.
  it("keeps UTC time across a DST transition, and lets the local clock move", () => {
    inZone("Australia/Sydney", () => {
      const base = new Date("2028-09-15T02:30:00Z");
      const next = nextRecurrenceDue(base, "monthly", 1);

      expect(next.toISOString()).toBe("2028-10-15T02:30:00.000Z");
      // Sydney went from UTC+10 to UTC+11 on 1 October 2028, so the same UTC instant reads an hour
      // later on the wall — by design.
      expect(base.getTimezoneOffset()).toBe(-600);
      expect(next.getTimezoneOffset()).toBe(-660);
    });
  });

  // Also from the review of BP-461: `getUTCMonth() + interval + 1` concatenates rather than adds if
  // `interval` arrives as a string — `0 + "2" + 1` is "021", which is September 2027, whose last
  // day is the 30th, so 31 January + 2 months came back as 30 March instead of the 31st.
  //
  // Unreachable through the app — `schemaValuesOrRefusal` requires an integer >= 1 and the schema
  // types the path as a Number — but this function is exported, and its one caller reads the
  // interval off a task typed `any`, so the parameter's type is documentation rather than a guard.
  it("adds a string interval rather than concatenating it", () => {
    const next = nextRecurrenceDue(stored("2026-01-31"), "monthly", "2" as unknown as number);
    expect(ymd(next)).toEqual([2026, 3, 31]);
  });
});
