import { describe, it, expect, vi, beforeEach } from "vitest";
// mongoose's own query matcher, so the filters below are judged by MongoDB semantics rather than
// by a hand-rolled reading of them
import sift from "sift";
import { Types } from "mongoose";

// MongoDB's $cond treats only false, null, 0 and missing as false. An **empty string is true** —
// the opposite of JavaScript. `execution.workerId` defaults to "", so an expression that leaned on
// truthiness cleared the assignee of every task that had ever carried an execution subdocument,
// on every ordinary status change. It shipped, because asserting the *shape* of an expression
// cannot notice what the shape means. This runs it instead.
function mongoTruthy(value: unknown): boolean {
  return !(value === false || value === null || value === undefined || value === 0);
}

function evaluateExpr(expr: unknown, doc: Record<string, unknown>): unknown {
  if (typeof expr === "string" && expr.startsWith("$")) {
    return expr
      .slice(1)
      .split(".")
      .reduce<unknown>((at, key) => (at as Record<string, unknown>)?.[key], doc);
  }
  if (!expr || typeof expr !== "object" || Array.isArray(expr)) return expr;

  const [op, args] = Object.entries(expr as Record<string, unknown>)[0];
  const list = (Array.isArray(args) ? args : [args]).map((a) => evaluateExpr(a, doc));

  if (op === "$cond") return mongoTruthy(list[0]) ? list[1] : list[2];
  if (op === "$ifNull") return list[0] === undefined || list[0] === null ? list[1] : list[0];
  if (op === "$ne") return list[0] !== list[1];
  if (op === "$eq") return list[0] === list[1];
  if (op === "$and") return list.every(mongoTruthy);
  throw new Error(`the evaluator does not know ${op}`);
}


// Every path that hands a task back to the board became a pipeline update when the assignment
// started travelling with the run, so the shape these read is [{ $set }, { $unset }] rather than
// { $set, $unset }. Both are accepted so the tests say what they mean rather than what Mongo wants.
function setStage(update: unknown): Record<string, unknown> {
  if (Array.isArray(update)) {
    const stage = update.find((s) => s && typeof s === "object" && "$set" in s) as
      | { $set: Record<string, unknown> }
      | undefined;
    return stage?.$set ?? {};
  }
  return ((update as { $set?: Record<string, unknown> }).$set ?? {}) as Record<string, unknown>;
}

function unsetKeys(update: unknown): string[] {
  if (Array.isArray(update)) {
    const stage = update.find((s) => s && typeof s === "object" && "$unset" in s) as
      | { $unset: string[] | Record<string, string> }
      | undefined;
    const value = stage?.$unset;
    return Array.isArray(value) ? value : Object.keys(value ?? {});
  }
  return Object.keys((update as { $unset?: Record<string, string> }).$unset ?? {});
}


const findOneAndUpdate = vi.fn();
const taskCreate = vi.fn();
const projectFindOneAndUpdate = vi.fn();
const updateMany = vi.fn();
const updateOne = vi.fn();
const findOne = vi.fn();
const find = vi.fn();
const findByIdAndUpdate = vi.fn();
const findById = vi.fn();
const userFindOne = vi.fn();
const workerFindById = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/worker", () => ({ Worker: { findById: workerFindById } }));
vi.mock("@/models/task", () => ({
  Task: { findOneAndUpdate, updateMany, updateOne, findOne, find, findByIdAndUpdate, create: taskCreate },
}));
vi.mock("@/models/project", () => ({ Project: { findById, findOneAndUpdate: projectFindOneAndUpdate } }));
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
  CLEAR_WORKER_ASSIGNEE,
  claimNextTask,
  releaseTask,
  releaseExpiredTasks,
  recordTaskPhase,
  toApiExecution,
  phaseFrom,
  changeStatus,
  updateTask,
  MAX_EXECUTION_ATTEMPTS,
  MAX_PHASE_LENGTH,
  EXECUTION_LEASE_MS,
} = await import("./task-service");

const { logActivity } = await import("@/lib/activity");
const { dispatchWebhooks } = await import("@/lib/webhooks");
const { dispatchNotifications } = await import("@/lib/notifications");

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
  // The permissive scope on purpose: these cover columns, ordering and stamping, and under the
  // "assigned" default a worker passed no identity would claim nothing and prove none of it.
  // What each scope actually selects is e2e/claim-scope.spec.ts, against a real database.
  worker: { policy: { claimScope: "any" } },
};

// The claim is an update pipeline, so $set and $unset arrive as stages rather than operators
const claimStages = (call: unknown[]) => call[1] as Record<string, never>[];
const claimSet = (call: unknown[]) => claimStages(call)[0].$set as unknown as Record<string, unknown>;

// A document satisfying every clause of the claim filter, so a sift verdict on one built from it
// is about the clause the test varies and nothing else
const task = (over: Record<string, unknown> = {}) => ({
  project: "p1",
  status: "ready",
  assignee: null,
  execution: { attempts: 0 },
  blockedBy: [],
  ...over,
});

describe("claimNextTask", () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    find.mockReset();
    find.mockReturnValue({ lean: () => Promise.resolve([]) });
  });

  // A task nobody can start yet is not work, and the worker was taking it anyway: blockedBy was
  // never consulted. Judged through sift rather than by reading the filter, because what matters
  // is what MongoDB does with $nin over an array field, not that the source says "$nin".
  describe("blockers", () => {
    // Every test here runs on a board whose finished column is called "shipped", so an
    // implementation comparing against the literal "done" fails all of them rather than one
    const shipping = {
      ...customBoard,
      columns: [...customBoard.columns, { id: "shipped", label: "Shipped", role: "done", order: 3 }],
    };

    // Real ObjectId hex, not readable labels: blockedBy holds refs, and the claim now refuses ids
    // it cannot cast — labels would make every fixture here vanish before the query saw it
    const OPEN = "6a70afff45d39cd9bc8bb600";
    const FINISHED = "6a70afff45d39cd9bc8bb601";
    const ALSO_FINISHED = "6a70afff45d39cd9bc8bb602";

    // Two reads: which approved tasks name a blocker, then which of those blockers are unfinished.
    // Two waiting tasks naming the same blockers, so the second read is asked about each one once
    function boardWhere(named: string[], stillOpen: string[]) {
      find.mockReset();
      find.mockReturnValueOnce({
        lean: () =>
          Promise.resolve(named.length ? [{ blockedBy: named }, { blockedBy: named }] : []),
      });
      find.mockReturnValueOnce({
        lean: () => Promise.resolve(stillOpen.map((_id) => ({ _id }))),
      });
    }

    async function claimFilter(): Promise<Record<string, unknown>> {
      findOneAndUpdate.mockResolvedValue(null);
      await claimNextTask("p1", "worker-a", "run-1");
      return findOneAndUpdate.mock.calls[0][0];
    }

    beforeEach(() => {
      findById.mockReturnValue({ lean: () => Promise.resolve(shipping) });
    });

    it("passes over a task whose blocker is still unfinished", async () => {
      boardWhere([OPEN], [OPEN]);

      expect(matches(await claimFilter(), task({ blockedBy: [OPEN] }))).toBe(false);
    });

    it("holds a task back while any one of its blockers is open", async () => {
      boardWhere([OPEN, FINISHED], [OPEN]);

      const filter = await claimFilter();
      expect(matches(filter, task({ blockedBy: [FINISHED, OPEN] }))).toBe(false);
      expect(matches(filter, task({ blockedBy: [FINISHED] }))).toBe(true);
    });

    it("becomes claimable once every blocker has reached a done-role column", async () => {
      boardWhere([OPEN], []);

      expect(matches(await claimFilter(), task({ blockedBy: [OPEN] }))).toBe(true);
    });

    // The field has a default, but a task written before it existed has no such key at all, and
    // the guard must not quietly stop the worker on the oldest tasks on the board
    it("claims a task that predates the blockedBy field", async () => {
      boardWhere([OPEN], [OPEN]);
      const legacy = task();
      delete (legacy as Record<string, unknown>).blockedBy;

      expect(matches(await claimFilter(), legacy)).toBe(true);
    });

    // Bounded by the work waiting to start rather than by the size of the board: asking for every
    // unfinished task in the project grows the claim filter with the backlog forever
    it("asks only about the blockers the approved column actually names", async () => {
      boardWhere([OPEN], [OPEN]);

      await claimFilter();

      // Judged by what the filter selects, not by what it says. A wrong first read returns nothing,
      // `named` is empty, and the gate switches itself off silently — every other test here stubs
      // that read with names and would sail past it
      const asked = find.mock.calls[0][0];
      expect(matches(asked, task({ blockedBy: [OPEN] }))).toBe(true);
      expect(matches(asked, task({ blockedBy: [] }))).toBe(false);
      expect(matches(asked, task({ status: "doing", blockedBy: [OPEN] }))).toBe(false);
      const legacy = task();
      delete (legacy as Record<string, unknown>).blockedBy;
      expect(matches(asked, legacy)).toBe(false);
      // one entry, though two waiting tasks named it, and scoped to the project so a blocker from
      // another board is never judged against this board's idea of finished
      expect(find.mock.calls[1][0]).toEqual({
        project: "p1",
        _id: { $in: [OPEN] },
        status: { $nin: ["shipped"] },
      });
    });

    // A stored ref that cannot be cast would reject the claim and stop this project's worker until
    // somebody repaired the data. It reads as "not open" instead, the same as a deleted blocker
    it("keeps claiming when a stored blocker id cannot be cast", async () => {
      boardWhere(["not-an-object-id"], []);

      const filter = await claimFilter();

      expect(find).toHaveBeenCalledTimes(1);
      expect(matches(filter, task({ blockedBy: ["not-an-object-id"] }))).toBe(true);
    });

    it("does not ask a second time when nothing in the approved column names a blocker", async () => {
      boardWhere([], []);

      await claimFilter();

      expect(find).toHaveBeenCalledTimes(1);
    });

    // A board with no done column cannot express "finished", so it cannot express "blocked"
    // either: every blocker would read as open and every dependent would be frozen for good, with
    // nothing on the task or in any log saying why
    it("skips the gate on a board with no done column instead of freezing every dependent", async () => {
      findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
      find.mockReset();

      const filter = await claimFilter();

      expect(find).not.toHaveBeenCalled();
      expect(matches(filter, task({ blockedBy: [OPEN] }))).toBe(true);
    });
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

    expect(claimSet(findOneAndUpdate.mock.calls[0]).status).toBe("doing");
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
    expect(filter.$and).toContainEqual({
      $or: [
        { "execution.attempts": { $exists: false } },
        { "execution.attempts": { $lt: MAX_EXECUTION_ATTEMPTS } },
      ],
    });
  });

  it("stamps worker identity and increments attempts", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    const set = claimSet(findOneAndUpdate.mock.calls[0]);
    expect(set["execution.workerId"]).toBe("worker-a");
    expect(set["execution.runId"]).toBe("run-1");
    // Incremented inside the pipeline, where the missing field has to be read as zero first: $inc
    // creates it, but a pipeline $set computing on it does not
    expect(set["execution.attempts"]).toEqual({
      $add: [{ $ifNull: ["$execution.attempts", 0] }, 1],
    });
  });

  // Each run counts its phases from one, so a phaseSeq left behind by an earlier run would make
  // the ordering guard swallow the first events of this one
  it("drops any phase an earlier run left on the task", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    expect(claimStages(findOneAndUpdate.mock.calls[0])[1].$unset).toEqual(PHASE_KEYS);
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
    expect(setStage(update).status).toBe("ready");
    expect(setStage(update)["execution.attempts"]).toEqual({ $add: ["$execution.attempts", -1] });
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
    expect(setStage(retryable?.[1]).status).toBe("ready");
  });

  it("sends an exhausted task to the column humans watch, not back into the loop", async () => {
    await releaseExpiredTasks("p1", now);

    const spent = updateMany.mock.calls.find(
      ([f]) => f["execution.attempts"]?.$gte === MAX_EXECUTION_ATTEMPTS
    );
    expect(setStage(spent?.[1]).status).toBe("escalated");
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
    expect(setStage(spent?.[1]).status).toBe("ready");
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

    expect(unsetKeys(findOneAndUpdate.mock.calls[0][1])).toEqual(RUN_KEYS);
  });

  it("clears it when the edit form PUTs a new status", async () => {
    await updateTask("p1", "t1", { status: "checking" }, "actor");

    expect(unsetKeys(findOneAndUpdate.mock.calls[0][1])).toEqual(RUN_KEYS);
  });

  // The phase belongs to the run, not to the card: renaming a task the worker is running must not
  // blank the badge
  it("leaves it alone when the edit touches no status", async () => {
    await updateTask("p1", "t1", { title: "renamed" }, "actor");

    expect(unsetKeys(findOneAndUpdate.mock.calls[0][1])).toEqual([]);
  });

  it("clears it when the task is released with the attempt refunded", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1" });

    await releaseTask("p1", "t1");

    expect(unsetKeys(findOneAndUpdate.mock.calls[0][1])).toEqual(RUN_KEYS);
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
      expect(unsetKeys(update)).toEqual(RUN_KEYS);
    }
  });
});

describe("toApiExecution", () => {
  const running = {
    runId: "run-1",
    workerId: "w1",
    attempts: 1,
    startedAt: new Date("2026-08-03T09:00:00.000Z"),
    lastError: "",
    phase: "gates:build",
    phaseAt: new Date("2026-08-03T09:05:00.000Z"),
    phaseSeq: 7,
  };

  // workerId and startedAt survive a run; only the run identity is cleared. Keying on those would
  // leave a finished task rendering as one that had just started, forever.
  it("says nothing about a task no run is holding", () => {
    expect(toApiExecution({ ...running, runId: "", phase: undefined })).toBeUndefined();
    expect(toApiExecution(undefined)).toBeUndefined();
  });

  it("publishes only what a reader may see", () => {
    const api = toApiExecution(running)!;

    expect(Object.keys(api).sort()).toEqual(["asOf", "phase", "phaseAt", "startedAt", "workerId"]);
  });

  // A raw ObjectId names nothing to the person reading the card; the fleet console has shown the
  // name all along.
  it("names the worker when the caller can resolve it", () => {
    const api = toApiExecution(running, new Map([["w1", "rig-laptop"]]))!;

    expect(api.workerName).toBe("rig-laptop");
    expect(api.workerId).toBe("w1");
  });

  it("falls back to the id alone when the name cannot be resolved", () => {
    const api = toApiExecution(running, new Map())!;

    expect(api.workerName).toBeUndefined();
    expect(api.workerId).toBe("w1");
  });

  it("omits the name for a run with no worker recorded", () => {
    const api = toApiExecution({ ...running, workerId: "" }, new Map([["w1", "rig-laptop"]]))!;

    expect(api).not.toHaveProperty("workerName");
  });

  // runId is the scope recordTaskPhase authorises against; attempts counts attempts spent and
  // lastError is only ever "", so neither can be rendered as if it meant something
  it("keeps the run identity and the misleading counters off the wire", () => {
    const serialised = JSON.stringify(toApiExecution(running));

    expect(serialised).not.toContain("run-1");
    expect(serialised).not.toContain("phaseSeq");
    expect(serialised).not.toContain("attempts");
    expect(serialised).not.toContain("lastError");
  });

  it("carries the clock the ages were measured against", () => {
    const api = toApiExecution(running)!;

    expect(Number.isFinite(Date.parse(api.asOf!))).toBe(true);
  });
});

// A worker claims by assigning the task to itself. That is the concurrency answer for several
// machines on one project, and it makes a task parked for a colleague untouchable — but it opens a
// trap: a task left assigned to a machine that is no longer running it is a task nobody will ever
// claim again, and nothing says why. Both halves live or die together.
// A parseable ObjectId, because the claim casts it before writing — Mongoose does not cast an
// update pipeline, so this is the only thing standing between a ref field and a raw string
const IDENTITY = "6a70afff45d39cd9bc8bb600";

const NOMINEE = "6a70afff45d39cd9bc8bb5ff";

describe("claiming by assignment", () => {
  const board = {
    columns: [
      { id: "ready", role: "approved", order: 1 },
      { id: "doing", role: "active", order: 2 },
      { id: "checking", role: "review", order: 3, triggersPmReview: true },
    ],
    worker: { policy: { claimScope: "any" }, claimAssignee: NOMINEE },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
    findOneAndUpdate.mockResolvedValue({ _id: "t1" });
    updateMany.mockResolvedValue({ modifiedCount: 0 });
  });

  it("assigns the task to the worker's own identity", async () => {
    await claimNextTask("p1", "w1", "run-1", IDENTITY);

    // Kept rather than overwritten: under claimScope "assigned" the assignee already names this
    // worker, and whether the claim is what put it there is what decides if a release may clear it
    expect(claimSet(findOneAndUpdate.mock.calls[0]).assignee).toEqual({
      $ifNull: ["$assignee", new Types.ObjectId(IDENTITY)],
    });
  });

  it("takes nothing assigned to anybody but itself", async () => {
    await claimNextTask("p1", "w1", "run-1", IDENTITY);

    expect(findOneAndUpdate.mock.calls[0][0].$and).toContainEqual({
      $or: [{ assignee: null }, { assignee: NOMINEE }, { assignee: IDENTITY }],
    });
  });

  // The nominee is an ordinary user somebody picked. The worker's own identity is a machine
  // account excluded from every list the product offers, so a predicate keying only on it would
  // describe a hand-over nobody could perform.
  it("takes only what the project nominated when the scope is assigned", async () => {
    findById.mockReturnValue({
      lean: () =>
        Promise.resolve({ ...board, worker: { policy: { claimScope: "assigned" }, claimAssignee: NOMINEE } }),
    });

    await claimNextTask("p1", "w1", "run-1", IDENTITY);

    expect(findOneAndUpdate.mock.calls[0][0].$and).toContainEqual({
      $or: [{ assignee: NOMINEE }, { assignee: IDENTITY }],
    });
  });

  it("claims nothing when the scope is assigned and nobody is nominated", async () => {
    findById.mockReturnValue({
      lean: () => Promise.resolve({ ...board, worker: { policy: { claimScope: "assigned" } } }),
    });

    expect(await claimNextTask("p1", "w1", "run-1", null)).toBeNull();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  // String(worker.identity) always yields 24 hex, but a corrupt worker record must not 500 the
  // poll loop — nor claim a task while assigning nobody to it
  it("claims nothing rather than throwing on an identity that is not an id", async () => {
    expect(await claimNextTask("p1", "w1", "run-1", "u-worker")).toBeNull();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("claims without assigning when the worker has no identity yet", async () => {
    await claimNextTask("p1", "w1", "run-1", null);

    expect(claimSet(findOneAndUpdate.mock.calls[0])).not.toHaveProperty("assignee");
    expect(claimSet(findOneAndUpdate.mock.calls[0]).status).toBe("doing");
  });
});

describe("every way back to the board clears the assignment", () => {
  const board = {
    columns: [
      { id: "ready", role: "approved", order: 1 },
      { id: "doing", role: "active", order: 2 },
      { id: "checking", role: "review", order: 3, triggersPmReview: true },
    ],
  };

  // Cleared only for a task a run still holds, and only when the claim is what assigned it: these
  // same updates are what a person dragging a card goes through, and clearing their assignment
  // would be a bug of its own.
  //
  // Compared by shape, which proves every exit path applies the same rule and nothing about what
  // the rule means — a shape assertion is how the `""`-is-truthy bug shipped. The meaning is
  // e2e/claim-scope.spec.ts, which runs these updates against a real MongoDB.
  const CLEARED = CLEAR_WORKER_ASSIGNEE.assignee;

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

  it("clears it on a gate rejection into a review column", async () => {
    await changeStatus("p1", "t1", "checking", "actor");

    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignee).toEqual(CLEARED);
  });

  it("clears it when the run is released with the attempt refunded", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1" });

    await releaseTask("p1", "t1");

    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignee).toEqual(CLEARED);
  });

  it("clears it when the release charges the attempt", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1" });

    await releaseTask("p1", "t1", { refund: false });

    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignee).toEqual(CLEARED);
  });

  it("clears it on both lease-expiry branches, crashed and exhausted alike", async () => {
    await releaseExpiredTasks("p1", new Date("2026-07-31T12:00:00.000Z"));

    expect(updateMany.mock.calls).toHaveLength(2);
    for (const [, update] of updateMany.mock.calls) {
      expect(setStage(update).assignee).toEqual(CLEARED);
    }
  });

  // Mongoose validates a pipeline update only when told it is one; the mock accepts it either way,
  // so a missing flag would ship silently and every one of these updates would be rejected live
  it("marks every one of them as a pipeline update", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1" });
    await releaseTask("p1", "t1");
    await releaseTask("p1", "t1", { refund: false });
    await releaseExpiredTasks("p1", new Date("2026-07-31T12:00:00.000Z"));

    for (const call of findOneAndUpdate.mock.calls) {
      if (Array.isArray(call[1])) expect(call[2]?.updatePipeline).toBe(true);
    }
    for (const call of updateMany.mock.calls) {
      expect(call[2]?.updatePipeline).toBe(true);
    }
  });

  it("leaves a person's own assignment alone when the edit form moves a task nobody is running", async () => {
    findOne.mockReturnValue({
      lean: () => Promise.resolve({ _id: "t1", taskNumber: 1, status: "doing", title: "x", execution: {} }),
      populate: () => ({
        lean: () => Promise.resolve({ _id: "t1", taskNumber: 1, status: "doing", title: "x", execution: {} }),
      }),
    });

    await updateTask("p1", "t1", { status: "checking" }, "actor");

    expect(findOneAndUpdate.mock.calls[0][1].$set).not.toHaveProperty("assignee");
  });

  it("clears it when the edit form moves a task a worker is running", async () => {
    findOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: "t1",
          taskNumber: 1,
          status: "doing",
          title: "x",
          execution: { runId: "r1", workerId: "w1" },
        }),
      populate: () => ({
        lean: () =>
          Promise.resolve({
            _id: "t1",
            taskNumber: 1,
            status: "doing",
            title: "x",
            execution: { runId: "r1", workerId: "w1" },
          }),
      }),
    });

    await updateTask("p1", "t1", { status: "checking" }, "actor", true);

    expect(findOneAndUpdate.mock.calls[0][1].$set.assignee).toBeNull();
  });
});

describe("what the clearing expression actually evaluates to", () => {
  const CLEARING = CLEAR_WORKER_ASSIGNEE.assignee;

  it("keeps a person's assignment on a task no worker has ever run", () => {
    const doc = { assignee: "USER-A", execution: { workerId: "" } };

    expect(evaluateExpr(CLEARING, doc)).toBe("USER-A");
  });

  it("keeps it on a task with no execution subdocument at all", () => {
    expect(evaluateExpr(CLEARING, { assignee: "USER-A" })).toBe("USER-A");
  });

  it("clears it on a task a run still holds, when the claim is what assigned it", () => {
    const doc = { assignee: IDENTITY, execution: { runId: "r1", workerId: "w1" } };

    expect(evaluateExpr(CLEARING, doc)).toBeNull();
  });

  // workerId outlives the run as history, so keying on it cleared the assignee of any task a
  // worker had ever touched — "assign it to the worker, then drag it" undid the hand-over
  it("keeps it on a task a worker finished long ago", () => {
    const doc = { assignee: "USER-A", execution: { runId: "", workerId: "w1" } };

    expect(evaluateExpr(CLEARING, doc)).toBe("USER-A");
  });

  // A released task with no assignee drops out of what a worker may claim under scope "assigned",
  // so blanking a person's hand-over here loses the work silently rather than failing
  it("keeps a hand-over the claim did not make, even mid-run", () => {
    const doc = {
      assignee: "USER-A",
      execution: { runId: "r1", workerId: "w1", assignedByRun: false },
    };

    expect(evaluateExpr(CLEARING, doc)).toBe("USER-A");
  });

  // Absent means the claim assigned it: everything claimed before the field existed went through
  // a filter that refused any assignee
  it("treats a missing assignedByRun as the claim's own assignment", () => {
    const doc = { assignee: IDENTITY, execution: { runId: "r1", workerId: "w1" } };

    expect(evaluateExpr(CLEARING, doc)).toBeNull();
  });

  // The shipped-and-reverted version, kept as the thing this must never become again
  it("would have cleared every assignment had it leaned on truthiness", () => {
    const naive = { $cond: [{ $ifNull: ["$execution.workerId", false] }, null, "$assignee"] };
    const doc = { assignee: "USER-A", execution: { workerId: "" } };

    expect(evaluateExpr(naive, doc)).toBeNull();
  });
});

// CP-235. A worker claims a task and works on it for minutes; anyone moving that card — by drag,
// by the edit form, through MCP, or the PM agent — used to detach the run silently and leave the
// machine working on a task it no longer held.
describe("refusing to detach a live run", () => {
  const board = {
    key: "TP",
    columns: [
      { id: "ready", role: "approved", order: 1 },
      { id: "doing", role: "active", order: 2 },
      { id: "checking", role: "review", order: 3 },
    ],
  };

  const held = {
    _id: "t1",
    taskNumber: 7,
    status: "doing",
    title: "x",
    execution: { runId: "r1", workerId: "w1", phase: "agent", phaseAt: new Date() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
    findOne.mockReturnValue({
      lean: () => Promise.resolve(held),
      populate: () => ({ lean: () => Promise.resolve(held) }),
    });
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ _id: "t1", taskNumber: 7, status: "checking", title: "x" }),
    });
    updateMany.mockResolvedValue({ modifiedCount: 0 });
    workerFindById.mockReturnValue({ lean: () => Promise.resolve({ name: "mac-mini" }) });
  });

  it("refuses a status change that would take the task from its worker", async () => {
    const result = await changeStatus("p1", "t1", "checking", "actor");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(409);
    // The refusal has to happen before the write, not be undone after it
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("names the worker and the phase, so the caller can say who holds it", async () => {
    const result = await changeStatus("p1", "t1", "checking", "actor");

    expect(result.ok === false && result.error).toContain("TP-7");
    expect(result.ok === false && result.error).toContain("mac-mini");
    expect(result.ok === false && result.error).toContain("agent");
    expect(result.ok === false && result.runConflict).toMatchObject({
      workerId: "w1",
      workerName: "mac-mini",
      phase: "agent",
    });
  });

  it("falls back to the worker id when the fleet no longer knows the name", async () => {
    workerFindById.mockReturnValue({ lean: () => Promise.resolve(null) });

    const result = await changeStatus("p1", "t1", "checking", "actor");

    expect(result.ok === false && result.error).toContain("w1");
  });

  it("goes through when the move is forced", async () => {
    const result = await changeStatus("p1", "t1", "checking", "actor", true);

    expect(result.ok).toBe(true);
    expect(unsetKeys(findOneAndUpdate.mock.calls[0][1])).toEqual(RUN_KEYS);
  });

  // A reorder inside the column resends the status the task already has — that never released
  // the run, and must not start refusing either
  it("does not refuse a status that is not actually changing", async () => {
    const result = await changeStatus("p1", "t1", "doing", "actor");

    expect(result.ok).toBe(true);
    expect(findOneAndUpdate).toHaveBeenCalled();
  });

  it("refuses the same move made through the edit form", async () => {
    const result = await updateTask("p1", "t1", { status: "checking" }, "actor");

    expect(result.ok === false && result.status).toBe(409);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("forces through the edit form too", async () => {
    const result = await updateTask("p1", "t1", { status: "checking" }, "actor", true);

    expect(result.ok).toBe(true);
  });

  it("lets an edit that leaves the column alone through untouched", async () => {
    const result = await updateTask("p1", "t1", { title: "renamed" }, "actor");

    expect(result.ok).toBe(true);
    expect(findOneAndUpdate).toHaveBeenCalled();
  });

  it("does not refuse a task no run is holding", async () => {
    findOne.mockReturnValue({
      lean: () => Promise.resolve({ _id: "t1", taskNumber: 7, status: "doing", title: "x" }),
      populate: () => ({ lean: () => Promise.resolve({ _id: "t1", taskNumber: 7, status: "doing" }) }),
    });

    const result = await changeStatus("p1", "t1", "checking", "actor");

    expect(result.ok).toBe(true);
  });
});

// A board may define two columns with the active role. A forced move between them leaves the task
// active while the run is already gone, and a release keyed on status alone would then pull it back
// to the approved column and spend an attempt for a move somebody made on purpose.
describe("releaseTask only applies to a task the run still holds", () => {
  const twoActive = {
    columns: [
      { id: "ready", role: "approved", order: 1 },
      { id: "doing", role: "active", order: 2 },
      { id: "reviewing", role: "active", order: 3 },
    ],
  };

  const held = { _id: "t1", project: "p1", status: "reviewing", execution: { runId: "r1", attempts: 1 } };
  const released = { _id: "t1", project: "p1", status: "reviewing", execution: { runId: "", attempts: 1 } };

  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockReturnValue({ lean: () => Promise.resolve(twoActive) });
    findOneAndUpdate.mockResolvedValue({ _id: "t1" });
  });

  it("matches a task whose run is still on it", async () => {
    await releaseTask("p1", "t1");

    expect(matches(findOneAndUpdate.mock.calls[0][0], held)).toBe(true);
  });

  it("does not match one whose run was already taken away", async () => {
    await releaseTask("p1", "t1");

    expect(matches(findOneAndUpdate.mock.calls[0][0], released)).toBe(false);
  });

  it("holds for the no-refund path too", async () => {
    await releaseTask("p1", "t1", { refund: false });

    const filter = findOneAndUpdate.mock.calls[0][0];
    expect(matches(filter, held)).toBe(true);
    expect(matches(filter, released)).toBe(false);
  });
});

// Before CP-250 only a fixed list of columns reached the history, so every project-defined field
// — which since CP-213 is most of what people edit — changed in silence.
describe("updateTask writing project fields to the history", () => {
  const difficulty = {
    _id: "f-diff",
    name: "Difficulty",
    fieldType: "dropdown",
    options: [
      { id: "opt-m", value: "M", color: "#000", order: 0 },
      { id: "opt-l", value: "L", color: "#000", order: 1 },
    ],
  };
  const board = { ...customBoard, customFields: [difficulty] };

  function stored(values: Record<string, unknown> | Map<string, unknown>) {
    return { _id: "t1", taskNumber: 7, status: "doing", title: "x", customFieldValues: values };
  }

  function fieldEntries() {
    return (logActivity as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[3] === "Difficulty"
    );
  }

  // The two sides genuinely differ in production: the read before the write is lean and gives a
  // plain object, while the update returns a hydrated document whose values are a Map. Feeding
  // both sides the same shape here would hide exactly that.
  function setup(before: Record<string, unknown>, after: Record<string, unknown>) {
    vi.clearAllMocks();
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
    findOne.mockReturnValue({
      lean: () => Promise.resolve(stored(before)),
      populate: () => ({ lean: () => Promise.resolve(stored(before)) }),
    });
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve(stored(new Map(Object.entries(after)))),
    });
  }

  it("logs the change under the field's name, in the values a reader recognises", async () => {
    setup({ "f-diff": "opt-m" }, { "f-diff": "opt-l" });

    const result = await updateTask("p1", "t1", { customFieldValues: { "f-diff": "opt-l" } }, "actor");

    expect(result.ok).toBe(true);
    expect(logActivity).toHaveBeenCalledWith("t1", "actor", "updated", "Difficulty", "M", "L");
  });

  it("logs a cleared field rather than passing over it", async () => {
    setup({ "f-diff": "opt-m" }, {});

    await updateTask("p1", "t1", { customFieldValues: {} }, "actor");

    expect(logActivity).toHaveBeenCalledWith("t1", "actor", "updated", "Difficulty", "M", "");
  });

  it("writes one entry per field, never two", async () => {
    setup({ "f-diff": "opt-m" }, { "f-diff": "opt-l" });

    await updateTask("p1", "t1", { customFieldValues: { "f-diff": "opt-l" } }, "actor");

    expect(fieldEntries()).toHaveLength(1);
  });

  it("loads no definitions for an edit that carries no fields at all", async () => {
    setup({ "f-diff": "opt-m" }, { "f-diff": "opt-m" });

    await updateTask("p1", "t1", { title: "renamed" }, "actor");

    expect(fieldEntries()).toHaveLength(0);
  });

  // The shape every real writer sends: the board's inline edit, MCP and the PM agent all merge
  // the task's current values with the one they are changing, so all the other fields arrive
  // unchanged on every single save. Logging those would bury the real change in noise.
  it("says nothing about the untouched fields a full map carries along", async () => {
    setup({ "f-diff": "opt-m" }, { "f-diff": "opt-m" });

    await updateTask("p1", "t1", { customFieldValues: { "f-diff": "opt-m" } }, "actor");

    expect(fieldEntries()).toHaveLength(0);
  });
});


/**
 * Moving a task to another column sets off webhooks, notifications and — for a recurring task
 * reaching a done column — the next occurrence. The board PATCHes the status; the edit form PUTs
 * the whole task. Only the second path was missing all of it, and every test here passed anyway
 * because none of them asked what a status change announces.
 */
describe("a status change announces the same things whichever path made it", () => {
  const board = {
    key: "TP",
    columns: [
      { id: "doing", label: "Doing", role: "active", order: 1 },
      { id: "shipped", label: "Shipped", role: "done", order: 2 },
    ],
  };

  function setup(over: Record<string, unknown> = {}) {
    vi.clearAllMocks();
    const before = { _id: "t1", taskNumber: 7, status: "doing", title: "x", ...over };
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
    findOne.mockReturnValue({
      lean: () => Promise.resolve(before),
      populate: () => ({ lean: () => Promise.resolve(before) }),
    });
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ ...before, status: "shipped" }),
    });
    updateMany.mockResolvedValue({ modifiedCount: 0 });
    projectFindOneAndUpdate.mockResolvedValue({ _id: "p1", key: "TP", taskCounter: 8 });
    taskCreate.mockResolvedValue({ _id: "t2", taskNumber: 8 });
  }

  const webhookPayloads = () =>
    (dispatchWebhooks as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[1], c[2]]);

  it("dispatches a webhook from the board path", async () => {
    setup();
    await changeStatus("p1", "t1", "shipped", "actor");
    expect(webhookPayloads()).toHaveLength(1);
    expect(webhookPayloads()[0][0]).toBe("status_changed");
  });

  it("dispatches the identical webhook from the edit form", async () => {
    setup();
    await changeStatus("p1", "t1", "shipped", "actor");
    const fromBoard = webhookPayloads();

    setup();
    await updateTask("p1", "t1", { status: "shipped" }, "actor");

    expect(webhookPayloads()).toEqual(fromBoard);
  });

  it("sends the outbound notification from the edit form too", async () => {
    setup();
    await updateTask("p1", "t1", { status: "shipped" }, "actor");
    expect(dispatchNotifications).toHaveBeenCalledTimes(1);
  });

  // The reported bug: a weekly task closed from the detail view simply stopped recurring
  it("creates the next occurrence when the edit form closes a recurring task", async () => {
    setup({ recurrence: { frequency: "weekly", interval: 1 } });
    await updateTask("p1", "t1", { status: "shipped" }, "actor");

    expect(taskCreate, "no next occurrence was created").toHaveBeenCalled();
  });

  // Asserting only on Task.create is too weak: without the recurrence guard the helper still
  // throws on destructuring an absent config, so create is never reached and the test passes on
  // the mutation. It burns a task number on the way, though — the counter is incremented first —
  // so that is what proves the guard is doing its job.
  it("creates none, and burns no task number, when the task does not recur", async () => {
    setup();
    await updateTask("p1", "t1", { status: "shipped" }, "actor");
    await new Promise((r) => setTimeout(r, 0));

    expect(taskCreate).not.toHaveBeenCalled();
    expect(projectFindOneAndUpdate, "the recurrence counter was incremented anyway").not.toHaveBeenCalled();
  });

  // A reorder inside the same column is not a status change and must announce nothing
  it("announces nothing when the status does not actually move", async () => {
    setup();
    await updateTask("p1", "t1", { title: "renamed" }, "actor");
    expect(dispatchWebhooks).not.toHaveBeenCalled();
    expect(taskCreate).not.toHaveBeenCalled();
  });
});
