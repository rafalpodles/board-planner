import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEmail = vi.fn().mockResolvedValue(true);
const selfOrigin = vi.fn<() => string | null>(() => "https://app.example.com");
const insertMany = vi.fn().mockResolvedValue([]);
const userFind = vi.fn();
const grantFind = vi.fn();

const ASSIGNEE = "507f1f77bcf86cd799439011";
const WATCHER = "507f1f77bcf86cd799439012";
const ACTOR = "507f1f77bcf86cd799439013";
const ADMIN = "507f1f77bcf86cd799439014";

/** Who holds a grant on the project, per test. The delivery filter reads this through grants.ts. */
let granted: string[] = [];
/** Who is an instance admin, per test — access without any grant row. */
let instanceAdmins: string[] = [];

const MAILBOXES: Record<string, { email: string; fullName: string }> = {
  [ASSIGNEE]: { email: "assignee@example.com", fullName: "Ann" },
  [WATCHER]: { email: "watcher@example.com", fullName: "Wes" },
  [ADMIN]: { email: "admin@example.com", fullName: "Ada" },
};

vi.mock("@/models/notification", () => ({ Notification: { insertMany: (...a: unknown[]) => insertMany(...a) } }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/grant", () => ({
  Grant: {
    find: (...a: unknown[]) => {
      grantFind(...a);
      const filter = a[0] as { subject?: { $in?: string[] } };
      const asked = filter?.subject?.$in ?? [];
      return {
        select: () => ({
          lean: async () =>
            asked.filter((id) => granted.includes(id)).map((id) => ({ subject: id })),
        }),
      };
    },
  },
}));
// Query-aware because two callers share it: grants.ts asks "which of these are instance admins",
// the mail fan-out asks "which of these want mail". Answering both with one list would make
// every recipient an admin and the access filter untestable.
vi.mock("@/models/user", () => ({
  User: {
    find: (...a: unknown[]) => {
      userFind(...a);
      const filter = a[0] as { role?: string; _id?: { $in?: string[] } };
      const asked = filter?._id?.$in ?? [];
      if (filter?.role === "admin") {
        return {
          select: () => ({
            lean: async () =>
              asked.filter((id) => instanceAdmins.includes(id)).map((id) => ({ _id: id })),
          }),
        };
      }
      return {
        lean: async () =>
          asked.filter((id) => MAILBOXES[id]).map((id) => ({ _id: id, ...MAILBOXES[id] })),
      };
    },
  },
}));
vi.mock("@/lib/email", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
  isEmailConfigured: () => true,
}));
vi.mock("@/lib/session", () => ({ selfOrigin: () => selfOrigin() }));

const { createNotifications, collectRecipients, assigneeIdOf } = await import(
  "@/lib/in-app-notifications"
);

const NOTIFICATION = {
  type: "comment_added" as const,
  taskId: "507f1f77bcf86cd799439020",
  projectId: "507f1f77bcf86cd799439021",
  actorId: ACTOR,
  title: "New comment on BP-142",
  body: "Revoking on password change turned out to be two writes",
  recipientIds: [ASSIGNEE, WATCHER],
  email: {
    kicker: "New comment",
    taskKey: "BP-142",
    taskTitle: "Session cookie survives a password change",
    projectRef: "BP",
    taskNumber: 142,
    assigneeId: ASSIGNEE,
    quote: { who: "rafal", text: "two writes, not one" },
  },
};

async function sentMails() {
  await vi.waitFor(() => expect(sendEmail).toHaveBeenCalled());
  return sendEmail.mock.calls.map(([params]) => params as Record<string, string> & {
    headers?: Record<string, string>;
  });
}

beforeEach(() => {
  sendEmail.mockClear();
  insertMany.mockClear();
  userFind.mockClear();
  grantFind.mockClear();
  selfOrigin.mockReturnValue("https://app.example.com");
  granted = [ASSIGNEE, WATCHER];
  instanceAdmins = [];
});

describe("notification emails", () => {
  it("links back to the task the notification is about", async () => {
    await createNotifications(NOTIFICATION);
    const [mail] = await sentMails();

    expect(mail.html).toContain("https://app.example.com/projects/BP/tasks/142");
    expect(mail.text).toContain("https://app.example.com/projects/BP/tasks/142");
    expect(mail.subject).toBe("[Board Planner] New comment on BP-142");
  });

  it("offers the reader a way out instead of the spam button", async () => {
    await createNotifications(NOTIFICATION);
    const [mail] = await sentMails();

    expect(mail.headers?.["List-Unsubscribe"]).toBe(
      "<https://app.example.com/settings/profile>"
    );
    expect(mail.html).toContain("https://app.example.com/settings/profile");
  });

  it("tells each recipient why they got it", async () => {
    await createNotifications(NOTIFICATION);
    const mails = await sentMails();

    const toAssignee = mails.find((m) => m.to === "assignee@example.com");
    const toWatcher = mails.find((m) => m.to === "watcher@example.com");
    expect(toAssignee?.text).toContain("you're the assignee on BP-142");
    expect(toWatcher?.text).toContain("you watch BP-142");
  });

  it("says who mentioned them when that is why they were written to", async () => {
    await createNotifications({
      ...NOTIFICATION,
      type: "mentioned",
      title: "rafal mentioned you in BP-142",
      email: { ...NOTIFICATION.email, kicker: "You were mentioned" },
    });
    const [mail] = await sentMails();

    expect(mail.text).toContain("you were mentioned in a comment on BP-142");
  });

  // A build-machine literal is what NEXT_PUBLIC_APP_URL would have offered here (BP-316), so an
  // unconfigured instance sends the mail without a link rather than with a wrong one.
  it("still sends when the instance has no configured origin, minus the link", async () => {
    selfOrigin.mockReturnValue(null);
    await createNotifications(NOTIFICATION);
    const [mail] = await sentMails();

    expect(mail.html).not.toContain("href=\"http");
    expect(mail.headers).toBeUndefined();
    expect(mail.html).toContain("Session cookie survives a password change");
  });

  // Somebody on the digest hears about this in one message tomorrow morning; sending both would
  // make the digest a duplicate rather than a replacement
  it("skips the people who chose the daily digest", async () => {
    await createNotifications(NOTIFICATION);
    await sentMails();

    const [filter] = userFind.mock.calls.at(-1) ?? [];
    expect(filter.emailNotifications).toBe(true);
    expect(filter.emailDigest).toEqual({ $ne: true });
  });

  it("never writes to the person who caused the notification", async () => {
    await createNotifications({ ...NOTIFICATION, actorId: ASSIGNEE });

    expect(insertMany).toHaveBeenCalledWith([expect.objectContaining({ title: NOTIFICATION.title })]);
    expect(insertMany.mock.calls[0][0]).toHaveLength(1);
  });
});

describe("assigneeIdOf", () => {
  it("reads a populated assignee and a bare ref alike", () => {
    expect(assigneeIdOf({ assignee: { _id: ASSIGNEE } })).toBe(ASSIGNEE);
    expect(assigneeIdOf({ assignee: ASSIGNEE })).toBe(ASSIGNEE);
    expect(assigneeIdOf({})).toBeUndefined();
  });

  it("agrees with collectRecipients about who the assignee is", () => {
    expect(collectRecipients({ assignee: { _id: ASSIGNEE }, watchers: [WATCHER] })).toEqual([
      ASSIGNEE,
      WATCHER,
    ]);
  });
});

// BP-328. Watch membership is acquired by commenting and never expires, so a contractor removed
// from the board keeps every watch they accumulated. The rows are kept deliberately — a re-add
// restores the feed — which is exactly why delivery, not the watcher list, has to do the refusing.
describe("delivery to somebody who can no longer reach the board", () => {
  function recipientIdsOf(call: unknown[]) {
    return (call[0] as { recipient: string }[]).map((row) => String(row.recipient));
  }

  it("writes no row for a recipient whose grant on the project is gone", async () => {
    granted = [ASSIGNEE];

    await createNotifications(NOTIFICATION);

    expect(insertMany).toHaveBeenCalledTimes(1);
    expect(recipientIdsOf(insertMany.mock.calls[0])).toEqual([ASSIGNEE]);
  });

  it("sends no mail to a recipient whose grant on the project is gone", async () => {
    granted = [ASSIGNEE];

    await createNotifications(NOTIFICATION);
    const mails = await sentMails();

    expect(mails.map((m) => m.to)).toEqual(["assignee@example.com"]);
  });

  it("still notifies an instance admin, who reaches the board without a grant row", async () => {
    granted = [];
    instanceAdmins = [ADMIN];

    await createNotifications({ ...NOTIFICATION, recipientIds: [WATCHER, ADMIN] });

    expect(recipientIdsOf(insertMany.mock.calls[0])).toEqual([ADMIN]);
  });

  it("writes nothing and mails nobody when no recipient can reach the board", async () => {
    granted = [];

    await createNotifications(NOTIFICATION);

    expect(insertMany).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("asks about the project the notification is about, not some other one", async () => {
    granted = [ASSIGNEE, WATCHER];

    await createNotifications(NOTIFICATION);

    expect(grantFind).toHaveBeenCalledWith(
      expect.objectContaining({ objectType: "project", object: NOTIFICATION.projectId })
    );
  });
});
