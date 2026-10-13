import { describe, it, expect, vi, beforeEach } from "vitest";

const { projectFindById, logFind, taskFind } = vi.hoisted(() => ({
  projectFindById: vi.fn(),
  logFind: vi.fn(),
  taskFind: vi.fn(),
}));

vi.mock("@/models/project", () => ({ Project: { findOne: projectFindById } }));
vi.mock("@/models/activityLog", () => ({ ActivityLog: { find: logFind } }));
vi.mock("@/models/task", () => ({ Task: { find: taskFind } }));

const { statusHistory, projectStatusHistories, statusChangeFilter, STATUS_CHANGE_SORT } = await import("./status-history");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { DEFAULT_ORGANISATION_ID } = await import("@/lib/organisation-field");

type Role = import("./status-history").HistoryRole;

const ROLES: Record<string, Role> = {
  planned: "backlog",
  todo: "approved",
  doing: "active",
  review: "review",
  shipped: "done",
  done: "done",
};
const roleOf = (column: string): Role => ROLES[column] ?? "unknown";

const day = (n: number) => new Date(Date.UTC(2026, 9, n));
let seq = 0;
const move = (from: string, to: string, at: Date) => ({
  _id: String(++seq).padStart(24, "0"),
  oldValue: from,
  newValue: to,
  createdAt: at,
});
const CREATED = day(1);

describe("statusHistory — the definitions", () => {
  it("a straight path: started on the first entry to an active column, finished on the entry to done", () => {
    const history = statusHistory(
      [move("todo", "doing", day(2)), move("doing", "review", day(3)), move("review", "done", day(5))],
      roleOf,
      { createdAt: CREATED, status: "done" }
    );

    expect(history).toEqual({
      kind: "recorded",
      startedAt: day(2),
      finishedAt: day(5),
      reopened: 0,
      startInferred: false,
      endedIn: "done",
      unknownColumns: [],
      gap: false,
    });
  });

  it("a reopened task has no finish until it is done again, and keeps its first start", () => {
    const rows = [
      move("todo", "doing", day(2)),
      move("doing", "done", day(3)),
      move("done", "doing", day(4)),
    ];

    expect(statusHistory(rows, roleOf, { createdAt: CREATED, status: "doing" })).toMatchObject({
      startedAt: day(2),
      finishedAt: null,
      reopened: 1,
      endedIn: "active",
    });

    const doneAgain = [...rows, move("doing", "done", day(9))];
    expect(statusHistory(doneAgain, roleOf, { createdAt: CREATED, status: "done" })).toMatchObject({
      startedAt: day(2),
      finishedAt: day(9),
      reopened: 1,
    });
  });

  it("a skipped column leaves the task with a finish and no start, rather than inventing one", () => {
    const history = statusHistory([move("todo", "review", day(2)), move("review", "done", day(4))], roleOf, {
      createdAt: CREATED,
      status: "done",
    });

    expect(history).toMatchObject({ kind: "recorded", startedAt: null, finishedAt: day(4) });
  });

  it("a deleted column keeps the task and says so, and does not undo a finish", () => {
    const history = statusHistory(
      [move("todo", "doing", day(2)), move("doing", "done", day(3)), move("done", "retired-column", day(6))],
      roleOf,
      { createdAt: CREATED, status: "retired-column" }
    );

    expect(history).toMatchObject({
      kind: "recorded",
      startedAt: day(2),
      finishedAt: day(3),
      reopened: 0,
      endedIn: "unknown",
      unknownColumns: ["retired-column"],
    });
  });

  it("a column that is gone is not read as the task being active or done", () => {
    const history = statusHistory([move("todo", "ghost", day(2))], roleOf, { createdAt: CREATED, status: "ghost" });

    expect(history).toMatchObject({ startedAt: null, finishedAt: null, endedIn: "unknown" });
  });

  it("moving between two done columns is not a reopening and does not move the finish", () => {
    const history = statusHistory([move("doing", "done", day(3)), move("done", "shipped", day(8))], roleOf, {
      createdAt: CREATED,
      status: "shipped",
    });

    expect(history).toMatchObject({ finishedAt: day(3), reopened: 0, endedIn: "done" });
  });

  it("a task whose first row leaves an active column started when it was created, and says that was inferred", () => {
    const history = statusHistory([move("doing", "done", day(4))], roleOf, { createdAt: CREATED, status: "done" });

    expect(history).toMatchObject({ startedAt: CREATED, startInferred: true, finishedAt: day(4), gap: false });
  });

  it("a start that a row recorded is not inferred, even when an earlier column was assumed", () => {
    const history = statusHistory([move("todo", "doing", day(2))], roleOf, { createdAt: CREATED, status: "doing" });

    expect(history).toMatchObject({ startedAt: day(2), startInferred: false });
  });

  // A claim moves a task into an active column without writing a row, so the next row leaves a
  // column the previous one never entered. The time of that entry is unknown, and a later entry
  // into an active column must not be taken for the first.
  it("a transition nobody wrote is a gap: its column is entered at an unknown time", () => {
    const history = statusHistory(
      [move("planned", "todo", day(2)), move("doing", "review", day(5)), move("review", "doing", day(6))],
      roleOf,
      { createdAt: CREATED, status: "doing" }
    );

    expect(history).toMatchObject({ kind: "recorded", gap: true, startedAt: null, startInferred: false });
  });

  it("a move into done nobody wrote is a gap, and the later return to done is the finish", () => {
    const history = statusHistory(
      [move("todo", "doing", day(2)), move("done", "review", day(6)), move("review", "done", day(8))],
      roleOf,
      { createdAt: CREATED, status: "done" }
    );

    expect(history).toMatchObject({ gap: true, startedAt: day(2), finishedAt: day(8), reopened: 1 });
  });

  it("a chain that holds together is not a gap", () => {
    const history = statusHistory(
      [move("todo", "doing", day(2)), move("doing", "review", day(3)), move("review", "done", day(4))],
      roleOf,
      { createdAt: CREATED, status: "done" }
    );

    expect(history).toMatchObject({ gap: false });
  });

  it("reads rows in time order, not in id order or the order it is given", () => {
    const later = move("doing", "done", day(5));
    const earlier = move("todo", "doing", day(2));

    const history = statusHistory([later, earlier], roleOf, { createdAt: CREATED, status: "done" });

    expect(history).toMatchObject({ startedAt: day(2), finishedAt: day(5), reopened: 0 });
  });

  it("breaks a tie in time on the row id", () => {
    const tieA = move("doing", "done", day(5));
    const tieB = move("done", "doing", day(5));

    const history = statusHistory([tieB, tieA], roleOf, { createdAt: CREATED, status: "doing" });

    expect(history).toMatchObject({ finishedAt: null, reopened: 1, endedIn: "active" });
  });

  // "No history" is not "zero days": a task nothing was written about says nothing
  it("a task with no rows is reported as no history", () => {
    expect(statusHistory([], roleOf, { createdAt: CREATED, status: "done" })).toEqual({ kind: "no-history" });
  });

  it("flags a gap when the last recorded column is not where the task is", () => {
    const history = statusHistory([move("todo", "doing", day(2))], roleOf, { createdAt: CREATED, status: "done" });

    expect(history).toMatchObject({ kind: "recorded", gap: true, finishedAt: null });
  });
});

describe("projectStatusHistories", () => {
  const db = scopedToDefaultOrganisation();
  const sortOf = vi.fn();
  const leanOf = (rows: unknown[]) => ({
    sort: (order: unknown) => {
      sortOf(order);
      return { lean: () => Promise.resolve(rows) };
    },
    lean: () => Promise.resolve(rows),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    projectFindById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          columns: [
            { id: "todo", label: "To do", role: "approved", order: 0 },
            { id: "doing", label: "Doing", role: "active", order: 1 },
            { id: "done", label: "Done", role: "done", order: 2 },
          ],
        }),
    });
  });

  it("asks for the project's status rows through the indexed filter and the indexed order", async () => {
    logFind.mockReturnValue(leanOf([]));
    taskFind.mockReturnValue(leanOf([]));

    await projectStatusHistories(db, "p1");

    expect(logFind).toHaveBeenCalledWith(
      { ...statusChangeFilter("p1"), organisation: DEFAULT_ORGANISATION_ID },
      expect.any(String)
    );
    expect(statusChangeFilter("p1")).toEqual({ project: "p1", action: "status_changed" });
    expect(STATUS_CHANGE_SORT).toEqual({ createdAt: 1 });
    expect(sortOf).toHaveBeenCalledWith(STATUS_CHANGE_SORT);
  });

  it("includes a task with no rows, as no history, beside one that has them", async () => {
    logFind.mockReturnValue(
      leanOf([
        { _id: "r1", task: "t1", oldValue: "todo", newValue: "doing", createdAt: day(2) },
        { _id: "r2", task: "t1", oldValue: "doing", newValue: "done", createdAt: day(4) },
      ])
    );
    taskFind.mockReturnValue(
      leanOf([
        { _id: "t1", taskNumber: 1, status: "done", createdAt: CREATED },
        { _id: "t2", taskNumber: 2, status: "done", createdAt: CREATED },
      ])
    );

    const result = await projectStatusHistories(db, "p1");

    expect(result.map((r) => [r.taskNumber, r.history.kind])).toEqual([
      [1, "recorded"],
      [2, "no-history"],
    ]);
    expect(result[0].history).toMatchObject({ startedAt: day(2), finishedAt: day(4) });
  });

  it("resolves a column to its role through the project's current columns", async () => {
    logFind.mockReturnValue(
      leanOf([{ _id: "r1", task: "t1", oldValue: "todo", newValue: "gone", createdAt: day(2) }])
    );
    taskFind.mockReturnValue(leanOf([{ _id: "t1", taskNumber: 1, status: "gone", createdAt: CREATED }]));

    const [only] = await projectStatusHistories(db, "p1");

    expect(only.history).toMatchObject({ endedIn: "unknown", unknownColumns: ["gone"] });
  });

  it("answers nothing for a project that does not exist", async () => {
    projectFindById.mockReturnValue({ lean: () => Promise.resolve(null) });

    expect(await projectStatusHistories(db, "nope")).toEqual([]);
    expect(logFind).not.toHaveBeenCalled();
  });
});
