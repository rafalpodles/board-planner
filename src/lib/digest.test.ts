import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendEmail = vi.fn().mockResolvedValue(true);
const isEmailConfigured = vi.fn(() => true);
const selfOrigin = vi.fn<() => string | null>(() => "https://app.example.com");
const userFind = vi.fn();
const userFindOneAndUpdate = vi.fn();
const notificationFind = vi.fn();
const notificationCount = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
  isEmailConfigured: () => isEmailConfigured(),
}));
vi.mock("@/lib/session", () => ({ selfOrigin: () => selfOrigin() }));
vi.mock("@/models/user", () => ({
  User: { find: (...a: unknown[]) => userFind(...a), findOneAndUpdate: (...a: unknown[]) => userFindOneAndUpdate(...a) },
}));
vi.mock("@/models/notification", () => ({
  Notification: {
    find: (...a: unknown[]) => notificationFind(...a),
    countDocuments: (...a: unknown[]) => notificationCount(...a),
  },
}));

const { digestTick, dueDigestDay, digestHour, digestTimezone, DIGEST_ROW_LIMIT, DIGEST_SCAN_LIMIT } = await import(
  "@/lib/digest"
);

// An ordinary account that predates the grid: emailNotifications is still its stored preference,
// and the digest now reads that through resolveChannels rather than through the query.
const WAITING = [
  { _id: "u1", email: "rpo@example.com", username: "rpo", emailNotifications: true },
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
  notifications(3);
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
