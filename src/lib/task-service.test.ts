import { describe, it, expect, vi, beforeEach } from "vitest";

const findOneAndUpdate = vi.fn();
const findById = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { findOneAndUpdate } }));
vi.mock("@/models/project", () => ({ Project: { findById } }));

const { claimNextTask, releaseTask, MAX_EXECUTION_ATTEMPTS } = await import("./task-service");

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
