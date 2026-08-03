import { describe, it, expect } from "vitest";
import { sortTasks } from "./task-sort";
import { ApiCustomField, ApiSprint, ApiTask, SORT_OPTIONS, BOARD_SORT_FIELDS, LIST_SORT_FIELDS } from "@/types";

function task(over: Partial<ApiTask> & { taskNumber: number }): ApiTask {
  return {
    _id: `t${over.taskNumber}`,
    title: `Task ${over.taskNumber}`,
    status: "todo",
    priority: "medium",
    difficulty: "M",
    category: "bug",
    labels: [],
    order: 0,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...over,
  } as ApiTask;
}

const keys = (tasks: ApiTask[]) => tasks.map((t) => t.taskNumber);

describe("sortTasks", () => {
  it("orders by key both ways", () => {
    const tasks = [task({ taskNumber: 3 }), task({ taskNumber: 1 }), task({ taskNumber: 2 })];
    expect(keys(sortTasks(tasks, "key", "asc"))).toEqual([1, 2, 3]);
    expect(keys(sortTasks(tasks, "key", "desc"))).toEqual([3, 2, 1]);
  });

  it("leaves the input array alone", () => {
    const tasks = [task({ taskNumber: 3 }), task({ taskNumber: 1 })];
    sortTasks(tasks, "key", "asc");
    expect(keys(tasks)).toEqual([3, 1]);
  });

  it("puts urgent before low", () => {
    const tasks = [
      task({ taskNumber: 1, priority: "low" }),
      task({ taskNumber: 2, priority: "urgent" }),
      task({ taskNumber: 3, priority: "high" }),
    ];
    expect(keys(sortTasks(tasks, "priority", "asc"))).toEqual([2, 3, 1]);
  });

  it("sizes S before XL", () => {
    const tasks = [
      task({ taskNumber: 1, difficulty: "XL" }),
      task({ taskNumber: 2, difficulty: "S" }),
      task({ taskNumber: 3, difficulty: "L" }),
    ];
    expect(keys(sortTasks(tasks, "difficulty", "asc"))).toEqual([2, 3, 1]);
  });

  // Ascending due date means "soonest first", so an undated task belongs last
  it("sorts undated tasks last by due date", () => {
    const tasks = [
      task({ taskNumber: 1 }),
      task({ taskNumber: 2, dueDate: "2026-09-01T00:00:00Z" }),
      task({ taskNumber: 3, dueDate: "2026-08-05T00:00:00Z" }),
    ];
    expect(keys(sortTasks(tasks, "dueDate", "asc"))).toEqual([3, 2, 1]);
  });

  it("orders status by the board's own column order, not alphabetically", () => {
    const statusOrder = new Map([
      ["todo", 0],
      ["in_progress", 1],
      ["done", 2],
    ]);
    const tasks = [
      task({ taskNumber: 1, status: "done" }),
      task({ taskNumber: 2, status: "todo" }),
      task({ taskNumber: 3, status: "in_progress" }),
    ];
    expect(keys(sortTasks(tasks, "status", "asc", { statusOrder }))).toEqual([2, 3, 1]);
  });

  it("orders sprints by start date and puts unassigned last", () => {
    const sprintById = new Map<string, ApiSprint>([
      ["s1", { _id: "s1", startDate: "2026-08-01" } as ApiSprint],
      ["s2", { _id: "s2", startDate: "2026-07-01" } as ApiSprint],
    ]);
    const tasks = [
      task({ taskNumber: 1 }),
      task({ taskNumber: 2, sprint: "s1" }),
      task({ taskNumber: 3, sprint: "s2" }),
    ];
    expect(keys(sortTasks(tasks, "sprint", "asc", { sprintById }))).toEqual([3, 2, 1]);
  });

  it("keeps manual order and falls back to newest first inside a tie", () => {
    const tasks = [
      task({ taskNumber: 1, order: 2 }),
      task({ taskNumber: 2, order: 1 }),
      task({ taskNumber: 3, order: 1, createdAt: "2026-08-02T00:00:00Z" }),
    ];
    expect(keys(sortTasks(tasks, "manual", "asc"))).toEqual([3, 2, 1]);
  });

  // Without a tiebreak, equal values let the order jitter between renders
  it("breaks ties by key so the order is stable", () => {
    const tasks = [
      task({ taskNumber: 3, priority: "high" }),
      task({ taskNumber: 1, priority: "high" }),
      task({ taskNumber: 2, priority: "high" }),
    ];
    expect(keys(sortTasks(tasks, "priority", "asc"))).toEqual([1, 2, 3]);
    expect(keys(sortTasks(tasks, "priority", "desc"))).toEqual([1, 2, 3]);
  });
});

describe("sort vocabularies", () => {
  it("offers every field an option", () => {
    expect(LIST_SORT_FIELDS).toEqual(SORT_OPTIONS.map((o) => o.value));
  });

  // The board groups by status and shows none of these columns
  it("keeps status, assignee, sprint and component off the board", () => {
    for (const field of ["status", "assignee", "sprint", "component"]) {
      expect(BOARD_SORT_FIELDS).not.toContain(field);
    }
  });

  it("keeps the board's fields a subset of the list's", () => {
    for (const field of BOARD_SORT_FIELDS) {
      expect(LIST_SORT_FIELDS).toContain(field);
    }
  });
});

describe("sorting by a project field", () => {
  const numberField = {
    _id: "f-num",
    name: "Points",
    fieldType: "number",
    options: [],
  } as unknown as ApiCustomField;

  const dropdownField = {
    _id: "f-size",
    name: "Size",
    fieldType: "dropdown",
    // Deliberately not alphabetical: the project's order is what matters
    options: [
      { id: "s", value: "Small", color: "#000", order: 0 },
      { id: "m", value: "Medium", color: "#000", order: 1 },
      { id: "l", value: "Large", color: "#000", order: 2 },
    ],
  } as unknown as ApiCustomField;

  function withField(taskNumber: number, values: Record<string, unknown>): ApiTask {
    return { ...task({ taskNumber }), customFieldValues: values } as ApiTask;
  }

  const ctx = {
    fieldById: new Map([
      [numberField._id, numberField],
      [dropdownField._id, dropdownField],
    ]),
  };

  it("compares numbers numerically, not as text", () => {
    const tasks = [
      withField(1, { "f-num": 9 }),
      withField(2, { "f-num": 10 }),
      withField(3, { "f-num": 100 }),
    ];
    expect(sortTasks(tasks, "f-num", "asc", ctx).map((t) => t.taskNumber)).toEqual([1, 2, 3]);
  });

  it("compares a dropdown by option order, not alphabetically", () => {
    const tasks = [
      withField(1, { "f-size": "l" }),
      withField(2, { "f-size": "s" }),
      withField(3, { "f-size": "m" }),
    ];
    // Alphabetically this would be Large, Medium, Small
    expect(sortTasks(tasks, "f-size", "asc", ctx).map((t) => t.taskNumber)).toEqual([2, 3, 1]);
  });

  // A blank is not "smallest" — it is absent, and belongs at the bottom either way
  it("keeps empty values last in both directions", () => {
    const tasks = [
      withField(1, {}),
      withField(2, { "f-num": 5 }),
      withField(3, { "f-num": 1 }),
    ];
    expect(sortTasks(tasks, "f-num", "asc", ctx).map((t) => t.taskNumber)).toEqual([3, 2, 1]);
    expect(sortTasks(tasks, "f-num", "desc", ctx).map((t) => t.taskNumber)).toEqual([2, 3, 1]);
  });

  it("treats an empty list on a multiselect as empty", () => {
    const tasks = [withField(1, { "f-size": [] }), withField(2, { "f-size": "s" })];
    expect(sortTasks(tasks, "f-size", "asc", ctx).map((t) => t.taskNumber)).toEqual([2, 1]);
  });

  // Built-in behaviour must not shift: undated has always flipped with direction
  it("leaves dueDate alone, where undated still flips", () => {
    const tasks = [
      { ...task({ taskNumber: 1 }), dueDate: undefined },
      { ...task({ taskNumber: 2 }), dueDate: "2026-01-01" },
    ] as ApiTask[];
    expect(sortTasks(tasks, "dueDate", "asc").map((t) => t.taskNumber)).toEqual([2, 1]);
    expect(sortTasks(tasks, "dueDate", "desc").map((t) => t.taskNumber)).toEqual([1, 2]);
  });
});
