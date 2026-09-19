import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendEmail = vi.fn().mockResolvedValue(true);
const isEmailConfigured = vi.fn(() => true);
const selfOrigin = vi.fn<() => string | null>(() => "https://app.example.com");
const userFind = vi.fn();
const userFindOneAndUpdate = vi.fn();
const userUpdateOne = vi.fn();
const notificationFind = vi.fn();
const notificationCount = vi.fn();
const grantFind = vi.fn();

let grantedProjects: string[] = [];

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
  isEmailConfigured: () => isEmailConfigured(),
}));
vi.mock("@/lib/session", () => ({ selfOrigin: () => selfOrigin() }));
vi.mock("@/models/user", () => ({
  User: {
    find: (...a: unknown[]) => userFind(...a),
    findOneAndUpdate: (...a: unknown[]) => userFindOneAndUpdate(...a),
    updateOne: (...a: unknown[]) => userUpdateOne(...a),
  },
}));
vi.mock("@/models/grant", () => ({
  Grant: {
    find: (...a: unknown[]) => {
      grantFind(...a);
      return { select: () => ({ lean: async () => grantedProjects.map((id) => ({ object: id })) }) };
    },
  },
}));
vi.mock("@/models/notification", () => ({
  Notification: {
    find: (...a: unknown[]) => notificationFind(...a),
    countDocuments: (...a: unknown[]) => notificationCount(...a),
  },
}));

const {
  digestTick,
  dueDigestDay,
  digestHour,
  digestTimezone,
  DIGEST_ROW_LIMIT,
  DIGEST_SCAN_LIMIT,
  DIGEST_RETRY_WINDOW_MS,
  MAX_DIGEST_ATTEMPTS,
  digestAttemptLimit,
} = await import("@/lib/digest");

/** What the module's own interval allows, so the fixtures below cannot drift from the rule. */
const ATTEMPT_LIMIT = digestAttemptLimit();

/** The day `digestTick(morning)` claims, in the default zone. */
const MORNING_DAY = "2026-08-17";

const BOARD = "69a52e3b399b27d3cbb2c5a5";
const SECOND_BOARD = "69a52e3b399b27d3cbb2c5a7";
// `role` is what the grant lookup reads; `emailNotifications` is what the grid falls back to for
// an account that predates it. The digest asks both questions, so the fixture answers both.
const WAITING = [
  { _id: "u1", email: "owner@example.com", username: "owner", role: "member", emailNotifications: true },
];

const PROJECT = "507f1f77bcf86cd799439021";

/**
 * Rows are stamped oldest-first, and the mock honours BOTH `sort` and `limit`. A mock that ignores
 * either can only ever confirm the chain resolves: ignoring `limit` hid the scan ceiling, and
 * ignoring `sort` let a test named for the ordering pass with the ordering reverted.
 */
function notifications(shown: number, total = shown) {
  const rows = Array.from({ length: total }, (_, i) => ({
    title: `BP-${i + 1} moved to In Review`,
    type: "status_changed" as const,
    task: { taskNumber: i + 1 },
    project: { _id: PROJECT, key: "BP" },
    createdAt: new Date(Date.UTC(2026, 7, 17, 0, i)),
  }));
  notificationFind.mockReturnValue({
    sort: (spec: Record<string, number>) => {
      const ordered = spec.createdAt === -1 ? [...rows].reverse() : rows;
      return {
        limit: (n: number) => ({
          populate: () => ({ populate: () => ({ lean: async () => ordered.slice(0, n) }) }),
        }),
      };
    },
  });
  void shown;
}

const sent = () => sendEmail.mock.calls.at(-1)?.[0] as {
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
};

beforeEach(() => {
  vi.clearAllMocks();
  isEmailConfigured.mockReturnValue(true);
  selfOrigin.mockReturnValue("https://app.example.com");
  userFind.mockReturnValue({ lean: async () => WAITING });
  userFindOneAndUpdate.mockResolvedValue({ _id: "u1" });
  userUpdateOne.mockResolvedValue({ matchedCount: 1 });
  notifications(3);
  grantedProjects = [BOARD, SECOND_BOARD];
  delete process.env.DIGEST_HOUR;
  delete process.env.DIGEST_TIMEZONE;
});

afterEach(() => {
  delete process.env.DIGEST_HOUR;
  delete process.env.DIGEST_TIMEZONE;
});

describe("when the digest is due", () => {
  it("waits for the configured hour in the configured timezone", () => {
    process.env.DIGEST_HOUR = "7";
    process.env.DIGEST_TIMEZONE = "Europe/Warsaw";

    // 04:00 UTC is 06:00 in Warsaw in August — still too early
    expect(dueDigestDay(new Date("2026-08-17T04:00:00Z"))).toBeNull();
    expect(dueDigestDay(new Date("2026-08-17T05:30:00Z"))).toBe("2026-08-17");
  });

  it("falls back to a sane hour and zone when the environment says nothing usable", () => {
    process.env.DIGEST_HOUR = "not-a-number";
    process.env.DIGEST_TIMEZONE = "Mars/Olympus";

    expect(digestHour()).toBe(7);
    expect(digestTimezone()).toBe("Europe/Warsaw");
  });

  it("keeps a fumbled hour inside the day", () => {
    process.env.DIGEST_HOUR = "48";
    expect(digestHour()).toBe(23);
    process.env.DIGEST_HOUR = "-3";
    expect(digestHour()).toBe(0);
  });
});

describe("digestTick", () => {
  const morning = new Date("2026-08-17T09:00:00Z");

  it("sends one message listing what the reader has not seen", async () => {
    expect(await digestTick(morning)).toBe(1);

    expect(sent().subject).toBe("[Board Planner] 3 updates on your tasks");
    // The key labels the row, so the title does not repeat it
    expect(sent().text).toContain("BP-1: moved to In Review");
    // Each line keeps the link the per-event mail would have carried
    expect(sent().text).toContain("https://app.example.com/projects/BP/tasks/1");
    expect(sent().html).toContain('href="https://app.example.com/projects/BP/tasks/2"');
    expect(sent().text).toContain("Open my tasks: https://app.example.com/my-tasks");
    expect(sent().headers?.["List-Unsubscribe"]).toBe(
      "<https://app.example.com/settings/notifications>"
    );
  });

  it("only asks for notifications from the last day, unread", async () => {
    await digestTick(morning);

    const [filter] = notificationFind.mock.calls.at(-1) ?? [];
    expect(filter.recipient).toBe("u1");
    expect(filter.read).toBe(false);
    expect(filter.createdAt.$gte).toEqual(new Date(morning.getTime() - 24 * 60 * 60 * 1000));
  });

  // Claimed by the day before the send, so two app instances ticking at the same minute cannot
  // both take the same person
  it("claims the day first, and skips a person another instance already claimed", async () => {
    userFindOneAndUpdate.mockResolvedValue(null);

    expect(await digestTick(morning)).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(userFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: "u1", lastDigestDay: { $ne: "2026-08-17" } },
      { $set: { lastDigestDay: "2026-08-17" } }
    );
  });

  it("says nothing on a quiet day rather than sending an empty digest", async () => {
    notifications(0);

    expect(await digestTick(morning)).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // The page stops at the row limit; the number in the mail must be what is really waiting, not
  // what one page happened to hold
  it("counts what it could not fit instead of dropping it silently", async () => {
    notifications(DIGEST_ROW_LIMIT, DIGEST_ROW_LIMIT + 40);

    await digestTick(morning);

    expect(sent().subject).toContain(`${DIGEST_ROW_LIMIT + 40} updates`);
    expect(sent().text).toContain("And 40 more waiting on the board");
  });

  it("does nothing before the hour, and nothing without a mail server", async () => {
    expect(await digestTick(new Date("2026-08-17T02:00:00Z"))).toBe(0);

    isEmailConfigured.mockReturnValue(false);
    expect(await digestTick(morning)).toBe(0);
    expect(userFind).not.toHaveBeenCalled();
  });

  it("asks only for people who opted in and have somewhere to send it", async () => {
    await digestTick(morning);

    const [filter] = userFind.mock.calls.at(-1) ?? [];
    expect(filter).toEqual({
      emailDigest: true,
      email: { $ne: "" },
      lastDigestDay: { $ne: "2026-08-17" },
    });
  });

  // Turning mail off means no mail, digest included — decided in code now, because the condition
  // reads over a grid keyed by event
  it("leaves out somebody whose grid has mail off everywhere", async () => {
    userFind.mockReturnValue({
      lean: async () => [{ ...WAITING[0], emailNotifications: false }],
    });

    expect(await digestTick(morning)).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // The point of storing rows the bell hides: turning the in-app column off must not empty the
  // morning mail as well, or the two switches would silently cancel each other out
  it("lists a row the bell was told to hide, when the mail column is on", async () => {
    userFind.mockReturnValue({
      lean: async () => [
        {
          ...WAITING[0],
          notifications: {
            defaults: { status_changed: { inApp: false, email: true, chat: false } },
            projects: [],
          },
        },
      ],
    });

    expect(await digestTick(morning)).toBe(1);
    expect(sent().text).toContain("BP-1: moved to In Review");
  });

  // Muting a project has to hold in the morning too, or it only silences the day
  it("drops the rows belonging to a project muted in the mail column", async () => {
    userFind.mockReturnValue({
      lean: async () => [
        {
          ...WAITING[0],
          notifications: {
            defaults: { status_changed: { inApp: true, email: true, chat: false } },
            projects: [
              {
                project: PROJECT,
                matrix: { status_changed: { inApp: true, email: false, chat: false } },
              },
            ],
          },
        },
      ],
    });

    expect(await digestTick(morning)).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  /**
   * BP-659. The day is claimed before the message is built, so that a crash costs one digest rather
   * than sending it from every instance at once — and everything that was not a crash used to keep
   * that claim and end the reader's day in silence. What follows are the outcomes that are not a
   * delivery: refused, thrown, nothing to send, and the bound on how often the first two are tried
   * again. The delivery itself is asserted further up, in "sends one message listing what the
   * reader has not seen".
   *
   * It does not count itself. The sentence here used to say "these four tests", which was off by
   * one when it was written and off by four by the time the bound arrived.
   */
  it("hands the day back when the transport refuses it, and counts no delivery", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    sendEmail.mockResolvedValueOnce(false);

    // Not 1: the count is deliveries. `sendEmail` answers false rather than throwing, and that
    // answer used to be dropped, so a refused message was counted as a sent one.
    expect(await digestTick(morning)).toBe(0);
    // Back to "", which is the schema's default and what a fresh document holds — and the attempt
    // recorded against today, which is what stops this retrying until midnight
    expect(userUpdateOne).toHaveBeenCalledWith(
      { _id: "u1", lastDigestDay: MORNING_DAY },
      { $set: { lastDigestDay: "", digestRetry: { day: MORNING_DAY, attempts: 1 } } }
    );
    // Named: `email.ts` logs "Failed to send email" without saying whose message it was, so an
    // operator cannot tell a digest from a password reset
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("Digest for owner"));
  });

  /**
   * The bound, and why it needs one: `sendEmail` answers `false` for a server that is down for ten
   * seconds and for a mailbox that no longer exists, so without a count the second one is retried
   * on every tick from the digest hour to midnight — about two hundred times, each with a
   * `buildDigestFor` and an SMTP connection behind it.
   */
  it("stops trying after the day's attempts run out, and keeps the claim", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    userFind.mockReturnValue({
      lean: async () => [
        { ...WAITING[0], digestRetry: { day: MORNING_DAY, attempts: ATTEMPT_LIMIT - 1 } },
      ],
    });
    sendEmail.mockResolvedValueOnce(false);

    expect(await digestTick(morning)).toBe(0);

    // The claim stays: no `lastDigestDay: ""` in this write, so the candidate query passes this
    // reader over for the rest of the day
    expect(userUpdateOne).toHaveBeenCalledWith(
      { _id: "u1", lastDigestDay: MORNING_DAY },
      { $set: { digestRetry: { day: MORNING_DAY, attempts: ATTEMPT_LIMIT } } }
    );
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("waiting for tomorrow"));
  });

  // The attempt before the last one still gets its retry — the boundary, from the other side, so
  // an off-by-one in the comparison cannot pass both tests
  it("still retries on the attempt before the limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    userFind.mockReturnValue({
      lean: async () => [
        { ...WAITING[0], digestRetry: { day: MORNING_DAY, attempts: ATTEMPT_LIMIT - 2 } },
      ],
    });
    sendEmail.mockResolvedValueOnce(false);

    await digestTick(morning);

    expect(userUpdateOne).toHaveBeenCalledWith(
      { _id: "u1", lastDigestDay: MORNING_DAY },
      { $set: { lastDigestDay: "", digestRetry: { day: MORNING_DAY, attempts: ATTEMPT_LIMIT - 1 } } }
    );
  });

  // Keyed by the day, so yesterday's failures expire on their own rather than costing a reader
  // today's digest
  it("counts today's attempts only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    userFind.mockReturnValue({
      lean: async () => [{ ...WAITING[0], digestRetry: { day: "2026-08-16", attempts: 99 } }],
    });
    sendEmail.mockResolvedValueOnce(false);

    await digestTick(morning);

    expect(userUpdateOne).toHaveBeenCalledWith(
      { _id: "u1", lastDigestDay: MORNING_DAY },
      { $set: { lastDigestDay: "", digestRetry: { day: MORNING_DAY, attempts: 1 } } }
    );
  });

  // The claim's own filter says this cannot happen, which is exactly why it is worth a line: the
  // reader has lost the day and the count that was supposed to bound the retry went nowhere
  it("says so when the day's claim has vanished before the retry", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    sendEmail.mockResolvedValueOnce(false);
    userUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });

    await digestTick(morning);

    expect(logged).toHaveBeenCalledWith(expect.stringContaining("claim was gone before the retry"));
  });

  // The loop runs over every subscriber, so a write that throws for one of them must not end the
  // tick for everybody after it
  it("keeps going when recording the failure fails too", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    userFind.mockReturnValue({
      lean: async () => [
        ...WAITING,
        { _id: "u2", email: "b@example.com", username: "b", emailNotifications: true },
      ],
    });
    userFindOneAndUpdate.mockResolvedValue({ _id: "x" });
    sendEmail.mockResolvedValueOnce(false);
    userUpdateOne.mockRejectedValueOnce(new Error("the database went away"));

    // The second reader still gets theirs
    expect(await digestTick(morning)).toBe(1);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("could not record the failure for owner"),
      expect.any(Error)
    );
  });

  it("hands the day back when building the digest throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    notificationFind.mockImplementation(() => {
      throw new Error("the database went away mid-build");
    });

    expect(await digestTick(morning)).toBe(0);
    expect(userUpdateOne).toHaveBeenCalledWith(
      { _id: "u1", lastDigestDay: MORNING_DAY },
      { $set: { lastDigestDay: "", digestRetry: { day: MORNING_DAY, attempts: 1 } } }
    );
  });

  /**
   * The control, and the reason this is a release rather than "never claim until the end": a day
   * with nothing unread on it is not a failure. Keeping the claim is what stops the tick rebuilding
   * the same empty digest every five minutes until midnight.
   */
  it("keeps the claim on a quiet day, when there was nothing to deliver", async () => {
    notifications(0, 0);

    expect(await digestTick(morning)).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(userUpdateOne).not.toHaveBeenCalled();
  });

  // One person's mail server refusing must not cost everybody else their digest
  it("keeps going when a send fails", async () => {
    userFind.mockReturnValue({
      lean: async () => [
        ...WAITING,
        { _id: "u2", email: "b@example.com", username: "b", emailNotifications: true },
      ],
    });
    userFindOneAndUpdate.mockResolvedValue({ _id: "x" });
    sendEmail.mockRejectedValueOnce(new Error("smtp down"));

    expect(await digestTick(morning)).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });
});

describe("past the scan ceiling", () => {
  const morning = new Date("2026-08-17T05:30:00Z");

  // The count stops being a count once the read is capped, and a mail that prints a precise
  // number nobody computed is the silent cap this file already warns about, wearing a number.
  // Asserted on the SUBJECT: the "and N more" line contains the same words, so a body assertion
  // passed with the heading reverted to an exact figure.
  it("says the remainder is a floor rather than a total", async () => {
    notifications(DIGEST_SCAN_LIMIT + 200);

    expect(await digestTick(morning)).toBe(1);
    expect(sent().subject).toContain("at least");
    expect(sent().text).toContain("at least");
  });

  it("keeps the newest rows rather than the start of the day", async () => {
    const total = DIGEST_SCAN_LIMIT + 200;
    notifications(total);
    await digestTick(morning);

    // Ascending, the ceiling kept the first 500 of the day and the reader never saw what had just
    // happened. The newest row must be in the mail and the oldest must not.
    expect(sent().text).toContain(`BP-${total}:`);
    expect(sent().text).not.toContain("BP-1:");
  });

  it("says nothing about a floor when everything fitted", async () => {
    notifications(3);
    await digestTick(morning);

    expect(sent().subject).not.toContain("at least");
    expect(sent().text).not.toContain("at least");
  });
});

// BP-328. The digest is the one channel that reads the backlog straight out of the collection, so
// a row banked while somebody still held a grant would be mailed to them the morning after it was
// revoked — task keys, titles and links included.
describe("a digest for somebody who lost the board", () => {
  const DUE = new Date("2026-08-17T06:00:00Z");

  function digestFilter() {
    return (notificationFind.mock.calls.at(-1) ?? [])[0] as Record<string, unknown>;
  }

  // Two boards, so a digest that quietly covers only the first is a failure and not a pass.
  it("carries every board the reader can still reach", async () => {
    await digestTick(DUE);

    expect(digestFilter().project).toEqual({ $in: [BOARD, SECOND_BOARD] });
  });

  it("keeps the board they still hold when the other one is taken away", async () => {
    grantedProjects = [SECOND_BOARD];

    await digestTick(DUE);

    expect(digestFilter().project).toEqual({ $in: [SECOND_BOARD] });
  });

  it("sends nothing at all to somebody who holds no grant anywhere", async () => {
    grantedProjects = [];

    await digestTick(DUE);

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("leaves an instance admin's digest unconstrained, since they reach every board", async () => {
    userFind.mockReturnValue({
      lean: async () => [{ ...WAITING[0], role: "admin" }],
    });

    await digestTick(DUE);

    expect(digestFilter()).not.toHaveProperty("project");
  });

  it("asks for the role it needs to tell an admin from a member", async () => {
    await digestTick(DUE);

    const [, projection] = userFind.mock.calls[0] ?? [];
    expect(String(projection)).toContain("role");
  });

  /**
   * And for the field that bounds the retry, which is the only production input the bound has.
   * Every test in this file hands `digestRetry` back from a mocked `find` whatever was projected —
   * so dropping it from the projection string leaves them all green while, in production,
   * `attemptsToday` reads 0 on every tick and the retry runs until midnight. The bound would be
   * gone and nothing here would say so (BP-659 review).
   */
  it("asks for the attempt count that bounds the retry", async () => {
    await digestTick(DUE);

    const [, projection] = userFind.mock.calls[0] ?? [];
    expect(String(projection)).toContain("digestRetry");
  });
});

/**
 * BP-659 review. The bound started life as a count — three attempts — which is denominated in the
 * wrong unit: at the default interval that is ten minutes, and an operator who shortens the
 * interval so the digest lands closer to the hour would have silently shortened the retry window
 * with it. Greylisting, the failure this has to outlast, asks for fifteen minutes to an hour.
 */
describe("how long a failing digest keeps being retried", () => {
  /**
   * The attempts have to *span* the window, and n of them are spaced over n−1 intervals — so each
   * count below is one more than the division, and the last attempt lands an hour after the first.
   *
   * Seven minutes is here because the other three divide an hour exactly, and a set of exact
   * divisors cannot tell `Math.ceil` from `Math.floor`: with `floor`, a seven-minute interval
   * retries for 49 minutes instead of 56 and every assertion made of divisors stays green
   * (BP-659 review).
   */
  it("covers the retry window at whatever interval the instance runs", () => {
    expect(digestAttemptLimit(5 * 60_000)).toBe(13);
    expect(digestAttemptLimit(10 * 60_000)).toBe(7);
    expect(digestAttemptLimit(20 * 60_000)).toBe(4);
    expect(digestAttemptLimit(7 * 60_000)).toBe(10);
  });

  // Each attempt is a buildDigestFor and an SMTP connection, so a very short interval must not
  // turn one dead mailbox into thousands of them
  it("stops at the ceiling on what chasing it may cost", () => {
    expect(digestAttemptLimit(1_000)).toBe(MAX_DIGEST_ATTEMPTS);
  });

  /**
   * Two, not one — a limit of one is one attempt and no retry, which is the behaviour BP-659 exists
   * to remove. An interval at or above the window divides to one, and the e2e run is that case: its
   * timer is pinned to a day and its ticks are asked for over HTTP. The end-to-end test is what
   * found this, by delivering nothing on the retry.
   */
  it("never leaves a failure with no second chance at all", () => {
    expect(digestAttemptLimit(DIGEST_RETRY_WINDOW_MS)).toBe(2);
    expect(digestAttemptLimit(24 * 60 * 60_000)).toBe(2);
    expect(digestAttemptLimit(0)).toBe(MAX_DIGEST_ATTEMPTS);
    // Not academic: `Number("-5") || 300_000` keeps the −5, and a negative limit refuses every
    // retry rather than allowing them all
    expect(digestAttemptLimit(-5)).toBe(MAX_DIGEST_ATTEMPTS);
  });

  /**
   * The same floor, asserted as behaviour rather than as a number — which is the assertion that
   * would have caught the off-by-one. The three cases above all run at the default interval, where
   * the limit is twelve, so none of them reaches `limit === 1`; and the version of this file that
   * shipped the bug asserted `toBe(1)` here, encoding it instead of catching it (BP-659 review).
   *
   * A day-long interval is the e2e run's own configuration, and an hourly one is what a cautious
   * operator would pick.
   */
  it("still hands the day back at an interval longer than the window", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    process.env.DIGEST_TICK_MS = String(24 * 60 * 60_000);
    const { digestTick: tickOnADailyTimer } = await import("@/lib/digest");
    sendEmail.mockResolvedValueOnce(false);

    await tickOnADailyTimer(new Date("2026-08-17T09:00:00Z"));

    try {
      expect(userUpdateOne).toHaveBeenCalledWith(
        { _id: "u1", lastDigestDay: MORNING_DAY },
        { $set: { lastDigestDay: "", digestRetry: { day: MORNING_DAY, attempts: 1 } } }
      );
    } finally {
      // A failing assertion would otherwise leave the interval set for whatever runs next in this
      // worker; the next describe's own helper deletes it, which is luck rather than a guarantee
      delete process.env.DIGEST_TICK_MS;
    }
  });
});

/**
 * BP-660. `startDigestScheduler` answered `void`, and the condition deciding whether the digest
 * goes out at all — `isEmailConfigured()` — sat at the call site in `instrumentation.ts`. So
 * nothing could assert either, and both failure directions are silent: a digest that never goes
 * out produces no error and no failing request. The accident that had been exercising this path,
 * the unpinned five-minute timer running through every e2e run, is gone since BP-605.
 *
 * The timer is driven here rather than in a browser for the reason BP-605 gives: proving it fired
 * from a spec means waiting for a real tick, which is what the suite's pin exists to prevent.
 */
describe("arming the timer that sends it", () => {
  // 09:00 UTC is 11:00 in Warsaw in August, past the default 07:00 — so a tick that fires is due,
  // and a tick that did not fire is the only reason `User.find` would go uncalled below
  const DUE = new Date("2026-08-17T09:00:00Z");
  const TEN_MINUTES = 600_000;

  async function freshDigest(tickMs?: string) {
    vi.resetModules();
    if (tickMs === undefined) delete process.env.DIGEST_TICK_MS;
    else process.env.DIGEST_TICK_MS = tickMs;
    return import("@/lib/digest");
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: DUE });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DIGEST_TICK_MS;
  });

  it("says what it armed, and a second call arms nothing more", async () => {
    const { startDigestScheduler } = await freshDigest(String(TEN_MINUTES));

    expect(startDigestScheduler()).toEqual({ started: true, tickMs: TEN_MINUTES });
    // "Already running" rather than a second "off": a reload under `next dev` calls register()
    // again, and a log that cannot tell the two apart says a running scheduler is switched off
    expect(startDigestScheduler()).toEqual({ started: false, reason: "already running" });

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);

    // One tick, not two — which is what the latch is for, and the count no return value can prove
    expect(userFind).toHaveBeenCalledTimes(1);
  });

  it("takes the interval from the environment, and defaults to five minutes", async () => {
    const { startDigestScheduler } = await freshDigest();
    expect(startDigestScheduler()).toEqual({ started: true, tickMs: 300_000 });
  });

  it("arms nothing when there is no mail server to send through", async () => {
    isEmailConfigured.mockReturnValue(false);
    const { startDigestScheduler } = await freshDigest(String(TEN_MINUTES));

    expect(startDigestScheduler()).toEqual({ started: false, reason: "no mail server" });

    // The mail server "comes back" before the clock moves, and that line is load-bearing rather
    // than scene-setting. `digestTick` asks `isEmailConfigured()` again on its own first line and
    // returns 0 there — so with the answer left at false, a timer armed in spite of the refusal
    // would fire three times, reach the tick, and turn back before `User.find`, leaving this
    // assertion green. Measured: with the interval armed unconditionally, the whole file stayed
    // green without this line (BP-660 review).
    isEmailConfigured.mockReturnValue(true);

    // The half a return value cannot state: no timer was left behind either
    await vi.advanceTimersByTimeAsync(TEN_MINUTES * 3);
    expect(userFind).not.toHaveBeenCalled();
  });

  it("swallows a failed tick rather than leaving an unhandled rejection", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    userFind.mockImplementation(() => {
      throw new Error("the database went away");
    });
    const { startDigestScheduler } = await freshDigest(String(TEN_MINUTES));
    startDigestScheduler();

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);

    expect(logged).toHaveBeenCalledWith("Digest tick failed:", expect.any(Error));
    // And the timer survives it: a scheduler that stops at the first bad night is not a scheduler
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(userFind).toHaveBeenCalledTimes(2);
  });

  /**
   * A tick waits on a real mail server for every subscriber, so at a short interval the next one
   * can start while this one is still going. That matters more since BP-659: the day is handed back
   * when a send fails, and an overlapping tick can pick up a reader the first one has just released
   * and deliver twice.
   */
  it("skips a tick while the one before it is still going", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    let finish = () => {};
    userFind.mockReturnValue({
      lean: () =>
        new Promise((resolve) => {
          finish = () => resolve([]);
        }),
    });
    const { startDigestScheduler } = await freshDigest(String(TEN_MINUTES));
    startDigestScheduler();

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(userFind).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);

    expect(warned).toHaveBeenCalledWith(expect.stringContaining("previous one is still running"));
    expect(userFind).toHaveBeenCalledTimes(1);

    // Let the first one finish, so the next tick is taken again rather than refused for ever
    finish();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(userFind).toHaveBeenCalledTimes(2);
  });
});
