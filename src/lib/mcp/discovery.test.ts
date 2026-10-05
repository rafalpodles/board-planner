import { describe, it, expect } from "vitest";
import { noticeLines, runLines, searchLines, statsSummary } from "./discovery";

describe("searchLines", () => {
  it("names each hit by key, with the board it is on", () => {
    expect(
      searchLines([
        { taskNumber: 12, title: "Login", status: "todo", assignee: { username: "rafal", fullName: "R" }, project: { key: "MY-APP", name: "My app" } },
        { taskNumber: 3, title: "Old", project: null },
      ])
    ).toEqual([
      { key: "MY-APP-12", title: "Login", status: "todo", priority: "medium", assignee: "rafal", project: "My app" },
      { key: "#3", title: "Old", status: undefined, priority: "medium", assignee: null, project: null },
    ]);
  });
});

describe("statsSummary", () => {
  it("keeps the page's headline numbers and leaves out its per-field table", () => {
    const summary = statsSummary({
      total: 10,
      done: 4,
      statusBreakdown: { todo: 6 },
      categoryBreakdown: {},
      assigneeBreakdown: {},
      difficultyBreakdown: {},
      velocity: [{ week: "10/1", count: 2 }],
      createdOverTime: [],
      customFieldUsage: [{ huge: true }],
    });

    expect(Object.keys(summary).sort()).toEqual(
      ["assigneeBreakdown", "categoryBreakdown", "createdOverTime", "difficultyBreakdown", "done", "statusBreakdown", "total", "velocity"]
    );
    expect(summary.done).toBe(4);
  });
});

describe("runLines", () => {
  it("says how each run ended and what refused it, clipping a long detail", () => {
    const [ok, refused] = runLines([
      { taskKey: "BP-1", agentName: "Default", outcome: "delivered", detail: "x".repeat(2_000), minutes: 12, costUsd: 1.5, finishedAt: "2026-10-05T10:00:00.000Z" },
      { taskKey: "BP-2", outcome: "refused", refusedBy: "review-gate" },
    ]);

    expect(ok).toMatchObject({ taskKey: "BP-1", agent: "Default", outcome: "delivered", refusedBy: null, minutes: 12, costUsd: 1.5 });
    expect(ok.detail).toBe(`${"x".repeat(300)}…`);
    expect(refused).toMatchObject({ refusedBy: "review-gate", agent: "", minutes: 0, costUsd: 0, finishedAt: null });
  });
});

describe("noticeLines", () => {
  const row = (n: number, read: boolean) => ({
    _id: `n${n}`,
    type: "task_assigned",
    title: `T${n}`,
    read,
    createdAt: `2026-10-05T10:0${n}:00.000Z`,
    actor: { username: "rafal" },
    task: { taskNumber: n },
    project: { key: "BP", name: "BP" },
  });

  it("names the task by key and the person by username, and counts what is unread", () => {
    const answer = noticeLines([row(2, false), row(1, true)], 30);

    expect(answer.notifications[0]).toMatchObject({ id: "n2", task: "BP-2", by: "rafal", read: false, project: "BP" });
    expect(answer).toMatchObject({ returned: 2, unreadOnPage: 1 });
  });

  it("hands back a cursor only for a full page: a short one is the end", () => {
    expect(noticeLines([row(2, false), row(1, true)], 2).nextBefore).toBe("2026-10-05T10:01:00.000Z");
    expect(noticeLines([row(2, false), row(1, true)], 3).nextBefore).toBeNull();
    expect(noticeLines([], 3).nextBefore).toBeNull();
  });

  it("has no task to name for a notice about a board", () => {
    expect(noticeLines([{ _id: "n1", title: "Access", task: null, project: { key: "BP" } }], 5).notifications[0].task).toBeNull();
  });
});
