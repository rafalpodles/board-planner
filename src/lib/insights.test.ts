import { describe, it, expect } from "vitest";
import { computeInsights, percentile, weeksOrRefusal, weeksSince, WEEK_MS, FINISHED_SAMPLE_CAP } from "./insights";
import { statusHistory, type HistoryRole, type TaskStatusHistory } from "./status-history";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 29);
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY);

const ROLES: Record<string, HistoryRole> = { todo: "approved", doing: "active", review: "review", done: "done" };
const roleOf = (column: string): HistoryRole => ROLES[column] ?? "unknown";

let seq = 0;
function task(
  createdDaysAgo: number,
  moves: [string, string, number][],
  extra: Partial<TaskStatusHistory> = {}
): TaskStatusHistory {
  const n = ++seq;
  const rows = moves.map(([from, to, daysAgo]) => ({
    _id: String(++seq).padStart(24, "0"),
    oldValue: from,
    newValue: to,
    createdAt: at(daysAgo),
  }));
  const status = extra.status ?? (moves.length ? moves[moves.length - 1][1] : "todo");
  const createdAt = at(createdDaysAgo);
  return {
    taskId: `t${n}`,
    taskNumber: n,
    title: `Task ${n}`,
    category: "bug",
    sprint: null,
    role: roleOf(status),
    archived: false,
    createdAt,
    estimate: null,
    ...extra,
    status,
    history: statusHistory(rows, roleOf, { createdAt, status }),
  };
}

describe("percentile", () => {
  it("interpolates between closest ranks", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 85)).toBe(44);
    expect(percentile([7], 85)).toBe(7);
  });
});

describe("computeInsights — figures a hand computation gives", () => {
  // Lead: 10, 6, 4 days. Cycle: 8, 3, 1 day.
  //   lead sorted 4, 6, 10 → median 6, p85 = 6 + 0.7 * 4 = 8.8
  //   cycle sorted 1, 3, 8 → median 3, p85 = 3 + 0.7 * 5 = 6.5
  const straight = () =>
    task(12, [
      ["todo", "doing", 10],
      ["doing", "done", 2],
    ]);
  // Done, reopened and done again: the last finish counts, with the first start
  const reopened = () =>
    task(7, [
      ["todo", "doing", 4],
      ["doing", "done", 3.5],
      ["done", "doing", 3],
      ["doing", "done", 1],
    ]);
  // Passed through a column the project has since deleted: the column has no role, the times hold
  const throughDeletedColumn = () =>
    task(5, [
      ["todo", "doing", 2],
      ["doing", "qa-gone", 1.5],
      ["qa-gone", "done", 1],
    ]);

  it("lead and cycle time as median and 85th percentile, with a reopened task and a deleted column", () => {
    const insights = computeInsights([straight(), reopened(), throughDeletedColumn()], { now: NOW, weeks: 4 });

    expect(insights.summary).toEqual({
      throughput: 3,
      leadTime: { count: 3, medianMs: 6 * DAY, p85Ms: Math.round(8.8 * DAY) },
      cycleTime: { count: 3, medianMs: 3 * DAY, p85Ms: Math.round(6.5 * DAY) },
    });
    expect(insights.empty).toBe(false);
  });

  it("throughput by week of the finish, not of any later edit", () => {
    const insights = computeInsights([straight(), reopened(), throughDeletedColumn()], { now: NOW, weeks: 2 });

    expect(insights.weekly.map((w) => w.throughput)).toEqual([0, 3]);
    expect(insights.weekly[0].weekStart).toBe(new Date(NOW - 2 * WEEK_MS).toISOString());
  });

  it("a finish before the window is outside it, and so is not a task still finishing", () => {
    const old = task(60, [
      ["todo", "doing", 50],
      ["doing", "done", 40],
    ]);

    const insights = computeInsights([old], { now: NOW, weeks: 4 });

    expect(insights.summary.throughput).toBe(0);
    expect(insights.agingWip.tasks).toEqual([]);
  });

  it("a task that was finished and is now back in progress is work in progress, not throughput", () => {
    const back = task(20, [
      ["todo", "doing", 15],
      ["doing", "done", 10],
      ["done", "doing", 3],
    ]);

    const insights = computeInsights([back, straight()], { now: NOW, weeks: 4 });

    expect(insights.summary.throughput).toBe(1);
    expect(insights.agingWip.tasks.map((t) => t.taskNumber)).toEqual([back.taskNumber]);
    expect(insights.agingWip.tasks[0].ageMs).toBe(15 * DAY);
  });

  it("leaves a task with a gap out of every figure and counts it", () => {
    const holed = task(10, [
      ["todo", "doing", 8],
      ["review", "done", 2],
    ]);

    const insights = computeInsights([holed, straight()], { now: NOW, weeks: 4 });

    expect(insights.summary.throughput).toBe(1);
    expect(insights.excluded.gap).toBe(1);
  });

  it("an inferred start counts in lead time and not in cycle time", () => {
    const bornActive = task(6, [["doing", "done", 2]]);

    const insights = computeInsights([bornActive], { now: NOW, weeks: 4 });

    expect(insights.summary.leadTime).toEqual({ count: 1, medianMs: 4 * DAY, p85Ms: 4 * DAY });
    expect(insights.summary.cycleTime).toBeNull();
    expect(insights.excluded.startInferred).toBe(1);
  });

  it("a task with no rows is counted apart and is not a zero-day task", () => {
    const silent = task(3, [], { status: "done", role: "done" });

    const insights = computeInsights([silent], { now: NOW, weeks: 4 });

    expect(insights.excluded.noHistory).toBe(1);
    expect(insights.summary.leadTime).toBeNull();
  });

  it("an archived task that finished still counts, and an archived one in progress is not WIP", () => {
    const shippedThenArchived = task(12, [["todo", "doing", 10], ["doing", "done", 2]], { archived: true });
    const abandoned = task(12, [["todo", "doing", 10]], { archived: true });

    const insights = computeInsights([shippedThenArchived, abandoned], { now: NOW, weeks: 4 });

    expect(insights.summary.throughput).toBe(1);
    expect(insights.agingWip.tasks).toEqual([]);
  });
});

describe("computeInsights — aging WIP", () => {
  it("says what share of finished cycle times a task in progress is already older than", () => {
    const finished = [1, 2, 3, 4, 10].map((cycle) =>
      task(cycle + 2, [
        ["todo", "doing", cycle + 1],
        ["doing", "done", 1],
      ])
    );
    const stuck = task(9, [["todo", "doing", 5]]);
    const fresh = task(1, [["todo", "doing", 0.5]]);

    const { agingWip } = computeInsights([...finished, stuck, fresh], { now: NOW, weeks: 4 });

    // cycles 1, 2, 3, 4, 10 → p85 = 4 + 0.4 * 6 = 6.4 days
    expect(agingWip.referenceP85Ms).toBe(Math.round(6.4 * DAY));
    expect(agingWip.tasks.map((t) => [t.taskNumber, t.olderThanPercent])).toEqual([
      [stuck.taskNumber, 80],
      [fresh.taskNumber, 0],
    ]);
  });

  it("has no reference and no share when nothing has finished", () => {
    const { agingWip } = computeInsights([task(9, [["todo", "doing", 5]])], { now: NOW, weeks: 4 });

    expect(agingWip.referenceP85Ms).toBeNull();
    expect(agingWip.tasks[0].olderThanPercent).toBeNull();
  });
});

describe("computeInsights — the empty state", () => {
  it("a project with no finished tasks answers empty, with nulls and zeros and no NaN", () => {
    const insights = computeInsights([task(3, [["todo", "doing", 1]])], { now: NOW, weeks: 3 });

    expect(insights.empty).toBe(true);
    expect(insights.summary).toEqual({ throughput: 0, leadTime: null, cycleTime: null });
    expect(insights.weekly).toHaveLength(3);
    expect(insights.byCategory).toEqual({});
    expect(JSON.stringify(insights)).not.toContain("NaN");
  });
});

describe("computeInsights — breakdowns", () => {
  it("by category", () => {
    const bug = task(5, [["todo", "doing", 4], ["doing", "done", 1]], { category: "bug" });
    const story = task(5, [["todo", "doing", 3], ["doing", "done", 1]], { category: "user-story" });

    const { byCategory } = computeInsights([bug, story], { now: NOW, weeks: 2 });

    expect(Object.keys(byCategory).sort()).toEqual(["bug", "user-story"]);
    expect(byCategory["user-story"].cycleTime?.medianMs).toBe(2 * DAY);
  });

  it("by estimate only when the project designates one, with unestimated tasks under none", () => {
    const three = task(5, [["todo", "doing", 4], ["doing", "done", 1]], { estimate: 3 });
    const none = task(5, [["todo", "doing", 4], ["doing", "done", 1]]);

    const withField = computeInsights([three, none], {
      now: NOW,
      weeks: 2,
      estimateField: { id: "f1", name: "Points" },
    });
    const without = computeInsights([three, none], { now: NOW, weeks: 2 });

    expect(withField.byEstimate?.field).toEqual({ id: "f1", name: "Points" });
    expect(Object.keys(withField.byEstimate?.values ?? {}).sort()).toEqual(["3", "none"]);
    expect(without).not.toHaveProperty("byEstimate");
  });
});

describe("computeInsights — the cap", () => {
  it("keeps the most recently finished tasks and says it truncated", () => {
    const many = Array.from({ length: FINISHED_SAMPLE_CAP + 1 }, (_, i) =>
      task(20, [
        ["todo", "doing", 15],
        ["doing", "done", 10 - i / (FINISHED_SAMPLE_CAP + 10)],
      ])
    );

    const insights = computeInsights(many, { now: NOW, weeks: 4 });

    expect(insights.sample).toEqual({ finished: FINISHED_SAMPLE_CAP, cap: FINISHED_SAMPLE_CAP, truncated: true });
    expect(insights.summary.throughput).toBe(FINISHED_SAMPLE_CAP);
  });
});

describe("weeks", () => {
  it("defaults, accepts 1–52 and refuses anything else", () => {
    expect(weeksOrRefusal(null)).toEqual({ weeks: 12 });
    expect(weeksOrRefusal("52")).toEqual({ weeks: 52 });
    for (const bad of ["0", "53", "2.5", "x", "-1"]) expect(weeksOrRefusal(bad)).toHaveProperty("error");
  });

  it("a sprint's window covers it from its start, within the bounds", () => {
    expect(weeksSince(new Date(NOW - 10 * DAY), NOW)).toBe(2);
    expect(weeksSince(new Date(NOW + DAY), NOW)).toBe(1);
    expect(weeksSince(new Date(NOW - 400 * DAY), NOW)).toBe(52);
  });
});
