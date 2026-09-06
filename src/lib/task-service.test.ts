import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import sift from "sift";
import { Types } from "mongoose";
import { CRITERION_TEXT_MAX_LENGTH, TASK_TITLE_MAX_LENGTH } from "@/lib/identifiers";
import { BoardCannotClaim } from "@/lib/claim-refusal";

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
const userFindById = vi.fn(() => ({ lean: async () => ({ username: "actor" }) }));
const commentCreate = vi.fn(async () => ({ _id: "c1" }));
const createNotificationsMock = vi.fn();
const notifyBoardFeedMock = vi.fn();
const collectRecipientsMock = vi.fn((_task?: unknown): string[] => []);
const resolveMentionsMock = vi.fn(async (_body?: string): Promise<string[]> => []);
const workerFindById = vi.fn();
const taskFindById = vi.fn();
const taskExists = vi.fn(async (_filter?: unknown): Promise<unknown> => null);

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/worker", () => ({ Worker: { findById: workerFindById } }));
vi.mock("@/models/task", async () => ({
  Task: {
    schema: (await vi.importActual<typeof import("@/models/task")>("@/models/task")).Task.schema,
    findOneAndUpdate, updateMany, updateOne, findOne, find, findByIdAndUpdate, findById: taskFindById, create: taskCreate, exists: taskExists,
  },
}));
vi.mock("@/models/project", () => ({ Project: { findById, findOneAndUpdate: projectFindOneAndUpdate } }));
vi.mock("@/models/user", () => ({ User: { findOne: userFindOne, findById: userFindById } }));
const pmUserIdMock = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/pm/pm-user", () => ({
  pmUserId: () => pmUserIdMock(),
  PM_USERNAME: "pm",
  getPmUser: vi.fn(),
}));
const agentFindById = vi.fn();
vi.mock("@/models/agent", () => ({ Agent: { findById: agentFindById } }));

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

const canBeAssignedMock = vi.fn(async (_userId?: string, _projectId?: string) => true);
vi.mock("@/lib/grants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/grants")>()),
  canBeAssigned: (userId: string, projectId: string) => canBeAssignedMock(userId, projectId),
}));

beforeEach(() => {
  canBeAssignedMock.mockClear();
  canBeAssignedMock.mockResolvedValue(true);
  pmUserIdMock.mockReset();
  pmUserIdMock.mockResolvedValue(null);
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
  heldRunRefusal,
} = await import("./task-service");

const { logActivity } = await import("@/lib/activity");
const { dispatchWebhooks } = await import("@/lib/webhooks");
const { dispatchNotifications } = await import("@/lib/notifications");

function matches(filter: unknown, doc: unknown): boolean {
  return sift(filter as Record<string, unknown>)(doc);
}

const PHASE_KEYS = ["execution.phase", "execution.phaseAt", "execution.phaseSeq"];
const RUN_KEYS = [...PHASE_KEYS, "execution.runId"];

const customBoard = {
  columns: [
    { id: "ready", label: "Ready", role: "approved", order: 1 },
    { id: "doing", label: "Doing", role: "active", order: 2 },
  ],
};

const claimableBoard = {
  columns: [
    ...customBoard.columns,
    { id: "checking", label: "Checking", role: "review", order: 3 },
    { id: "shipped", label: "Shipped", role: "done", order: 4 },
  ],
};

const claimStages = (call: unknown[]) => call[1] as Record<string, never>[];
const claimSet = (call: unknown[]) => claimStages(call)[0].$set as unknown as Record<string, unknown>;

const OWNER = "6a70afff45d39cd9bc8bb5fe";

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
    findById.mockReturnValue({ lean: () => Promise.resolve(claimableBoard) });
    find.mockReset();
    find.mockReturnValue({ lean: () => Promise.resolve([]) });
  });

  describe("blockers", () => {
    const shipping = claimableBoard;

    const OPEN = "6a70afff45d39cd9bc8bb600";
    const FINISHED = "6a70afff45d39cd9bc8bb601";
    const ALSO_FINISHED = "6a70afff45d39cd9bc8bb602";

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

    it("claims a task that predates the blockedBy field", async () => {
      boardWhere([OPEN], [OPEN]);
      const legacy = task();
      delete (legacy as Record<string, unknown>).blockedBy;

      expect(matches(await claimFilter(), legacy)).toBe(true);
    });

    it("asks only about the blockers the approved column actually names", async () => {
      boardWhere([OPEN], [OPEN]);

      await claimFilter();

      const asked = find.mock.calls[0][0];
      expect(matches(asked, task({ blockedBy: [OPEN] }))).toBe(true);
      expect(matches(asked, task({ blockedBy: [] }))).toBe(false);
      expect(matches(asked, task({ status: "doing", blockedBy: [OPEN] }))).toBe(false);
      const legacy = task();
      delete (legacy as Record<string, unknown>).blockedBy;
      expect(matches(asked, legacy)).toBe(false);
      expect(find.mock.calls[1][0]).toEqual({
        project: "p1",
        _id: { $in: [OPEN] },
        status: { $nin: ["shipped"] },
      });
    });

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

    it("never consults the gate on a board with no done column, which is refused outright", async () => {
      findById.mockReturnValue({
        lean: () =>
          Promise.resolve({ columns: claimableBoard.columns.filter((c) => c.role !== "done") }),
      });
      find.mockReset();

      await expect(claimNextTask("p1", "worker-a", "run-1", OWNER)).rejects.toThrow(/Done/);

      expect(find).not.toHaveBeenCalled();
      expect(findOneAndUpdate).not.toHaveBeenCalled();
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

  it("refuses, naming the role, when the board has no active column to claim into", async () => {
    findById.mockReturnValue({
      lean: () => Promise.resolve({ columns: [{ id: "ready", role: "approved", order: 1 }] }),
    });

    const claim = claimNextTask("p1", "worker-a", "run-1", OWNER);
    await expect(claim).rejects.toBeInstanceOf(BoardCannotClaim);
    await expect(claim).rejects.toThrow(/no column meaning In progress/);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses, naming the role, when the board has no approved column to claim from", async () => {
    findById.mockReturnValue({
      lean: () => Promise.resolve({ columns: [{ id: "doing", role: "active", order: 1 }] }),
    });

    const claim = claimNextTask("p1", "worker-a", "run-1", OWNER);
    await expect(claim).rejects.toBeInstanceOf(BoardCannotClaim);
    await expect(claim).rejects.toThrow(/no column meaning Ready to pick up/);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a board with no review column, where a run could not put its result", async () => {
    findById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          columns: claimableBoard.columns.filter((c) => c.role !== "review"),
        }),
    });

    const claim = claimNextTask("p1", "worker-a", "run-1", OWNER);
    await expect(claim).rejects.toBeInstanceOf(BoardCannotClaim);
    await expect(claim).rejects.toThrow(/no column meaning Awaiting review/);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a board with no done column, where a run could not deliver", async () => {
    findById.mockReturnValue({
      lean: () =>
        Promise.resolve({ columns: claimableBoard.columns.filter((c) => c.role !== "done") }),
    });

    const claim = claimNextTask("p1", "worker-a", "run-1", OWNER);
    await expect(claim).rejects.toBeInstanceOf(BoardCannotClaim);
    await expect(claim).rejects.toThrow(/no column meaning Done/);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
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
    expect(set["execution.workerId"]).toEqual({ $literal: "worker-a" });
    expect(set["execution.runId"]).toEqual({ $literal: "run-1" });
    expect(set["execution.attempts"]).toEqual({
      $add: [{ $ifNull: ["$execution.attempts", 0] }, 1],
    });
  });

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

    it("says nothing when the worker's identity cannot be resolved", async () => {
      abandoned();
      userFindOne.mockReturnValue({ lean: async () => null });

      await releaseExpiredTasks("p1", now);

      expect(createNotificationsMock).not.toHaveBeenCalled();
    });

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

  it("drops a replay of the run the task was released from", async () => {
    const released = { _id: TASK_ID, execution: { workerId: "w1", attempts: 1 } };
    expect(matches(await filterFor(1), released)).toBe(false);
  });

  it("drops an event carrying a seq already recorded", async () => {
    const doc = { ...holder, execution: { ...holder.execution, phaseSeq: 3 } };
    expect(matches(await filterFor(3), doc)).toBe(false);
  });

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

  it("leaves it alone when the edit touches no status", async () => {
    await updateTask("p1", "t1", { title: "renamed" }, "actor");

    expect(unsetKeys(findOneAndUpdate.mock.calls[0][1])).toEqual([]);
  });

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

  it("says nothing about a task no run is holding", () => {
    expect(toApiExecution({ ...running, runId: "", phase: undefined })).toBeUndefined();
    expect(toApiExecution(undefined)).toBeUndefined();
  });

  it("publishes only what a reader may see", () => {
    const api = toApiExecution(running)!;

    expect(Object.keys(api).sort()).toEqual(["asOf", "phase", "phaseAt", "startedAt", "workerId"]);
  });

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

const IDENTITY = "6a70afff45d39cd9bc8bb600";

describe("claiming by assignment", () => {
  const board = {
    columns: [
      { id: "ready", role: "approved", order: 1 },
      { id: "doing", role: "active", order: 2 },
      { id: "checking", role: "review", order: 3, triggersPmReview: true },
      { id: "shipped", role: "done", order: 4 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
    findOneAndUpdate.mockResolvedValue({ _id: "t1" });
    updateMany.mockResolvedValue({ modifiedCount: 0 });
  });

  it("touches neither the assignee nor the assigner", async () => {
    await claimNextTask("p1", "w1", "run-1", OWNER);

    expect(claimSet(findOneAndUpdate.mock.calls[0])).not.toHaveProperty("assignee");
    expect(claimSet(findOneAndUpdate.mock.calls[0])).not.toHaveProperty("assignedBy");
    expect(claimSet(findOneAndUpdate.mock.calls[0]).status).toBe("doing");
  });

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

  const CLEARED = CLEAR_WORKER_ASSIGNEE.assignee;
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

  it("keeps it on a task a worker finished long ago", () => {
    const doc = { assignee: "USER-A", execution: { runId: "", workerId: "w1" } };

    expect(evaluateExpr(CLEARING, doc)).toBe("USER-A");
  });

  it("keeps a hand-over the claim did not make, even mid-run", () => {
    const doc = {
      assignee: "USER-A",
      execution: { runId: "r1", workerId: "w1", assignedByRun: false },
    };

    expect(evaluateExpr(CLEARING, doc)).toBe("USER-A");
  });

  it("treats a missing assignedByRun as the claim's own assignment", () => {
    const doc = { assignee: IDENTITY, execution: { runId: "r1", workerId: "w1" } };

    expect(evaluateExpr(CLEARING, doc)).toBeNull();
  });

  it("would have cleared every assignment had it leaned on truthiness", () => {
    const naive = { $cond: [{ $ifNull: ["$execution.workerId", false] }, null, "$assignee"] };
    const doc = { assignee: "USER-A", execution: { workerId: "" } };

    expect(evaluateExpr(naive, doc)).toBeNull();
  });

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

  it("does not treat an absent worker id as the holder", async () => {
    const result = await changeStatus("p1", "t1", "checking", "actor", { workerId: undefined });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(409);
  });

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

describe("updateTask and the writes that are not edits", () => {
  function setup() {
    vi.clearAllMocks();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    findOne.mockReturnValue({
      lean: () => Promise.resolve({ _id: "t1", taskNumber: 7, status: "doing", title: "x" }),
      populate: () => ({
        lean: () => Promise.resolve({ _id: "t1", taskNumber: 7, status: "doing", title: "x" }),
      }),
    });
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ _id: "t1", taskNumber: 7, status: "doing" }),
    });
  }

  function timestampsOf() {
    return findOneAndUpdate.mock.calls[0][2].timestamps;
  }

  it("stamps an ordinary edit", async () => {
    setup();

    await updateTask("p1", "t1", { title: "renamed" }, "actor");

    expect(timestampsOf()).toBe(true);
  });

  it("does not stamp a card dragged inside its column", async () => {
    setup();

    await updateTask("p1", "t1", { order: 3 }, "actor");

    expect(timestampsOf()).toBe(false);
  });

  it("does not stamp a body that sets nothing at all", async () => {
    setup();

    await updateTask("p1", "t1", {}, "actor");

    expect(timestampsOf()).toBe(false);
  });
});

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

  it("says nothing about the untouched fields a full map carries along", async () => {
    setup({ "f-diff": "opt-m" }, { "f-diff": "opt-m" });

    await updateTask("p1", "t1", { customFieldValues: { "f-diff": "opt-m" } }, "actor");

    expect(fieldEntries()).toHaveLength(0);
  });
});

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

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("dispatches a webhook when a task is created", async () => {
    setup();
    projectFindOneAndUpdate.mockResolvedValue({ _id: "p1", key: "TP", name: "A board", taskCounter: 8 });
    taskCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ ...doc, _id: "new", taskNumber: 8 }));
    taskFindById.mockReturnValue({ populate: () => ({ lean: async () => ({ _id: "new" }) }) });

    await createTask("p1", "actor", { title: "Announced to the room", status: "doing" });

    expect(webhookPayloads()).toHaveLength(1);
    const [event, payload] = webhookPayloads()[0];
    expect(event).toBe("task_created");
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

  it("creates the next occurrence when the edit form closes a recurring task", async () => {
    setup({ recurrence: { frequency: "weekly", interval: 1 } });
    await updateTask("p1", "t1", { status: "shipped" }, "actor");
    await flush();

    expect(taskCreate, "no next occurrence was created").toHaveBeenCalled();
  });

  it("carries the original assigner into the next occurrence, not whoever closed this one", async () => {
    setup({ recurrence: { frequency: "weekly", interval: 1 }, assignee: "u9", assignedBy: "u9" });
    await updateTask("p1", "t1", { status: "shipped" }, "actor");
    await flush();

    expect(taskCreate.mock.calls[0]?.[0].assignedBy).toBe("u9");
  });

  it("carries the agent into the next occurrence, or the series stops running on the machine", async () => {
    setup({
      recurrence: { frequency: "weekly", interval: 1 },
      assignee: "u9",
      assignedBy: "u9",
      agent: "a1",
    });
    await updateTask("p1", "t1", { status: "shipped" }, "actor");
    await flush();

    expect(taskCreate.mock.calls[0]?.[0].agent).toBe("a1");
  });

  it("leaves the next occurrence of a hand-written task with no agent", async () => {
    setup({ recurrence: { frequency: "weekly", interval: 1 }, assignee: "u9", assignedBy: "u9" });
    await updateTask("p1", "t1", { status: "shipped" }, "actor");
    await flush();

    expect(taskCreate.mock.calls[0]?.[0].agent).toBeNull();
  });

  it("creates none, and burns no task number, when the task does not recur", async () => {
    setup();
    await updateTask("p1", "t1", { status: "shipped" }, "actor");
    await flush();

    expect(taskCreate).not.toHaveBeenCalled();
    expect(projectFindOneAndUpdate, "the recurrence counter was incremented anyway").not.toHaveBeenCalled();
  });

  it("announces nothing when the status does not actually move", async () => {
    setup();
    await updateTask("p1", "t1", { title: "renamed" }, "actor");
    expect(dispatchWebhooks).not.toHaveBeenCalled();
    expect(taskCreate).not.toHaveBeenCalled();
  });
});

describe("two overlapping closes of the same recurring task (BP-489)", () => {
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
    const current = { ...before, status: "shipped" };
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
    findOne.mockReturnValue({
      lean: () => Promise.resolve(before),
      populate: () => ({
        lean: () => Promise.resolve(before),
        then: (resolve: (v: unknown) => void) => resolve(current),
      }),
    });
    findOneAndUpdate.mockReturnValue({ populate: () => Promise.resolve(current) });
    updateMany.mockResolvedValue({ modifiedCount: 0 });
    return before;
  }

  it("changeStatus guards its write with the status it just read", async () => {
    const before = setup();
    await changeStatus("p1", "t1", "shipped", "actor");

    expect(findOneAndUpdate.mock.calls[0][0]).toMatchObject({ status: before.status });
  });

  it("updateTask guards its write the same way when the edit form carries a status", async () => {
    const before = setup();
    await updateTask("p1", "t1", { status: "shipped" }, "actor");

    expect(findOneAndUpdate.mock.calls[0][0]).toMatchObject({ status: before.status });
  });

  it("does not guard a write that stays in its column", async () => {
    setup();
    await updateTask("p1", "t1", { title: "renamed" }, "actor");

    expect(findOneAndUpdate.mock.calls[0][0]).not.toHaveProperty("status");
  });

  it("reports the current task instead of a 404 when the guarded write loses the race", async () => {
    setup({ recurrence: { frequency: "weekly", interval: 1 } });
    findOneAndUpdate.mockReturnValue({ populate: () => Promise.resolve(null) });

    const result = await changeStatus("p1", "t1", "shipped", "actor");

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.data.status).toBe("shipped");
  });

  it("a lost race announces nothing and mints no second occurrence", async () => {
    setup({ recurrence: { frequency: "weekly", interval: 1 } });
    findOneAndUpdate.mockReturnValue({ populate: () => Promise.resolve(null) });

    const result = await changeStatus("p1", "t1", "shipped", "actor");

    expect(result.ok).toBe(true);
    expect(dispatchWebhooks).not.toHaveBeenCalled();
    expect(taskCreate).not.toHaveBeenCalled();
  });

  it("updateTask's lost race is silent in exactly the same way", async () => {
    setup({ recurrence: { frequency: "weekly", interval: 1 } });
    findOneAndUpdate.mockReturnValue({ populate: () => Promise.resolve(null) });

    const result = await updateTask("p1", "t1", { status: "shipped" }, "actor");

    expect(result.ok).toBe(true);
    expect(dispatchWebhooks).not.toHaveBeenCalled();
    expect(taskCreate).not.toHaveBeenCalled();
  });
});

describe("what the next occurrence of a recurring task is", () => {
  const board = {
    key: "TP",
    columns: [
      { id: "shipped", label: "Shipped", role: "done", order: 1 },
      { id: "later", label: "Later", role: "backlog", order: 2 },
      { id: "doing", label: "Doing", role: "active", order: 3 },
      { id: "released", label: "Released", role: "done", order: 4 },
    ],
  };

  const flush = () => new Promise((r) => setTimeout(r, 0));

  function setup(
    over: Record<string, unknown> = {},
    columns: Record<string, unknown>[] = board.columns
  ) {
    vi.clearAllMocks();
    const before = {
      _id: "t1",
      taskNumber: 7,
      status: "doing",
      title: "weekly sweep",
      recurrence: { frequency: "weekly", interval: 1 },
      ...over,
    };
    const project = { ...board, columns };
    findById.mockReturnValue({ lean: () => Promise.resolve(project) });
    findOne.mockReturnValue({
      lean: () => Promise.resolve(before),
      populate: () => ({ lean: () => Promise.resolve(before) }),
    });
    findOneAndUpdate.mockImplementation((_filter: unknown, update: unknown) => ({
      populate: () =>
        Promise.resolve({ ...before, status: setStage(update).status ?? before.status }),
    }));
    updateMany.mockResolvedValue({ modifiedCount: 0 });
    projectFindOneAndUpdate.mockResolvedValue({ _id: "p1", ...project, taskCounter: 8 });
    taskCreate.mockResolvedValue({ _id: "t2", taskNumber: 8 });
  }

  const minted = () => taskCreate.mock.calls[0]?.[0];

  it("hands the anchor to the occurrence it mints, or the climb back dies here", async () => {
    setup({
      dueDate: new Date("2026-01-31"),
      recurrence: { frequency: "monthly", interval: 1 },
    });
    await changeStatus("p1", "t1", "shipped", "actor");
    await flush();

    expect(minted()?.dueDate?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(minted()?.recurrence).toMatchObject({ frequency: "monthly", anchorDay: 31 });
  });

  it("gets the chosen day back on the occurrence after the short month", async () => {
    setup({
      dueDate: new Date("2026-02-28"),
      recurrence: { frequency: "monthly", interval: 1, anchorDay: 31 },
    });
    await changeStatus("p1", "t1", "shipped", "actor");
    await flush();

    expect(minted()?.dueDate?.toISOString()).toBe("2026-03-31T00:00:00.000Z");
  });

  it("is born in the backlog column even when that is not the first one", async () => {
    setup();
    await changeStatus("p1", "t1", "shipped", "actor");
    await flush();

    expect(minted()?.status).toBe("later");
  });

  it("is born somewhere it can be worked on when the board has no backlog column", async () => {
    setup({}, [
      { id: "shipped", label: "Shipped", role: "done", order: 1 },
      { id: "doing", label: "Doing", role: "active", order: 2 },
    ]);
    await changeStatus("p1", "t1", "shipped", "actor");
    await flush();

    expect(minted()?.status).toBe("doing");
  });

  it("counts from the occurrence's own due date", async () => {
    setup({ dueDate: "2026-06-03T12:00:00.000Z" });
    await changeStatus("p1", "t1", "shipped", "actor");
    await flush();

    expect(minted()?.dueDate?.toISOString()).toBe("2026-06-10T12:00:00.000Z");
  });

  it("stays undated when the occurrence it follows was undated", async () => {
    setup();
    await changeStatus("p1", "t1", "shipped", "actor");
    await flush();

    expect(minted()?.dueDate).toBeNull();
  });

  it("mints nothing once the series' end is behind the occurrence that would come next", async () => {
    setup({
      dueDate: "2026-06-03T12:00:00.000Z",
      recurrence: { frequency: "weekly", interval: 1, endDate: "2026-06-08T00:00:00.000Z" },
    });
    await changeStatus("p1", "t1", "shipped", "actor");
    await flush();

    expect(taskCreate).not.toHaveBeenCalled();
    expect(projectFindOneAndUpdate, "a task number was burned on a series that is over").not.toHaveBeenCalled();
  });

  it("goes on minting while the series' end is still ahead", async () => {
    setup({
      dueDate: "2026-06-03T12:00:00.000Z",
      recurrence: { frequency: "weekly", interval: 1, endDate: "2026-12-31T00:00:00.000Z" },
    });
    await changeStatus("p1", "t1", "shipped", "actor");
    await flush();

    expect(taskCreate).toHaveBeenCalled();
  });

  it("ends an undated series once its end date has passed", async () => {
    setup({ recurrence: { frequency: "weekly", interval: 1, endDate: "2020-01-01T00:00:00.000Z" } });
    await changeStatus("p1", "t1", "shipped", "actor");
    await flush();

    expect(taskCreate).not.toHaveBeenCalled();
  });

  it("mints nothing on a hop between two done columns", async () => {
    setup({ status: "shipped" });
    await changeStatus("p1", "t1", "released", "actor");
    await flush();

    expect(taskCreate).not.toHaveBeenCalled();
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("mints nothing for an occurrence that already has a successor", async () => {
    setup();
    taskExists.mockResolvedValueOnce({ _id: "t2" });
    await changeStatus("p1", "t1", "shipped", "actor");
    await flush();

    expect(taskExists).toHaveBeenCalledWith({ recurringParentId: "t1" });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("carries the series' end into the occurrence it mints", async () => {
    const recurrence = { frequency: "weekly", interval: 1, endDate: "2026-12-31T00:00:00.000Z" };
    setup({ recurrence });
    await changeStatus("p1", "t1", "shipped", "actor");
    await flush();

    expect(minted()?.recurrence).toEqual({ ...recurrence, anchorDay: null });
  });
});

describe("what a client may say about a repeating task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sprintExists.mockResolvedValue(null);
    projectFindOneAndUpdate.mockResolvedValue({
      _id: "p1",
      taskCounter: 1,
      key: "BP",
      ...customBoard,
    });
    taskCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ ...doc, _id: "new" }));
    taskFindById.mockReturnValue({ populate: () => ({ lean: async () => ({ _id: "new" }) }) });
    const stored = { _id: "t1", taskNumber: 7, status: "ready", title: "x" };
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    findOne.mockReturnValue({
      lean: () => Promise.resolve(stored),
      populate: () => ({ lean: () => Promise.resolve(stored) }),
    });
    findOneAndUpdate.mockReturnValue({ populate: () => Promise.resolve(stored) });
  });

  const created = () => taskCreate.mock.calls.at(-1)?.[0];
  const written = () =>
    (findOneAndUpdate.mock.calls.at(-1)?.[1] as { $set?: Record<string, unknown> })?.$set;

  it("refuses an interval above the stated maximum rather than storing it", async () => {
    const result = await createTask("p1", "actor", {
      title: "x",
      recurrence: { frequency: "weekly", interval: 400 },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(400);
    expect(result.ok === false && result.error).toContain("365");
    expect(taskCreate).not.toHaveBeenCalled();
  });

  it("refuses an interval below one", async () => {
    const result = await createTask("p1", "actor", {
      title: "x",
      recurrence: { frequency: "weekly", interval: 0 },
    });

    expect(result.ok === false && result.status).toBe(400);
  });

  it("refuses a frequency the schema does not have", async () => {
    const result = await createTask("p1", "actor", {
      title: "x",
      recurrence: { frequency: "fortnightly", interval: 1 },
    });

    expect(result.ok === false && result.status).toBe(400);
  });

  it("refuses an end date it cannot read rather than dropping it", async () => {
    const result = await createTask("p1", "actor", {
      title: "x",
      recurrence: { frequency: "weekly", interval: 1, endDate: "whenever" },
    });

    expect(result.ok === false && result.status).toBe(400);
    expect(result.ok === false && result.error).toContain("endDate");
  });

  it("stores the end a client does give", async () => {
    const result = await createTask("p1", "actor", {
      title: "x",
      recurrence: { frequency: "weekly", interval: 1, endDate: "2026-12-31" },
    });

    expect(result.ok).toBe(true);
    expect(created()?.recurrence.endDate).toEqual(new Date("2026-12-31"));
  });

  it("takes a null end as a series with no end", async () => {
    const result = await createTask("p1", "actor", {
      title: "x",
      recurrence: { frequency: "weekly", interval: 1, endDate: null },
    });

    expect(result.ok).toBe(true);
    expect(created()?.recurrence.endDate).toBeNull();
  });

  it("refuses the same interval on an edit", async () => {
    const result = await updateTask(
      "p1",
      "t1",
      { recurrence: { frequency: "daily", interval: 100000 } },
      "actor"
    );

    expect(result.ok === false && result.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  describe("which day a monthly series stays anchored to", () => {
    const storedWith = (over: Record<string, unknown>) => {
      const stored = { _id: "t1", taskNumber: 7, status: "ready", title: "x", ...over };
      findOne.mockReturnValue({
        lean: () => Promise.resolve(stored),
        populate: () => ({ lean: () => Promise.resolve(stored) }),
      });
    };
    const anchored = { frequency: "monthly", interval: 1, endDate: null, anchorDay: 31 };

    it("keeps it when only the rhythm changes", async () => {
      storedWith({ recurrence: anchored });
      await updateTask("p1", "t1", { recurrence: { frequency: "monthly", interval: 2 } }, "actor");

      expect((written()?.recurrence as { anchorDay?: number })?.anchorDay).toBe(31);
    });

    it("drops it when the frequency changes", async () => {
      storedWith({ recurrence: anchored });
      await updateTask("p1", "t1", { recurrence: { frequency: "weekly", interval: 1 } }, "actor");

      expect((written()?.recurrence as { anchorDay?: number | null })?.anchorDay).toBeNull();
    });

    it("clears it when the due date is chosen again", async () => {
      storedWith({ recurrence: anchored });
      await updateTask("p1", "t1", { dueDate: "2026-03-05" }, "actor");

      expect(written()).toMatchObject({ "recurrence.anchorDay": null });
    });

    it("writes nothing about it when the task does not repeat", async () => {
      storedWith({ recurrence: null });
      await updateTask("p1", "t1", { dueDate: "2026-03-05" }, "actor");

      expect(Object.keys(written() ?? {})).not.toContain("recurrence.anchorDay");
    });

    it("lets the new due date decide when both are written together", async () => {
      storedWith({ recurrence: anchored });
      await updateTask(
        "p1",
        "t1",
        { dueDate: "2026-03-05", recurrence: { frequency: "monthly", interval: 1 } },
        "actor"
      );

      const set = written() ?? {};
      expect((set.recurrence as { anchorDay?: number | null })?.anchorDay).toBeNull();
      expect(Object.keys(set)).not.toContain("recurrence.anchorDay");
    });
  });

  it("stores an end set on an edit", async () => {
    const result = await updateTask(
      "p1",
      "t1",
      { recurrence: { frequency: "daily", interval: 2, endDate: "2026-12-31" } },
      "actor"
    );

    expect(result.ok).toBe(true);
    expect(written()?.recurrence).toEqual({
      anchorDay: null,
      frequency: "daily",
      interval: 2,
      endDate: new Date("2026-12-31"),
    });
  });

  it("still clears the recurrence when an edit sends none", async () => {
    const result = await updateTask("p1", "t1", { recurrence: null }, "actor");

    expect(result.ok).toBe(true);
    expect(written()?.recurrence).toBeNull();
  });
});

const OURS = "507f1f77bcf86cd799439011";

describe("a task's sprint has to belong to the task's project", () => {
  const OTHER = "507f1f77bcf86cd799439012";

  beforeEach(() => {
    sprintExists.mockClear();
    sprintExists.mockResolvedValue(null);
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

describe("createTask and a foreign sprint", () => {
  const OTHER = "507f1f77bcf86cd799439012";

  beforeEach(() => {
    sprintExists.mockClear();
    sprintExists.mockResolvedValue(null);
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

describe("createTask and updateTask do not echo an unbounded value into their refusals", () => {
  const board = { categories: [{ name: "bug" }], ...customBoard };
  const UNBOUNDED = "y".repeat(5000);
  const NOT_SLICED = "y".repeat(65);

  beforeEach(() => {
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
  });

  describe.each([
    ["category", "createTask", (v: unknown) => createTask("p1", "actor", { title: "x", category: v })],
    ["status", "createTask", (v: unknown) => createTask("p1", "actor", { title: "x", status: v })],
    ["category", "updateTask", (v: unknown) => updateTask("p1", "t1", { category: v }, "actor")],
    ["status", "updateTask", (v: unknown) => updateTask("p1", "t1", { status: v }, "actor")],
    ["priority", "createTask", (v: unknown) => createTask("p1", "actor", { title: "x", priority: v })],
    ["priority", "updateTask", (v: unknown) => updateTask("p1", "t1", { priority: v }, "actor")],
    ["dueDate", "createTask", (v: unknown) => createTask("p1", "actor", { title: "x", dueDate: v })],
    ["dueDate", "updateTask", (v: unknown) => updateTask("p1", "t1", { dueDate: v }, "actor")],
  ] as const)("%s, via %s", (_field, _writer, call) => {
    it("bounds an unbounded value in its refusal", async () => {
      const result = await call(UNBOUNDED);

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect((result as { error: string }).error).not.toContain(NOT_SLICED);
    });

    it("still names a short invalid value", async () => {
      const result = await call("not-real");

      expect(result).toMatchObject({ error: expect.stringContaining("not-real") });
    });
  });
});

describe("choosing a task's agent", () => {
  const AGENT = "69a52e3b399b27d3cbb2c5a5";
  const OTHER = "69a52e3b399b27d3cbb2c5b7";

  const COMPOSED = { implementation: [{ key: "write-the-change" }] };

  const ACTOR = "u-actor";
  const MATE = "u-colleague";

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
    findOne.mockReset();
    storedAgent(null);
    agentInTheCatalog({ _id: AGENT, scope: "global", name: "Default", composition: COMPOSED });
  });

  it("lets an ordinary caller choose one, with no capability to pass", async () => {
    const result = await updateTask("p1", "t1", { agent: AGENT }, "member");

    expect(result.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).agent).toBe(AGENT);
  });

  it("lets the same caller clear it again, storing null rather than an empty string", async () => {
    storedAgent(AGENT);

    const result = await updateTask("p1", "t1", { agent: "" }, "member");

    expect(result.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).agent).toBeNull();
  });

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

    it("accepts a project agent belonging to this one, on anybody's task", async () => {
      storedAgent(null, MATE);
      agentInTheCatalog({ _id: AGENT, scope: "project", project: "p1", composition: COMPOSED });

      expect((await updateTask("p1", "t1", { agent: AGENT }, ACTOR)).ok).toBe(true);
    });

    it("refuses another person's personal agent", async () => {
      agentInTheCatalog({ _id: AGENT, scope: "user", owner: OTHER, composition: COMPOSED });

      const result = await updateTask("p1", "t1", { agent: AGENT }, ACTOR);

      expect(result).toMatchObject({ ok: false, status: 400 });
    });

    it("accepts the caller's own personal agent, on the caller's own task", async () => {
      agentInTheCatalog({ _id: AGENT, scope: "user", owner: ACTOR, composition: COMPOSED });

      expect((await updateTask("p1", "t1", { agent: AGENT }, ACTOR)).ok).toBe(true);
    });

    it("refuses the caller's own personal agent on a colleague's task", async () => {
      storedAgent(null, MATE);
      agentInTheCatalog({ _id: AGENT, scope: "user", owner: ACTOR, composition: COMPOSED });

      const result = await updateTask("p1", "t1", { agent: AGENT }, ACTOR);

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });

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

    it("refuses the caller's own personal agent on an unassigned task", async () => {
      storedAgent(null, null);
      agentInTheCatalog({ _id: AGENT, scope: "user", owner: ACTOR, composition: COMPOSED });

      expect((await updateTask("p1", "t1", { agent: AGENT }, ACTOR)).ok).toBe(false);
    });

    it("accepts a global agent whoever is holding the task", async () => {
      storedAgent(null, MATE);

      expect((await updateTask("p1", "t1", { agent: AGENT }, ACTOR)).ok).toBe(true);
    });

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

      it("accepts taking the task on and picking my own agent in one write", async () => {
        storedAgent(null, MATE);
        userFindOne.mockResolvedValue({ _id: ACTOR, username: "me" });

        expect(
          (await updateTask("p1", "t1", { assignee: "me", agent: AGENT }, ACTOR)).ok
        ).toBe(true);
      });

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

      it("is refused for its emptiness, not for its scope", async () => {
        draft({ scope: "user", owner: ACTOR });

        const result = await updateTask("p1", "t1", { agent: AGENT }, ACTOR);

        expect((result as { error: string }).error).not.toMatch(/cannot run on this project/i);
        expect((result as { error: string }).error).toMatch(/no steps/i);
      });

      it("is refused when every bucket it has is empty", async () => {
        draft({ composition: { analysis: [], implementation: [], delivery: [] } });

        expect((await updateTask("p1", "t1", { agent: AGENT }, ACTOR)).ok).toBe(false);
      });

      it("accepts an agent whose composition still holds bare keys", async () => {
        draft({ composition: { implementation: ["write-the-change"] } });

        expect((await updateTask("p1", "t1", { agent: AGENT }, ACTOR)).ok).toBe(true);
      });
    });
  });
});

describe("a task records who assigned it", () => {
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
  });

  it("stamps the actor when the assignee changes", async () => {
    await updateTask("p1", "t1", { assignee: "kuba" }, "actor");

    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignedBy).toBe("actor");
  });

  it("stamps it when a task is unassigned, so the field never describes an older assignee", async () => {
    await updateTask("p1", "t1", { assignee: null }, "actor");

    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignedBy).toBe("actor");
  });

  it("leaves the assigner alone when the body re-sends the assignee it already has", async () => {
    userFindOne.mockResolvedValue({ _id: "u1", username: "rpo" });

    await updateTask("p1", "t1", { assignee: "rpo", title: "renamed" }, "somebody-else");

    expect(setStage(findOneAndUpdate.mock.calls[0][1])).not.toHaveProperty("assignedBy");
  });

  it("compares the resolved id, not the username the body carried", async () => {
    userFindOne.mockResolvedValue({ _id: "u1", username: "rpo" });

    await updateTask("p1", "t1", { assignee: "RPO" }, "somebody-else");

    expect(setStage(findOneAndUpdate.mock.calls[0][1])).not.toHaveProperty("assignedBy");
  });

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

  it("leaves a legacy task blank when a third writer merely echoes its assignee", async () => {
    legacyTaskAssignedTo("u1");

    await updateTask("p1", "t1", { assignee: "rpo", title: "renamed" }, "the-pm-agent");

    expect(setStage(findOneAndUpdate.mock.calls[0][1])).not.toHaveProperty("assignedBy");
  });

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

  it("ignores an assignedBy the caller supplied, rather than storing it", async () => {
    await updateTask("p1", "t1", { title: "renamed", assignedBy: "somebody-else" }, "actor");

    expect(setStage(findOneAndUpdate.mock.calls[0][1])).not.toHaveProperty("assignedBy");
  });
});

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

  afterEach(() => {
    userFindById.mockReset();
  });

  it("refuses the move, with a 400 rather than a silent success", async () => {
    canBeAssignedMock.mockResolvedValue(false);

    const result = await updateTask("p1", "t1", { assignee: "kuba" }, "actor");

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 400 });
  });

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

  it("never refuses an unassignment", async () => {
    canBeAssignedMock.mockResolvedValue(false);

    const result = await updateTask("p1", "t1", { assignee: null }, "actor");

    expect(result.ok).toBe(true);
  });

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

describe("an assignee username nobody holds", () => {
  const board = { categories: [{ name: "bug" }], ...customBoard };

  beforeEach(() => {
    vi.clearAllMocks();
    canBeAssignedMock.mockResolvedValue(true);
    findById.mockReturnValue({ lean: () => Promise.resolve(board) });
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
    findOneAndUpdate.mockReturnValue({
      populate: () => Promise.resolve({ _id: "t1", taskNumber: 1, title: "x", execution: {} }),
    });
    projectFindOneAndUpdate.mockResolvedValue({ _id: "p1", taskCounter: 12, key: "BP", ...board });
    taskCreate.mockResolvedValue({ _id: "new" });
    taskFindById.mockReturnValue({ populate: () => ({ lean: async () => ({ _id: "new" }) }) });
    userFindOne.mockResolvedValue(null);
  });

  const held = (username: string) => userFindOne.mockResolvedValue({ _id: "u2", username });

  it("is refused by updateTask, naming the name that resolved to nobody", async () => {
    const result = await updateTask("p1", "t1", { assignee: "rafa" }, "actor");

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(result).toMatchObject({ error: expect.stringContaining("rafa") });
  });

  it("leaves the assignee the task already had, rather than clearing it", async () => {
    await updateTask("p1", "t1", { assignee: "rafa" }, "actor");

    expect(findOneAndUpdate, "an unknown username still reached the write").not.toHaveBeenCalled();
  });

  it("does not borrow the no-access wording, which names a different repair", async () => {
    const missing = await updateTask("p1", "t1", { assignee: "rafa" }, "actor");

    held("kuba");
    canBeAssignedMock.mockResolvedValue(false);
    const barred = await updateTask("p1", "t1", { assignee: "kuba" }, "actor");

    expect(missing).toMatchObject({ error: expect.not.stringMatching(/no access to this board/i) });
    expect(barred).toMatchObject({ error: expect.stringMatching(/no access to this board/i) });
  });

  it("still assigns a username somebody holds", async () => {
    held("kuba");

    const result = await updateTask("p1", "t1", { assignee: "kuba" }, "actor");

    expect(result.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignee).toBe("u2");
  });

  it("still unassigns on an explicit null", async () => {
    const result = await updateTask("p1", "t1", { assignee: null }, "actor");

    expect(result.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignee).toBeNull();
  });

  it("reads an empty string as unassigning, not as a username to look up", async () => {
    const result = await updateTask("p1", "t1", { assignee: "" }, "actor");

    expect(result.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).assignee).toBeNull();
    expect(userFindOne, "an empty string was looked up as a username").not.toHaveBeenCalled();
  });

  it("is refused by createTask too, before a task number is spent on it", async () => {
    const result = await createTask("p1", "actor", { title: "Ordinary title", assignee: "rafa" });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(result).toMatchObject({ error: expect.stringContaining("rafa") });
    expect(taskCreate, "the task was created unassigned").not.toHaveBeenCalled();
    expect(projectFindOneAndUpdate, "a refused create still spent a task number").not.toHaveBeenCalled();
  });

  it("still creates one for a username somebody holds", async () => {
    held("kuba");

    const result = await createTask("p1", "actor", { title: "Ordinary title", assignee: "kuba" });

    expect(result.ok).toBe(true);
    expect(taskCreate.mock.calls[0][0].assignee).toBe("u2");
  });

  it("looks the name up normalised, so case and stray spaces are not a refusal", async () => {
    held("kuba");

    const result = await updateTask("p1", "t1", { assignee: "  KUBA " }, "actor");

    expect(result.ok).toBe(true);
    expect(userFindOne).toHaveBeenCalledWith({ username: "kuba" });
  });

  it("does not echo an unbounded username back into the refusal", async () => {
    const result = await updateTask("p1", "t1", { assignee: "x".repeat(5000) }, "actor");

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error.length).toBeLessThan(500);
  });

  describe.each([
    ["an object, which is what a populated assignee is", { _id: "u2", username: "kuba" }],
    ["a number", 7],
    ["an array", ["kuba"]],
  ])("an assignee given as %s", (_label, value) => {
    it("is refused by updateTask, rather than reaching the cast", async () => {
      held("kuba");

      const result = await updateTask("p1", "t1", { assignee: value }, "actor");

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("is refused by createTask in the same words, before a task number is spent", async () => {
      held("kuba");

      const result = await createTask("p1", "actor", { title: "Ordinary title", assignee: value });

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(projectFindOneAndUpdate).not.toHaveBeenCalled();
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

describe("a machine claims its owner's work", () => {
  const OWNER = "6a732075133f935b19154cd2";

  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(claimableBoard) });
  });

  async function claimFilterFor(ownerId: string | null) {
    findOneAndUpdate.mockClear();
    await claimNextTask("p1", "w1", "r1", ownerId);
    return findOneAndUpdate.mock.calls[0]?.[0];
  }

  it("asks only for tasks its owner assigned to themselves, on an instance with no PM", async () => {
    const matches = sift(await claimFilterFor(OWNER));

    expect((await claimFilterFor(OWNER)).assignee).toBe(OWNER);
    expect(matches(task({ assignee: OWNER, assignedBy: OWNER }))).toBe(true);
    expect(matches(task({ assignee: OWNER, assignedBy: "6a732075133f935b19154cf1" }))).toBe(false);
  });

  describe("and the PM's assignment is one of them", () => {
    const PM = "6a732075133f935b19154cf0";
    const THIRD = "6a732075133f935b19154cf1";

    beforeEach(() => {
      pmUserIdMock.mockResolvedValue(PM);
    });

    it("takes a task the PM assigned to its owner, on the owner's own instruction", async () => {
      const matches = sift(await claimFilterFor(OWNER));

      expect(matches(task({ assignee: OWNER, assignedBy: PM, pmAssignedFor: OWNER }))).toBe(true);
    });

    it("refuses a task the PM assigned on somebody else's instruction", async () => {
      const matches = sift(await claimFilterFor(OWNER));

      expect(matches(task({ assignee: OWNER, assignedBy: PM, pmAssignedFor: THIRD }))).toBe(false);
    });

    it("refuses a task the PM assigned with nobody driving the turn", async () => {
      const matches = sift(await claimFilterFor(OWNER));

      expect(matches(task({ assignee: OWNER, assignedBy: PM, pmAssignedFor: null }))).toBe(false);
    });

    it("still takes a task the owner assigned to themselves, with no PM record at all", async () => {
      const matches = sift(await claimFilterFor(OWNER));

      expect(matches(task({ assignee: OWNER, assignedBy: OWNER }))).toBe(true);
    });

    it("refuses a task another person assigned to its owner", async () => {
      const matches = sift(await claimFilterFor(OWNER));

      expect(matches(task({ assignee: OWNER, assignedBy: THIRD }))).toBe(false);
    });

    it("refuses a task the PM assigned to somebody else", async () => {
      const matches = sift(await claimFilterFor(OWNER));

      expect(matches(task({ assignee: THIRD, assignedBy: PM }))).toBe(false);
    });
  });

  it("offers no alternative that skips the assigner check", async () => {
    const filter = await claimFilterFor(OWNER);

    expect(filter.$or).toEqual([
      { "execution.attempts": { $exists: false } },
      { "execution.attempts": { $lt: 3 } },
    ]);
  });

  it("never asks for an unassigned task, which belongs to nobody", async () => {
    const filter = await claimFilterFor(OWNER);

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

describe("what a member can and cannot arm by choosing an agent", () => {
  const ME = "6a732075133f935b19154cd2";
  const SOMEBODY_ELSE = "6a732075133f935b19154cd3";

  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(claimableBoard) });
    find.mockReset();
    find.mockReturnValue({ lean: () => Promise.resolve([]) });
  });

  async function whatMyMachineAsksFor() {
    await claimNextTask("p1", "w1", "r1", ME);
    return findOneAndUpdate.mock.calls[0][0];
  }

  it("cannot arm my machine with a task assigned to somebody else", async () => {
    const filter = await whatMyMachineAsksFor();

    expect(matches(filter, task({ assignee: SOMEBODY_ELSE, assignedBy: SOMEBODY_ELSE }))).toBe(false);
    expect(matches(filter, task({ assignee: SOMEBODY_ELSE, assignedBy: ME }))).toBe(false);
    expect(matches(filter, task({ assignee: ME, assignedBy: ME }))).toBe(true);
  });

  it("cannot arm my machine with a task somebody else assigned to me", async () => {
    const filter = await whatMyMachineAsksFor();

    expect(matches(filter, task({ assignee: ME, assignedBy: SOMEBODY_ELSE }))).toBe(false);
    expect(matches(filter, task({ assignee: ME, assignedBy: ME }))).toBe(true);
  });

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

describe("whose machine choosing an agent can reach", () => {
  const ME = "6a732075133f935b19154cd2";
  const MATE = "6a732075133f935b19154cd3";
  const AGENT_ID = "69a52e3b399b27d3cbb2c5a5";
  const COMPOSED = { implementation: [{ key: "write-the-change" }] };

  beforeEach(() => {
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(claimableBoard) });
    find.mockReset();
    find.mockReturnValue({ lean: () => Promise.resolve([]) });
    findOne.mockReset();
    findOneAndUpdate.mockReset();
  });

  async function machineOf(owner: string) {
    findOneAndUpdate.mockReset();
    await claimNextTask("p1", "w1", "r1", owner);
    return findOneAndUpdate.mock.calls[0][0];
  }

  interface Shape {
    agent: Record<string, unknown>;
    assignee: string | null;
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

describe("what a change of hands does to the agent already on the task", () => {
  const THIRD = "6a732075133f935b19154ce1";
  const HOLDER = "6a732075133f935b19154ce2";
  const INCOMING = "6a732075133f935b19154ce3";
  const AGENT_ID = "69a52e3b399b27d3cbb2c5a5";
  const PICKED = "69a52e3b399b27d3cbb2c5b8";
  const COMPOSED = { implementation: [{ key: "write-the-change" }] };

  beforeEach(() => {
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(claimableBoard) });
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

  async function machineOf(owner: string) {
    findOneAndUpdate.mockReset();
    await claimNextTask("p1", "w1", "r1", owner);
    return findOneAndUpdate.mock.calls[0][0];
  }

  interface Held {
    agent: Record<string, unknown> | null;
    holder?: string | null;
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

  it("drops a personal agent when the task goes to somebody else", async () => {
    taskHolding({ agent: { scope: "user", owner: HOLDER } });

    const { result, written, document } = await write({ assignee: "incoming" }, HOLDER, INCOMING);

    expect(result.ok).toBe(true);
    expect(written.agent).toBeNull();
    expect(matches(await machineOf(INCOMING), document)).toBe(false);
  });

  it("keeps a personal agent that belongs to the person receiving the task", async () => {
    taskHolding({ agent: { scope: "user", owner: INCOMING } });

    const { result, written } = await write({ assignee: "incoming" }, THIRD, INCOMING);

    expect(result.ok).toBe(true);
    expect(written).not.toHaveProperty("agent");
  });

  it("and that person's machine takes the task once they have taken it on themselves", async () => {
    taskHolding({ agent: { scope: "user", owner: INCOMING } });

    const { written, document } = await write({ assignee: "incoming" }, INCOMING, INCOMING);

    expect(written).not.toHaveProperty("agent");
    expect(document.agent).toBe(AGENT_ID);
    expect(matches(await machineOf(INCOMING), document)).toBe(true);
    expect(matches(await machineOf(HOLDER), document)).toBe(false);
  });

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

  it("drops a personal agent when the task is unassigned altogether", async () => {
    taskHolding({ agent: { scope: "user", owner: HOLDER } });

    const { written } = await write({ assignee: null }, HOLDER);

    expect(written.agent).toBeNull();
  });

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

  it("leaves the agent alone on an edit that does not move the assignee", async () => {
    taskHolding({ agent: { scope: "user", owner: THIRD } });

    const { written } = await write({ title: "renamed" }, HOLDER);

    expect(written).not.toHaveProperty("agent");
    expect(agentFindById).not.toHaveBeenCalled();
  });

  it("leaves it alone when the body re-sends the assignee the task already has", async () => {
    taskHolding({ agent: { scope: "user", owner: HOLDER } });

    const { written } = await write({ assignee: "whoever" }, HOLDER, HOLDER);

    expect(written).not.toHaveProperty("agent");
    expect(agentFindById).not.toHaveBeenCalled();
  });

  it("drops a personal agent in the write that releases the task from a run", async () => {
    taskHolding({
      agent: { scope: "user", owner: HOLDER },
      execution: { runId: "r9", workerId: "w9" },
    });

    const { written } = await write({ status: "doing" }, THIRD, undefined, true);

    expect(written.assignee).toBeNull();
    expect(written.agent).toBeNull();
  });

  it("drops a stranger's agent when a legacy task's assigner is recorded for the first time", async () => {
    taskHolding({ agent: { scope: "user", owner: THIRD }, legacy: true });

    const { written, document } = await write({ assignee: "whoever" }, HOLDER, HOLDER);

    expect(written.assignedBy).toBe(HOLDER);
    expect(written.agent).toBeNull();
    expect(matches(await machineOf(HOLDER), document)).toBe(false);
  });

  it("leaves the repairing person's own agent alone, and their machine then takes it", async () => {
    taskHolding({ agent: { scope: "user", owner: HOLDER }, legacy: true });

    const { written, document } = await write({ assignee: "whoever" }, HOLDER, HOLDER);

    expect(written.assignedBy).toBe(HOLDER);
    expect(written).not.toHaveProperty("agent");
    expect(matches(await machineOf(HOLDER), document)).toBe(true);
  });

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

describe("personalAgentAlienTo", () => {
  beforeEach(() => agentFindById.mockReset());

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

  it("is alien on an unassigned task", async () => {
    agentInTheCatalog({ scope: "user", owner: "u1" });
    expect(await personalAgentAlienTo("a1", null)).toBe(true);
  });

  it("is never alien for a project-scoped agent", async () => {
    agentInTheCatalog({ scope: "project", owner: null });
    expect(await personalAgentAlienTo("a1", "somebody-else")).toBe(false);
  });

  it("is not alien when the agent cannot be found — missing id or dangling reference alike", async () => {
    agentInTheCatalog(null);
    expect(await personalAgentAlienTo("gone", "u1")).toBe(false);
    expect(await personalAgentAlienTo(null, "u1")).toBe(false);
  });
});

describe("what a task is populated with before it is answered", () => {
  const path = (name: string) => taskPopulateFields.find((f) => f.path === name);

  it("names the assigner, not just the assignee", () => {
    expect(path("assignedBy")).toEqual({ path: "assignedBy", select: "username fullName" });
  });

  it("asks the assigner for a display name and a username", () => {
    expect(path("assignedBy")?.select).toBe(path("assignee")?.select);
  });

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

  it("announces it to the board's own subscribers, with the mail it would send", async () => {
    await createTask("p1", "actor", { title: "Session cookie survives a change" });

    const [feed] = notifyBoardFeedMock.mock.calls.at(-1) ?? [];
    expect(feed.projectId).toBe("p1");
    expect(feed.title).toBe("New task BP-7 in Board Planner");
    expect(feed.body).toBe("Session cookie survives a change");
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

  it("tells the project's shared chat channel", async () => {
    await createTask("p1", "actor", { title: "Session cookie survives a change" });

    expect(dispatchNotifications).toHaveBeenCalledWith("p1", "task_created", {
      project: { key: "BP", name: "Board Planner" },
      task: { taskKey: "BP-7", title: "Session cookie survives a change", status: "ready" },
    });
  });
});

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
    findByIdAndUpdate.mockReturnValue(Promise.resolve(null));
  });

  it("tells the new assignee, with the column's label and the assigner's name", async () => {
    await updateTask("p1", "t1", { assignee: "kuba" }, "actor");

    const [notification] = createNotificationsMock.mock.calls.at(-1) ?? [];
    expect(notification.type).toBe("task_assigned");
    expect(notification.recipientIds).toEqual(["u2"]);
    expect(notification.title).toBe("TP-4 assigned to you");
    expect(notification.email.taskPills).toEqual([
      { label: "Doing", tone: "progress" },
      { label: "High", tone: "neutral" },
    ]);
    expect(notification.email.taskMeta).toBe("Test Project · assigned by actor");
    expect(notification.email.projectRef).toBe("TP");
    expect(notification.email.taskNumber).toBe(4);
  });

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

function codePoints(...codes: number[]): string {
  return codes.map((code) => String.fromCodePoint(code)).join("");
}

describe("a title neither writer will store", () => {
  const WHO = "u-actor";

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
    ["a zero-width space", codePoints(0x200b)],
    ["a word joiner", codePoints(0x2060)],
    ["a Hangul filler", codePoints(0x3164)],
    ["invisible characters padded with spaces", ` ${codePoints(0x200b, 0xfeff)} `],
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
      expect(projectFindOneAndUpdate, "a refused create still spent a task number").not.toHaveBeenCalled();
    });
  });

  it("stores an ordinary title, trimmed the way the schema would", async () => {
    const updated = await updateTask("p1", "t1", { title: "  Renamed by hand  " }, WHO);
    expect(updated.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1])).toMatchObject({ title: "Renamed by hand" });

    const created = await createTask("p1", WHO, { title: "  Brand new  " });
    expect(created.ok).toBe(true);
    expect(taskCreate.mock.calls[0][0]).toMatchObject({ title: "Brand new" });
  });

  it("stores a title of exactly the length cap", async () => {
    const atTheCap = "a".repeat(TASK_TITLE_MAX_LENGTH);
    const updated = await updateTask("p1", "t1", { title: atTheCap }, WHO);

    expect(updated.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1])).toMatchObject({ title: atTheCap });
  });
});

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

  const A_ROW_ID = "507f1f77bcf86cd799439011";

  it("stores ordinary criteria, trimmed, keeping the row's own id and done flag", async () => {
    const result = await updateTask(
      "p1",
      "t1",
      { checklist: [{ _id: A_ROW_ID, text: "  Ships with a test  ", done: true }] } as never,
      WHO
    );

    expect(result.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).checklist).toEqual([
      { _id: A_ROW_ID, text: "Ships with a test", done: true },
    ]);
  });

  const REFUSED_ROWS: [string, Record<string, unknown>][] = [
    ["a done flag that is an object", { text: "a", done: {} }],
    ["a done flag that is a list", { text: "a", done: ["x"] }],
    ["a done flag that is not a word the cast knows", { text: "a", done: "maybe" }],
    ["an id that is not one", { text: "a", _id: "nope" }],
    ["an id that is an object", { text: "a", _id: {} }],
  ];

  describe.each(REFUSED_ROWS)("%s", (_label, row) => {
    it("is refused with a 400, and nothing is written", async () => {
      const result = await updateTask("p1", "t1", { checklist: [row] } as never, WHO);

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(findOneAndUpdate, "the update reached the model anyway").not.toHaveBeenCalled();
    });
  });

  it("takes the flags the cast takes, and drops the keys the row invented", async () => {
    const result = await updateTask(
      "p1",
      "t1",
      {
        checklist: [
          { text: "a", done: "yes", mischief: "dropped", createdBy: "someone else" },
          { text: "b", done: 1 },
          { text: "c", _id: "" },
          { text: "d", done: null },
        ],
      } as never,
      WHO
    );

    expect(result.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls[0][1]).checklist).toEqual([
      { text: "a", done: "yes" },
      { text: "b", done: 1 },
      { text: "c" },
      { text: "d" },
    ]);
  });

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
    ["a priority the schema will not store", { priority: "critical" }],
    ["a priority cleared to an empty string", { priority: "" }],
    ["a due date that is not a date", { dueDate: "next thursday" }],
    ["a due date that is not even a string", { dueDate: { when: "soon" } }],
    ["a recurrence with no frequency", { recurrence: { interval: 2 } }],
    ["a recurrence the schema does not know", { recurrence: { frequency: "hourly", interval: 1 } }],
    ["a recurrence interval below the minimum", { recurrence: { frequency: "weekly", interval: 0 } }],
    ["a recurrence interval that is not a number", { recurrence: { frequency: "weekly", interval: "often" } }],
    ["an order the cast will not take", { order: "abc" }],
    ["an order given as an array", { order: [] }],
    ["a description that is not text", { description: {} }],
    ["a description given as an array", { description: ["a"] }],
    ["a criterion whose done flag is an object", { checklist: [{ text: "a", done: {} }] }],
    ["a criterion whose id is not one", { checklist: [{ text: "a", _id: "nope" }] }],
  ];

  describe.each(REFUSED)("%s", (_label, over) => {
    it("is refused with a 400, before the counter moves", async () => {
      const result = await createTask("p1", "actor", { title: "Ordinary title", ...over });

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(taskCreate).not.toHaveBeenCalled();
      expect(projectFindOneAndUpdate, "a refused create still spent a task number").not.toHaveBeenCalled();
    });
  });

  it("refuses an assignee with no access to the board before the counter moves", async () => {
    canBeAssignedMock.mockResolvedValue(false);

    const result = await createTask("p1", "actor", { title: "Ordinary title", assignee: "kuba" });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(projectFindOneAndUpdate, "a refused create still spent a task number").not.toHaveBeenCalled();
  });

  it("refuses a category that is not text even when the board has no categories", async () => {
    findById.mockReturnValue({ lean: () => Promise.resolve({ ...board, categories: [] }) });

    const refused = await createTask("p1", "actor", { title: "Ordinary title", category: {} });
    expect(refused).toMatchObject({ ok: false, status: 400 });
    expect(projectFindOneAndUpdate, "a refused create still spent a task number").not.toHaveBeenCalled();

    const created = await createTask("p1", "actor", { title: "Ordinary title", category: "chore" });
    expect(created.ok).toBe(true);
  });

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

  it("takes what the cast takes, and writes what the cast would write", async () => {
    const result = await createTask("p1", "actor", {
      title: "Ordinary title",
      order: "2",
      description: "plain text",
    });

    expect(result.ok).toBe(true);
    expect(taskCreate.mock.calls[0][0]).toMatchObject({ order: "2", description: "plain text" });
  });

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
    ["an order the cast will not take", { order: "abc" }],
    ["an order given as an array", { order: [] }],
    ["a description that is not text", { description: {} }],
    ["a description given as an array", { description: ["a"] }],
    ["a criterion whose done flag is an object", { checklist: [{ text: "a", done: {} }] }],
    ["a criterion whose id is not one", { checklist: [{ text: "a", _id: "nope" }] }],
  ];

  describe.each(REFUSED)("%s", (_label, body) => {
    it("is refused with a 400, and nothing is written", async () => {
      const result = await updateTask("p1", "t1", body, WHO);

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(findOneAndUpdate, "the update reached the model anyway").not.toHaveBeenCalled();
    });
  });

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

    const reordered = await updateTask("p1", "t1", { order: "7", description: "text" }, WHO);
    expect(reordered.ok).toBe(true);
    expect(setStage(findOneAndUpdate.mock.calls.at(-1)![1])).toMatchObject({
      order: "7",
      description: "text",
    });
  });
});

describe("heldRunRefusal", () => {
  const held = { execution: { runId: "r1", workerId: "w1", phase: "agent" }, taskNumber: 42 };

  it("says nothing about a task no run holds", async () => {
    expect(await heldRunRefusal({ execution: {}, taskNumber: 42 }, "TP")).toBeNull();
  });

  it("names the task, the worker and the phase", async () => {
    workerFindById.mockReturnValue({ lean: () => Promise.resolve({ name: "mac-mini" }) });

    const refusal = await heldRunRefusal(held, "TP");

    expect(refusal?.status).toBe(409);
    expect(refusal?.error).toContain("TP-42");
    expect(refusal?.error).toContain("mac-mini");
    expect(refusal?.error).toContain("phase agent");
    expect(refusal?.runConflict).toMatchObject({ workerId: "w1", workerName: "mac-mini" });
  });

  it("names the act the caller was attempting, not always a move", async () => {
    workerFindById.mockReturnValue({ lean: () => Promise.resolve({ name: "mac-mini" }) });

    expect((await heldRunRefusal(held, "TP", "delete"))?.error).toContain("delete it anyway");
    expect((await heldRunRefusal(held, "TP"))?.error).toContain("move it anyway");
  });

  it("falls back to a bare number when the project key is missing", async () => {
    workerFindById.mockReturnValue({ lean: () => Promise.resolve({ name: "mac-mini" }) });

    expect((await heldRunRefusal(held, undefined))?.error).toContain("42");
  });

  it("still refuses when the worker has no name to give", async () => {
    workerFindById.mockReturnValue({ lean: () => Promise.resolve(null) });

    const refusal = await heldRunRefusal(held, "TP");

    expect(refusal?.status).toBe(409);
    expect(refusal?.error).toContain("w1");
  });
});
