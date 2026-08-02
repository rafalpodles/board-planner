import { describe, it, expect } from "vitest";
import {
  migratePersistedFilters,
  countActiveFilters,
  EMPTY_FILTERS,
} from "./board-filters-state";

describe("migratePersistedFilters", () => {
  it("falls back to defaults for missing or malformed storage", () => {
    for (const raw of [null, undefined, "nonsense", 42, []]) {
      const state = migratePersistedFilters(raw, "rpo");
      expect(state.filters).toEqual(EMPTY_FILTERS);
      expect(state.sortField).toBe("manual");
      expect(state.sortDir).toBe("asc");
      expect(state.showFilters).toBe(false);
    }
  });

  it("reads stored filters back", () => {
    const state = migratePersistedFilters(
      { filters: { assignee: "claude", priority: "high" }, sortField: "priority", sortDir: "desc" },
      "rpo"
    );
    expect(state.filters.assignee).toBe("claude");
    expect(state.filters.priority).toBe("high");
    expect(state.filters.component).toBe("");
    expect(state.sortField).toBe("priority");
    expect(state.sortDir).toBe("desc");
  });

  // The regression this function exists to prevent
  it("carries a legacy myTasks toggle over to the assignee filter", () => {
    const state = migratePersistedFilters({ myTasks: true, filters: {} }, "rpo");
    expect(state.filters.assignee).toBe("rpo");
  });

  it("does not clobber an explicit assignee with the legacy toggle", () => {
    const state = migratePersistedFilters(
      { myTasks: true, filters: { assignee: "claude" } },
      "rpo"
    );
    expect(state.filters.assignee).toBe("claude");
  });

  it("drops the legacy toggle when nobody is signed in", () => {
    const state = migratePersistedFilters({ myTasks: true, filters: {} }, undefined);
    expect(state.filters.assignee).toBe("");
  });

  it("ignores myTasks:false", () => {
    const state = migratePersistedFilters({ myTasks: false, filters: {} }, "rpo");
    expect(state.filters.assignee).toBe("");
  });

  // A truthy non-boolean must not switch the filter on — the string "false" is
  // truthy, and a corrupted blob should not silently start filtering the board
  it("only migrates a literal true, not any truthy value", () => {
    for (const value of ["false", "true", 1, "yes", {}]) {
      const state = migratePersistedFilters({ myTasks: value, filters: {} }, "rpo");
      expect(state.filters.assignee).toBe("");
    }
  });

  it("never leaks the legacy field into the returned state", () => {
    const state = migratePersistedFilters({ myTasks: true, filters: {} }, "rpo");
    expect("myTasks" in state).toBe(false);
    expect("myTasks" in state.filters).toBe(false);
  });

  it("coerces non-string filter values to empty rather than trusting them", () => {
    const state = migratePersistedFilters(
      { filters: { assignee: 42, priority: null, label: { a: 1 } } },
      "rpo"
    );
    expect(state.filters.assignee).toBe("");
    expect(state.filters.priority).toBe("");
    expect(state.filters.label).toBe("");
  });

  it("treats any sortDir other than desc as asc", () => {
    expect(migratePersistedFilters({ sortDir: "sideways" }, "rpo").sortDir).toBe("asc");
    expect(migratePersistedFilters({ sortDir: "desc" }, "rpo").sortDir).toBe("desc");
  });

  it("keeps showFilters, which now drives the popover", () => {
    expect(migratePersistedFilters({ showFilters: true }, "rpo").showFilters).toBe(true);
    expect(migratePersistedFilters({ showFilters: "yes" }, "rpo").showFilters).toBe(false);
  });
});

describe("countActiveFilters", () => {
  it("counts nothing when nothing is set", () => {
    expect(countActiveFilters(EMPTY_FILTERS)).toBe(0);
  });

  it("counts each set dimension once", () => {
    expect(countActiveFilters({ ...EMPTY_FILTERS, assignee: "rpo" })).toBe(1);
    expect(
      countActiveFilters({ ...EMPTY_FILTERS, assignee: "rpo", priority: "high", label: "ui" })
    ).toBe(3);
  });

  // Search lives in the resting row, not the popover, so it must not inflate the pill
  it("does not count search", () => {
    const withSearch = { ...EMPTY_FILTERS, assignee: "rpo" } as Record<string, string>;
    withSearch.search = "CP-128";
    expect(countActiveFilters(withSearch as never)).toBe(1);
  });
});
