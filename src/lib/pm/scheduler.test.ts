import { describe, it, expect, vi, beforeEach } from "vitest";

const projectFind = vi.fn();
const findOneAndUpdate = vi.fn();
const runPmTurn = vi.fn();
const isOverDailyTurnCap = vi.fn();
const dailyPmSpend = vi.fn();
const buildBoardDigest = vi.fn();
const drainPmTriggers = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({ Project: { find: projectFind, findOneAndUpdate } }));
vi.mock("./agent", () => ({ runPmTurn }));
vi.mock("./turn-cap", () => ({ isOverDailyTurnCap, dailyPmSpend }));
vi.mock("./triggers", () => ({ drainPmTriggers }));
vi.mock("./pm-user", () => ({ getPmUser: async () => ({ _id: "pm-user" }) }));
vi.mock("./board-review", () => ({
  buildBoardDigest,
  digestHeadline: () => "Board review: 2 findings",
  renderBoardDigest: () => "- BP-1 has no acceptance criteria",
}));

const { pmSchedulerTick, startBoardReview } = await import("./scheduler");
const { isTurnRunning } = await import("./turn-lock");
const { BOARD_REVIEW_DISALLOWED_TOOLS, currentReviewSlot } = await import("./autonomy");

const PM = { enabled: true, dailyTurnCap: 100, autonomy: { dailyReview: true, handleNeedsHumanReview: false, reviewHour: 0, reviewIntervalHours: 24, timezone: "UTC", lastReviewSlot: "" } };

beforeEach(() => {
  vi.clearAllMocks();
  projectFind.mockReturnValue({ lean: async () => [{ _id: "p1", key: "BP", pm: PM }] });
  findOneAndUpdate.mockResolvedValue({ _id: "p1" });
  isOverDailyTurnCap.mockResolvedValue({ over: false, cap: 100 });
  dailyPmSpend.mockResolvedValue({ over: false });
  buildBoardDigest.mockResolvedValue({ findings: 2 });
  runPmTurn.mockResolvedValue({ ok: true });
});

// BP-471: the daily review ran on a timer nothing in the suite could reach
describe("pmSchedulerTick", () => {
  it("claims the due slot before running, and runs the review with the board-changing tools withheld", async () => {
    await pmSchedulerTick();

    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: "p1", "pm.autonomy.lastReviewSlot": { $ne: update.$set["pm.autonomy.lastReviewSlot"] } });
    expect(findOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(runPmTurn.mock.invocationCallOrder[0]);
    expect(runPmTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        autonomous: true,
        projectId: "p1",
        storedMessage: "Board review: 2 findings",
        trigger: { type: "daily_review" },
        disallowedTools: BOARD_REVIEW_DISALLOWED_TOOLS,
      })
    );
    expect(BOARD_REVIEW_DISALLOWED_TOOLS).toEqual(expect.arrayContaining(["change_status", "create_task"]));
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
  it("refuses at once when the turn cap is reached, and spends nothing", async () => {
    isOverDailyTurnCap.mockResolvedValue({ over: true, cap: 3 });

    const start = await startBoardReview("p1", "BP", PM, "pm-user");

    expect(start).toEqual({ status: "skipped", reason: "the daily turn cap (3) is reached" });
    expect(runPmTurn).not.toHaveBeenCalled();
  });

  it("refuses at once when the token cap is reached", async () => {
    dailyPmSpend.mockResolvedValue({ over: true, tokens: 900, cap: 800, calls: 4 });

    expect((await startBoardReview("p1", "BP", PM, "pm-user")).status).toBe("skipped");
    expect(runPmTurn).not.toHaveBeenCalled();
  });

  it("refuses a second review while the first holds the project's turn", async () => {
    let finish!: (v: unknown) => void;
    runPmTurn.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    const first = await startBoardReview("p1", "BP", PM, "pm-user");
    const second = await startBoardReview("p1", "BP", PM, "pm-user");

    expect(first.status).toBe("started");
    expect(second).toEqual({ status: "skipped", reason: "a PM turn is already running on this project" });
    finish({ ok: true });
    if (first.status === "started") await first.done;
    expect(isTurnRunning("p1")).toBe(false);
  });

  it("gives the turn back even when the review throws", async () => {
    runPmTurn.mockRejectedValue(new Error("provider down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const start = await startBoardReview("p1", "BP", PM, "pm-user");
    if (start.status === "started") await start.done;

    expect(isTurnRunning("p1")).toBe(false);
    error.mockRestore();
  });
});
