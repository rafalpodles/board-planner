import { describe, it, expect } from "vitest";
import { ApiCustomField } from "@/types";
import {
  migratePersistedFilters,
  countActiveFilters,
  EMPTY_FILTERS,
  sanitizeFieldFilters,
  matchesStatusFilter,
  statusLabel,
  statusOptions,
  statusRoleMap,
  UNFILED,
} from "./board-filters-state";

describe("migratePersistedFilters — category renames", () => {
  const stored = { filters: { ...EMPTY_FILTERS, category: "bug" } };

  // Categories are stored on a task by name, so renaming one leaves this filter pointing
  // at a name the picker no longer offers: an empty board and no way to clear it
  it("drops a category filter the project no longer has", () => {
    const state = migratePersistedFilters(stored, "owner", [], ["defect", "doc"]);
    expect(state.filters.category).toBe("");
  });

  it("keeps a category the project still has", () => {
    const state = migratePersistedFilters(stored, "owner", [], ["bug", "doc"]);
    expect(state.filters.category).toBe("bug");
  });

  // Callers that do not know the categories yet must not have their filter wiped
  it("leaves the filter alone when the category list is not supplied", () => {
    const state = migratePersistedFilters(stored, "owner", []);
    expect(state.filters.category).toBe("bug");
  });
});

describe("migratePersistedFilters", () => {
  it("falls back to defaults for missing or malformed storage", () => {
    for (const raw of [null, undefined, "nonsense", 42, []]) {
      const state = migratePersistedFilters(raw, "owner");
      expect(state.filters).toEqual(EMPTY_FILTERS);
      expect(state.sortField).toBe("manual");
      expect(state.sortDir).toBe("asc");
      expect(state.showFilters).toBe(false);
    }
  });

  it("reads stored filters back", () => {
    const state = migratePersistedFilters(
      { filters: { assignee: "claude", priority: "high" }, sortField: "priority", sortDir: "desc" },
      "owner"
    );
    expect(state.filters.assignee).toBe("claude");
    expect(state.filters.priority).toBe("high");
    expect(state.sortField).toBe("priority");
    expect(state.sortDir).toBe("desc");
  });

  // The regression this function exists to prevent
  it("carries a legacy myTasks toggle over to the assignee filter", () => {
    const state = migratePersistedFilters({ myTasks: true, filters: {} }, "owner");
    expect(state.filters.assignee).toBe("owner");
  });

  it("does not clobber an explicit assignee with the legacy toggle", () => {
    const state = migratePersistedFilters(
      { myTasks: true, filters: { assignee: "claude" } },
      "owner"
    );
    expect(state.filters.assignee).toBe("claude");
  });

  it("drops the legacy toggle when nobody is signed in", () => {
    const state = migratePersistedFilters({ myTasks: true, filters: {} }, undefined);
    expect(state.filters.assignee).toBe("");
  });

  it("ignores myTasks:false", () => {
    const state = migratePersistedFilters({ myTasks: false, filters: {} }, "owner");
    expect(state.filters.assignee).toBe("");
  });

  // A truthy non-boolean must not switch the filter on — the string "false" is
  // truthy, and a corrupted blob should not silently start filtering the board
  it("only migrates a literal true, not any truthy value", () => {
    for (const value of ["false", "true", 1, "yes", {}]) {
      const state = migratePersistedFilters({ myTasks: value, filters: {} }, "owner");
      expect(state.filters.assignee).toBe("");
    }
  });

  it("never leaks the legacy field into the returned state", () => {
    const state = migratePersistedFilters({ myTasks: true, filters: {} }, "owner");
    expect("myTasks" in state).toBe(false);
    expect("myTasks" in state.filters).toBe(false);
  });

  it("coerces non-string filter values to empty rather than trusting them", () => {
    const state = migratePersistedFilters(
      { filters: { assignee: 42, priority: null, label: { a: 1 } } },
      "owner"
    );
    expect(state.filters.assignee).toBe("");
    expect(state.filters.priority).toBe("");
  });

  it("treats any sortDir other than desc as asc", () => {
    expect(migratePersistedFilters({ sortDir: "sideways" }, "owner").sortDir).toBe("asc");
    expect(migratePersistedFilters({ sortDir: "desc" }, "owner").sortDir).toBe("desc");
  });

  it("keeps showFilters, which now drives the popover", () => {
    expect(migratePersistedFilters({ showFilters: true }, "owner").showFilters).toBe(true);
    expect(migratePersistedFilters({ showFilters: "yes" }, "owner").showFilters).toBe(false);
  });
});

describe("countActiveFilters", () => {
  it("counts nothing when nothing is set", () => {
    expect(countActiveFilters(EMPTY_FILTERS)).toBe(0);
  });

  it("counts each set dimension once", () => {
    expect(countActiveFilters({ ...EMPTY_FILTERS, assignee: "owner" })).toBe(1);
    expect(
      countActiveFilters({ ...EMPTY_FILTERS, assignee: "owner", priority: "high", category: "bug" })
    ).toBe(3);
  });

  // Search lives in the resting row, not the popover, so it must not inflate the pill
  it("does not count search", () => {
    const withSearch = { ...EMPTY_FILTERS, assignee: "owner", search: "CP-128" };
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
    const filters = { ...EMPTY_FILTERS, assignee: "owner", fields: { f1: { from: "3" } } };
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

describe("the status filter reads roles, not column ids", () => {
  // A board that renamed every column: the ids are this project's alone, the roles are
  // the only thing anything outside the project can compare (BP-128)
  const renamed = [
    { id: "parked", label: "Parked", color: "#000", role: "backlog" as const, order: 0 },
    { id: "cooking", label: "Cooking", color: "#000", role: "active" as const, order: 1 },
    { id: "checking", label: "Checking", color: "#000", role: "review" as const, order: 2 },
    { id: "double-checking", label: "Double checking", color: "#000", role: "review" as const, order: 3 },
  ];

  it("matches a task by the role of the column it sits in", () => {
    expect(matchesStatusFilter("cooking", "active", statusRoleMap(renamed))).toBe(true);
    expect(matchesStatusFilter("cooking", "review", statusRoleMap(renamed))).toBe(false);
  });

  it("covers every column sharing the role, not just the first", () => {
    expect(matchesStatusFilter("checking", "review", statusRoleMap(renamed))).toBe(true);
    expect(matchesStatusFilter("double-checking", "review", statusRoleMap(renamed))).toBe(true);
  });

  it("offers each role once, in board order", () => {
    expect(statusOptions(renamed).map((o) => o.value)).toEqual(["backlog", "active", "review"]);
  });

  it("matches nothing away when no status is chosen", () => {
    expect(matchesStatusFilter("anything at all", "", statusRoleMap(renamed))).toBe(true);
  });

  // A deleted column leaves its tasks behind with a status naming nothing
  it("puts a task whose column is gone under UNFILED and nowhere else", () => {
    expect(matchesStatusFilter("deleted_column", UNFILED, statusRoleMap(renamed))).toBe(true);
    expect(matchesStatusFilter("deleted_column", "backlog", statusRoleMap(renamed))).toBe(false);
  });

  it("offers UNFILED only when a task actually needs it", () => {
    expect(statusOptions(renamed, [{ status: "cooking" }]).map((o) => o.value)).not.toContain(
      UNFILED
    );
    expect(statusOptions(renamed, [{ status: "gone" }]).map((o) => o.value)).toContain(UNFILED);
  });

  it("falls back to the built-in columns for a project that stored none", () => {
    expect(matchesStatusFilter("in_review", "review", statusRoleMap([]))).toBe(true);
    expect(statusOptions([]).map((o) => o.value)).toEqual([
      "backlog",
      "approved",
      "active",
      "review",
      "done",
    ]);
  });
});

describe("statusLabel", () => {
  it("names a role the way the board settings name it", () => {
    expect(statusLabel("backlog")).toBe("Ideas & backlog");
    expect(statusLabel("review")).toBe("Awaiting review");
  });

  // The chip fell back to the raw value, so a dropped option read "Remove @unfiled filter"
  it("names the sentinel rather than leaking it", () => {
    expect(statusLabel(UNFILED)).toBe("No column");
    expect(statusLabel(UNFILED)).not.toContain("@");
  });
});

describe("migratePersistedFilters — status", () => {
  it("keeps a stored role", () => {
    expect(migratePersistedFilters({ filters: { status: "review" } }).filters.status).toBe("review");
  });

  it("keeps the UNFILED sentinel", () => {
    expect(migratePersistedFilters({ filters: { status: UNFILED } }).filters.status).toBe(UNFILED);
  });

  // Otherwise it filters every task away with nothing in the picker to clear it by
  it("drops a stored value that is not a role", () => {
    expect(migratePersistedFilters({ filters: { status: "in_progress" } }).filters.status).toBe("");
  });

  it("counts as an active filter", () => {
    expect(countActiveFilters({ ...EMPTY_FILTERS, status: "active" })).toBe(1);
  });
});
