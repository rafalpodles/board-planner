import { describe, it, expect, vi, beforeEach } from "vitest";

const projectFind = vi.fn();
const findOneAndUpdate = vi.fn();
const runPmTurn = vi.fn();
const buildBoardDigest = vi.fn();
const drainPmTriggers = vi.fn();

const servedOrganisations = vi.hoisted(() => ({ list: null as null | { _id: unknown; digestHour?: number; timezone?: string }[] }));
// The gateway's counters are its own tests' business (src/lib/ai-gateway): these only need the door to open
const checkBudget = vi.hoisted(() => vi.fn(async () => ({ refusal: null as unknown, counter: "month" })));
vi.mock("@/lib/ai-gateway/budget", () => ({ counterKindOf: async () => "month", checkBudget }));
vi.mock("@/lib/ai-gateway/usage", () => ({ recordUsage: vi.fn() }));
vi.mock("@/lib/organisation-jobs", async () => {
  const { scoped } = await import("@/lib/db-scope");
  const { DEFAULT_ORGANISATION_ID } = await import("@/lib/organisation-field");
  return {
    stillServed: async () => true,
    forEachServedOrganisation: async (_job: string, work: (db: unknown, organisation: unknown) => Promise<void>) => {
      for (const organisation of servedOrganisations.list ?? [{ _id: DEFAULT_ORGANISATION_ID }]) await work(scoped(organisation._id as never), organisation);
    },
  };
});

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({ Project: { find: projectFind, findOneAndUpdate } }));
vi.mock("./agent", () => ({ runPmTurn }));
vi.mock("./triggers", () => ({ drainPmTriggers }));
vi.mock("./pm-user", () => ({ getPmUser: async () => ({ _id: "pm-user" }) }));
const resolveModelKey = vi.hoisted(() => vi.fn(async () => ({ ok: true, key: "k", source: "own" }) as unknown));
vi.mock("@/lib/model-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/model-keys")>()),
  resolveModelKey,
}));
vi.mock("./board-review", () => ({
  buildBoardDigest,
  digestHeadline: () => "Board review: 2 findings",
  renderBoardDigest: () => "- BP-1 has no acceptance criteria",
}));

const { pmSchedulerTick, startBoardReview, startPmScheduler } = await import("./scheduler");
const { isTurnRunning } = await import("./turn-lock");
const { BOARD_REVIEW_DISALLOWED_TOOLS, currentReviewSlot } = await import("./autonomy");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { DEFAULT_ORGANISATION_ID } = await import("@/lib/organisation-field");
const db = scopedToDefaultOrganisation();

const PM = { enabled: true, autonomy: { dailyReview: true, handleNeedsHumanReview: false, reviewHour: 0, reviewIntervalHours: 24, timezone: "UTC", lastReviewSlot: "" } };

beforeEach(() => {
  vi.clearAllMocks();
  projectFind.mockReturnValue({ lean: async () => [{ _id: "p1", key: "BP", pm: PM }] });
  findOneAndUpdate.mockResolvedValue({ _id: "p1" });
  buildBoardDigest.mockResolvedValue({ findings: 2 });
  runPmTurn.mockResolvedValue({ ok: true });
});

// BP-471: the daily review ran on a timer nothing in the suite could reach
describe("pmSchedulerTick", () => {
  it("claims the due slot before running, and runs the review with the board-changing tools withheld", async () => {
    await pmSchedulerTick();

    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: "p1", organisation: DEFAULT_ORGANISATION_ID, "pm.autonomy.lastReviewSlot": { $ne: update.$set["pm.autonomy.lastReviewSlot"] } });
    expect(findOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(runPmTurn.mock.invocationCallOrder[0]);
    expect(runPmTurn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        autonomous: true,
        projectId: "p1",
        storedMessage: "Board review: 2 findings",
        trigger: { type: "daily_review" },
        disallowedTools: BOARD_REVIEW_DISALLOWED_TOOLS,
        // The turn lock's controller: without it an interrupt could not stop a review
        signal: expect.any(AbortSignal),
      })
    );
    expect(BOARD_REVIEW_DISALLOWED_TOOLS).toEqual(expect.arrayContaining(["change_status", "create_task"]));
  });

  it("drains a bounded number of one organisation's triggers per tick, so a queue that never empties holds nobody else back (BP-671)", async () => {
    const { pmSchedulerTick, TRIGGERS_PER_ORGANISATION_PER_TICK } = await import("./scheduler");

    await pmSchedulerTick();

    expect(drainPmTriggers).toHaveBeenCalledWith(expect.anything(), { limit: TRIGGERS_PER_ORGANISATION_PER_TICK });
    expect(TRIGGERS_PER_ORGANISATION_PER_TICK).toBeLessThan(10);
  });

  it("runs one project's review at a time", async () => {
    projectFind.mockReturnValue({
      lean: async () => [
        { _id: "p1", key: "BP", pm: PM },
        { _id: "p2", key: "OT", pm: PM },
      ],
    });
    let finishFirst!: (v: unknown) => void;
    runPmTurn.mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)));

    const tick = pmSchedulerTick();
    await vi.waitFor(() => expect(runPmTurn).toHaveBeenCalledTimes(1));
    // Given time to start the second, it must not have
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runPmTurn).toHaveBeenCalledTimes(1);

    finishFirst({ ok: true });
    await tick;
    expect(runPmTurn).toHaveBeenCalledTimes(2);
    expect(runPmTurn.mock.calls[1][1].projectId).toBe("p2");
  });

  it("leaves the slot unclaimed while another turn holds the project, so the next tick can still run it", async () => {
    const { acquireTurnLock, releaseTurnLock } = await import("./turn-lock");
    acquireTurnLock("p1", "someone");
    try {
      await pmSchedulerTick();
    } finally {
      releaseTurnLock("p1");
    }

    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(runPmTurn).not.toHaveBeenCalled();
  });

  it("runs nothing when another tick already claimed the slot", async () => {
    findOneAndUpdate.mockResolvedValue(null);

    await pmSchedulerTick();

    expect(runPmTurn).not.toHaveBeenCalled();
  });

  it("runs nothing when this slot's review has already happened", async () => {
    const slotTaken = { ...PM, autonomy: { ...PM.autonomy, lastReviewSlot: currentReviewSlot(new Date(), PM.autonomy)! } };
    projectFind.mockReturnValue({ lean: async () => [{ _id: "p1", key: "BP", pm: slotTaken }] });

    await pmSchedulerTick();

    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(runPmTurn).not.toHaveBeenCalled();
  });
});

describe("startBoardReview", () => {
  it("refuses without a model, rather than spending a turn on a warning", async () => {
    resolveModelKey.mockResolvedValueOnce({ ok: false, reason: "not_configured", plan: "free" });

    const start = await startBoardReview(db, "p1", "BP", PM, "pm-user");

    expect(start).toEqual({ status: "skipped", reason: "the PM agent is not configured on this instance" });
    expect(runPmTurn).not.toHaveBeenCalled();
    expect(isTurnRunning("p1")).toBe(false);
  });

  // BP-652: the reason is what the owner who pressed "Run a review now" is told
  it("says a Free organisation needs a key of its own or Pro, and spends nothing", async () => {
    resolveModelKey.mockResolvedValueOnce({ ok: false, reason: "needs_plan", plan: "free" });

    const start = await startBoardReview(db, "p1", "BP", PM, "pm-user");

    expect(start).toEqual({ status: "skipped", reason: expect.stringMatching(/your own key.*upgrade to Pro/) });
    expect(runPmTurn).not.toHaveBeenCalled();
  });

  // BP-680: the operator's key is only spent while the organisation has some of its allowance left
  it("refuses a review the organisation has no AI allowance left for, naming the number and the renewal, and runs nothing", async () => {
    resolveModelKey.mockResolvedValueOnce({ ok: true, key: "k", source: "managed" });
    checkBudget.mockResolvedValueOnce({ refusal: { scope: "month", used: 15_000_000, limit: 15_000_000, resetsAt: new Date("2026-11-01T00:00:00Z") }, counter: "month" });

    const start = await startBoardReview(db, "p1", "BP", PM, "pm-user");

    expect(start).toEqual({ status: "skipped", reason: expect.stringMatching(/15,000,000 of 15,000,000.*1 November 2026/) });
    expect(runPmTurn).not.toHaveBeenCalled();
  });

  it("says a stored key that cannot be read has to be entered again", async () => {
    resolveModelKey.mockResolvedValueOnce({ ok: false, reason: "own_key_unreadable", plan: "pro" });

    const start = await startBoardReview(db, "p1", "BP", PM, "pm-user");

    expect(start).toEqual({ status: "skipped", reason: expect.stringMatching(/cannot be read.*Enter it again/) });
  });

  it("gives the turn back when the board has nothing to review, without a turn", async () => {
    buildBoardDigest.mockResolvedValue(null);

    const start = await startBoardReview(db, "p1", "BP", PM, "pm-user");
    expect(start.status).toBe("started");
    if (start.status === "started") await start.done;

    expect(runPmTurn).not.toHaveBeenCalled();
    expect(isTurnRunning("p1")).toBe(false);
  });

  it("refuses a second review while the first holds the project's turn", async () => {
    let finish!: (v: unknown) => void;
    runPmTurn.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    const first = await startBoardReview(db, "p1", "BP", PM, "pm-user");
    const second = await startBoardReview(db, "p1", "BP", PM, "pm-user");

    expect(first.status).toBe("started");
    expect(second).toEqual({ status: "skipped", reason: "a PM turn is already running on this project" });
    finish({ ok: true });
    if (first.status === "started") await first.done;
    expect(isTurnRunning("p1")).toBe(false);
  });

  it("gives the turn back even when the review throws", async () => {
    runPmTurn.mockRejectedValue(new Error("provider down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const start = await startBoardReview(db, "p1", "BP", PM, "pm-user");
    expect(start.status).toBe("started");
    expect(isTurnRunning("p1")).toBe(true);
    if (start.status === "started") await start.done;

    expect(runPmTurn).toHaveBeenCalledTimes(1);
    expect(isTurnRunning("p1")).toBe(false);
    error.mockRestore();
  });
});

describe("startPmScheduler", () => {
  it("skips a tick while the previous one still runs, and says so (BP-671)", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { connectDB } = await import("@/lib/db");
    vi.mocked(connectDB).mockReturnValueOnce(new Promise(() => {}));
    try {
      startPmScheduler();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(connectDB).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(connectDB).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("PM scheduler tick skipped: the previous one is still running");
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
