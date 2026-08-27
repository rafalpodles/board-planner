import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// mongoose's own query matcher, so the filters below are judged by MongoDB semantics rather than
// by a hand-rolled reading of them
import sift from "sift";
import { Types } from "mongoose";
import { CRITERION_TEXT_MAX_LENGTH, TASK_TITLE_MAX_LENGTH } from "@/lib/identifiers";

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
// The notification mails name the person who moved the task, so every announcing path resolves
// the actor's username now
const userFindById = vi.fn(() => ({ lean: async () => ({ username: "actor" }) }));
const commentCreate = vi.fn(async () => ({ _id: "c1" }));
const createNotificationsMock = vi.fn();
const notifyBoardFeedMock = vi.fn();
const collectRecipientsMock = vi.fn((_task?: unknown): string[] => []);
const resolveMentionsMock = vi.fn(async (_body?: string): Promise<string[]> => []);
const workerFindById = vi.fn();
const taskFindById = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/worker", () => ({ Worker: { findById: workerFindById } }));
vi.mock("@/models/task", () => ({
  Task: { findOneAndUpdate, updateMany, updateOne, findOne, find, findByIdAndUpdate, findById: taskFindById, create: taskCreate },
}));
vi.mock("@/models/project", () => ({ Project: { findById, findOneAndUpdate: projectFindOneAndUpdate } }));
vi.mock("@/models/user", () => ({ User: { findOne: userFindOne, findById: userFindById } }));
const agentFindById = vi.fn();
vi.mock("@/models/agent", () => ({ Agent: { findById: agentFindById } }));

/**
 * Answers with only the fields the caller's PROJECTION named, the way MongoDB does.
 *
 * A mock that ignores its arguments hands back a whole fixture whatever was asked for, which makes
 * the projection string untestable — and it is a real dependency here: drop `composition` from
 * `agentUsableOnProject`'s and `isRunnable` is false for every agent on the instance, so updateTask
 * refuses EVERY agent on EVERY task with `"undefined" has no steps in it yet`. The feature this
 * branch exists to add, off, with the suite green.
 */
function agentInTheCatalog(doc: Record<string, unknown> | null) {
  agentFindById.mockImplementation((_id: unknown, projection?: unknown) => {
    if (!doc) return { lean: () => Promise.resolve(null) };
    const named = String(projection ?? "").split(/\s+/).filter(Boolean);
    const visible = named.length
      ? Object.fromEntries(Object.entries(doc).filter(([key]) => key === "_id" || named.includes(key)))
      : doc;
    return { lean: () => Promise.resolve(visible) };
  });
}
vi.mock("@/models/comment", () => ({
  Comment: {
    create: commentCreate,
    findById: () => ({ populate: async () => ({ _id: "c1" }) }),
  },
}));
const sprintExists = vi.fn();
vi.mock("@/models/sprint", () => ({ Sprint: { exists: sprintExists } }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ dispatchNotifications: vi.fn() }));
vi.mock("@/lib/in-app-notifications", () => ({
  createNotifications: createNotificationsMock,
  collectRecipients: (task: { watchers?: string[] }) => collectRecipientsMock(task),
  resolveMentions: (body: string) => resolveMentionsMock(body),
  assigneeIdOf: () => undefined,
}));
vi.mock("@/lib/board-feed", () => ({ notifyBoardFeed: (p: unknown) => notifyBoardFeedMock(p) }));
vi.mock("@/lib/pm/triggers", () => ({ onTaskStatusChanged: vi.fn().mockResolvedValue(undefined) }));

/**
 * The rule itself is grants.ts's, and grants.test.ts runs it against real filters. What this file
 * has to show is that task-service ASKS and obeys the answer, so the answer is what is controlled
 * here — the tests below that care set it explicitly, and everything else assigns freely, the way
 * it did before BP-400.
 */
const canBeAssignedMock = vi.fn(async (_userId?: string, _projectId?: string) => true);
vi.mock("@/lib/grants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/grants")>()),
  canBeAssigned: (userId: string, projectId: string) => canBeAssignedMock(userId, projectId),
}));

beforeEach(() => {
  // Cleared as well as re-answered: the assertions below that count calls are otherwise reading
  // every earlier test's calls too, and pass or fail on the order the file happens to run in.
  canBeAssignedMock.mockClear();
  canBeAssignedMock.mockResolvedValue(true);
});

const {
  CLEAR_WORKER_ASSIGNEE,
  claimNextTask,
  taskPopulateFields,
  releaseTask,
  releaseExpiredTasks,
  recordTaskPhase,
  toApiExecution,
  phaseFrom,
  changeStatus,
  updateTask,
  createTask,
  addComment,
  MAX_EXECUTION_ATTEMPTS,
  MAX_PHASE_LENGTH,
  EXECUTION_LEASE_MS,
  personalAgentAlienTo,
  nextRecurrenceDue,
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
};

// The claim is an update pipeline, so $set and $unset arrive as stages rather than operators
const claimStages = (call: unknown[]) => call[1] as Record<string, never>[];
const claimSet = (call: unknown[]) => claimStages(call)[0].$set as unknown as Record<string, unknown>;

// Shared by every fixture below standing in for a machine's owner. A parseable ObjectId, because
// the claim filter casts it before writing — Mongoose does not cast an update pipeline, so this is
// the only thing standing between a ref field and a raw string reaching it.
const OWNER = "6a70afff45d39cd9bc8bb5fe";

// A document satisfying every clause of the claim filter, so a sift verdict on one built from it
// is about the clause the test varies and nothing else
const task = (over: Record<string, unknown> = {}) => ({
  project: "p1",
  status: "ready",
  assignee: OWNER,
  assignedBy: OWNER,
  agent: "a1",
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
      await claimNextTask("p1", "worker-a", "run-1", OWNER);
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

    await claimNextTask("p1", "worker-a", "run-1", OWNER);

    const filter = findOneAndUpdate.mock.calls[0][0];
    expect(filter.status).toEqual({ $in: ["ready"] });
    expect(filter.project).toBe("p1");
  });

  it("derives the claimed status from the active role, not a fixed id", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1", OWNER);

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

    await claimNextTask("p1", "worker-a", "run-1", OWNER);

    const options = findOneAndUpdate.mock.calls[0][2];
    expect(options.sort).toEqual({ order: 1, createdAt: 1 });
    expect(options.sort.priority).toBeUndefined();
  });

  it("claims tasks that predate the execution subdocument", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1", OWNER);

    const filter = findOneAndUpdate.mock.calls[0][0];
    expect(filter.$or).toEqual([
      { "execution.attempts": { $exists: false } },
      { "execution.attempts": { $lt: MAX_EXECUTION_ATTEMPTS } },
    ]);
  });

  it("stamps worker identity and increments attempts", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1", OWNER);

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

    await claimNextTask("p1", "worker-a", "run-1", OWNER);

    expect(claimStages(findOneAndUpdate.mock.calls[0])[1].$unset).toEqual(PHASE_KEYS);
  });

  it("returns null when nothing is claimable", async () => {
    findOneAndUpdate.mockResolvedValue(null);
    expect(await claimNextTask("p1", "worker-a", "run-1", OWNER)).toBeNull();
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
    key: "TP",
    name: "Test Project",
    columns: [
      { id: "ready", role: "approved", order: 1 },
      { id: "doing", role: "active", order: 2 },
      { id: "escalated", label: "Escalated", role: "review", order: 3, triggersPmReview: true },
    ],
  };
  const now = new Date("2026-07-31T12:00:00.000Z");

  beforeEach(() => {
    updateMany.mockReset();
    findById.mockReset();
    find.mockReset();
    createNotificationsMock.mockClear();
    collectRecipientsMock.mockReturnValue([]);
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
    find.mockReturnValue({ lean: () => Promise.resolve([]) });
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

  // The move has no actor — the worker that held it is gone — so nothing else on this path says
  // it happened: updateMany fires no webhook and no notification
  describe("telling somebody the machine gave up", () => {
    const WATCHER = "507f1f77bcf86cd799439051";

    function abandoned() {
      find.mockReturnValue({
        lean: async () => [
          {
            _id: "t9",
            taskNumber: 9,
            title: "Split the worker lease",
            watchers: [WATCHER],
            execution: { workerId: "w1" },
          },
        ],
      });
      // The machine that stopped answering owns the notification row
      userFindOne.mockReturnValue({ lean: async () => ({ _id: "worker-user-1" }) });
      collectRecipientsMock.mockReturnValue([WATCHER]);
      updateMany.mockImplementation(async (filter: Record<string, { $gte?: number }>) =>
        filter["execution.attempts"]?.$gte === MAX_EXECUTION_ATTEMPTS
          ? { modifiedCount: 1 }
          : { modifiedCount: 0 }
      );
    }

    it("names the task, the column it landed in and who it is for", async () => {
      abandoned();

      await releaseExpiredTasks("p1", now);

      const [notification] = createNotificationsMock.mock.calls.at(-1) ?? [];
      expect(notification.title).toBe("TP-9 needs a human — the run was abandoned");
      expect(notification.recipientIds).toEqual([WATCHER]);
      expect(notification.email.kicker).toBe("Run abandoned");
      expect(notification.email.taskPills).toEqual([{ label: "Escalated", tone: "review" }]);
      expect(notification.email.projectRef).toBe("TP");
      expect(userFindOne).toHaveBeenCalledWith({ username: "worker-w1" }, "_id");
      expect(notification.actorId).toBe("worker-user-1");
    });

    // The row's actor is a required reference; a machine whose identity has gone leaves nothing
    // truthful to put in it, and a half-written notification is worse than none
    it("says nothing when the worker's identity cannot be resolved", async () => {
      abandoned();
      userFindOne.mockReturnValue({ lean: async () => null });

      await releaseExpiredTasks("p1", now);

      expect(createNotificationsMock).not.toHaveBeenCalled();
    });

    // The list is read before the update, so a poll that lost the race holds tasks somebody else
    // already moved and announced
    it("stays quiet when its own update moved nothing", async () => {
      abandoned();
      updateMany.mockResolvedValue({ modifiedCount: 0 });

      await releaseExpiredTasks("p1", now);

      expect(createNotificationsMock).not.toHaveBeenCalled();
    });

    it("says nothing about a task nobody is assigned to or watching", async () => {
      abandoned();
      collectRecipientsMock.mockReturnValue([]);

      await releaseExpiredTasks("p1", now);

      expect(createNotificationsMock).not.toHaveBeenCalled();
    });

    // Nothing awaits the announcement — the poll has already been answered — so a rejection
    // escaping it is an unhandled rejection, which ends the process rather than losing one mail.
    //
    // The failure is an implementation that THROWS, not mockRejectedValue: that one builds its
    // rejected promise when the test sets it up, vitest handles it there, and the test then passes
    // with the .catch() deleted — the one thing it exists to prove.
    it("logs and survives an announcement that throws", async () => {
      abandoned();
      const reported = vi.spyOn(console, "error").mockImplementation(() => {});
      userFindOne.mockImplementationOnce(() => {
        throw new Error("mongo is having a bad afternoon");
      });

      await expect(releaseExpiredTasks("p1", now)).resolves.toBe(1);

      await vi.waitFor(() =>
        expect(reported).toHaveBeenCalledWith(
          "Failed to announce an abandoned run:",
          expect.any(Error)
        )
      );
      reported.mockRestore();
    });
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

  // BP-320: the 409 guard was conditional on the status actually changing, but the pipeline that
  // followed unset the run fields unconditionally. So resending the status a task already held
  // skipped the refusal and still detached the worker — no force needed, so the machine-credential
  // refusal on the route never fired either. CLAUDE.md states the opposite as a guarantee:
  // "staying in the column — a reorder, or resending the status already held — never touches the run".
  it("leaves the run alone when the status a task already holds is resent", async () => {
    await changeStatus("p1", "t1", "doing", "actor");

    expect(unsetKeys(findOneAndUpdate.mock.calls[0][1])).toEqual([]);
  });

  it("does not clear the assignee when the status is resent unchanged", async () => {
    await changeStatus("p1", "t1", "doing", "actor");

    const stages = findOneAndUpdate.mock.calls[0][1] as Record<string, never>[];
    const setStage = stages.find((stage) => "$set" in stage) as
      | { $set: Record<string, unknown> }
      | undefined;
    expect(setStage?.$set).not.toHaveProperty("assignee");
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

describe("claiming by assignment", () => {
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
    findOneAndUpdate.mockResolvedValue({ _id: "t1" });
    updateMany.mockResolvedValue({ modifiedCount: 0 });
  });

  // The filter matched on both fields, so writing either could only overwrite the hand-over with
  // itself — or, if the expression were ever wrong, quietly rewrite whose task it is
  it("touches neither the assignee nor the assigner", async () => {
    await claimNextTask("p1", "w1", "run-1", OWNER);

    expect(claimSet(findOneAndUpdate.mock.calls[0])).not.toHaveProperty("assignee");
    expect(claimSet(findOneAndUpdate.mock.calls[0])).not.toHaveProperty("assignedBy");
    expect(claimSet(findOneAndUpdate.mock.calls[0]).status).toBe("doing");
  });

  // Not omitted: releasing reads $ifNull over this field and treats MISSING as "the claim assigned
  // it", so leaving it out blanks the person's own assignment on the first release — and a blanked
  // task drops out of what any machine may claim and is never retried.
  it("records that the claim is not what assigned the task", async () => {
    await claimNextTask("p1", "w1", "run-1", OWNER);

    expect(claimSet(findOneAndUpdate.mock.calls[0])["execution.assignedByRun"]).toBe(false);
  });

  it("claims nothing rather than throwing on an owner that is not an id", async () => {
    expect(await claimNextTask("p1", "w1", "run-1", "u-owner")).toBeNull();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
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
  // e2e/claim-ownership.spec.ts, which runs these updates against a real MongoDB.
  const CLEARED = CLEAR_WORKER_ASSIGNEE.assignee;
  // Same shape check, same reason, for the field that has to clear alongside it: an assignedBy
  // left behind here would go on describing a person who has nothing to do with the empty assignee.
  const CLEARED_BY = CLEAR_WORKER_ASSIGNEE.assignedBy;

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
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignedBy).toEqual(CLEARED_BY);
  });

  it("clears it when the run is released with the attempt refunded", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1" });

    await releaseTask("p1", "t1");

    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignee).toEqual(CLEARED);
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignedBy).toEqual(CLEARED_BY);
  });

  it("clears it when the release charges the attempt", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1" });

    await releaseTask("p1", "t1", { refund: false });

    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignee).toEqual(CLEARED);
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignedBy).toEqual(CLEARED_BY);
  });

  it("clears it on both lease-expiry branches, crashed and exhausted alike", async () => {
    await releaseExpiredTasks("p1", new Date("2026-07-31T12:00:00.000Z"));

    expect(updateMany.mock.calls).toHaveLength(2);
    for (const [, update] of updateMany.mock.calls) {
      expect(setStage(update).assignee).toEqual(CLEARED);
      expect(setStage(update).assignedBy).toEqual(CLEARED_BY);
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
    expect(findOneAndUpdate.mock.calls[0][1].$set).not.toHaveProperty("assignedBy");
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
    expect(findOneAndUpdate.mock.calls[0][1].$set.assignedBy).toBeNull();
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

  // assignedBy on its own condition, not assignee's: a doc where the two differ is what would
  // catch a copy-paste that left assignedBy reading $assignee instead of $assignedBy.
  const CLEARING_BY = CLEAR_WORKER_ASSIGNEE.assignedBy;

  it("clears assignedBy exactly when it clears assignee", () => {
    const doc = {
      assignee: "USER-A",
      assignedBy: "USER-B",
      execution: { runId: "r1", workerId: "w1" },
    };

    expect(evaluateExpr(CLEARING_BY, doc)).toBeNull();
  });

  it("keeps assignedBy exactly when it keeps assignee, and keeps assignedBy's own value", () => {
    const doc = {
      assignee: "USER-A",
      assignedBy: "USER-B",
      execution: { runId: "", workerId: "w1" },
    };

    expect(evaluateExpr(CLEARING_BY, doc)).toBe("USER-B");
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

  // BP-335: the hold exists to stop a task being taken away from the machine running it, which is
  // not something that machine can do to itself. Refusing the holder meant every worker success
  // path answered 409 — the outbox retried forever and the task sat in the active column until the
  // two-hour lease expired, with its work already merged.
  it("lets the run's own holder report its outcome", async () => {
    const result = await changeStatus("p1", "t1", "checking", "actor", { workerId: "w1" });

    expect(result.ok).toBe(true);
    expect(unsetKeys(findOneAndUpdate.mock.calls[0][1])).toEqual(RUN_KEYS);
  });

  it("still refuses a different worker", async () => {
    const result = await changeStatus("p1", "t1", "checking", "actor", { workerId: "w2" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(409);
  });

  // A person has no verified worker id, so an absent one must never read as "I am the holder"
  it("does not treat an absent worker id as the holder", async () => {
    const result = await changeStatus("p1", "t1", "checking", "actor", { workerId: undefined });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(409);
  });

  // The run's workerId is "" on a task claimed before that field existed; an empty caller id must
  // not match it
  it("does not treat an empty worker id as matching an empty holder", async () => {
    findOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: "t1",
          taskNumber: 1,
          status: "doing",
          execution: { runId: "r1", workerId: "" },
        }),
    });

    const result = await changeStatus("p1", "t1", "checking", "actor", { workerId: "" });

    expect(result.ok).toBe(false);
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

  // BP-396. `status_changed` had this assertion and `task_created` did not, so deleting the
  // dispatch from createTask left every test in the repository green — the e2e specs written for
  // webhooks included, because their subject is a delivery being *refused*. Silence reads the same
  // whether the guard stopped it or nobody ever announced it.
  it("dispatches a webhook when a task is created", async () => {
    setup();
    projectFindOneAndUpdate.mockResolvedValue({ _id: "p1", key: "TP", name: "A board", taskCounter: 8 });
    taskCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ ...doc, _id: "new", taskNumber: 8 }));
    taskFindById.mockReturnValue({ populate: () => ({ lean: async () => ({ _id: "new" }) }) });

    await createTask("p1", "actor", { title: "Announced to the room", status: "doing" });

    expect(webhookPayloads()).toHaveLength(1);
    const [event, payload] = webhookPayloads()[0];
    expect(event).toBe("task_created");
    // The payload too: an event announcing the wrong task is its own bug, and the receiver has
    // nothing else to go on
    expect(payload).toMatchObject({
      project: { key: "TP", name: "A board" },
      task: { taskKey: "TP-8", title: "Announced to the room", status: "doing" },
    });
  });

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

  // userId (here "actor") is whoever/whatever closed this occurrence — often the worker's own
  // identity finishing its run, not the person who owns the recurring series. The next occurrence
  // must keep the series' own assigner, not read as though the machine assigned it to itself.
  it("carries the original assigner into the next occurrence, not whoever closed this one", async () => {
    setup({ recurrence: { frequency: "weekly", interval: 1 }, assignee: "u9", assignedBy: "u9" });
    await updateTask("p1", "t1", { status: "shipped" }, "actor");

    expect(taskCreate.mock.calls[0]?.[0].assignedBy).toBe("u9");
  });

  // BP-358: choosing an agent is the whole of the hand-over, so an occurrence created without one
  // is a task no machine looks at. A weekly task that ran autonomously for months would simply
  // stop, and the card would look entirely normal — no error, no field a person would notice.
  it("carries the agent into the next occurrence, or the series stops running on the machine", async () => {
    setup({
      recurrence: { frequency: "weekly", interval: 1 },
      assignee: "u9",
      assignedBy: "u9",
      agent: "a1",
    });
    await updateTask("p1", "t1", { status: "shipped" }, "actor");

    expect(taskCreate.mock.calls[0]?.[0].agent).toBe("a1");
  });

  // Null rather than undefined: Task.create would default an absent field anyway, but the pair
  // above and below are the two halves of one decision and reading them together should not
  // require knowing which fields the schema defaults
  it("leaves the next occurrence of a hand-written task with no agent", async () => {
    setup({ recurrence: { frequency: "weekly", interval: 1 }, assignee: "u9", assignedBy: "u9" });
    await updateTask("p1", "t1", { status: "shipped" }, "actor");

    expect(taskCreate.mock.calls[0]?.[0].agent).toBeNull();
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

// BP-314: `sprint` was on updateTask's allowed list and written straight through, and the sprint
// routes then read and sweep by sprint id alone — so a task from board A could sit in board B's
// sprint, inflate its counts and be moved when B completed it.
const OURS = "507f1f77bcf86cd799439011";

describe("a task's sprint has to belong to the task's project", () => {
  const OTHER = "507f1f77bcf86cd799439012";

  beforeEach(() => {
    sprintExists.mockClear();
    sprintExists.mockResolvedValue(null);
    // Set here rather than inherited from whichever describe ran last: the three tests that reach
    // the write were passing on a mock configured elsewhere in this file, and failed under
    // --sequence.shuffle.tests roughly one run in four.
    const task = { _id: "t1", taskNumber: 1, status: "doing", title: "x" };
    findOne.mockReturnValue({
      lean: () => Promise.resolve(task),
      populate: () => ({ lean: () => Promise.resolve(task) }),
    });
    findOneAndUpdate.mockReturnValue({ populate: () => Promise.resolve(task) });
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
  });

  it("refuses a sprint this project does not have", async () => {
    const result = await updateTask("p1", "t1", { sprint: OTHER }, "actor");

    expect(result.ok).toBe(false);
    expect(sprintExists).toHaveBeenCalledWith({ _id: OTHER, project: "p1" });
  });

  it("refuses a sprint id that is not an object id at all", async () => {
    const result = await updateTask("p1", "t1", { sprint: "nope" }, "actor");

    expect(result.ok).toBe(false);
    expect(sprintExists).not.toHaveBeenCalled();
  });

  it("lets a task be taken out of its sprint", async () => {
    const result = await updateTask("p1", "t1", { sprint: null }, "actor");

    expect(sprintExists).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  // "" is what a cleared <select> sends. sprint is an ObjectId, so it used to reach the update and
  // surface as a CastError 500 rather than clearing the field.
  it("treats an empty string as clearing the sprint, not as a value to cast", async () => {
    const result = await updateTask("p1", "t1", { sprint: "" }, "actor");

    expect(sprintExists).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    const written = findOneAndUpdate.mock.calls.at(-1)?.[1] as { $set?: Record<string, unknown> };
    expect(written?.$set?.sprint ?? null).toBeNull();
  });

  it("keeps a sprint this project does have", async () => {
    sprintExists.mockResolvedValue({ _id: OURS });

    const result = await updateTask("p1", "t1", { sprint: OURS }, "actor");

    expect(result.ok).toBe(true);
    expect(sprintExists).toHaveBeenCalledWith({ _id: OURS, project: "p1" });
  });
});

// createTask writes `sprint` too, and reverting its guard used to leave the whole suite green
describe("createTask and a foreign sprint", () => {
  const OTHER = "507f1f77bcf86cd799439012";

  beforeEach(() => {
    sprintExists.mockClear();
    sprintExists.mockResolvedValue(null);
    // The board createTask validates against, read before the counter moves (BP-438)
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    projectFindOneAndUpdate.mockResolvedValue({
      _id: "p1",
      taskCounter: 1,
      key: "BP",
      ...customBoard,
    });
    taskCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ ...doc, _id: "new" }));
    taskFindById.mockReturnValue({ populate: () => ({ lean: async () => ({ _id: "new" }) }) });
  });

  it("does not store a sprint belonging to another project", async () => {
    await createTask("p1", "actor", { title: "x", sprint: OTHER });

    expect(sprintExists).toHaveBeenCalledWith({ _id: OTHER, project: "p1" });
    expect(taskCreate.mock.calls.at(-1)?.[0].sprint).toBeNull();
  });

  it("does not query for a sprint id that is not an object id", async () => {
    await createTask("p1", "actor", { title: "x", sprint: "nope" });

    expect(sprintExists).not.toHaveBeenCalled();
    expect(taskCreate.mock.calls.at(-1)?.[0].sprint).toBeNull();
  });

  it("keeps a sprint this project does have", async () => {
    sprintExists.mockResolvedValue({ _id: OURS });

    await createTask("p1", "actor", { title: "x", sprint: OURS });

    expect(taskCreate.mock.calls.at(-1)?.[0].sprint).toBe(OURS);
  });
});

/**
 * Choosing the agent chooses what runs on the operator's machine, under bypassPermissions, in
 * their own checkout. BP-345 held it to instance admins because, at the time, choosing one could
 * arm a machine belonging to somebody else. Since BP-358 a claim takes only what its own owner
 * assigned to themselves, so the routing holds that boundary — see "what a member can and cannot
 * arm by choosing an agent" — and the choice belongs to whoever may edit the task, which is what
 * `withProjectAccess` on the route already answers.
 *
 * What stays here is which agents may run on this project at all, below.
 */
describe("choosing a task's agent", () => {
  const AGENT = "69a52e3b399b27d3cbb2c5a5";
  const OTHER = "69a52e3b399b27d3cbb2c5b7";

  // Exactly what the API stores for an agent somebody has actually composed. Not `{}`: an agent
  // with no composition is a real and common state — every agent is empty between "New agent" and
  // the first block dragged into it — and a fixture that always carried one could never notice a
  // writer that lets a draft through onto a task (BP-358).
  const COMPOSED = { implementation: [{ key: "write-the-change" }] };

  /**
   * Three people, never collapsed into one id. With the caller, the assignee and the agent's owner
   * all the same string, "the actor owns this agent" and "the actor is the assignee" are the same
   * assertion, and no test below could say which of the two rules was doing the work.
   */
  const ACTOR = "u-actor";
  const MATE = "u-colleague";

  // The before-image the activity log reads. Answered through both `lean()` and `populate().lean()`
  // so a change of shape in the reader does not silently hand every test an undefined task.
  //
  // The assignee arrives POPULATED, which is the shape updateTask reads it in; `assignedBy` mirrors
  // it, so every fixture here is a task somebody handed to themselves — the only shape a machine
  // ever takes, and therefore the only one worth asking about an agent.
  function storedAgent(agent: string | null, assignee: string | null = ACTOR) {
    const task = {
      _id: "t1",
      taskNumber: 1,
      status: "doing",
      title: "x",
      agent,
      assignee: assignee ? { _id: assignee, username: "whoever" } : null,
      assignedBy: assignee,
    };
    findOne.mockReturnValue({
      lean: () => Promise.resolve(task),
      populate: () => ({ lean: () => Promise.resolve(task) }),
    });
  }

  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ _id: "t1", taskNumber: 1, title: "x", execution: {} }),
    });
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    // Its own describe sets this, rather than inheriting a mock from the block above — under
    // --sequence.shuffle that inheritance made two of these pass by accident.
    findOne.mockReset();
    storedAgent(null);
    agentInTheCatalog({ _id: AGENT, scope: "global", name: "Default", composition: COMPOSED });
  });

  /**
   * The bar BP-345 raised. updateTask took a `mayChooseAgent` boolean the route computed from the
   * live principal, defaulting to false, and answered 403 without it. Nothing about the caller is
   * consulted any more — the project gate on the route is the whole of it — so an ordinary member's
   * write goes through.
   */
  it("lets an ordinary caller choose one, with no capability to pass", async () => {
    const result = await updateTask("p1", "t1", { agent: AGENT }, "member");

    expect(result.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).agent).toBe(AGENT);
  });

  // "" is what a cleared picker sends, and it is not a value an ObjectId ref can hold. Without the
  // normalisation it reaches agentUsableOnProject and comes back as "that agent cannot run here" —
  // a 400 about a foreign agent, for the act of choosing none.
  it("lets the same caller clear it again, storing null rather than an empty string", async () => {
    storedAgent(AGENT);

    const result = await updateTask("p1", "t1", { agent: "" }, "member");

    expect(result.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).agent).toBeNull();
  });

  // The catalog is consulted for the field, not for the request: an ordinary edit must not start
  // paying for a lookup, nor fail on an agent it never named
  it("leaves an edit that names no agent alone", async () => {
    agentFindById.mockClear();

    const result = await updateTask("p1", "t1", { title: "renamed" }, "member");

    expect(result.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1])).not.toHaveProperty("agent");
    expect(agentFindById).not.toHaveBeenCalled();
  });

  describe("and which agents may run here at all", () => {
    it("refuses a project agent belonging to another project", async () => {
      agentInTheCatalog({ _id: AGENT, scope: "project", project: "p2", composition: COMPOSED });

      const result = await updateTask("p1", "t1", { agent: AGENT }, ACTOR);

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });

    // On a COLLEAGUE's task, deliberately: a project agent was authored by a project admin
    // (`POST /api/agents` refuses one otherwise), so it is the board's own composition and runs
    // wherever the board's work goes. Nothing about it depends on who is holding the task.
    it("accepts a project agent belonging to this one, on anybody's task", async () => {
      storedAgent(null, MATE);
      agentInTheCatalog({ _id: AGENT, scope: "project", project: "p1", composition: COMPOSED });

      expect((await updateTask("p1", "t1", { agent: AGENT }, ACTOR)).ok).toBe(true);
    });

    // Pointing a task at somebody else's personal agent would run their prompts, with write
    // access, on this project's checkout
    it("refuses another person's personal agent", async () => {
      agentInTheCatalog({ _id: AGENT, scope: "user", owner: OTHER, composition: COMPOSED });

      const result = await updateTask("p1", "t1", { agent: AGENT }, ACTOR);

      expect(result).toMatchObject({ ok: false, status: 400 });
    });

    it("accepts the caller's own personal agent, on the caller's own task", async () => {
      agentInTheCatalog({ _id: AGENT, scope: "user", owner: ACTOR, composition: COMPOSED });

      expect((await updateTask("p1", "t1", { agent: AGENT }, ACTOR)).ok).toBe(true);
    });

    /**
     * The hole the lowering left. A claim runs on the machine of whoever assigned the task to
     * themselves, and that need not be whoever picked the agent — so "the actor owns it" alone let
     * a member compose an agent from admin-authored blocks, put `merge` in it with no review gate
     * ahead of it (which agent-rules grades risky, not broken, so it stores), point a colleague's
     * self-assigned task at it and have it run on the colleague's machine under their credentials.
     *
     * Authoring a PROJECT agent takes project-admin; authoring a personal one takes nothing. So
     * this is the only scope where the composition is unvetted, and the only one narrowed.
     */
    it("refuses the caller's own personal agent on a colleague's task", async () => {
      storedAgent(null, MATE);
      agentInTheCatalog({ _id: AGENT, scope: "user", owner: ACTOR, composition: COMPOSED });

      const result = await updateTask("p1", "t1", { agent: AGENT }, ACTOR);

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });

    // Distinguished from the foreign-owner refusal above, which shares the status and the code path
    // but not the message. Asserting only on `ok` would pass with either, and the two say opposite
    // things about what the reader should do next.
    it("says which task a personal agent would run on, and how to get there", async () => {
      storedAgent(null, MATE);
      agentInTheCatalog({ _id: AGENT, scope: "user", owner: ACTOR, composition: COMPOSED });

      const { error } = (await updateTask("p1", "t1", { agent: AGENT }, ACTOR)) as {
        error: string;
      };

      expect(error).not.toMatch(/cannot run on this project/i);
      expect(error).toMatch(/personal agent/i);
      expect(error).toMatch(/assign this task to yourself/i);
      expect(error).toMatch(/project's agents/i);
    });

    // Nobody's task is not your task. An unassigned one is also the state a release leaves behind,
    // and whoever picks it up next would be the one running this composition.
    it("refuses the caller's own personal agent on an unassigned task", async () => {
      storedAgent(null, null);
      agentInTheCatalog({ _id: AGENT, scope: "user", owner: ACTOR, composition: COMPOSED });

      expect((await updateTask("p1", "t1", { agent: AGENT }, ACTOR)).ok).toBe(false);
    });

    // A global agent is what the instance ships. It answers to neither rule, and asking it to would
    // make the built-in default unpickable on every task not already in the caller's hands.
    it("accepts a global agent whoever is holding the task", async () => {
      storedAgent(null, MATE);

      expect((await updateTask("p1", "t1", { agent: AGENT }, ACTOR)).ok).toBe(true);
    });

    /**
     * Assignee and agent travel in one PUT — the detail view's auto-save sends every edited field
     * together — so the pair that matters is the one the task ENDS UP with. Read the stored
     * assignee instead and `{ assignee: colleague, agent: mine }` goes through on the strength of a
     * pairing the same write is about to end.
     */
    describe("the pairing it judges is the one the update leaves behind", () => {
      beforeEach(() => {
        agentInTheCatalog({ _id: AGENT, scope: "user", owner: ACTOR, composition: COMPOSED });
      });

      it("refuses handing my own task, and my own agent with it, to a colleague", async () => {
        storedAgent(null, ACTOR);
        userFindOne.mockResolvedValue({ _id: MATE, username: "colleague" });

        const result = await updateTask(
          "p1",
          "t1",
          { assignee: "colleague", agent: AGENT },
          ACTOR
        );

        expect(result).toMatchObject({ ok: false, status: 400 });
      });

      // The other direction, and the reason the check cannot simply read the stored value either:
      // taking a colleague's task on and picking my own agent in the same gesture is allowed
      it("accepts taking the task on and picking my own agent in one write", async () => {
        storedAgent(null, MATE);
        userFindOne.mockResolvedValue({ _id: ACTOR, username: "me" });

        expect(
          (await updateTask("p1", "t1", { assignee: "me", agent: AGENT }, ACTOR)).ok
        ).toBe(true);
      });

      /**
       * Leaving the active column takes the task off the worker holding it, and that write blanks
       * the assignee — so the task this update leaves behind belongs to nobody, whatever it was
       * assigned to when it was read. Whoever picks it up next would be the one running this
       * composition, which is the case the rule exists for.
       */
      it("refuses my own agent in the same write that releases the task from a run", async () => {
        const held = {
          _id: "t1",
          taskNumber: 1,
          status: "doing",
          title: "x",
          agent: null,
          assignee: { _id: ACTOR, username: "me" },
          assignedBy: ACTOR,
          execution: { runId: "r1", workerId: "w1" },
        };
        findOne.mockReturnValue({
          lean: () => Promise.resolve(held),
          populate: () => ({ lean: () => Promise.resolve(held) }),
        });

        const result = await updateTask(
          "p1",
          "t1",
          { status: "ready", agent: AGENT },
          ACTOR,
          true
        );

        expect(result).toMatchObject({ ok: false, status: 400 });
        expect(findOneAndUpdate).not.toHaveBeenCalled();
      });
    });

    it("refuses an id that is not an object id, without querying for it", async () => {
      agentFindById.mockClear();

      const result = await updateTask("p1", "t1", { agent: "nonsense" }, ACTOR);

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(agentFindById).not.toHaveBeenCalled();
    });

    it("refuses an agent that does not exist", async () => {
      agentInTheCatalog(null);

      expect((await updateTask("p1", "t1", { agent: AGENT }, ACTOR)).ok).toBe(false);
    });

    /**
     * Every agent is born empty — `NewAgent` is {name, description, projectId} with no composition
     * — and storing an empty one is deliberate: it is a draft until something is dragged into it.
     *
     * Since BP-358 the task's own agent is the only thing a claim resolves, so an empty one written
     * onto a task is a task no machine can serve: snapshotFor answers null, the route hands it
     * straight back, and it sorts first again thirty seconds later. Nothing escalates, nothing is
     * logged, and every other claimable task on the project waits behind it.
     */
    describe("an agent nobody has composed yet", () => {
      const draft = (over: Record<string, unknown> = {}) =>
        agentInTheCatalog({ _id: AGENT, scope: "global", name: "Untitled agent", ...over });

      it("is refused, naming it and saying what is missing", async () => {
        draft();

        const result = await updateTask("p1", "t1", { agent: AGENT }, ACTOR);

        expect(result).toMatchObject({ ok: false, status: 400 });
        expect((result as { error: string }).error).toContain("Untitled agent");
        expect((result as { error: string }).error).toMatch(/no steps/i);
        expect(findOneAndUpdate).not.toHaveBeenCalled();
      });

      // Distinguished from the cross-project and foreign-owner refusals, which share the status
      // and the code path but not the message — asserting only on `ok` would pass with either
      it("is refused for its emptiness, not for its scope", async () => {
        draft({ scope: "user", owner: ACTOR });

        const result = await updateTask("p1", "t1", { agent: AGENT }, ACTOR);

        expect((result as { error: string }).error).not.toMatch(/cannot run on this project/i);
        expect((result as { error: string }).error).toMatch(/no steps/i);
      });

      // Buckets present but empty is what an agent looks like after its last block is removed
      it("is refused when every bucket it has is empty", async () => {
        draft({ composition: { analysis: [], implementation: [], delivery: [] } });

        expect((await updateTask("p1", "t1", { agent: AGENT }, ACTOR)).ok).toBe(false);
      });

      // A bucket written before entries existed holds bare key strings, and normaliseComposition
      // reads either shape. One of those agents is runnable and must not be refused as a draft.
      it("accepts an agent whose composition still holds bare keys", async () => {
        draft({ composition: { implementation: ["write-the-change"] } });

        expect((await updateTask("p1", "t1", { agent: AGENT }, ACTOR)).ok).toBe(true);
      });
    });
  });
});

/**
 * Assigning a task to yourself means "I am working on this" in every tracker. Under BP-358 a
 * machine takes its owner's work, so without recording who did the assigning there is no way to
 * tell that from "somebody handed this to my machine".
 */
describe("a task records who assigned it", () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ _id: "t1", taskNumber: 1, title: "x", execution: {} }),
    });
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    // Assigned to somebody already, and POPULATED, which is the shape updateTask reads it in —
    // an unassigned fixture could not tell "the assignee moved" from "the body named the same one"
    const task = {
      _id: "t1",
      taskNumber: 1,
      status: "doing",
      title: "x",
      assignee: { _id: "u1", username: "rpo", fullName: "Rafal" },
      // Already recorded, so the no-op cases below are about the assignee not moving rather than
      // about the legacy repair
      assignedBy: "u9",
    };
    findOne.mockReturnValue({
      lean: () => Promise.resolve(task),
      populate: () => ({ lean: () => Promise.resolve(task) }),
    });
    // What User.findOne actually resolves to here — updateTask reads `._id` off it directly, with
    // no .lean(), so a mock wrapping the document in one would leave the id undefined
    userFindOne.mockResolvedValue({ _id: "u2", username: "kuba" });
  });

  it("stamps the actor when the assignee changes", async () => {
    await updateTask("p1", "t1", { assignee: "kuba" }, "actor");

    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignedBy).toBe("actor");
  });

  it("stamps it when a task is unassigned, so the field never describes an older assignee", async () => {
    await updateTask("p1", "t1", { assignee: null }, "actor");

    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignedBy).toBe("actor");
  });

  /**
   * The same call `agent` makes: re-sending the value a task already carries is a no-op. A REST or
   * MCP consumer that GETs a task, edits one field and PUTs the whole object back would otherwise
   * re-stamp itself as the assigner — which silently takes the task out of what any machine may
   * claim, with no error, no activity row, and a card that looks exactly as it did.
   */
  it("leaves the assigner alone when the body re-sends the assignee it already has", async () => {
    userFindOne.mockResolvedValue({ _id: "u1", username: "rpo" });

    await updateTask("p1", "t1", { assignee: "rpo", title: "renamed" }, "somebody-else");

    expect(setStage(findOneAndUpdate.mock.calls[0][1])).not.toHaveProperty("assignedBy");
  });

  // Resolved first, then compared: the body carries a username and the stored value is an id, so
  // comparing before resolution would read every re-send as a change
  it("compares the resolved id, not the username the body carried", async () => {
    userFindOne.mockResolvedValue({ _id: "u1", username: "rpo" });

    await updateTask("p1", "t1", { assignee: "RPO" }, "somebody-else");

    expect(setStage(findOneAndUpdate.mock.calls[0][1])).not.toHaveProperty("assignedBy");
  });

  /**
   * Every task stored before BP-358 has no assigner, and the documented repair is the ordinary
   * gesture: assign it. For the common legacy shape — already assigned to you — that assignment
   * does not MOVE, so the no-op rule above would make the repair a no-op too and the Agent row's
   * "assign it again to record that" a lie. Caught by e2e/claim-ownership.spec.ts, which drives the
   * real writer against a real document.
   */
  function legacyTaskAssignedTo(userId: string) {
    const legacy = { _id: "t1", taskNumber: 1, status: "doing", title: "x", assignee: { _id: userId } };
    findOne.mockReturnValue({
      lean: () => Promise.resolve(legacy),
      populate: () => ({ lean: () => Promise.resolve(legacy) }),
    });
    userFindOne.mockResolvedValue({ _id: userId, username: "rpo" });
  }

  it("stamps a task that has no assigner yet, when its assignee takes it on themselves", async () => {
    legacyTaskAssignedTo("u1");

    await updateTask("p1", "t1", { assignee: "rpo" }, "u1");

    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignedBy).toBe("u1");
  });

  /**
   * The other side of the same clause, and the reason it is not simply "stamp whenever nothing is
   * recorded". The PM agent, MCP under a second account and any REST client that GETs a task and
   * PUTs the whole object back all send the assignee unchanged — and each would stamp ITSELF as
   * the assigner of a legacy task. That reads as a definite "somebody else handed you this" where
   * the truth is "nobody recorded it", and it is worse than the blank: the notice for it offers no
   * remedy, and the owner re-selecting themselves then changes nothing at all.
   */
  it("leaves a legacy task blank when a third writer merely echoes its assignee", async () => {
    legacyTaskAssignedTo("u1");

    await updateTask("p1", "t1", { assignee: "rpo", title: "renamed" }, "the-pm-agent");

    expect(setStage(findOneAndUpdate.mock.calls[0][1])).not.toHaveProperty("assignedBy");
  });

  // Still a hand-over when it really is one: moving a legacy task to somebody else records who did
  // it, actor and assignee being different people being exactly what that field is for
  it("still stamps a third writer that moves a legacy task to a different assignee", async () => {
    legacyTaskAssignedTo("u1");
    userFindOne.mockResolvedValue({ _id: "u2", username: "kuba" });

    await updateTask("p1", "t1", { assignee: "kuba" }, "the-pm-agent");

    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignedBy).toBe("the-pm-agent");
  });

  it("leaves it alone when the edit touches no assignee", async () => {
    await updateTask("p1", "t1", { title: "renamed" }, "actor");

    expect(setStage(findOneAndUpdate.mock.calls[0][1])).not.toHaveProperty("assignedBy");
  });

  /**
   * assignedBy is what says a machine may act unattended, and it is kept honest only by being
   * absent from updateTask's `allowed` array — so a request body naming it is dropped. Nothing
   * pinned that, and adding the field to the whitelist would look like an ordinary oversight while
   * handing every client the ability to forge its own consent.
   */
  it("ignores an assignedBy the caller supplied, rather than storing it", async () => {
    await updateTask("p1", "t1", { title: "renamed", assignedBy: "somebody-else" }, "actor");

    expect(setStage(findOneAndUpdate.mock.calls[0][1])).not.toHaveProperty("assignedBy");
  });
});

// createTask writes assignedBy too, and none of the tests above exercise that path
/**
 * BP-400. A task could be handed to somebody who cannot open the board. Since BP-328 delivery
 * checks the grant, so they correctly hear nothing — which left the assignment itself silently
 * broken: a 200, an avatar on the card, and nobody working on it.
 *
 * The rule lives in grants.ts and is exercised against real filters in grants.test.ts. What is
 * under test here is that task-service asks it, and obeys the answer, on every path that writes an
 * assignee — which is these two functions and nothing else in the repo.
 */
describe("assigning somebody who cannot reach the board", () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ _id: "t1", taskNumber: 1, title: "x", execution: {} }),
    });
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    const task = {
      _id: "t1",
      taskNumber: 1,
      status: "doing",
      title: "x",
      assignee: { _id: "u1", username: "rpo", fullName: "Rafal" },
      assignedBy: "u9",
    };
    findOne.mockReturnValue({
      lean: () => Promise.resolve(task),
      populate: () => ({ lean: () => Promise.resolve(task) }),
    });
    userFindOne.mockResolvedValue({ _id: "u2", username: "kuba" });
    userFindById.mockReturnValue({ lean: async () => ({ username: "kuba" }) });
  });

  // Restores the module-level implementation, which answers "actor" — mockReturnValue above would
  // otherwise stand for the rest of the file, and every later test asserting who assigned a task
  // would read this block's fixture instead of its own.
  afterEach(() => {
    userFindById.mockReset();
  });

  it("refuses the move, with a 400 rather than a silent success", async () => {
    canBeAssignedMock.mockResolvedValue(false);

    const result = await updateTask("p1", "t1", { assignee: "kuba" }, "actor");

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 400 });
  });

  // The message is the only thing separating "no such account" from "that account cannot reach
  // this board", and an agent reading it has no other way to tell which repair to attempt.
  it("names the person it refused", async () => {
    canBeAssignedMock.mockResolvedValue(false);

    const result = await updateTask("p1", "t1", { assignee: "kuba" }, "actor");

    expect(result).toMatchObject({ error: expect.stringContaining("kuba") });
    expect(result).toMatchObject({ error: expect.stringMatching(/no access to this board/i) });
  });

  it("writes nothing at all when it refuses", async () => {
    canBeAssignedMock.mockResolvedValue(false);

    await updateTask("p1", "t1", { assignee: "kuba" }, "actor");

    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  // The control. Without it, a refusal caused by a mis-wired fixture reads exactly like the rule
  // working — every assertion above would pass against a task-service that refused everything.
  it("still assigns somebody the rule accepts", async () => {
    canBeAssignedMock.mockResolvedValue(true);

    const result = await updateTask("p1", "t1", { assignee: "kuba" }, "actor");

    expect(result.ok).toBe(true);
    expect(findOneAndUpdate).toHaveBeenCalled();
  });

  it("asks about the board the task is on", async () => {
    await updateTask("p1", "t1", { assignee: "kuba" }, "actor");

    expect(canBeAssignedMock).toHaveBeenCalledWith("u2", "p1");
  });

  /**
   * Taking work away from somebody who cannot reach the board is the repair, not the mistake — and
   * refusing it would leave such a task permanently stuck with them on it.
   */
  it("never refuses an unassignment", async () => {
    canBeAssignedMock.mockResolvedValue(false);

    const result = await updateTask("p1", "t1", { assignee: null }, "actor");

    expect(result.ok).toBe(true);
  });

  /**
   * Only a MOVE is judged. A REST or MCP client that GETs a task, edits one field and PUTs the
   * whole object back sends the assignee too — so judging every incoming value would make a task
   * assigned before that person lost access refuse every unrelated edit made to it since.
   */
  it("lets the stored assignee be echoed back even once they have lost access", async () => {
    canBeAssignedMock.mockResolvedValue(false);
    userFindOne.mockResolvedValue({ _id: "u1", username: "rpo" });

    const result = await updateTask("p1", "t1", { assignee: "rpo", title: "renamed" }, "actor");

    expect(result.ok).toBe(true);
    expect(canBeAssignedMock).not.toHaveBeenCalled();
  });

  describe("and the same answer on the way in", () => {
    beforeEach(() => {
      taskCreate.mockClear();
      findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
      projectFindOneAndUpdate.mockResolvedValue({
        _id: "p1",
        taskCounter: 1,
        key: "BP",
        ...customBoard,
      });
      taskCreate.mockResolvedValue({ _id: "new" });
      taskFindById.mockReturnValue({ populate: () => ({ lean: async () => ({ _id: "new" }) }) });
      userFindOne.mockReturnValue({ _id: "u2", username: "kuba" });
    });

    it("refuses to create a task already assigned to somebody without access", async () => {
      canBeAssignedMock.mockResolvedValue(false);

      const result = await createTask("p1", "actor", { title: "x", assignee: "kuba" });

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ status: 400 });
      expect(taskCreate).not.toHaveBeenCalled();
    });

    it("creates it for somebody the rule accepts", async () => {
      canBeAssignedMock.mockResolvedValue(true);

      const result = await createTask("p1", "actor", { title: "x", assignee: "kuba" });

      expect(result.ok).toBe(true);
      expect(taskCreate.mock.calls[0][0].assignee).toBe("u2");
    });

    it("asks nothing when the new task starts unassigned", async () => {
      await createTask("p1", "actor", { title: "x" });

      expect(canBeAssignedMock).not.toHaveBeenCalled();
    });
  });
});

describe("createTask stamps who assigned it", () => {
  beforeEach(() => {
    taskCreate.mockClear();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    projectFindOneAndUpdate.mockResolvedValue({
      _id: "p1",
      taskCounter: 1,
      key: "BP",
      ...customBoard,
    });
    taskCreate.mockResolvedValue({ _id: "new" });
    taskFindById.mockReturnValue({ populate: () => ({ lean: async () => ({ _id: "new" }) }) });
    userFindOne.mockReturnValue({ _id: "u2", username: "kuba" });
  });

  it("stamps the actor when a new task is created already assigned", async () => {
    await createTask("p1", "actor", { title: "x", assignee: "kuba" });

    expect(taskCreate.mock.calls[0][0].assignedBy).toBe("actor");
  });

  it("leaves it null when a new task starts unassigned", async () => {
    await createTask("p1", "actor", { title: "x" });

    expect(taskCreate.mock.calls[0][0].assignedBy).toBeNull();
  });
});

/**
 * A machine takes its owner's work and nothing else. Before BP-358 the filter keyed on one
 * nominated user per project, so every approved machine raced for that person's tasks and a
 * colleague's work could land on your Mac.
 *
 * The approval path for work somebody else assigned you is a separate change, so until it exists
 * the filter also requires that the owner did the assigning — failing closed rather than running
 * another person's choice unattended.
 */
describe("a machine claims its owner's work", () => {
  const OWNER = "6a732075133f935b19154cd2";

  // Not inherited from any describe above: this block sets its own board so it means the same
  // thing regardless of which test happened to run immediately before it.
  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
  });

  async function claimFilterFor(ownerId: string | null) {
    findOneAndUpdate.mockClear();
    await claimNextTask("p1", "w1", "r1", ownerId);
    return findOneAndUpdate.mock.calls[0]?.[0];
  }

  it("asks only for tasks its owner assigned to themselves", async () => {
    const filter = await claimFilterFor(OWNER);

    expect(filter.assignee).toBe(OWNER);
    expect(filter.assignedBy).toBe(OWNER);
  });

  // The alternative that used to sit beside it. A task assigned to the worker's own `worker-<id>`
  // account matched with no assignedBy check at all, so anyone able to reach the API could hand a
  // machine unattended work by naming its account — the shape of BP-345.
  it("offers no alternative that skips the assigner check", async () => {
    const filter = await claimFilterFor(OWNER);

    expect(filter.$or).toEqual([
      { "execution.attempts": { $exists: false } },
      { "execution.attempts": { $lt: 3 } },
    ]);
  });

  /**
   * Judged by running the filter over an unassigned document rather than by reading the field:
   * `expect(filter.assignee).not.toBeNull()` passed for the wrong reason — deleting the clause it
   * names leaves the field `undefined`, and `undefined !== null`, so it could not fail.
   */
  it("never asks for an unassigned task, which belongs to nobody", async () => {
    const filter = await claimFilterFor(OWNER);

    // Built for THIS block's owner rather than reusing the module fixture's, so the pair differs
    // only in the hand-over
    const handed = task({ assignee: OWNER, assignedBy: OWNER });
    expect(sift(filter)(handed)).toBe(true);
    expect(sift(filter)({ ...handed, assignee: null, assignedBy: null })).toBe(false);
  });

  it("asks for a task that names an agent, because that is the hand-over", async () => {
    const filter = await claimFilterFor(OWNER);

    expect(filter.agent).toEqual({ $ne: null });
  });

  it("claims nothing at all for a machine with no owner", async () => {
    expect(await claimNextTask("p1", "w1", "r1", null)).toBeNull();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});

/**
 * BP-345 held the agent picker to instance admins because choosing an agent could arm a machine
 * belonging to somebody else. BP-358 took that bar down, and the whole of the argument for taking
 * it down is that this filter now holds the boundary instead — so it is asserted here, against the
 * filter, rather than against a permission check that no longer exists.
 *
 * Run through sift rather than read off the filter: `expect(filter.assignedBy).toBe(ME)` passes for
 * the wrong reason once the clause is gone, because `undefined` is not `SOMEBODY_ELSE` either.
 * Each case asserts BOTH polarities, so a filter that matched nothing at all would fail too.
 */
describe("what a member can and cannot arm by choosing an agent", () => {
  // The member doing the choosing, who also owns a machine on this project
  const ME = "6a732075133f935b19154cd2";
  const SOMEBODY_ELSE = "6a732075133f935b19154cd3";

  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    find.mockReset();
    find.mockReturnValue({ lean: () => Promise.resolve([]) });
  });

  async function whatMyMachineAsksFor() {
    await claimNextTask("p1", "w1", "r1", ME);
    return findOneAndUpdate.mock.calls[0][0];
  }

  // Every document below already carries an agent, because that is the gesture under test: the
  // member has picked one. What decides is the hand-over, and nothing else.
  it("cannot arm my machine with a task assigned to somebody else", async () => {
    const filter = await whatMyMachineAsksFor();

    expect(matches(filter, task({ assignee: SOMEBODY_ELSE, assignedBy: SOMEBODY_ELSE }))).toBe(false);
    // Nor by being the one who put it in their hands
    expect(matches(filter, task({ assignee: SOMEBODY_ELSE, assignedBy: ME }))).toBe(false);
    expect(matches(filter, task({ assignee: ME, assignedBy: ME }))).toBe(true);
  });

  // The other half, and the reason `assignedBy` exists at all: being handed work is a proposal, and
  // accepting one is a gesture the product does not have yet
  it("cannot arm my machine with a task somebody else assigned to me", async () => {
    const filter = await whatMyMachineAsksFor();

    expect(matches(filter, task({ assignee: ME, assignedBy: SOMEBODY_ELSE }))).toBe(false);
    expect(matches(filter, task({ assignee: ME, assignedBy: ME }))).toBe(true);
  });

  // The forgery the two above would be worth nothing against. `assignedBy` is kept off updateTask's
  // whitelist, so a body naming it is dropped — pinned in full by "ignores an assignedBy the caller
  // supplied", and named here because it is the other leg this decision stands on.
  it("has no writer that lets a caller name the assigner", async () => {
    findOneAndUpdate.mockReset();
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ _id: "t1", taskNumber: 1, title: "x", execution: {} }),
    });
    const stored = { _id: "t1", taskNumber: 1, status: "ready", title: "x", assignee: { _id: ME } };
    findOne.mockReturnValue({
      lean: () => Promise.resolve(stored),
      populate: () => ({ lean: () => Promise.resolve(stored) }),
    });

    await updateTask("p1", "t1", { title: "x", assignedBy: ME }, SOMEBODY_ELSE);

    expect(setStage(findOneAndUpdate.mock.calls[0][1])).not.toHaveProperty("assignedBy");
  });
});

/**
 * The sentence the whole lowering rests on: choosing an agent can set work running only on the
 * chooser's own machine — or, on somebody else's, only an agent the project itself sanctioned.
 *
 * Neither half of the system proves that alone. `updateTask` decides what may be written; the claim
 * filter decides whose machine ever reads it. So each shape below is written through the real
 * writer and the result is then offered to the real filter of a machine belonging to each person in
 * turn. The document handed to the filter is the stored one with the writer's OWN `$set` over it —
 * nothing here asserts an assignee this code did not produce.
 */
describe("whose machine choosing an agent can reach", () => {
  // Parseable ObjectIds, because the claim filter casts the owner before writing it
  const ME = "6a732075133f935b19154cd2";
  const MATE = "6a732075133f935b19154cd3";
  const AGENT_ID = "69a52e3b399b27d3cbb2c5a5";
  const COMPOSED = { implementation: [{ key: "write-the-change" }] };

  beforeEach(() => {
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    find.mockReset();
    find.mockReturnValue({ lean: () => Promise.resolve([]) });
    findOne.mockReset();
    findOneAndUpdate.mockReset();
  });

  /** What a machine belonging to this person actually asks the database for */
  async function machineOf(owner: string) {
    findOneAndUpdate.mockReset();
    await claimNextTask("p1", "w1", "r1", owner);
    return findOneAndUpdate.mock.calls[0][0];
  }

  interface Shape {
    agent: Record<string, unknown>;
    assignee: string | null;
    /** Who did the assigning; the same person unless a shape is about being handed work */
    assigner?: string | null;
    actor: string;
  }

  async function choose({ agent, assignee, assigner = assignee, actor }: Shape) {
    agentInTheCatalog({ _id: AGENT_ID, name: "An agent", composition: COMPOSED, ...agent });
    const stored = {
      _id: "t1",
      taskNumber: 1,
      status: "ready",
      title: "x",
      agent: null,
      assignee: assignee ? { _id: assignee, username: "whoever" } : null,
      assignedBy: assigner,
    };
    findOne.mockReturnValue({
      lean: () => Promise.resolve(stored),
      populate: () => ({ lean: () => Promise.resolve(stored) }),
    });
    findOneAndUpdate.mockReset();
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ _id: "t1", taskNumber: 1, title: "x", execution: {} }),
    });

    const result = await updateTask("p1", "t1", { agent: AGENT_ID }, actor);

    const written = findOneAndUpdate.mock.calls.length
      ? setStage(findOneAndUpdate.mock.calls[0][1])
      : {};
    const document = {
      project: "p1",
      status: "ready",
      assignee,
      assignedBy: assigner,
      agent: null,
      blockedBy: [],
      execution: { attempts: 0 },
      ...written,
    };
    return { result, document };
  }

  it("my own task, my own personal agent: runs, and on my machine alone", async () => {
    const { result, document } = await choose({
      agent: { scope: "user", owner: ME },
      assignee: ME,
      actor: ME,
    });

    expect(result.ok).toBe(true);
    expect(document.agent).toBe(AGENT_ID);
    expect(matches(await machineOf(ME), document)).toBe(true);
    expect(matches(await machineOf(MATE), document)).toBe(false);
  });

  it("my own task, one of the project's agents: the same", async () => {
    const { result, document } = await choose({
      agent: { scope: "project", project: "p1" },
      assignee: ME,
      actor: ME,
    });

    expect(result.ok).toBe(true);
    expect(matches(await machineOf(ME), document)).toBe(true);
    expect(matches(await machineOf(MATE), document)).toBe(false);
  });

  // The shape this change exists for. Refused at the writer, so there is no document for any
  // machine to read — asserted at both ends, because a refusal that still wrote would be worse
  // than one that never fired.
  it("a colleague's self-assigned task, my personal agent: refused, and nothing is stored", async () => {
    const { result, document } = await choose({
      agent: { scope: "user", owner: ME },
      assignee: MATE,
      actor: ME,
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(document.agent).toBeNull();
    expect(matches(await machineOf(MATE), document)).toBe(false);
    expect(matches(await machineOf(ME), document)).toBe(false);
  });

  /**
   * Allowed, and it really does run on the colleague's machine — which is the residue rpo's own
   * decision text describes and accepts. What bounds it is that a project agent takes project-admin
   * to author (`POST /api/agents`), so the composition reaching that machine is the board's own.
   */
  it("a colleague's self-assigned task, one of the project's agents: runs, on their machine", async () => {
    const { result, document } = await choose({
      agent: { scope: "project", project: "p1" },
      assignee: MATE,
      actor: ME,
    });

    expect(result.ok).toBe(true);
    expect(matches(await machineOf(MATE), document)).toBe(true);
    expect(matches(await machineOf(ME), document)).toBe(false);
  });

  // Being handed work is a proposal. The write is fine — it is my task and my agent — and no
  // machine takes it, because nobody assigned it to themselves.
  it("a task somebody else assigned to me: written, and no machine takes it", async () => {
    const { result, document } = await choose({
      agent: { scope: "user", owner: ME },
      assignee: ME,
      assigner: MATE,
      actor: ME,
    });

    expect(result.ok).toBe(true);
    expect(document.agent).toBe(AGENT_ID);
    expect(matches(await machineOf(ME), document)).toBe(false);
    expect(matches(await machineOf(MATE), document)).toBe(false);
  });
});

/**
 * BP-358 final round. `agentUsableOnProject` runs on the writer of `agent`, so a write naming only
 * `assignee` never asks — and the agent rode the hand-over it was chosen for into somebody else's
 * hands. The claim's other half hid it for one gesture (the write stamps the OLD holder as the
 * assigner) and stopped hiding it on the next: the new assignee unassigns and re-assigns to
 * themselves, restoring `assignee === assignedBy`, and their machine runs a composition nobody
 * vetted. Reproduced end to end in e2e/claim-ownership.spec.ts.
 *
 * "An agent is the hand-over" is the design's own sentence, so handing the task to a different
 * person is a NEW hand-over and the old agent has no standing on it.
 *
 * Three ids throughout, varied one at a time. With the actor, the incoming assignee and the
 * agent's owner collapsed into one string, "the new assignee owns it" and "the actor owns it" are
 * the same assertion — and the clause reading the wrong one of the two would pass every case.
 */
describe("what a change of hands does to the agent already on the task", () => {
  const THIRD = "6a732075133f935b19154ce1";
  const HOLDER = "6a732075133f935b19154ce2";
  const INCOMING = "6a732075133f935b19154ce3";
  const AGENT_ID = "69a52e3b399b27d3cbb2c5a5";
  const PICKED = "69a52e3b399b27d3cbb2c5b8";
  const COMPOSED = { implementation: [{ key: "write-the-change" }] };

  beforeEach(() => {
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    find.mockReset();
    find.mockReturnValue({ lean: () => Promise.resolve([]) });
    findOne.mockReset();
    findOneAndUpdate.mockReset();
    findOneAndUpdate.mockReturnValue({
      populate: () =>
        Promise.resolve({ _id: "t1", taskNumber: 1, title: "x", agent: null, execution: {} }),
    });
    agentFindById.mockReset();
  });

  /**
   * Answers per id, honouring the projection the way MongoDB does. The shared fixture answers with
   * ONE agent whatever is asked for, which cannot tell the agent a write NAMES from the one the
   * task already carries — and that is the only difference the clause below turns on.
   */
  function catalogOf(docs: Record<string, Record<string, unknown>>) {
    agentFindById.mockImplementation((id: unknown, projection?: unknown) => {
      const doc = docs[String(id)];
      if (!doc) return { lean: () => Promise.resolve(null) };
      const named = String(projection ?? "").split(/\s+/).filter(Boolean);
      const visible = named.length
        ? Object.fromEntries(Object.entries(doc).filter(([k]) => k === "_id" || named.includes(k)))
        : doc;
      return { lean: () => Promise.resolve(visible) };
    });
  }

  /** What a machine belonging to this person actually asks the database for */
  async function machineOf(owner: string) {
    findOneAndUpdate.mockReset();
    await claimNextTask("p1", "w1", "r1", owner);
    return findOneAndUpdate.mock.calls[0][0];
  }

  interface Held {
    /** The agent the task is ALREADY carrying, as the catalog answers for it */
    agent: Record<string, unknown> | null;
    /** Who holds the task before this write */
    holder?: string | null;
    /** A task stored before BP-358: the assignedBy KEY is absent, not null */
    legacy?: boolean;
    execution?: Record<string, unknown>;
  }

  function taskHolding({ agent, holder = HOLDER, legacy = false, execution = {} }: Held) {
    if (agent) {
      agentInTheCatalog({ _id: AGENT_ID, name: "An agent", composition: COMPOSED, ...agent });
    } else {
      agentInTheCatalog(null);
    }
    const stored = {
      _id: "t1",
      taskNumber: 1,
      status: "ready",
      title: "x",
      agent: agent ? AGENT_ID : null,
      assignee: holder ? { _id: holder, username: "whoever" } : null,
      ...(legacy ? {} : { assignedBy: holder }),
      execution,
    };
    findOne.mockReturnValue({
      lean: () => Promise.resolve(stored),
      populate: () => ({ lean: () => Promise.resolve(stored) }),
    });
  }

  /** The write, and the document it leaves — stored, with its own $set over it */
  async function write(
    body: Record<string, unknown>,
    actor: string,
    resolves?: string | null,
    force = false
  ) {
    if (resolves !== undefined) {
      userFindOne.mockResolvedValue(resolves ? { _id: resolves, username: "whoever" } : null);
    }
    findOneAndUpdate.mockClear();
    const result = await updateTask("p1", "t1", body, actor, force);
    const written = findOneAndUpdate.mock.calls.length
      ? setStage(findOneAndUpdate.mock.calls[0][1])
      : {};
    return {
      result,
      written,
      document: {
        project: "p1",
        status: "ready",
        assignee: HOLDER,
        assignedBy: HOLDER,
        agent: AGENT_ID,
        blockedBy: [],
        execution: { attempts: 0 },
        ...written,
      },
    };
  }

  // The headline. The agent is the holder's own composition; the task stops being theirs, so it
  // stops being a task that composition may run on — asserted at the machine too, because a
  // cleared field is only interesting if it is what keeps the run off somebody's computer.
  it("drops a personal agent when the task goes to somebody else", async () => {
    taskHolding({ agent: { scope: "user", owner: HOLDER } });

    const { result, written, document } = await write({ assignee: "incoming" }, HOLDER, INCOMING);

    expect(result.ok).toBe(true);
    expect(written.agent).toBeNull();
    expect(matches(await machineOf(INCOMING), document)).toBe(false);
  });

  /**
   * The three-id case, and the only one that separates "the new assignee owns it" from "the actor
   * owns it": the agent belongs to the person the task is going TO, and the person writing is
   * neither of them. An agent the incoming assignee could have chosen survives the move.
   */
  it("keeps a personal agent that belongs to the person receiving the task", async () => {
    taskHolding({ agent: { scope: "user", owner: INCOMING } });

    const { result, written } = await write({ assignee: "incoming" }, THIRD, INCOMING);

    expect(result.ok).toBe(true);
    expect(written).not.toHaveProperty("agent");
  });

  // …and it is still a hand-over their machine acts on, once they are the one who took it on. The
  // case above deliberately has a third party doing the assigning, which no machine acts on at
  // all — so on its own it could not tell "the agent survived" from "the agent stopped mattering".
  it("and that person's machine takes the task once they have taken it on themselves", async () => {
    taskHolding({ agent: { scope: "user", owner: INCOMING } });

    const { written, document } = await write({ assignee: "incoming" }, INCOMING, INCOMING);

    expect(written).not.toHaveProperty("agent");
    expect(document.agent).toBe(AGENT_ID);
    expect(matches(await machineOf(INCOMING), document)).toBe(true);
    expect(matches(await machineOf(HOLDER), document)).toBe(false);
  });

  // Sanctioned by the project rather than composed by a person: `POST /api/agents` refuses a
  // project agent to anyone but a project admin, so the incoming assignee could have chosen it and
  // clearing it would be a gratuitous loss on every ordinary reassignment.
  it("keeps a project agent, which the project sanctioned rather than any one person", async () => {
    taskHolding({ agent: { scope: "project", project: "p1" } });

    const { written } = await write({ assignee: "incoming" }, HOLDER, INCOMING);

    expect(written).not.toHaveProperty("agent");
  });

  it("keeps a global agent, which is shipped", async () => {
    taskHolding({ agent: { scope: "global" } });

    const { written } = await write({ assignee: "incoming" }, HOLDER, INCOMING);

    expect(written).not.toHaveProperty("agent");
  });

  // Nobody is not "assigned to you" either, and this is what a released task looks like: whoever
  // picks it up next would otherwise be the one running that composition
  it("drops a personal agent when the task is unassigned altogether", async () => {
    taskHolding({ agent: { scope: "user", owner: HOLDER } });

    const { written } = await write({ assignee: null }, HOLDER);

    expect(written.agent).toBeNull();
  });

  /**
   * The detail view's auto-save sends every edited field in one PUT, so this body is what picking
   * an agent and handing the task over in the same visit produces. That agent was judged against
   * the assignee this write LEAVES, one clause up — re-clearing it here would undo a choice that
   * was just made validly.
   */
  it("leaves an agent chosen in the same write alone", async () => {
    taskHolding({ agent: { scope: "user", owner: INCOMING } });

    const { result, written } = await write(
      { assignee: "incoming", agent: AGENT_ID },
      INCOMING,
      INCOMING
    );

    expect(result.ok).toBe(true);
    expect(written.agent).toBe(AGENT_ID);
  });

  /**
   * The same rule where the two agents are different documents, which is the only shape that can
   * tell "the agent this write names" from "the agent it is replacing": handing the task over and
   * picking one of the project's agents in the same PUT. Judging the STORED agent here overwrites
   * the freshly chosen one with null — the clause would undo the choice it was meant to protect.
   */
  it("does not clear the agent this write chose because of the one it replaces", async () => {
    taskHolding({ agent: { scope: "user", owner: HOLDER } });
    catalogOf({
      [AGENT_ID]: { _id: AGENT_ID, scope: "user", owner: HOLDER, name: "Mine", composition: COMPOSED },
      [PICKED]: { _id: PICKED, scope: "project", project: "p1", name: "The board's", composition: COMPOSED },
    });

    const { result, written } = await write({ assignee: "incoming", agent: PICKED }, HOLDER, INCOMING);

    expect(result.ok).toBe(true);
    expect(written.agent).toBe(PICKED);
  });

  /**
   * Keyed on the assignee MOVING, not on the pairing being wrong. A task already carrying an
   * invalid pairing — every one the reproduction left behind — must not have a field silently
   * dropped by an edit that had nothing to do with it, which is the shape of bug the round before
   * this one exists to stop. It also keeps an ordinary edit from paying for the lookup.
   */
  it("leaves the agent alone on an edit that does not move the assignee", async () => {
    taskHolding({ agent: { scope: "user", owner: THIRD } });

    const { written } = await write({ title: "renamed" }, HOLDER);

    expect(written).not.toHaveProperty("agent");
    expect(agentFindById).not.toHaveBeenCalled();
  });

  // The documented repair for a legacy task — assign it to yourself again — must not cost the
  // person their agent. Resending the assignee already stored is not a change of hands.
  it("leaves it alone when the body re-sends the assignee the task already has", async () => {
    taskHolding({ agent: { scope: "user", owner: HOLDER } });

    const { written } = await write({ assignee: "whoever" }, HOLDER, HOLDER);

    expect(written).not.toHaveProperty("agent");
    expect(agentFindById).not.toHaveBeenCalled();
  });

  /**
   * A forced status change that takes a task off a live run blanks the assignee in that same
   * write, without the body naming the field at all. The task ends up belonging to nobody, so it
   * is a change of hands like any other — and the pairing is read off what the update SENDS rather
   * than off what the body carried, which is the only place the two differ.
   */
  it("drops a personal agent in the write that releases the task from a run", async () => {
    taskHolding({
      agent: { scope: "user", owner: HOLDER },
      execution: { runId: "r9", workerId: "w9" },
    });

    const { written } = await write({ status: "doing" }, THIRD, undefined, true);

    expect(written.assignee).toBeNull();
    expect(written.agent).toBeNull();
  });

  /**
   * The other half of the same pair, and a shape the "assignee moved" rule alone walks past. A task
   * stored before BP-358 records no assigner, so no machine looks at it — and the repair the
   * product prints on the task itself, ASSIGN IT TO YOURSELF AGAIN, is what records one. The
   * assignee does not move, and that single gesture is what makes the task claimable for the first
   * time, carrying whatever agent it has been carrying all along.
   */
  it("drops a stranger's agent when a legacy task's assigner is recorded for the first time", async () => {
    taskHolding({ agent: { scope: "user", owner: THIRD }, legacy: true });

    const { written, document } = await write({ assignee: "whoever" }, HOLDER, HOLDER);

    expect(written.assignedBy).toBe(HOLDER);
    expect(written.agent).toBeNull();
    expect(matches(await machineOf(HOLDER), document)).toBe(false);
  });

  // …and the repair still does what it is for. Clearing here would take the agent off every legacy
  // task on the board, which is the gratuitous half of the same rule.
  it("leaves the repairing person's own agent alone, and their machine then takes it", async () => {
    taskHolding({ agent: { scope: "user", owner: HOLDER }, legacy: true });

    const { written, document } = await write({ assignee: "whoever" }, HOLDER, HOLDER);

    expect(written.assignedBy).toBe(HOLDER);
    expect(written).not.toHaveProperty("agent");
    expect(matches(await machineOf(HOLDER), document)).toBe(true);
  });

  // A field changed by a write nobody asked to change it must be answerable for afterwards. The
  // response carries the task itself; this is the other half.
  it("records the drop in the task\'s history", async () => {
    taskHolding({ agent: { scope: "user", owner: HOLDER } });
    findOneAndUpdate.mockReturnValue({
      populate: () =>
        Promise.resolve({ _id: "t1", taskNumber: 1, title: "x", agent: null, execution: {} }),
    });
    vi.mocked(logActivity).mockClear();

    await write({ assignee: "incoming" }, HOLDER, INCOMING);

    expect(vi.mocked(logActivity).mock.calls).toContainEqual([
      "t1",
      HOLDER,
      "updated",
      "agent",
      AGENT_ID,
      "",
    ]);
  });

  // The populate added for the Agent row returns a DOCUMENT where the before-image holds an id, so
  // the history comparison has to read the id out of both. Without that every update to any field
  // logs an agent change that never happened.
  it("does not invent an agent change when the answer comes back populated", async () => {
    taskHolding({ agent: { scope: "user", owner: HOLDER } });
    findOneAndUpdate.mockReturnValue({
      populate: () =>
        Promise.resolve({
          _id: "t1",
          taskNumber: 1,
          title: "renamed",
          agent: { _id: AGENT_ID, name: "An agent" },
          execution: {},
        }),
    });
    vi.mocked(logActivity).mockClear();

    await write({ title: "renamed" }, HOLDER);

    expect(vi.mocked(logActivity).mock.calls.map((c) => c[3])).not.toContain("agent");
  });
});

// BP-369. Exported so scripts/repair-recurring-agent-pairing.ts asks the same question updateTask
// already asks live, rather than a second copy of the rule.
describe("personalAgentAlienTo", () => {
  beforeEach(() => agentFindById.mockReset());

  // The mock resolves by projection alone and ignores which id it was asked for, so nothing above
  // this line would notice the two arguments swapped — `agent` looked up instead of `assigneeAfter`
  // compared, or vice versa. Asserted here once, directly, rather than trusted to a return-value
  // check that would pass either way.
  it("looks up the agent argument, not the assignee", async () => {
    agentInTheCatalog({ scope: "user", owner: "u1" });
    await personalAgentAlienTo("the-agent-id", "u1");
    expect(agentFindById).toHaveBeenCalledWith("the-agent-id", "scope owner");
  });

  it("is not alien when the personal agent's owner is the assignee", async () => {
    agentInTheCatalog({ scope: "user", owner: "u1" });
    expect(await personalAgentAlienTo("a1", "u1")).toBe(false);
  });

  it("is alien when the personal agent belongs to somebody else", async () => {
    agentInTheCatalog({ scope: "user", owner: "u1" });
    expect(await personalAgentAlienTo("a1", "u2")).toBe(true);
  });

  // Nobody chose it: an unassigned task cannot be the reason a personal agent is still there
  it("is alien on an unassigned task", async () => {
    agentInTheCatalog({ scope: "user", owner: "u1" });
    expect(await personalAgentAlienTo("a1", null)).toBe(true);
  });

  // A project or global agent is nobody's personal choice to begin with
  it("is never alien for a project-scoped agent", async () => {
    agentInTheCatalog({ scope: "project", owner: null });
    expect(await personalAgentAlienTo("a1", "somebody-else")).toBe(false);
  });

  // Covers a dangling reference and a missing agent alike — neither branches before the lookup
  it("is not alien when the agent cannot be found — missing id or dangling reference alike", async () => {
    agentInTheCatalog(null);
    expect(await personalAgentAlienTo("gone", "u1")).toBe(false);
    expect(await personalAgentAlienTo(null, "u1")).toBe(false);
  });
});

/**
 * BP-358 review: `assignedBy` is what says whether a machine may act on a task, and the Agent row
 * reads it to name whoever handed the task over. Left unpopulated it serialises as a bare ObjectId,
 * so "Krzysiek assigned it" degrades to "Somebody else assigned it" — and nothing fails anywhere,
 * because the component's own tests are handed an already-populated fixture.
 *
 * This was three copies of the list (here and both task routes) until the same review; it is one
 * now, and this is where its contents are pinned.
 */
describe("what a task is populated with before it is answered", () => {
  const path = (name: string) => taskPopulateFields.find((f) => f.path === name);

  it("names the assigner, not just the assignee", () => {
    expect(path("assignedBy")).toEqual({ path: "assignedBy", select: "username fullName" });
  });

  // The same two fields the assignee is asked for, because the Agent row falls back from one to
  // the other and an id would satisfy neither
  it("asks the assigner for a display name and a username", () => {
    expect(path("assignedBy")?.select).toBe(path("assignee")?.select);
  });

  // `/api/agents` answers only with agents the reader may CHOOSE, so a personal agent belonging to
  // somebody else never reaches the browser through that route. Without the name here the picker
  // cannot resolve the id and falls back to its empty state — "No agent" printed over the one
  // field that decides what executes on a machine.
  it("names the agent the task carries, which no other route will tell the reader", () => {
    expect(path("agent")).toEqual({ path: "agent", select: "name" });
  });

  it("still names everyone else a task detail renders", () => {
    expect(taskPopulateFields.map((f) => f.path)).toEqual([
      "assignee",
      "assignedBy",
      "createdBy",
      "agent",
      "blockedBy",
      "relations.task",
    ]);
  });
});

// Handing work over by creating the task — how the MCP, the PM agent and a worker all do it —
// used to tell the assignee nothing. Only reassigning an existing task did.
//
// The other two audiences a created task reaches are here for a different reason: the tests that
// came with the mails assert how one RENDERS, which is only reachable once something sent it. That
// left the sending itself unheld — delete either dispatch below and the whole suite stays green.
describe("createTask handing the task to somebody", () => {
  const ASSIGNEE = "507f1f77bcf86cd799439041";

  beforeEach(() => {
    vi.clearAllMocks();
    sprintExists.mockResolvedValue(null);
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    projectFindOneAndUpdate.mockResolvedValue({
      _id: "p1",
      taskCounter: 7,
      key: "BP",
      name: "Board Planner",
      ...customBoard,
    });
    taskCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ ...doc, _id: "new" }));
    taskFindById.mockReturnValue({ populate: () => ({ lean: async () => ({ _id: "new" }) }) });
    userFindOne.mockResolvedValue({ _id: ASSIGNEE, username: "rpo" });
  });

  it("tells the assignee, with the column's label and a link", async () => {
    await createTask("p1", "actor", { title: "Session cookie survives a change", assignee: "rpo" });

    const [notification] = createNotificationsMock.mock.calls.at(-1) ?? [];
    expect(notification.type).toBe("task_assigned");
    expect(notification.recipientIds).toEqual([ASSIGNEE]);
    expect(notification.title).toBe("BP-7 assigned to you");
    expect(notification.email.taskPills[0]).toEqual({ label: "Ready", tone: "todo" });
    expect(notification.email.projectRef).toBe("BP");
    expect(notification.email.taskNumber).toBe(7);
  });

  it("stays quiet when the task is created for nobody", async () => {
    await createTask("p1", "actor", { title: "x" });

    expect(createNotificationsMock).not.toHaveBeenCalled();
  });

  // The personal counterpart of the shared team channel: the people who ticked "every task created
  // on this board" hear about it here and nowhere else. board-feed.test.ts proves the fan-out;
  // that createTask reaches it, and what mail it hands over, was pinned by nothing.
  it("announces it to the board's own subscribers, with the mail it would send", async () => {
    await createTask("p1", "actor", { title: "Session cookie survives a change" });

    const [feed] = notifyBoardFeedMock.mock.calls.at(-1) ?? [];
    expect(feed.projectId).toBe("p1");
    expect(feed.title).toBe("New task BP-7 in Board Planner");
    expect(feed.body).toBe("Session cookie survives a change");
    // The builder is a function so an unsubscribed board never pays for the actor lookup, which
    // means nothing runs it unless a test does
    expect(await feed.email()).toMatchObject({
      kicker: "New on the board",
      taskKey: "BP-7",
      taskPills: [
        { label: "Ready", tone: "todo" },
        { label: "Medium", tone: "neutral" },
      ],
      taskMeta: "Board Planner · created by actor",
      projectRef: "BP",
      taskNumber: 7,
    });
  });

  // A different audience and a different switch from the one above: a room nobody subscribed to
  // individually. The webhook beside it is asserted; this dispatch was not.
  it("tells the project's shared chat channel", async () => {
    await createTask("p1", "actor", { title: "Session cookie survives a change" });

    expect(dispatchNotifications).toHaveBeenCalledWith("p1", "task_created", {
      project: { key: "BP", name: "Board Planner" },
      task: { taskKey: "BP-7", title: "Session cookie survives a change", status: "ready" },
    });
  });
});

// One comment used to raise two notifications for the same person: the watcher list and the
// mention list overlap, and each one sent its own mail carrying the identical excerpt.
describe("a comment mentioning a watcher", () => {
  const WATCHER = "507f1f77bcf86cd799439031";
  const MENTIONED_WATCHER = "507f1f77bcf86cd799439032";
  const board = {
    key: "TP",
    name: "Test Project",
    columns: [{ id: "doing", label: "Doing", role: "active", order: 1 }],
  };

  function setup(mentions: string[], watchers: string[]) {
    vi.clearAllMocks();
    findOne.mockReturnValue({ _id: "t1", taskNumber: 7, title: "x", status: "doing" });
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
    collectRecipientsMock.mockReturnValue(watchers);
    resolveMentionsMock.mockResolvedValue(mentions);
  }

  const notificationsByType = (): Record<string, Record<string, unknown>> =>
    Object.fromEntries(createNotificationsMock.mock.calls.map(([n]) => [n.type, n]));

  it("writes to a mentioned watcher once, as a mention", async () => {
    setup([MENTIONED_WATCHER], [MENTIONED_WATCHER]);
    await addComment("p1", "t1", "@bob look at this", { id: "actor", username: "rafal" });

    const byType = notificationsByType();
    expect(byType.comment_added, "the same person got both mails").toBeUndefined();
    expect(byType.mentioned.recipientIds).toEqual([MENTIONED_WATCHER]);
  });

  it("still tells the watchers who were not mentioned", async () => {
    setup([MENTIONED_WATCHER], [WATCHER, MENTIONED_WATCHER]);
    await addComment("p1", "t1", "@bob look at this", { id: "actor", username: "rafal" });

    const byType = notificationsByType();
    expect(byType.comment_added.recipientIds).toEqual([WATCHER]);
    expect(byType.mentioned.recipientIds).toEqual([MENTIONED_WATCHER]);
  });

  it("gives the mail the column's label and a link, not the raw status id", async () => {
    setup([], [WATCHER]);
    await addComment("p1", "t1", "no mentions here", { id: "actor", username: "rafal" });

    const email = notificationsByType().comment_added.email as Record<string, unknown>;
    expect(email.taskPills).toEqual([{ label: "Doing", tone: "progress" }]);
    expect(email.projectRef).toBe("TP");
    expect(email.taskNumber).toBe(7);
    expect(email.quote).toEqual({ who: "rafal", text: "no mentions here" });
  });
});

/**
 * The three paths where this branch's control flow and main's notifications meet.
 *
 * `updateTask` was rewritten here — the assignee is resolved earlier, the agent is judged against
 * the assignee the write LEAVES, and two guards return before the write. Main added a notification
 * after that write. Nothing in either side's suite fired it, so the one arrangement that matters —
 * guard refuses BEFORE the write and says nothing, write succeeds and the assignee is told — was
 * held up by no test at all, on either branch.
 */
describe("what a rewritten updateTask still tells the assignee", () => {
  const board = {
    key: "TP",
    name: "Test Project",
    columns: [
      { id: "ready", label: "Ready", role: "approved", order: 1 },
      { id: "doing", label: "Doing", role: "active", order: 2 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
    const stored = {
      _id: "t1",
      taskNumber: 4,
      status: "doing",
      title: "Session cookie survives a change",
      assignee: { _id: "u1", username: "rpo" },
      assignedBy: "u9",
    };
    findOne.mockReturnValue({
      lean: () => Promise.resolve(stored),
      populate: () => ({ lean: () => Promise.resolve(stored) }),
    });
    findOneAndUpdate.mockReturnValue({
      populate: () =>
        Promise.resolve({
          _id: "t1",
          taskNumber: 4,
          status: "doing",
          title: "Session cookie survives a change",
          priority: "high",
          assignee: { _id: "u2", username: "kuba" },
          execution: {},
        }),
    });
    userFindOne.mockResolvedValue({ _id: "u2", username: "kuba" });
    // Auto-watch on assign runs in the same Promise.all as the activity writes
    findByIdAndUpdate.mockReturnValue(Promise.resolve(null));
  });

  // Main's notification sits after the write. The branch moved the assignee resolution above it
  // and added two early returns, so "still reached" is the whole question.
  it("tells the new assignee, with the column's label and the assigner's name", async () => {
    await updateTask("p1", "t1", { assignee: "kuba" }, "actor");

    const [notification] = createNotificationsMock.mock.calls.at(-1) ?? [];
    expect(notification.type).toBe("task_assigned");
    expect(notification.recipientIds).toEqual(["u2"]);
    expect(notification.title).toBe("TP-4 assigned to you");
    // The column's label, not the raw id, and the priority beside it
    expect(notification.email.taskPills).toEqual([
      { label: "Doing", tone: "progress" },
      { label: "High", tone: "neutral" },
    ]);
    expect(notification.email.taskMeta).toBe("Test Project · assigned by actor");
    expect(notification.email.projectRef).toBe("TP");
    expect(notification.email.taskNumber).toBe(4);
  });

  // The other half of the same arrangement: a guard that refuses must refuse BEFORE the write, so
  // there is nothing to announce. A guard moved below the notification would still return 400 and
  // still leave this mail sent.
  it("says nothing when the agent guard refuses the write", async () => {
    agentInTheCatalog({
      _id: "a1",
      scope: "user",
      owner: "someone-else",
      name: "Mine",
      composition: { implementation: ["write-the-change"] },
    });

    const result = await updateTask(
      "p1",
      "t1",
      { assignee: "kuba", agent: "507f1f77bcf86cd799439011" },
      "actor"
    );

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(createNotificationsMock).not.toHaveBeenCalled();
  });
});

// The status-change mail, which no test on either side fired. The title and the pills both read
// the project's own column labels, so a board that renamed its columns is the case that separates
// "reads the label" from "prints the id".
describe("what a status change tells a watcher", () => {
  const board = {
    key: "TP",
    name: "Test Project",
    columns: [
      { id: "doing", label: "Doing", role: "active", order: 2 },
      { id: "checking", label: "Under review", role: "review", order: 3 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
    const stored = { _id: "t1", taskNumber: 9, status: "doing", title: "x" };
    findOne.mockReturnValue({
      lean: () => Promise.resolve(stored),
      populate: () => ({ lean: () => Promise.resolve(stored) }),
    });
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ _id: "t1", taskNumber: 9, status: "checking", title: "x" }),
    });
    updateMany.mockResolvedValue({ modifiedCount: 0 });
    collectRecipientsMock.mockReturnValue(["u1"]);
  });

  it("names the column the board calls it, in the title and in both pills", async () => {
    await changeStatus("p1", "t1", "checking", "actor");

    const [notification] = createNotificationsMock.mock.calls.at(-1) ?? [];
    expect(notification.type).toBe("status_changed");
    expect(notification.title).toBe("TP-9 moved to Under review");
    expect(notification.email.taskPills).toEqual([
      { label: "Doing", tone: "progress" },
      "arrow",
      { label: "Under review", tone: "review" },
    ]);
    expect(notification.email.taskMeta).toBe("Test Project · moved by actor");
    expect(notification.email.projectRef).toBe("TP");
  });
});

/** BP-440's inputs, built rather than pasted: a character that paints nothing paints nothing here. */
function codePoints(...codes: number[]): string {
  return codes.map((code) => String.fromCodePoint(code)).join("");
}

/**
 * BP-437. `title` is `required` on the schema, so a blank one was refused by Mongoose's
 * updateValidators rather than by either writer — and a ValidationError nobody catches leaves the
 * route as a 500. Found by clearing the title on the task screen, which is what a person does on
 * the way to typing a new one: the screen saves on every keystroke, so the empty value is sent.
 *
 * Both writers are covered because both reached the schema, and `createTask` had the sharper
 * consequence: it spends a task number with `$inc` before it writes, so a refusal past that point
 * leaves a permanent hole in the board's numbering.
 *
 * BP-440 widened the same block rather than starting another: a title of zero-width spaces and a
 * title of a megabyte are refused by the same guard, in the same two writers, for the same reason.
 */

describe("a title neither writer will store", () => {
  const WHO = "u-actor";

  // Every mock this block reads is given an implementation here, including the ones only the
  // control needs. Borrowing them from an earlier describe is what an unqualified `mockClear` gets
  // you: the refusals return before any mock is touched and pass either way, while the control
  // — the one assertion telling "refuses blanks" apart from "refuses everything" — passed only
  // because a block two thousand lines above happened to run first. Alone, or under `-t`, or after
  // a reorder, it died on `Cannot read properties of undefined (reading 'populate')`, and under a
  // mutation it died of that rather than of the mutation.
  beforeEach(() => {
    vi.clearAllMocks();
    const stored = { _id: "t1", taskNumber: 9, status: "doing", title: "Before the edit" };
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    findOne.mockReturnValue({
      lean: () => Promise.resolve(stored),
      populate: () => ({ lean: () => Promise.resolve(stored) }),
    });
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ ...stored, title: "Renamed by hand" }),
    });
    // Task.findById, not Project.findById — createTask re-reads what it wrote
    taskFindById.mockReturnValue({ populate: () => Promise.resolve({ _id: "new", title: "Brand new" }) });
    projectFindOneAndUpdate.mockResolvedValue({ _id: "p1", key: "TP", taskCounter: 8, ...customBoard });
    taskCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ ...doc, _id: "new" }));
  });

  describe.each([
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["a newline and nothing else", "\n"],
    ["a number", 7],
    ["null", null],
    // BP-440: the titles `trim()` does not empty. Written as code points because a pasted one
    // would be invisible here too — which is the whole complaint.
    ["a zero-width space", codePoints(0x200b)],
    ["a word joiner", codePoints(0x2060)],
    ["a Hangul filler", codePoints(0x3164)],
    ["invisible characters padded with spaces", ` ${codePoints(0x200b, 0xfeff)} `],
    // Not blank: this one renders, and renders as a lie about the order of what follows it
    ["a bidi override beside ordinary text", `Approve${codePoints(0x202e)}the payout`],
    ["one character past the length cap", "a".repeat(TASK_TITLE_MAX_LENGTH + 1)],
  ])("%s", (_label, title) => {
    it("is refused by updateTask with a 400, and nothing is written", async () => {
      const result = await updateTask("p1", "t1", { title } as never, WHO);

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(findOneAndUpdate, "the update reached the model anyway").not.toHaveBeenCalled();
    });

    it("is refused by createTask before the task number is spent", async () => {
      const result = await createTask("p1", WHO, { title } as never);

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(taskCreate).not.toHaveBeenCalled();
      // The counter is minted by this call, so a refusal after it burns a number on nothing
      expect(projectFindOneAndUpdate, "a refused create still spent a task number").not.toHaveBeenCalled();
    });
  });

  // The control both halves rest on. Without it, "nothing was written" is equally true of a guard
  // that refuses every title, and the surrounding padding proves the value is normalised rather
  // than merely accepted — the schema trims, so an untrimmed write would disagree with it.
  it("stores an ordinary title, trimmed the way the schema would", async () => {
    const updated = await updateTask("p1", "t1", { title: "  Renamed by hand  " }, WHO);
    expect(updated.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1])).toMatchObject({ title: "Renamed by hand" });

    const created = await createTask("p1", WHO, { title: "  Brand new  " });
    expect(created.ok).toBe(true);
    expect(taskCreate.mock.calls[0][0]).toMatchObject({ title: "Brand new" });
  });

  // The cap's own control, at the boundary: a guard off by one refuses a title that fits, and
  // looks from the refusals above exactly like a guard that works.
  it("stores a title of exactly the length cap", async () => {
    const atTheCap = "a".repeat(TASK_TITLE_MAX_LENGTH);
    const updated = await updateTask("p1", "t1", { title: atTheCap }, WHO);

    expect(updated.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1])).toMatchObject({ title: atTheCap });
  });
});

/**
 * The same mine one section lower on the same screen. `checklist[].text` is `required` too, and the
 * raw array comes straight off the request body — so clearing an acceptance criterion sent
 * `text: ""` and got the identical escaped ValidationError.
 *
 * The `acceptanceCriteria` string path was deliberately not covered: parseChecklistString drops
 * blank lines before anything reaches the schema, so it never had *that* bug. BP-440 is one it does
 * have — a line of zero-width spaces is not a blank line — so it now shares the same guard, and the
 * two tests at the foot of this block are what says so in both directions.
 */
describe("an acceptance criterion neither writer will store", () => {
  const WHO = "u-actor";
  const GOOD = { text: "Ships with a test", done: false };

  beforeEach(() => {
    vi.clearAllMocks();
    const stored = { _id: "t1", taskNumber: 9, status: "doing", title: "Before the edit" };
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    findOne.mockReturnValue({
      lean: () => Promise.resolve(stored),
      populate: () => ({ lean: () => Promise.resolve(stored) }),
    });
    findOneAndUpdate.mockReturnValue({ populate: () => Promise.resolve(stored) });
    taskFindById.mockReturnValue({ populate: () => Promise.resolve({ _id: "new" }) });
    projectFindOneAndUpdate.mockResolvedValue({ _id: "p1", key: "TP", taskCounter: 8, ...customBoard });
    taskCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ ...doc, _id: "new" }));
  });

  describe.each([
    ["an emptied criterion", [{ _id: "c1", text: "", done: false }]],
    ["one of whitespace", [{ _id: "c1", text: "   ", done: false }]],
    ["a criterion with no text at all", [{ _id: "c1", done: false }]],
    ["a good one beside a blank one", [GOOD, { text: "", done: false }]],
    // BP-440, the same field family: blank to a reader without being empty to `trim()`
    ["one of zero-width spaces", [{ _id: "c1", text: codePoints(0x200b, 0x200b), done: false }]],
    ["one carrying a bidi override", [{ text: `Approve${codePoints(0x202e)}the payout`, done: false }]],
    ["one past the length cap", [{ text: "a".repeat(CRITERION_TEXT_MAX_LENGTH + 1), done: false }]],
  ])("%s", (_label, checklist) => {
    it("is refused by updateTask, and nothing is written", async () => {
      const result = await updateTask("p1", "t1", { checklist } as never, WHO);

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(findOneAndUpdate, "the update reached the model anyway").not.toHaveBeenCalled();
    });

    it("is refused by createTask before the task number is spent", async () => {
      const result = await createTask("p1", WHO, { title: "New", checklist } as never);

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(taskCreate).not.toHaveBeenCalled();
      expect(projectFindOneAndUpdate, "a refused create still spent a task number").not.toHaveBeenCalled();
    });
  });

  // The control. Adding a criterion is the gesture this must never break, and the padding proves
  // the text is normalised rather than merely waved through.
  it("stores ordinary criteria, trimmed, keeping the row's own id and done flag", async () => {
    const result = await updateTask(
      "p1",
      "t1",
      { checklist: [{ _id: "c1", text: "  Ships with a test  ", done: true }] } as never,
      WHO
    );

    expect(result.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).checklist).toEqual([
      { _id: "c1", text: "Ships with a test", done: true },
    ]);
  });

  // BP-440. The string form is where MCP and the AI generator arrive, and parseChecklistString
  // keeps a line of zero-width spaces because it is not a blank line.
  it("refuses an invisible criterion arriving as an acceptanceCriteria string", async () => {
    const result = await updateTask(
      "p1",
      "t1",
      { acceptanceCriteria: `- [ ] ${codePoints(0x200b)}` },
      WHO
    );

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(findOneAndUpdate, "the update reached the model anyway").not.toHaveBeenCalled();
  });

  it("refuses it on create too, before the task number is spent", async () => {
    const result = await createTask("p1", WHO, {
      title: "New",
      acceptanceCriteria: `- [ ] ${codePoints(0x3164)}`,
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(projectFindOneAndUpdate, "a refused create still spent a task number").not.toHaveBeenCalled();
  });

  // The control for the two above, and for the guard the string path did not need: ordinary
  // criteria still parse, and blank lines are still dropped rather than refused.
  it("still stores an ordinary acceptanceCriteria string", async () => {
    const result = await updateTask(
      "p1",
      "t1",
      { acceptanceCriteria: "- [ ] one\n\n- [x] two\n   \n" },
      WHO
    );

    expect(result.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).checklist).toEqual([
      { text: "one", done: false },
      { text: "two", done: true },
    ]);
  });
});

/**
 * BP-438. BP-437 moved ONE refusal in front of the `$inc` that mints the task number; the other
 * four stayed behind it, so an unknown category, an unknown status, an assignee without access and
 * anything the schema throws on each spent a number on a task that never existed — a permanent
 * hole in the board's numbering.
 *
 * The `priority` arm is the sharpest and the reachable one: MCP's `create_task` declares it as a
 * free-form string and forwards it unchecked, so a model writing "critical" got a 500 *and* burnt
 * a number.
 *
 * `projectFindOneAndUpdate` is the assertion in every case, because it IS the counter: it is the
 * only call that increments it, and a create that reaches it and then refuses cannot give the
 * number back.
 */
describe("nothing a create is refused for costs a task number", () => {
  const board = {
    categories: [{ name: "bug" }, { name: "user-story" }],
    ...customBoard,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
    projectFindOneAndUpdate.mockResolvedValue({
      _id: "p1",
      taskCounter: 12,
      key: "BP",
      name: "Board Planner",
      ...board,
    });
    taskCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ ...doc, _id: "new" }));
    taskFindById.mockReturnValue({ populate: () => ({ lean: async () => ({ _id: "new" }) }) });
    userFindOne.mockResolvedValue({ _id: "u2", username: "kuba" });
    sprintExists.mockResolvedValue(null);
  });

  const REFUSED: [string, Record<string, unknown>][] = [
    ["a category the project does not have", { category: "chore" }],
    ["a column the board does not have", { status: "in_progress" }],
    // The one MCP hands over unchecked
    ["a priority the schema will not store", { priority: "critical" }],
    ["a priority cleared to an empty string", { priority: "" }],
    ["a due date that is not a date", { dueDate: "next thursday" }],
    ["a due date that is not even a string", { dueDate: { when: "soon" } }],
    ["a recurrence with no frequency", { recurrence: { interval: 2 } }],
    ["a recurrence the schema does not know", { recurrence: { frequency: "hourly", interval: 1 } }],
    ["a recurrence interval below the minimum", { recurrence: { frequency: "weekly", interval: 0 } }],
    ["a recurrence interval that is not a number", { recurrence: { frequency: "weekly", interval: "often" } }],
  ];

  describe.each(REFUSED)("%s", (_label, over) => {
    it("is refused with a 400, before the counter moves", async () => {
      const result = await createTask("p1", "actor", { title: "Ordinary title", ...over });

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(taskCreate).not.toHaveBeenCalled();
      expect(projectFindOneAndUpdate, "a refused create still spent a task number").not.toHaveBeenCalled();
    });
  });

  // Not table-driven with the rest: this one is refused by an answer rather than by the body, so
  // it needs the grant rule turned against it.
  it("refuses an assignee with no access to the board before the counter moves", async () => {
    canBeAssignedMock.mockResolvedValue(false);

    const result = await createTask("p1", "actor", { title: "Ordinary title", assignee: "kuba" });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(projectFindOneAndUpdate, "a refused create still spent a task number").not.toHaveBeenCalled();
  });

  // The control the whole block rests on: "the counter did not move" is equally true of a create
  // that refuses everything, and a task number nobody mints is a bug of its own.
  it("mints the number and writes the task when the body is answerable", async () => {
    const result = await createTask("p1", "actor", {
      title: "Ordinary title",
      category: "bug",
      status: "doing",
      priority: "urgent",
      dueDate: "2026-08-25",
      recurrence: { frequency: "weekly", interval: 2 },
    });

    expect(result.ok).toBe(true);
    expect(projectFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(taskCreate.mock.calls[0][0]).toMatchObject({
      taskNumber: 12,
      category: "bug",
      status: "doing",
      priority: "urgent",
      recurrence: { frequency: "weekly", interval: 2 },
    });
  });

  // The default arms of the same values: a body naming none of them still writes, so the guard
  // cannot be refusing absence.
  it("still creates a task that names none of them", async () => {
    const result = await createTask("p1", "actor", { title: "Ordinary title" });

    expect(result.ok).toBe(true);
    expect(taskCreate.mock.calls[0][0]).toMatchObject({
      priority: "medium",
      dueDate: null,
      recurrence: null,
    });
  });
});

/**
 * The same three values on the update path, where they escaped as 500s too — `priority` is an
 * enum, `dueDate` a Date cast and `recurrence.interval` required, and all three are on updateTask's
 * whitelist. The family BP-437 closed for `title` and `checklist[].text`, closed for the rest.
 */
describe("a value the schema will not store is refused by updateTask too", () => {
  const WHO = "u-actor";

  beforeEach(() => {
    vi.clearAllMocks();
    const stored = { _id: "t1", taskNumber: 9, status: "doing", title: "Before the edit" };
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    findOne.mockReturnValue({
      lean: () => Promise.resolve(stored),
      populate: () => ({ lean: () => Promise.resolve(stored) }),
    });
    findOneAndUpdate.mockReturnValue({ populate: () => Promise.resolve(stored) });
  });

  const REFUSED: [string, Record<string, unknown>][] = [
    ["a priority the schema will not store", { priority: "critical" }],
    ["a priority cleared to an empty string", { priority: "" }],
    ["a priority cleared to null", { priority: null }],
    ["a due date that is not a date", { dueDate: "next thursday" }],
    ["a recurrence with no frequency", { recurrence: { interval: 2 } }],
    ["a recurrence interval below the minimum", { recurrence: { frequency: "daily", interval: 0 } }],
    ["a recurrence that is not an object at all", { recurrence: "weekly" }],
  ];

  describe.each(REFUSED)("%s", (_label, body) => {
    it("is refused with a 400, and nothing is written", async () => {
      const result = await updateTask("p1", "t1", body, WHO);

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(findOneAndUpdate, "the update reached the model anyway").not.toHaveBeenCalled();
    });
  });

  // The control, and the two clearing gestures the schema DOES accept: a date input emptied to ""
  // and an explicit null both mean "no due date", and Mongoose's own cast stores null for each.
  it("stores the values the schema accepts, clearings included", async () => {
    const result = await updateTask(
      "p1",
      "t1",
      { priority: "high", dueDate: "2026-08-25", recurrence: { frequency: "monthly", interval: 3 } },
      WHO
    );

    expect(result.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1])).toMatchObject({
      priority: "high",
      dueDate: "2026-08-25",
      recurrence: { frequency: "monthly", interval: 3 },
    });

    expect((await updateTask("p1", "t1", { dueDate: "" }, WHO)).ok).toBe(true);
    expect((await updateTask("p1", "t1", { dueDate: null, recurrence: null }, WHO)).ok).toBe(true);
  });
});


// BP-461. `setMonth` does not clamp: 31 January + 1 month is 3 March, so a monthly series skipped
// February and then kept drifting, because the occurrence after that was computed from the 3rd.
describe("advancing a recurring series' due date", () => {
  const ymd = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];

  // The short months, both directions across a year boundary, and both leap-year answers for
  // 29 February, plus one whose day the target month can hold. All but the last are dates where
  // a bare `setMonth` and the clamp disagree, so they cannot go green against the code this
  // replaces; the last one guards the other half of `Math.min`.
  it.each([
    { from: [2026, 0, 31], interval: 1, to: [2026, 2, 28], why: "31 Jan lands on the last of February" },
    { from: [2026, 0, 29], interval: 1, to: [2026, 2, 28], why: "so does the 29th" },
    { from: [2026, 0, 30], interval: 1, to: [2026, 2, 28], why: "and the 30th" },
    { from: [2026, 2, 31], interval: 1, to: [2026, 4, 30], why: "31 March lands on 30 April" },
    { from: [2028, 0, 31], interval: 1, to: [2028, 2, 29], why: "a leap year gets its 29th" },
    { from: [2026, 11, 31], interval: 2, to: [2027, 2, 28], why: "the clamp survives a year boundary" },
    { from: [2026, 0, 31], interval: 3, to: [2026, 4, 30], why: "and an interval above one" },
    // The other half of `Math.min`. Every row above lands on the target month's last day, so a
    // version that discarded `day` and always used the month end would satisfy all of them —
    // measured. This one is shorter than February, let alone the month it lands in.
    { from: [2026, 4, 15], interval: 2, to: [2026, 7, 15], why: "a day the target month can hold is kept" },
  ])("monthly: $why", ({ from, interval, to }) => {
    const next = nextRecurrenceDue(new Date(from[0], from[1], from[2], 12, 0, 0), "monthly", interval);
    expect(ymd(next)).toEqual(to);
  });

  // Measured, and deliberately not what BP-461's own description predicted: each occurrence is
  // computed from the one just closed, so once February has clamped 31 to 28 the series settles on
  // the 28th rather than climbing back to the 31st.
  //
  // That is the price of basing the next occurrence on the previous one, and the previous one is
  // what makes retargeting work — a person who edits a mid-series due date to the 5th gets the 5th
  // from then on. Climbing back would need the originally chosen day stored beside the recurrence
  // and invalidated on every explicit due-date edit; see the note on BP-461.
  //
  // What matters is that it is stationary. The bug was a series walking forward forever — 31 Jan,
  // 3 Mar, 3 Apr, 3 May — through months nobody chose.
  it("settles on a day and stays there, instead of walking forward month after month", () => {
    let due = new Date(2026, 0, 31, 12, 0, 0);
    const series: number[][] = [];
    for (let i = 0; i < 4; i++) {
      due = nextRecurrenceDue(due, "monthly", 1);
      series.push(ymd(due));
    }

    expect(series).toEqual([
      [2026, 2, 28],
      [2026, 3, 28],
      [2026, 4, 28],
      [2026, 5, 28],
    ]);
  });

  // The control. `setDate` overflowing into the next month is exactly what "seven days later"
  // means, so these two must be left alone by the fix above — and the interval has to be carried,
  // or `7 * interval` mutated to a bare `7` goes unnoticed.
  it.each([
    { frequency: "daily" as const, interval: 3, to: [2026, 3, 3] },
    { frequency: "weekly" as const, interval: 2, to: [2026, 3, 14] },
  ])("$frequency every $interval still counts days across the month boundary", ({ frequency, interval, to }) => {
    const next = nextRecurrenceDue(new Date(2026, 1, 28, 12, 0, 0), frequency, interval);
    expect(ymd(next)).toEqual(to);
  });

  it("keeps the time of day, so a series does not walk around the clock", () => {
    const next = nextRecurrenceDue(new Date(2026, 0, 31, 9, 30, 0), "monthly", 1);
    expect([next.getHours(), next.getMinutes()]).toEqual([9, 30]);
  });

  // Raised by an independent review of this fix. Clamping by stepping through the 1st of the
  // target month — `setDate(1)` then `setMonth` then `setDate(day)` — imports a DST gap that the
  // chosen day does not have. In a zone whose clocks go forward on the 1st of October, a series
  // due at 02:30 on the 15th passes through an hour that does not exist on 1 October, is
  // normalised forward, and every occurrence from then on is an hour late: 02:30, 03:30, 03:30…
  //
  // Nothing to do with the clamp — 15 October holds a 15th perfectly well, and the whole zone
  // family (Sydney, Melbourne, Hobart, Adelaide, Lord Howe, Norfolk) is affected for any base
  // whose time-of-day falls in the gap. Europe and the Americas are clean only because their
  // transition Sundays land later in the month.
  it("does not pick up an hour from a DST gap the chosen day never touches", () => {
    const wasTz = process.env.TZ;
    process.env.TZ = "Australia/Sydney";
    try {
      const base = new Date(2028, 8, 15, 2, 30, 0);
      expect(base.getHours(), "the base itself is before the transition").toBe(2);

      let due = base;
      const clock: string[] = [];
      for (let i = 0; i < 3; i++) {
        due = nextRecurrenceDue(due, "monthly", 1);
        clock.push(`${due.getDate()}/${due.getMonth() + 1} ${due.getHours()}:${due.getMinutes()}`);
      }

      expect(clock).toEqual(["15/10 2:30", "15/11 2:30", "15/12 2:30"]);
    } finally {
      process.env.TZ = wasTz;
    }
  });
});
