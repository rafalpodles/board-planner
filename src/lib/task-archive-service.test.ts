import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";

const taskFindOne = vi.fn();
const taskFindOneAndUpdate = vi.fn();
const projectFindOne = vi.fn();
const workerFindOne = vi.fn();
const activityCreate = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { findOne: taskFindOne, findOneAndUpdate: taskFindOneAndUpdate } }));
vi.mock("@/models/project", () => ({ Project: { findOne: projectFindOne } }));
vi.mock("@/models/worker", () => ({ Worker: { findOne: workerFindOne } }));
vi.mock("@/models/activityLog", () => ({ ActivityLog: { create: activityCreate } }));

const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { archiveTask, unarchiveTask } = await import("./task-archive-service");

const db = scopedToDefaultOrganisation();
const TASK = "507f1f77bcf86cd799439011";
const ACTOR = "507f1f77bcf86cd799439022";
const HELD = { taskNumber: 7, archivedAt: null, execution: { runId: "run-1", workerId: "w1", phase: "agent" } };
const FREE = { taskNumber: 7, archivedAt: null, execution: { runId: "" } };

const reads = (doc: unknown) => ({ select: () => ({ lean: async () => doc }), populate: async () => doc });
const writes = (doc: unknown) => ({ populate: async () => doc });

beforeEach(() => {
  vi.clearAllMocks();
  projectFindOne.mockReturnValue({ lean: async () => ({ key: "BP" }) });
  workerFindOne.mockReturnValue({ lean: async () => ({ name: "mac" }) });
  activityCreate.mockResolvedValue({});
});

describe("archiveTask", () => {
  it("stamps who and when, and writes an archived row to History", async () => {
    taskFindOne.mockReturnValue(reads(FREE));
    taskFindOneAndUpdate.mockReturnValue(writes({ ...FREE, archivedAt: new Date() }));

    const result = await archiveTask(db, "p1", TASK, ACTOR);

    expect(result.ok).toBe(true);
    const [filter, update] = taskFindOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ _id: TASK, project: "p1", archivedAt: null, organisation: DEFAULT_ORGANISATION_ID });
    expect(update.$set).toMatchObject({ archivedBy: ACTOR, archivedAt: expect.any(Date) });
    expect(update).not.toHaveProperty("$unset");
    expect(activityCreate).toHaveBeenCalledWith(expect.objectContaining({ task: TASK, user: ACTOR, action: "archived" }));
  });

  it("refuses a task a run holds with the 409 the other writers give, naming the worker and the verb", async () => {
    taskFindOne.mockReturnValue(reads(HELD));

    const result = await archiveTask(db, "p1", TASK, ACTOR);

    expect(result).toMatchObject({ ok: false, status: 409, runConflict: { workerId: "w1", workerName: "mac" } });
    expect(result.ok === false && result.error).toMatch(/mac.*archive it anyway/);
    expect(taskFindOneAndUpdate).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("takes the task from the run when a person forces, so nothing keeps writing into an archived task", async () => {
    taskFindOne.mockReturnValue(reads(HELD));
    taskFindOneAndUpdate.mockReturnValue(writes({ ...HELD, archivedAt: new Date() }));

    const result = await archiveTask(db, "p1", TASK, ACTOR, true);

    expect(result.ok).toBe(true);
    const [filter, update] = taskFindOneAndUpdate.mock.calls[0];
    expect(filter).not.toHaveProperty("execution.runId");
    expect(update.$unset).toMatchObject({ "execution.runId": "" });
  });

  it("gives back the assignee a run invented, and the lease clock, so nothing sweeps the archived task", async () => {
    taskFindOne.mockReturnValue(reads(HELD));
    taskFindOneAndUpdate.mockReturnValue(writes({ ...HELD, archivedAt: new Date() }));

    await archiveTask(db, "p1", TASK, ACTOR, true);

    const [, update] = taskFindOneAndUpdate.mock.calls[0];
    expect(update.$set).toMatchObject({ assignee: null, assignedBy: null });
    expect(update.$unset).toMatchObject({ "execution.runId": "", "execution.startedAt": "" });
  });

  it("keeps the assignee a person made when the run only borrowed the task", async () => {
    taskFindOne.mockReturnValue(reads({ ...HELD, execution: { ...HELD.execution, assignedByRun: false } }));
    taskFindOneAndUpdate.mockReturnValue(writes({ ...HELD, archivedAt: new Date() }));

    await archiveTask(db, "p1", TASK, ACTOR, true);

    const [, update] = taskFindOneAndUpdate.mock.calls[0];
    expect(update.$set).not.toHaveProperty("assignee");
    expect(update.$unset).toMatchObject({ "execution.runId": "" });
  });

  it("unsets the run on a forced write even when the read saw the task free, since a claim can land between", async () => {
    taskFindOne.mockReturnValue(reads(FREE));
    taskFindOneAndUpdate.mockReturnValue(writes({ ...FREE, archivedAt: new Date() }));

    await archiveTask(db, "p1", TASK, ACTOR, true);

    const [, update] = taskFindOneAndUpdate.mock.calls[0];
    expect(update.$unset).toMatchObject({ "execution.runId": "" });
  });

  it("tries again once when the run was released between the read and the write, rather than calling the task missing", async () => {
    taskFindOne.mockReturnValueOnce(reads(HELD)).mockReturnValueOnce(reads(FREE));
    taskFindOneAndUpdate.mockReturnValueOnce(writes(null)).mockReturnValueOnce(writes({ ...FREE, archivedAt: new Date() }));

    const result = await archiveTask(db, "p1", TASK, ACTOR, true);
    expect(result.ok).toBe(true);
    expect(taskFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(activityCreate).toHaveBeenCalledTimes(1);
  });

  it("answers 409 rather than 404 when the write misses twice on a task that exists", async () => {
    taskFindOne.mockReturnValue(reads(FREE));
    taskFindOneAndUpdate.mockReturnValue(writes(null));

    const result = await archiveTask(db, "p1", TASK, ACTOR);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false && result.error).toMatch(/try again/);
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("loses a race with a claim to the same 409 rather than archiving over the new run", async () => {
    taskFindOne.mockReturnValueOnce(reads(FREE)).mockReturnValueOnce(reads(HELD));
    taskFindOneAndUpdate.mockReturnValue(writes(null));

    const result = await archiveTask(db, "p1", TASK, ACTOR);

    expect(taskFindOneAndUpdate.mock.calls[0][0]).toMatchObject({ "execution.runId": { $in: ["", null] } });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("answers an archived task as it is, without a second row in History", async () => {
    taskFindOne.mockReturnValue(reads({ ...FREE, archivedAt: new Date() }));

    const result = await archiveTask(db, "p1", TASK, ACTOR);

    expect(result.ok).toBe(true);
    expect(taskFindOneAndUpdate).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("answers 404 for a task that is not on the board", async () => {
    taskFindOne.mockReturnValue(reads(null));

    expect(await archiveTask(db, "p1", TASK, ACTOR)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("unarchiveTask", () => {
  it("clears the stamp and writes an unarchived row", async () => {
    taskFindOneAndUpdate.mockReturnValue(writes({ ...FREE }));

    const result = await unarchiveTask(db, "p1", TASK, ACTOR);

    expect(result.ok).toBe(true);
    const [filter, update] = taskFindOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ _id: TASK, project: "p1", archivedAt: { $ne: null } });
    expect(update.$set).toEqual({ archivedAt: null, archivedBy: null });
    expect(activityCreate).toHaveBeenCalledWith(expect.objectContaining({ task: TASK, user: ACTOR, action: "unarchived" }));
  });

  it("answers a task that was never archived as it is, without a row", async () => {
    taskFindOneAndUpdate.mockReturnValue(writes(null));
    taskFindOne.mockReturnValue(reads(FREE));

    const result = await unarchiveTask(db, "p1", TASK, ACTOR);

    expect(result.ok).toBe(true);
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("answers 404 for a task that is not on the board", async () => {
    taskFindOneAndUpdate.mockReturnValue(writes(null));
    taskFindOne.mockReturnValue(reads(null));

    expect(await unarchiveTask(db, "p1", TASK, ACTOR)).toMatchObject({ ok: false, status: 404 });
  });
});
