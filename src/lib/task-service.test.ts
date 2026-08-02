import { describe, it, expect, vi, beforeEach } from "vitest";
// mongoose's own query matcher, so the filters below are judged by MongoDB semantics rather than
// by a hand-rolled reading of them
import sift from "sift";

const findOneAndUpdate = vi.fn();
const updateMany = vi.fn();
const updateOne = vi.fn();
const findOne = vi.fn();
const findByIdAndUpdate = vi.fn();
const findById = vi.fn();
const userFindOne = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({
  Task: { findOneAndUpdate, updateMany, updateOne, findOne, findByIdAndUpdate },
}));
vi.mock("@/models/project", () => ({ Project: { findById } }));
vi.mock("@/models/user", () => ({ User: { findOne: userFindOne } }));
vi.mock("@/models/comment", () => ({ Comment: {} }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ dispatchNotifications: vi.fn() }));
vi.mock("@/lib/in-app-notifications", () => ({
  createNotifications: vi.fn(),
  collectRecipients: () => [],
  resolveMentions: async () => [],
}));
vi.mock("@/lib/pm/triggers", () => ({ onTaskStatusChanged: vi.fn().mockResolvedValue(undefined) }));

const {
  claimNextTask,
  releaseTask,
  releaseExpiredTasks,
  recordTaskPhase,
  phaseFrom,
  changeStatus,
  updateTask,
  MAX_EXECUTION_ATTEMPTS,
  MAX_PHASE_LENGTH,
  EXECUTION_LEASE_MS,
} = await import("./task-service");

function matches(filter: unknown, doc: unknown): boolean {
  return sift(filter as Record<string, unknown>)(doc);
}

const PHASE_KEYS = ["execution.phase", "execution.phaseAt", "execution.phaseSeq"];
// Every exit also clears the run identity, so a released worker replaying its own old runId
// reaches nothing. The claim is the exception: it sets runId in the same update.
const RUN_KEYS = [...PHASE_KEYS, "execution.runId"];

// A non-default board on purpose: with the seeded columns the approved id is
// literally "todo" and the active id "in_progress", so a hardcoding
// implementation would pass every assertion below
const customBoard = {
  columns: [
    { id: "ready", label: "Ready", role: "approved", order: 1 },
    { id: "doing", label: "Doing", role: "active", order: 2 },
  ],
};

describe("claimNextTask", () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
  });

  it("derives the source column from the approved role, not a fixed id", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    const filter = findOneAndUpdate.mock.calls[0][0];
    expect(filter.status).toEqual({ $in: ["ready"] });
    expect(filter.project).toBe("p1");
  });

  it("derives the claimed status from the active role, not a fixed id", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    expect(findOneAndUpdate.mock.calls[0][1].$set.status).toBe("doing");
  });

  it("returns null when the board has no active column to claim into", async () => {
    findById.mockReturnValue({
      lean: () => Promise.resolve({ columns: [{ id: "ready", role: "approved", order: 1 }] }),
    });

    expect(await claimNextTask("p1", "worker-a", "run-1")).toBeNull();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("returns null when the board has no approved column to claim from", async () => {
    findById.mockReturnValue({
      lean: () => Promise.resolve({ columns: [{ id: "doing", role: "active", order: 1 }] }),
    });

    expect(await claimNextTask("p1", "worker-a", "run-1")).toBeNull();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("orders by board position, never lexicographically by priority", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    const options = findOneAndUpdate.mock.calls[0][2];
    expect(options.sort).toEqual({ order: 1, createdAt: 1 });
    expect(options.sort.priority).toBeUndefined();
  });

  it("claims tasks that predate the execution subdocument", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    const filter = findOneAndUpdate.mock.calls[0][0];
    expect(filter.$or).toEqual([
      { "execution.attempts": { $exists: false } },
      { "execution.attempts": { $lt: MAX_EXECUTION_ATTEMPTS } },
    ]);
  });

  it("stamps worker identity and increments attempts", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    const update = findOneAndUpdate.mock.calls[0][1];
    expect(update.$set["execution.workerId"]).toBe("worker-a");
    expect(update.$set["execution.runId"]).toBe("run-1");
    expect(update.$inc["execution.attempts"]).toBe(1);
  });

  // Each run counts its phases from one, so a phaseSeq left behind by an earlier run would make
  // the ordering guard swallow the first events of this one
  it("drops any phase an earlier run left on the task", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    expect(Object.keys(findOneAndUpdate.mock.calls[0][1].$unset)).toEqual(PHASE_KEYS);
  });

  it("returns null when nothing is claimable", async () => {
    findOneAndUpdate.mockResolvedValue(null);
    expect(await claimNextTask("p1", "worker-a", "run-1")).toBeNull();
  });
});

describe("releaseTask", () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
  });

  it("returns the task to the approved column and gives back the attempt", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await releaseTask("p1", "t1");

    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe("t1");
    expect(filter.project).toBe("p1");
    expect(update.$set.status).toBe("ready");
    expect(update.$inc["execution.attempts"]).toBe(-1);
  });

  it("never drives attempts below zero", async () => {
    findOneAndUpdate.mockResolvedValue(null);

    await releaseTask("p1", "t1");

    expect(findOneAndUpdate.mock.calls[0][0]["execution.attempts"]).toEqual({ $gt: 0 });
  });

  // Without this a repeated release refunds an attempt the task really spent,
  // which $gt:0 alone does not prevent
  it("only refunds a task the worker is still holding", async () => {
    findOneAndUpdate.mockResolvedValue(null);

    await releaseTask("p1", "t1");

    expect(findOneAndUpdate.mock.calls[0][0].status).toEqual({ $in: ["doing"] });
  });

  it("returns null without touching the task when the board has no active column", async () => {
    findById.mockReturnValue({
      lean: () => Promise.resolve({ columns: [{ id: "ready", role: "approved", order: 1 }] }),
    });

    expect(await releaseTask("p1", "t1")).toBeNull();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("returns null without touching the task when the board has no approved column", async () => {
    findById.mockReturnValue({
      lean: () => Promise.resolve({ columns: [{ id: "doing", role: "active", order: 1 }] }),
    });

    expect(await releaseTask("p1", "t1")).toBeNull();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("returns null when the release matched nothing", async () => {
    findOneAndUpdate.mockResolvedValue(null);
    expect(await releaseTask("p1", "t1")).toBeNull();
  });
});

describe("releaseTask charging the attempt", () => {
  const boardWithReview = {
    columns: [
      { id: "ready", label: "Ready", role: "approved", order: 1 },
      { id: "doing", label: "Doing", role: "active", order: 2 },
      { id: "checking", label: "Checking", role: "review", order: 3 },
      { id: "escalated", label: "Escalated", role: "review", order: 4, triggersPmReview: true },
    ],
  };

  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(boardWithReview) });
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });
  });

  it("keeps the attempt the run spent, so a repeating failure cannot retry forever", async () => {
    await releaseTask("p1", "t1", { refund: false });

    const update = findOneAndUpdate.mock.calls[0][1];
    expect(JSON.stringify(update)).not.toContain("$inc");
  });

  it("sends a task back to the approved column while attempts remain", async () => {
    await releaseTask("p1", "t1", { refund: false });

    const [, update] = findOneAndUpdate.mock.calls[0];
    expect(update[0].$set.status.$cond[1]).toBe("escalated");
    expect(update[0].$set.status.$cond[2]).toBe("ready");
    expect(update[0].$set.status.$cond[0]).toEqual({
      $gte: ["$execution.attempts", MAX_EXECUTION_ATTEMPTS],
    });
  });

  it("routes an exhausted task to the column the humans watch, not back to the queue", async () => {
    await releaseTask("p1", "t1", { refund: false });

    expect(findOneAndUpdate.mock.calls[0][1][0].$set.status.$cond[1]).toBe("escalated");
  });

  it("holds an exhausted task in the queue when the board has no review column", async () => {
    findById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          columns: [
            { id: "ready", role: "approved", order: 1 },
            { id: "doing", role: "active", order: 2 },
          ],
        }),
    });

    await releaseTask("p1", "t1", { refund: false });

    const cond = findOneAndUpdate.mock.calls[0][1][0].$set.status.$cond;
    expect(cond[1]).toBe("ready");
    expect(cond[2]).toBe("ready");
  });

  // Mongoose rejects an array update outright unless this option says it is a pipeline, and a
  // mocked findOneAndUpdate never runs that check — so assert the option, not just the stages
  it("marks the update as a pipeline, which mongoose demands for an array update", async () => {
    await releaseTask("p1", "t1", { refund: false });

    expect(findOneAndUpdate.mock.calls[0][2]).toMatchObject({ updatePipeline: true });
  });

  it("still only releases a task the worker is holding", async () => {
    await releaseTask("p1", "t1", { refund: false });

    const filter = findOneAndUpdate.mock.calls[0][0];
    expect(filter.status).toEqual({ $in: ["doing"] });
    expect(filter["execution.attempts"]).toBeUndefined();
  });
});

describe("releaseExpiredTasks", () => {
  const board = {
    columns: [
      { id: "ready", role: "approved", order: 1 },
      { id: "doing", role: "active", order: 2 },
      { id: "escalated", role: "review", order: 3, triggersPmReview: true },
    ],
  };
  const now = new Date("2026-07-31T12:00:00.000Z");

  beforeEach(() => {
    updateMany.mockReset();
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
    updateMany.mockResolvedValue({ modifiedCount: 0 });
  });

  it("only touches tasks whose lease has actually run out", async () => {
    await releaseExpiredTasks("p1", now);

    const filter = updateMany.mock.calls[0][0];
    expect(filter.status).toEqual({ $in: ["doing"] });
    expect(filter["execution.startedAt"]).toEqual({
      $lt: new Date(now.getTime() - EXECUTION_LEASE_MS),
    });
    expect(filter.project).toBe("p1");
  });

  it("returns a task with attempts left to the queue", async () => {
    await releaseExpiredTasks("p1", now);

    const retryable = updateMany.mock.calls.find(
      ([f]) => f["execution.attempts"]?.$lt === MAX_EXECUTION_ATTEMPTS
    );
    expect(retryable?.[1].$set.status).toBe("ready");
  });

  it("sends an exhausted task to the column humans watch, not back into the loop", async () => {
    await releaseExpiredTasks("p1", now);

    const spent = updateMany.mock.calls.find(
      ([f]) => f["execution.attempts"]?.$gte === MAX_EXECUTION_ATTEMPTS
    );
    expect(spent?.[1].$set.status).toBe("escalated");
  });

  // Refunding would let a task that repeatedly outlives its worker cycle forever
  it("never gives the attempt back", async () => {
    await releaseExpiredTasks("p1", now);

    for (const [, update] of updateMany.mock.calls) {
      expect(JSON.stringify(update)).not.toContain("$inc");
    }
  });

  it("counts everything it freed", async () => {
    updateMany.mockResolvedValueOnce({ modifiedCount: 1 }).mockResolvedValueOnce({ modifiedCount: 2 });

    expect(await releaseExpiredTasks("p1", now)).toBe(3);
  });

  it("holds an exhausted task in the queue when the board has no review column", async () => {
    findById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          columns: [
            { id: "ready", role: "approved", order: 1 },
            { id: "doing", role: "active", order: 2 },
          ],
        }),
    });

    await releaseExpiredTasks("p1", now);

    const spent = updateMany.mock.calls.find(
      ([f]) => f["execution.attempts"]?.$gte === MAX_EXECUTION_ATTEMPTS
    );
    expect(spent?.[1].$set.status).toBe("ready");
  });

  it("does nothing on a board with no active column", async () => {
    findById.mockReturnValue({
      lean: () => Promise.resolve({ columns: [{ id: "ready", role: "approved", order: 1 }] }),
    });

    expect(await releaseExpiredTasks("p1", now)).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("recordTaskPhase", () => {
  const TASK_ID = "69a52e3b399b27d3cbb2c5b7";
  const holder = {
    _id: TASK_ID,
    execution: { workerId: "w1", runId: "run-1", attempts: 1 },
  };

  beforeEach(() => {
    updateOne.mockReset();
    updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  });

  async function filterFor(seq: number) {
    updateOne.mockClear();
    await recordTaskPhase({ taskId: TASK_ID, workerId: "w1", runId: "run-1", seq, phase: "agent" });
    return updateOne.mock.calls[0][0];
  }

  // A bare $lt never matches a missing field, so with one branch this filter would drop the first
  // phase of every task that has never carried one — which is all of them, once
  it("applies the first phase to a task that has no phaseSeq at all", async () => {
    expect(matches(await filterFor(1), holder)).toBe(true);
  });

  it("applies an event newer than the phase already on the task", async () => {
    const doc = { ...holder, execution: { ...holder.execution, phaseSeq: 3 } };
    expect(matches(await filterFor(7), doc)).toBe(true);
  });

  it("drops an event overtaken by a newer one", async () => {
    const doc = { ...holder, execution: { ...holder.execution, phaseSeq: 7 } };
    expect(matches(await filterFor(3), doc)).toBe(false);
  });

  // The worker mints its own runId, so it knows the one it used an hour ago. Every exit clears the
  // run identity precisely so that replaying it reaches nothing — and note the release also unsets
  // phaseSeq, so the $exists branch would otherwise accept any seq, however stale
  it("drops a replay of the run the task was released from", async () => {
    const released = { _id: TASK_ID, execution: { workerId: "w1", attempts: 1 } };
    expect(matches(await filterFor(1), released)).toBe(false);
  });

  it("drops an event carrying a seq already recorded", async () => {
    const doc = { ...holder, execution: { ...holder.execution, phaseSeq: 3 } };
    expect(matches(await filterFor(3), doc)).toBe(false);
  });

  // The run is the authorization: without these two clauses a worker could write a phase onto any
  // task in the instance, including one another worker is holding
  it("refuses a worker that is not the one holding the task", async () => {
    const doc = { ...holder, execution: { ...holder.execution, workerId: "w2" } };
    expect(matches(await filterFor(1), doc)).toBe(false);
  });

  it("refuses a run the task has moved on from", async () => {
    const doc = { ...holder, execution: { ...holder.execution, runId: "run-0" } };
    expect(matches(await filterFor(1), doc)).toBe(false);
  });

  it("refuses a different task", async () => {
    const doc = { ...holder, _id: "69a52e3b399b27d3cbb2c5c9" };
    expect(matches(await filterFor(1), doc)).toBe(false);
  });

  it("stamps the phase, its seq and when it arrived", async () => {
    await recordTaskPhase({
      taskId: TASK_ID,
      workerId: "w1",
      runId: "run-1",
      seq: 4,
      phase: "gates:build",
    });

    const update = updateOne.mock.calls[0][1];
    expect(update.$set["execution.phase"]).toBe("gates:build");
    expect(update.$set["execution.phaseSeq"]).toBe(4);
    expect(update.$set["execution.phaseAt"]).toBeInstanceOf(Date);
  });

  it("reports whether the write landed", async () => {
    const event = { taskId: TASK_ID, workerId: "w1", runId: "run-1", seq: 1, phase: "agent" };

    expect(await recordTaskPhase(event)).toBe(true);

    updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    expect(await recordTaskPhase(event)).toBe(false);
  });
});

describe("phaseFrom", () => {
  it("keeps a label a badge can show", () => {
    expect(phaseFrom("gates:build")).toBe("gates:build");
    expect(phaseFrom("  agent  ")).toBe("agent");
  });

  it("refuses anything that is not a label", () => {
    expect(phaseFrom("")).toBeNull();
    expect(phaseFrom("   ")).toBeNull();
    expect(phaseFrom(42)).toBeNull();
    expect(phaseFrom(undefined)).toBeNull();
    expect(phaseFrom({ phase: "agent" })).toBeNull();
    expect(phaseFrom("x".repeat(MAX_PHASE_LENGTH + 1))).toBeNull();
    expect(phaseFrom("agent\nwipe")).toBeNull();
    expect(phaseFrom("agent\u001b[2Kwipe")).toBeNull();
  });
});

// A frozen badge is worse than none: a gate rejection lands in a review column, not done, so the
// most common non-merge outcome is the one that has to clear
describe("clearing the phase on every exit from the active column", () => {
  const board = {
    columns: [
      { id: "ready", role: "approved", order: 1 },
      { id: "doing", role: "active", order: 2 },
      { id: "checking", role: "review", order: 3, triggersPmReview: true },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
    findOne.mockReturnValue({
      lean: () => Promise.resolve({ _id: "t1", taskNumber: 1, status: "doing", title: "x" }),
      populate: () => ({
        lean: () => Promise.resolve({ _id: "t1", taskNumber: 1, status: "doing", title: "x" }),
      }),
    });
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ _id: "t1", taskNumber: 1, status: "checking", title: "x" }),
    });
    updateMany.mockResolvedValue({ modifiedCount: 0 });
  });

  it("clears it when a gate rejection moves the task to a review column", async () => {
    await changeStatus("p1", "t1", "checking", "actor");

    expect(findOneAndUpdate.mock.calls[0][1].$unset).toEqual({
      "execution.phase": "",
      "execution.phaseAt": "",
      "execution.phaseSeq": "",
      "execution.runId": "",
    });
  });

  it("clears it when the edit form PUTs a new status", async () => {
    await updateTask("p1", "t1", { status: "checking" }, "actor");

    expect(Object.keys(findOneAndUpdate.mock.calls[0][1].$unset ?? {})).toEqual(RUN_KEYS);
  });

  // The phase belongs to the run, not to the card: renaming a task the worker is running must not
  // blank the badge
  it("leaves it alone when the edit touches no status", async () => {
    await updateTask("p1", "t1", { title: "renamed" }, "actor");

    expect(findOneAndUpdate.mock.calls[0][1].$unset).toBeUndefined();
  });

  it("clears it when the task is released with the attempt refunded", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1" });

    await releaseTask("p1", "t1");

    expect(Object.keys(findOneAndUpdate.mock.calls[0][1].$unset)).toEqual(RUN_KEYS);
  });

  it("clears it when the release charges the attempt", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1" });

    await releaseTask("p1", "t1", { refund: false });

    const stages = findOneAndUpdate.mock.calls[0][1];
    expect(stages[stages.length - 1]).toEqual({ $unset: RUN_KEYS });
  });

  it("clears it when a lease expires, whether or not attempts remain", async () => {
    await releaseExpiredTasks("p1", new Date("2026-07-31T12:00:00.000Z"));

    expect(updateMany.mock.calls).toHaveLength(2);
    for (const [, update] of updateMany.mock.calls) {
      expect(Object.keys(update.$unset)).toEqual(RUN_KEYS);
    }
  });
});
