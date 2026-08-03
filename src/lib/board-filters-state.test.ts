import { describe, it, expect } from "vitest";
import { ApiCustomField } from "@/types";
import {
  migratePersistedFilters,
  countActiveFilters,
  EMPTY_FILTERS,
  sanitizeFieldFilters,
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
      countActiveFilters({ ...EMPTY_FILTERS, assignee: "rpo", priority: "high", category: "bug" })
    ).toBe(3);
  });

  // Search lives in the resting row, not the popover, so it must not inflate the pill
  it("does not count search", () => {
    const withSearch = { ...EMPTY_FILTERS, assignee: "rpo", search: "CP-128" };
    expect(countActiveFilters(withSearch as never)).toBe(1);
  });
});

describe("project field filters", () => {
  const fields = [
    { _id: "f1", name: "Points", fieldType: "number", filterable: true, archived: false },
    { _id: "f2", name: "Gone", fieldType: "text", filterable: true, archived: true },
    { _id: "f3", name: "Hidden", fieldType: "text", filterable: false, archived: false },
  ] as unknown as ApiCustomField[];

  it("counts a set field filter alongside the built-in ones", () => {
    const filters = { ...EMPTY_FILTERS, assignee: "rpo", fields: { f1: { from: "3" } } };
    expect(countActiveFilters(filters)).toBe(2);
  });

  it("does not count an empty field filter", () => {
    expect(countActiveFilters({ ...EMPTY_FILTERS, fields: { f1: {} } })).toBe(0);
  });

  // Otherwise the board keeps filtering on a field the panel no longer shows
  it("drops filters for archived and non-filterable fields", () => {
    const kept = sanitizeFieldFilters(
      { f1: { from: "3" }, f2: { value: "x" }, f3: { value: "y" } },
      fields
    );
    expect(Object.keys(kept)).toEqual(["f1"]);
  });

  it("drops a filter whose field no longer exists at all", () => {
    expect(sanitizeFieldFilters({ ghost: { value: "x" } }, fields)).toEqual({});
  });

  it("survives a reload with a live field filter intact", () => {
    const state = migratePersistedFilters(
      { filters: { fields: { f1: { from: "3", to: "8" } } } },
      undefined,
      fields
    );
    expect(state.filters.fields).toEqual({ f1: { from: "3", to: "8" } });
  });
});
