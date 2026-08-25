import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEmail = vi.fn().mockResolvedValue(true);
const sendPersonalChat = vi.fn(async (_params: unknown): Promise<void> => {});
const selfOrigin = vi.fn<() => string | null>(() => "https://app.example.com");
const insertMany = vi.fn().mockResolvedValue([]);
const userFind = vi.fn();
const grantFind = vi.fn();

const ASSIGNEE = "507f1f77bcf86cd799439011";
const WATCHER = "507f1f77bcf86cd799439012";
const ACTOR = "507f1f77bcf86cd799439013";
const ADMIN = "507f1f77bcf86cd799439014";
const NOTIFICATION_PROJECT = "507f1f77bcf86cd799439021";

/** Who holds a grant on the project, per test. The delivery filter reads this through grants.ts. */
let granted: string[] = [];
/** Stored role per recipient. "admin" reaches every board without a grant row existing. */
let roles: Record<string, string> = {};
/** Makes the access lookup reject, so the fail-closed branch can be exercised. */
let accessLookupFails = false;

/** Per-test notification preferences, layered over the mailbox fixture. */
let prefs: Record<string, Record<string, unknown>> = {};

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
      const filter = a[0] as { subject?: { $in?: string[] }; objectType?: string; object?: string };
      const asked = filter?.subject?.$in ?? [];
      if (accessLookupFails) {
        return { select: () => ({ lean: async () => { throw new Error("no database"); } }) };
      }
      // Honours objectType and object, so a query that forgot either would return grants it has
      // no business returning and the tests below would notice.
      if (filter?.objectType !== "project" || filter?.object !== NOTIFICATION_PROJECT) {
        return { select: () => ({ lean: async () => [] }) };
      }
      return {
        select: () => ({
          lean: async () =>
            asked
              .filter((id) => granted.includes(id))
              .map((id) => ({ subject: id, relation: "member" })),
        }),
      };
    },
  },
}));
// Query-aware because two callers share it: grants.ts asks for stored roles, the mail fan-out
// asks who wants mail and passes a projection as the second argument. Answering both with one
// list would make the access filter untestable.
vi.mock("@/models/user", () => ({
  User: {
    find: (...a: unknown[]) => {
      userFind(...a);
      const filter = a[0] as { _id?: { $in?: string[] }; role?: string };
      const asked = filter?._id?.$in ?? [];
      if (a[1] === undefined) {
        return {
          select: () => ({
            lean: async () =>
              asked
                .filter((id) => roles[id])
                // Honoured, so re-adding `role: "admin"` to the access query — which would make
                // every recipient an admin and the filter a no-op — fails here too, not only in
                // grants.test.ts.
                .filter((id) => filter.role === undefined || filter.role === roles[id])
                .map((id) => ({ _id: id, role: roles[id] })),
          }),
        };
      }
      return {
        lean: async () =>
          asked
            .filter((id) => MAILBOXES[id])
            // Preferences decide per recipient now rather than filtering inside the query, so the
            // fan-out fixture carries them. The default is an ordinary account that predates the
            // grid: emailNotifications is its stored preference and nothing has been migrated.
            .map((id) => ({
              _id: id,
              ...MAILBOXES[id],
              emailNotifications: true,
              ...(prefs[id] ?? {}),
            })),
      };
    },
  },
}));
vi.mock("@/lib/email", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
  isEmailConfigured: () => true,
}));
vi.mock("@/lib/session", () => ({ selfOrigin: () => selfOrigin() }));
vi.mock("@/lib/personal-chat", () => ({ sendPersonalChat: (p: unknown) => sendPersonalChat(p) }));

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
  sendPersonalChat.mockClear();
  insertMany.mockClear();
  prefs = {};
  userFind.mockClear();
  grantFind.mockClear();
  selfOrigin.mockReturnValue("https://app.example.com");
  granted = [ASSIGNEE, WATCHER];
  roles = { [ASSIGNEE]: "member", [WATCHER]: "member", [ADMIN]: "admin" };
  accessLookupFails = false;
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
      "<https://app.example.com/settings/notifications>"
    );
    expect(mail.html).toContain("https://app.example.com/settings/notifications");
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
    prefs[ASSIGNEE] = { emailDigest: true };

    await createNotifications(NOTIFICATION);
    await sentMails();

    const to = sendEmail.mock.calls.map(([p]) => (p as { to: string }).to);
    expect(to).toEqual(["watcher@example.com"]);
  });

  // The bell hides the row; it does not stop the write. The digest is assembled from these
  // documents, so a skipped insert would take tomorrow's mail down with today's bell.
  it("still stores a notification the bell is not allowed to show", async () => {
    prefs[WATCHER] = {
      notifications: {
        defaults: { comment_added: { inApp: false, email: true, chat: false } },
        projects: [],
      },
    };

    await createNotifications({ ...NOTIFICATION, recipientIds: [WATCHER] });

    expect(insertMany.mock.calls[0][0][0]).toMatchObject({ inApp: false });
    await sentMails();
  });

  it("sends no mail for a project the recipient muted, while another project still arrives", async () => {
    prefs[WATCHER] = {
      notifications: {
        projects: [
          {
            project: NOTIFICATION.projectId,
            matrix: { comment_added: { inApp: true, email: false, chat: false } },
          },
        ],
      },
    };

    await createNotifications({ ...NOTIFICATION, recipientIds: [WATCHER] });
    expect(sendEmail).not.toHaveBeenCalled();

    // The bell still rings for it — one channel muted for one board is not the whole row
    expect(insertMany.mock.calls[0][0][0]).toMatchObject({ inApp: true });

    // And with the override gone, the same event reaches them
    prefs[WATCHER] = {};
    await createNotifications({ ...NOTIFICATION, recipientIds: [WATCHER] });
    await sentMails();
  });

  // Every writer calls createNotifications without awaiting it, so anything that escapes is an
  // unhandled rejection — which ends the process rather than losing one notification. A username
  // reaching the recipient list is enough to cast: `new ObjectId("admin")` throws.
  it("does not reject when a recipient is not an id", async () => {
    await expect(
      createNotifications({ ...NOTIFICATION, recipientIds: ["admin"] })
    ).resolves.toBeUndefined();
  });

  it("still writes to the recipients that are ids when one of them is not", async () => {
    await createNotifications({ ...NOTIFICATION, recipientIds: ["admin", WATCHER] });

    expect(insertMany.mock.calls[0][0]).toHaveLength(1);
    expect(insertMany.mock.calls[0][0][0]).toMatchObject({ title: NOTIFICATION.title });
  });

  // Anything the notification path throws is the notification's problem, not the caller's
  it("does not reject when the preference read fails", async () => {
    userFind.mockImplementationOnce(() => {
      throw new Error("mongo is having a bad afternoon");
    });

    await expect(createNotifications(NOTIFICATION)).resolves.toBeUndefined();
  });

  it("never writes to the person who caused the notification", async () => {
    await createNotifications({ ...NOTIFICATION, actorId: ASSIGNEE });

    expect(insertMany).toHaveBeenCalledWith([expect.objectContaining({ title: NOTIFICATION.title })]);
    expect(insertMany.mock.calls[0][0]).toHaveLength(1);
  });
});

/**
 * Both fan-outs are started and walked away from: notify() has already answered the request that
 * caused them. A rejection escaping either one is an unhandled rejection, which ends the process
 * rather than losing a single notification — so each has a .catch(), and each .catch() was held up
 * by nothing.
 *
 * Every failure below is an implementation that THROWS rather than mockRejectedValue. That one
 * builds its rejected promise when the test sets it up; vitest attaches a handler there and the
 * test then passes with the .catch() deleted, which is the only thing it exists to prove.
 *
 * Recorded gap: the per-recipient `sendEmail(...).catch(() => {})` inside the mail fan-out cannot
 * be pinned this way. It swallows silently — no log line, no effect on the loop, which is not
 * awaited either — so nothing distinguishes the guarded version from the unguarded one except an
 * unhandled rejection arriving at the runtime. Pinning it needs a process-level
 * "unhandledRejection" listener, which is a different kind of test from these.
 */
describe("the fan-outs nobody awaits", () => {
  const CHAT_CONNECTED = {
    notifications: {
      defaults: { comment_added: { inApp: true, email: false, chat: true } },
      projects: [],
      chat: { kind: "slack", webhookUrl: "https://hooks.example.com/T/B/x" },
    },
  };

  it("hands the personal chat fan-out the recipients who asked for it, and the mail payload", async () => {
    prefs[WATCHER] = CHAT_CONNECTED;

    await createNotifications({ ...NOTIFICATION, recipientIds: [WATCHER] });

    const [chat] = sendPersonalChat.mock.calls.at(-1) ?? [];
    expect(chat).toMatchObject({
      type: "comment_added",
      title: NOTIFICATION.title,
      email: NOTIFICATION.email,
      users: [expect.objectContaining({ _id: WATCHER })],
    });
    // Mail was off in that grid, so the two channels are decided separately rather than together
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("leaves chat alone for somebody who connected nothing", async () => {
    await createNotifications({ ...NOTIFICATION, recipientIds: [WATCHER] });
    await sentMails();

    expect(sendPersonalChat).not.toHaveBeenCalled();
  });

  it("logs and survives a mail fan-out that throws", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    selfOrigin.mockImplementation(() => {
      throw new Error("origin is misconfigured");
    });

    await expect(createNotifications(NOTIFICATION)).resolves.toBeUndefined();

    await vi.waitFor(() =>
      expect(reported).toHaveBeenCalledWith(
        "Failed to send email notifications:",
        expect.any(Error)
      )
    );
    reported.mockRestore();
  });

  it("logs and survives a chat fan-out that throws", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    prefs[WATCHER] = CHAT_CONNECTED;
    sendPersonalChat.mockImplementationOnce(async () => {
      throw new Error("slack answered 404");
    });

    await expect(
      createNotifications({ ...NOTIFICATION, recipientIds: [WATCHER] })
    ).resolves.toBeUndefined();

    await vi.waitFor(() =>
      expect(reported).toHaveBeenCalledWith(
        "Failed to send chat notifications:",
        expect.any(Error)
      )
    );
    reported.mockRestore();
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

    await createNotifications({ ...NOTIFICATION, recipientIds: [WATCHER, ADMIN] });

    expect(recipientIdsOf(insertMany.mock.calls[0])).toEqual([ADMIN]);
  });

  it("writes nothing and mails nobody when no recipient can reach the board", async () => {
    granted = [];

    await createNotifications(NOTIFICATION);

    expect(insertMany).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // The choice is stated in a comment in the source and was defended by nothing: turning the
  // refusal back into delivery-to-everybody kept every test green, which is exactly the edit
  // somebody chasing "notifications go missing when Mongo hiccups" would make.
  it("delivers to nobody when it cannot find out who may be told", async () => {
    accessLookupFails = true;

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
