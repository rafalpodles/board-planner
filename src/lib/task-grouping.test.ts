import { describe, it, expect } from "vitest";
import { ApiCustomField, ApiProjectCategory, ApiTask, DEFAULT_PROJECT_COLUMNS } from "@/types";
import {
  NONE_GROUP,
  UNFILED_GROUP,
  flattenGroups,
  groupByOptions,
  groupTasks,
  sanitizeGroupBy,
  valueKey,
} from "./task-grouping";
import { migratePersistedFilters } from "./board-filters-state";

function task(over: Partial<ApiTask> & { taskNumber: number }): ApiTask {
  return {
    _id: `t${over.taskNumber}`,
    title: `Task ${over.taskNumber}`,
    status: "todo",
    priority: "medium",
    category: "bug",
    assignee: null,
    order: 0,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...over,
  } as ApiTask;
}

const person = (username: string, fullName = username) =>
  ({ _id: `u-${username}`, username, fullName }) as ApiTask["assignee"];

const numbers = (tasks: ApiTask[]) => tasks.map((t) => t.taskNumber);
const keys = (groups: { key: string }[]) => groups.map((g) => g.key);

const sizeField = {
  _id: "f-size",
  name: "Size",
  fieldType: "dropdown",
  options: [
    { id: "l", value: "Large", color: "#f00", order: 1 },
    { id: "s", value: "Small", color: "#0f0", order: 0 },
  ],
  archived: false,
  filterable: true,
} as unknown as ApiCustomField;

const labelsField = {
  _id: "f-labels",
  name: "Labels",
  fieldType: "multiselect",
  options: [{ id: "a", value: "A", order: 0 }],
  archived: false,
} as unknown as ApiCustomField;

describe("groupTasks", () => {
  it("returns no groups when nothing is grouped on", () => {
    expect(groupTasks([task({ taskNumber: 1 })], "")).toEqual([]);
  });

  it("orders status groups by the board's columns and keeps the sorted order inside each", () => {
    const tasks = [
      task({ taskNumber: 1, status: "done" }),
      task({ taskNumber: 2, status: "todo" }),
      task({ taskNumber: 3, status: "done" }),
      task({ taskNumber: 4, status: "in_progress" }),
    ];
    const groups = groupTasks(tasks, "status", { columns: DEFAULT_PROJECT_COLUMNS });
    expect(keys(groups)).toEqual(["todo", "in_progress", "done"].map(valueKey));
    expect(numbers(groups[2].tasks)).toEqual([1, 3]);
  });

  it("puts a task on a deleted column in an unfiled group, last, instead of dropping it", () => {
    const tasks = [
      task({ taskNumber: 1, status: "gone" as ApiTask["status"] }),
      task({ taskNumber: 2, status: "todo" }),
    ];
    const groups = groupTasks(tasks, "status", { columns: DEFAULT_PROJECT_COLUMNS });
    expect(keys(groups)).toEqual([valueKey("todo"), UNFILED_GROUP]);
    expect(groups[1].label).toBe("No column");
    expect(numbers(groups[1].tasks)).toEqual([1]);
  });

  it("orders priority from urgent to low and reads a missing priority as medium", () => {
    const tasks = [
      task({ taskNumber: 1, priority: "low" }),
      task({ taskNumber: 2, priority: undefined as unknown as ApiTask["priority"] }),
      task({ taskNumber: 3, priority: "urgent" }),
    ];
    const groups = groupTasks(tasks, "priority");
    expect(keys(groups)).toEqual(["urgent", "medium", "low"].map(valueKey));
    expect(numbers(groups[1].tasks)).toEqual([2]);
  });

  it("sorts people by the name shown, not by username, and falls back to the username without one", () => {
    const tasks = [
      task({ taskNumber: 1, assignee: person("aaa", "Zoe Zimmer") }),
      task({ taskNumber: 2, assignee: person("zzz", "Amy Adams") }),
      task({ taskNumber: 3, assignee: person("mid", "") }),
    ];
    expect(groupTasks(tasks, "assignee").map((g) => g.label)).toEqual(["Amy Adams", "mid", "Zoe Zimmer"]);
  });

  it("puts a task with no category in a none group after the project's own and the ones it lost", () => {
    const categories = [{ _id: "1", name: "bug", color: "#222" }] as ApiProjectCategory[];
    const tasks = [
      task({ taskNumber: 1, category: "" }),
      task({ taskNumber: 2, category: "retired" }),
      task({ taskNumber: 3, category: "bug" }),
    ];
    const groups = groupTasks(tasks, "category", { categories });
    expect(groups.map((g) => g.label)).toEqual(["bug", "retired", "No category"]);
    expect(groups[2].key).toBe(NONE_GROUP);
  });

  it("groups by assignee alphabetically by name with the unassigned group last", () => {
    const tasks = [
      task({ taskNumber: 1 }),
      task({ taskNumber: 2, assignee: person("zed", "Zed Zimmer") }),
      task({ taskNumber: 3, assignee: person("amy", "Amy Adams") }),
      task({ taskNumber: 4, assignee: person("zed", "Zed Zimmer") }),
    ];
    const groups = groupTasks(tasks, "assignee");
    expect(groups.map((g) => g.label)).toEqual(["Amy Adams", "Zed Zimmer", "Unassigned"]);
    expect(groups[2].key).toBe(NONE_GROUP);
    expect(numbers(groups[1].tasks)).toEqual([2, 4]);
  });

  it("orders categories as the project does and puts one it no longer has after them", () => {
    const categories = [
      { _id: "1", name: "feature", color: "#111" },
      { _id: "2", name: "bug", color: "#222" },
    ] as ApiProjectCategory[];
    const tasks = [
      task({ taskNumber: 1, category: "retired" }),
      task({ taskNumber: 2, category: "bug" }),
      task({ taskNumber: 3, category: "feature" }),
    ];
    const groups = groupTasks(tasks, "category", { categories });
    expect(keys(groups)).toEqual(["feature", "bug", "retired"].map(valueKey));
    expect(groups[0].color).toBe("#111");
  });

  it("groups by a dropdown field in option order, with a none group for no value or a stale option", () => {
    const tasks = [
      task({ taskNumber: 1, customFieldValues: { "f-size": "l" } }),
      task({ taskNumber: 2 }),
      task({ taskNumber: 3, customFieldValues: { "f-size": "s" } }),
      task({ taskNumber: 4, customFieldValues: { "f-size": "deleted-option" } }),
    ];
    const groups = groupTasks(tasks, "field:f-size", { customFields: [sizeField] });
    expect(groups.map((g) => g.label)).toEqual(["Small", "Large", "No Size"]);
    expect(groups.slice(0, 2).map((g) => g.color)).toEqual(["#0f0", "#f00"]);
    expect(numbers(groups[2].tasks)).toEqual([2, 4]);
  });

  it("returns nothing for a field that is archived or not a dropdown", () => {
    const tasks = [task({ taskNumber: 1 })];
    expect(
      groupTasks(tasks, "field:f-size", { customFields: [{ ...sizeField, archived: true }] })
    ).toEqual([]);
    expect(groupTasks(tasks, "field:f-labels", { customFields: [labelsField] })).toEqual([]);
  });

  it("cannot confuse a category named like a sentinel with the none group", () => {
    const tasks = [
      task({ taskNumber: 1, category: NONE_GROUP }),
      task({ taskNumber: 2, category: "" }),
    ];
    const groups = groupTasks(tasks, "category");
    expect(groups).toHaveLength(2);
    expect(new Set(keys(groups)).size).toBe(2);
  });

  it("does not return empty groups", () => {
    const groups = groupTasks([task({ taskNumber: 1, status: "done" })], "status", {
      columns: DEFAULT_PROJECT_COLUMNS,
    });
    expect(keys(groups)).toEqual([valueKey("done")]);
  });

  it("flattens to the order the groups are drawn in, skipping collapsed ones", () => {
    const tasks = [
      task({ taskNumber: 1, status: "done" }),
      task({ taskNumber: 2, status: "todo" }),
      task({ taskNumber: 3, status: "done" }),
    ];
    const groups = groupTasks(tasks, "status", { columns: DEFAULT_PROJECT_COLUMNS });
    expect(numbers(flattenGroups(groups))).toEqual([2, 1, 3]);
    expect(numbers(flattenGroups(groups, new Set([valueKey("todo")])))).toEqual([1, 3]);
  });
});

describe("group by choices", () => {
  it("offers the built-ins and only live dropdown fields", () => {
    const options = groupByOptions([sizeField, labelsField, { ...sizeField, _id: "gone", archived: true }]);
    expect(options.map((o) => o.value)).toEqual([
      "",
      "assignee",
      "priority",
      "category",
      "status",
      "field:f-size",
    ]);
  });

  it("drops a stored choice that names an archived or unknown field, or is not a choice at all", () => {
    expect(sanitizeGroupBy("field:f-size", [sizeField])).toBe("field:f-size");
    expect(sanitizeGroupBy("field:f-size", [{ ...sizeField, archived: true }])).toBe("");
    expect(sanitizeGroupBy("field:nope", [sizeField])).toBe("");
    expect(sanitizeGroupBy("sprint", [sizeField])).toBe("");
    expect(sanitizeGroupBy(42, [sizeField])).toBe("");
  });

  it("is restored with the stored filters and dropped when its field has gone", () => {
    expect(migratePersistedFilters({ groupBy: "priority" }, "me", []).groupBy).toBe("priority");
    expect(migratePersistedFilters({ groupBy: "field:f-size" }, "me", [sizeField]).groupBy).toBe(
      "field:f-size"
    );
    expect(migratePersistedFilters({ groupBy: "field:f-size" }, "me", []).groupBy).toBe("");
    expect(migratePersistedFilters(null, "me", []).groupBy).toBe("");
  });
});
