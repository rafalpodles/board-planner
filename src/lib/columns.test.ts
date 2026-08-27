import { describe, it, expect } from "vitest";
import {
  columnFor,
  columnIdsWithRole,
  defaultStatusFor,
  getColumnIds,
  roleOf,
  ROLE_ORDER,
} from "./columns";
import { DEFAULT_PROJECT_COLUMNS, IProjectColumn } from "@/types";

const columns = DEFAULT_PROJECT_COLUMNS as unknown as IProjectColumn[];

describe("columns", () => {
  it("returns default column ids when a project has none", () => {
    expect(getColumnIds(null)).toContain("todo");
  });

  it("maps the todo column to the approved role", () => {
    expect(roleOf({ columns }, "todo")).toBe("approved");
  });
});

// BP-227. Eight places compared a task's status against a literal id, so any board that was
// renamed or rebuilt behaved as if its columns meant nothing — and closing a sprint moved work
// nobody asked it to move.
describe("resolving columns by role", () => {
  // Deliberately not the seeded ids: with those, an implementation that still hardcodes "done"
  // passes every assertion below
  const renamed = [
    { id: "icebox", label: "Icebox", color: "#111", role: "backlog", order: 0 },
    { id: "ready", label: "Ready", color: "#222", role: "approved", order: 1 },
    { id: "building", label: "Building", color: "#333", role: "active", order: 2 },
    { id: "checking", label: "Checking", color: "#444", role: "review", order: 3 },
    { id: "verifying", label: "Verifying", color: "#555", role: "review", order: 4 },
    { id: "shipped", label: "Shipped", color: "#666", role: "done", order: 5 },
  ] as unknown as IProjectColumn[];

  it("finds the done column on a board that has no column called done", () => {
    expect(columnIdsWithRole({ columns: renamed }, "done")).toEqual(["shipped"]);
  });

  // A board may split review across several columns, so a single id would silently drop one
  it("returns every column carrying the role, not the first", () => {
    expect(columnIdsWithRole({ columns: renamed }, "review")).toEqual(["checking", "verifying"]);
  });

  it("returns nothing for a role the board does not use", () => {
    expect(columnIdsWithRole({ columns: renamed }, "blocked")).toEqual([]);
  });

  it("falls back to the seeded board when a project has no columns of its own", () => {
    expect(columnIdsWithRole(null, "done")).toEqual(["done"]);
  });

  it("hands back the column a task is sitting in, with its own label and colour", () => {
    expect(columnFor({ columns: renamed }, "building")).toMatchObject({
      label: "Building",
      color: "#333",
      role: "active",
    });
  });

  // What happens to work left behind by a column somebody deleted: naming it undefined is the
  // point, so callers show the raw status rather than inventing a label for it
  it("returns undefined for a status naming no column the project has", () => {
    expect(columnFor({ columns: renamed }, "done")).toBeUndefined();
  });

  // BP-463. The fallback was columns[0], which on a board with no backlog column can be a done
  // one — a task born there is born finished, and a recurring occurrence born there ends its
  // series silently, because creation never runs the status-change side effects.
  //
  // The seeded board cannot tell any of this apart: `planned` is both its backlog column and its
  // first, so every board here puts the backlog somewhere other than the front.
  describe("the column a new task opens in", () => {
    const at = (...roles: string[]) =>
      ({
        columns: roles.map((role, order) => ({
          id: `c-${role}-${order}`,
          label: role,
          color: "#000",
          role,
          order,
        })),
      }) as unknown as { columns: IProjectColumn[] };

    it("is the backlog column, wherever on the board it sits", () => {
      expect(defaultStatusFor(at("done", "active", "backlog"))).toBe("c-backlog-2");
    });

    it("is the approved column when the board has no backlog one", () => {
      expect(defaultStatusFor(at("done", "active", "approved"))).toBe("c-approved-2");
    });

    it("is never a done column while the board has anything else", () => {
      expect(defaultStatusFor(at("done", "review", "done"))).toBe("c-review-1");
    });

    it("falls back to the first column on a board that is nothing but done", () => {
      expect(defaultStatusFor(at("done", "done"))).toBe("c-done-0");
    });
  });

  it("orders every role, so nothing sorts into an undefined bucket", () => {
    const roles = new Set(renamed.map((c) => c.role));
    for (const role of roles) expect(ROLE_ORDER[role]).toBeTypeOf("number");
    expect(ROLE_ORDER.active).toBeLessThan(ROLE_ORDER.done);
  });
});
