import { describe, it, expect, vi, beforeEach } from "vitest";

const findOneAndUpdate = vi.fn();
const findById = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { findOneAndUpdate } }));
vi.mock("@/models/project", () => ({ Project: { findById } }));

const { claimNextTask } = await import("./task-service");

describe("claimNextTask", () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve({ columns: null }) });
  });

  it("filters on the approved-role column so an in_progress task cannot be re-claimed", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    const filter = findOneAndUpdate.mock.calls[0][0];
    expect(filter.status).toEqual({ $in: ["todo"] });
    expect(filter.project).toBe("p1");
  });

  it("claims tasks that predate the execution subdocument", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    const filter = findOneAndUpdate.mock.calls[0][0];
    expect(filter.$or).toEqual([
      { "execution.attempts": { $exists: false } },
      { "execution.attempts": { $lt: 3 } },
    ]);
  });

  it("stamps worker identity and increments attempts", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    const update = findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.status).toBe("in_progress");
    expect(update.$set["execution.workerId"]).toBe("worker-a");
    expect(update.$set["execution.runId"]).toBe("run-1");
    expect(update.$inc["execution.attempts"]).toBe(1);
  });

  it("returns null when nothing is claimable", async () => {
    findOneAndUpdate.mockResolvedValue(null);
    expect(await claimNextTask("p1", "worker-a", "run-1")).toBeNull();
  });
});
