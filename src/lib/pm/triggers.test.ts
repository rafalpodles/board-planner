import { describe, it, expect, vi, beforeEach } from "vitest";

const runPmTurn = vi.fn();
const findByIdAndUpdate = vi.fn();
const createNotifications = vi.fn();

const WATCHER = "507f1f77bcf86cd799439051";
const REVIEW_COLUMN = { id: "needs_human_review", label: "Needs a human", role: "review", order: 4 };

/** The task the trigger is about. Null stands for one deleted between the turn and the mail. */
let reviewed: Record<string, unknown> | null = null;

// Projection-aware, because runPmTrigger asks for the pm config and the notification asks for the
// board's identity. One answer for both leaves the mail's project name and key untestable.
vi.mock("@/models/project", () => ({
  Project: {
    findById: (_id: unknown, projection?: string) => ({
      lean: async () =>
        projection === "pm"
          ? { pm: { enabled: true, autonomy: { handleNeedsHumanReview: true } } }
          : { key: "BP", name: "Board Planner", columns: [REVIEW_COLUMN] },
    }),
  },
}));
vi.mock("@/models/task", () => ({ Task: { findById: () => ({ lean: async () => reviewed }) } }));
vi.mock("@/models/pmTrigger", () => ({
  PmTrigger: { findByIdAndUpdate, create: vi.fn(), findOneAndUpdate: vi.fn() },
}));
vi.mock("@/lib/in-app-notifications", () => ({
  createNotifications,
  collectRecipients: (task: { watchers?: string[] }) => task?.watchers ?? [],
  assigneeIdOf: () => undefined,
}));
vi.mock("@/lib/escalation", () => ({ explicitEscalationColumnId: () => "needs_human_review" }));
vi.mock("@/lib/columns", () => ({
  getProjectColumns: (project: { columns?: unknown[] } | null) => project?.columns ?? [],
}));
vi.mock("./pm-user", () => ({ getPmUser: async () => ({ _id: "pm-user-id" }) }));
vi.mock("./agent", () => ({ runPmTurn }));
vi.mock("./turn-cap", () => ({ isOverDailyTurnCap: async () => ({ over: false, cap: 100 }) }));
vi.mock("./turn-lock", () => ({
  acquireTurnLock: () => new AbortController(),
  releaseTurnLock: vi.fn(),
}));
vi.mock("./availability", () => ({ isPmRunnable: () => true }));

const { runPmTrigger } = await import("./triggers");
const { NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS } = await import("./autonomy");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const trigger = { _id: "t1", project: "p1", task: "task1", taskKey: "BP-1", attempts: 1 } as any;

beforeEach(() => {
  vi.clearAllMocks();
  runPmTurn.mockResolvedValue({ ok: true, message: { content: "" } });
  reviewed = {
    _id: "task1",
    taskNumber: 1,
    title: "Session cookie survives a password change",
    status: "needs_human_review",
    watchers: [WATCHER],
  };
});

// BP-301: this turn is unattended and its prompt is built from board text, so it must
// run with the same withholding the scheduled review uses.
describe("runPmTrigger", () => {
  it("withholds assign_task and change_status from the turn", async () => {
    await runPmTrigger(trigger);

    expect(runPmTurn).toHaveBeenCalledWith(
      expect.objectContaining({ disallowedTools: NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS })
    );
    expect(findByIdAndUpdate).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ $set: expect.objectContaining({ state: "done" }) })
    );
  });

  it("does not ask the turn to move the task", async () => {
    await runPmTrigger(trigger);

    const { userMessage } = runPmTurn.mock.calls[0][0];
    expect(userMessage).toContain("cannot change statuses or assignees");
    expect(userMessage).not.toContain("move the task to the status you judge correct");
  });
});

/**
 * The turn runs with nobody watching, so this mail is the whole of how its verdict reaches a
 * person. Nothing here fired it: the fixture's task was null, so the notification returned before
 * it was assembled — deleting the notifyWatchers call left every test in the file green, and the
 * mock did not even export the assigneeIdOf the path calls.
 */
describe("what an autonomous PM review tells the watchers", () => {
  it("names the task, the column it is sitting in and what the PM concluded", async () => {
    runPmTurn.mockResolvedValue({ ok: true, message: { content: "Blocked on the OIDC redirect" } });

    await runPmTrigger(trigger);

    expect(createNotifications).toHaveBeenCalledTimes(1);
    const [notification] = createNotifications.mock.calls[0];
    expect(notification).toMatchObject({
      type: "comment_added",
      taskId: "task1",
      projectId: "p1",
      actorId: "pm-user-id",
      title: "PM reviewed BP-1 — needs your call",
      body: "Blocked on the OIDC redirect",
      recipientIds: [WATCHER],
    });
    expect(notification.email).toMatchObject({
      kicker: "PM review",
      taskKey: "BP-1",
      taskTitle: "Session cookie survives a password change",
      taskPills: [{ label: "Needs a human", tone: "review" }],
      taskMeta: "Board Planner · reviewed by pm",
      quote: { who: "pm · autonomous review", text: "Blocked on the OIDC redirect" },
      projectRef: "BP",
      taskNumber: 1,
    });
  });

  // The control: a turn that produced no verdict has nothing to announce, and the trigger is
  // retried rather than settled
  it("says nothing when the turn itself failed", async () => {
    runPmTurn.mockResolvedValue({ ok: false, error: "the model refused" });

    await runPmTrigger(trigger);

    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("says nothing about a task that is gone by the time the turn ends", async () => {
    reviewed = null;

    await runPmTrigger(trigger);

    expect(createNotifications).not.toHaveBeenCalled();
  });
});
