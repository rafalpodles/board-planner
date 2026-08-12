import { describe, it, expect, vi, beforeEach } from "vitest";

const runPmTurn = vi.fn();
const findByIdAndUpdate = vi.fn();

vi.mock("@/models/project", () => ({
  Project: {
    findById: () => ({
      lean: async () => ({ pm: { enabled: true, autonomy: { handleNeedsHumanReview: true } } }),
    }),
  },
}));
vi.mock("@/models/task", () => ({ Task: { findById: () => ({ lean: async () => null }) } }));
vi.mock("@/models/pmTrigger", () => ({
  PmTrigger: { findByIdAndUpdate, create: vi.fn(), findOneAndUpdate: vi.fn() },
}));
vi.mock("@/lib/in-app-notifications", () => ({
  createNotifications: vi.fn(),
  collectRecipients: () => [],
}));
vi.mock("@/lib/escalation", () => ({ explicitEscalationColumnId: () => "needs_human_review" }));
vi.mock("@/lib/columns", () => ({ getProjectColumns: () => [] }));
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
