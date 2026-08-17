import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEmail = vi.fn().mockResolvedValue(true);
const selfOrigin = vi.fn<() => string | null>(() => "https://app.example.com");
const insertMany = vi.fn().mockResolvedValue([]);

const ASSIGNEE = "507f1f77bcf86cd799439011";
const WATCHER = "507f1f77bcf86cd799439012";
const ACTOR = "507f1f77bcf86cd799439013";

vi.mock("@/models/notification", () => ({ Notification: { insertMany: (...a: unknown[]) => insertMany(...a) } }));
vi.mock("@/models/user", () => ({
  User: {
    find: () => ({
      lean: async () => [
        { _id: ASSIGNEE, email: "assignee@example.com", fullName: "Ann" },
        { _id: WATCHER, email: "watcher@example.com", fullName: "Wes" },
      ],
    }),
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
  selfOrigin.mockReturnValue("https://app.example.com");
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
