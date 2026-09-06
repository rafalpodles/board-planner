import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendEmail = vi.fn().mockResolvedValue(true);
const isEmailConfigured = vi.fn(() => true);
const selfOrigin = vi.fn<() => string | null>(() => "https://app.example.com");
const userFind = vi.fn();
const userFindOneAndUpdate = vi.fn();
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
  User: { find: (...a: unknown[]) => userFind(...a), findOneAndUpdate: (...a: unknown[]) => userFindOneAndUpdate(...a) },
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

const { digestTick, dueDigestDay, digestHour, digestTimezone, DIGEST_ROW_LIMIT, DIGEST_SCAN_LIMIT } = await import(
  "@/lib/digest"
);

const BOARD = "69a52e3b399b27d3cbb2c5a5";
const SECOND_BOARD = "69a52e3b399b27d3cbb2c5a7";
const WAITING = [
  { _id: "u1", email: "rpo@example.com", username: "rpo", role: "member", emailNotifications: true },
];

const PROJECT = "507f1f77bcf86cd799439021";

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
    expect(sent().text).toContain("BP-1: moved to In Review");
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

  it("leaves out somebody whose grid has mail off everywhere", async () => {
    userFind.mockReturnValue({
      lean: async () => [{ ...WAITING[0], emailNotifications: false }],
    });

    expect(await digestTick(morning)).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

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

describe("a digest for somebody who lost the board", () => {
  const DUE = new Date("2026-08-17T06:00:00Z");

  function digestFilter() {
    return (notificationFind.mock.calls.at(-1) ?? [])[0] as Record<string, unknown>;
  }

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
});
