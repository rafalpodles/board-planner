import { describe, it, expect } from "vitest";
import {
  defaultHidden,
  hideableColumns,
  listColumns,
  ListColumnId,
  isColumnVisible,
  sanitizeHidden,
  toggleColumn,
  visibleCount,
} from "./list-columns";
import { SORT_OPTIONS } from "@/types";

describe("column definitions", () => {
  // A row with no title is not a row, and the key is how you open it
  it("keeps key and title unhideable", () => {
    expect(listColumns().filter((c) => c.fixed).map((c) => c.id)).toEqual(["key", "title"]);
    expect(hideableColumns().map((c) => c.id)).not.toContain("title");
  });

  // Twelve columns at once squeezed the title out; these are the ones that earn
  // their width least
  it("starts with the noisiest columns off", () => {
    expect(defaultHidden()).toEqual(["category", "dueDate", "updatedAt"]);
    expect(visibleCount(defaultHidden())).toBe(listColumns().length - 3);
  });

  it("starts every project field off too", () => {
    const fields = [
      { _id: "f1", name: "Component", showInList: true, order: 1 },
      { _id: "f2", name: "Difficulty", showInList: true, order: 2 },
    ] as unknown as Parameters<typeof defaultHidden>[0];
    expect(defaultHidden(fields)).toContain("f1");
    expect(defaultHidden(fields)).toContain("f2");
    expect(visibleCount(defaultHidden(fields), fields)).toBe(listColumns().length - 3);
  });

  // Column ids double as sort fields, so a typo would silently break sorting
  it("names every column after a real sort field", () => {
    const fields = new Set(SORT_OPTIONS.map((o) => o.value));
    for (const column of listColumns()) expect(fields).toContain(column.id);
  });
});

describe("isColumnVisible", () => {
  it("hides what is listed", () => {
    expect(isColumnVisible("status", ["status"])).toBe(false);
    expect(isColumnVisible("status", [])).toBe(true);
  });

  it("refuses to hide a fixed column even when asked", () => {
    expect(isColumnVisible("title", ["title" as ListColumnId])).toBe(true);
    expect(isColumnVisible("key", ["key" as ListColumnId])).toBe(true);
  });
});

describe("toggleColumn", () => {
  it("round-trips", () => {
    const once = toggleColumn([], "assignee");
    expect(once).toEqual(["assignee"]);
    expect(toggleColumn(once, "assignee")).toEqual([]);
  });

  it("leaves fixed columns alone", () => {
    expect(toggleColumn([], "title")).toEqual([]);
  });

  it("does not mutate its input", () => {
    const hidden: ListColumnId[] = ["status"];
    toggleColumn(hidden, "priority");
    expect(hidden).toEqual(["status"]);
  });
});

// A stored blob outlives the code that wrote it
describe("sanitizeHidden", () => {
  it("drops unknown ids", () => {
    expect(sanitizeHidden(["status", "nonsense", 7])).toEqual(["status"]);
  });

  it("drops fixed ids, so a stale blob cannot hide the title", () => {
    expect(sanitizeHidden(["title", "key", "sprint"])).toEqual(["sprint"]);
  });

  it("dedupes", () => {
    expect(sanitizeHidden(["status", "status"])).toEqual(["status"]);
  });

  it("falls back to the default for anything that is not an array", () => {
    expect(sanitizeHidden(null)).toEqual(defaultHidden());
    expect(sanitizeHidden("status")).toEqual(defaultHidden());
    expect(sanitizeHidden(undefined)).toEqual(defaultHidden());
  });
});
