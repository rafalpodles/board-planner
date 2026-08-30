import { describe, it, expect } from "vitest";
import {
  columnFor,
  columnIdsWithRole,
  mergedReviewDestination,
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

/**
 * BP-429. A merged merge request advances a task one review column, never into or out of a column
 * somebody flagged for a human. Every shape below is a board a project can actually build in
 * settings, and the first version of this rule — "the first review column advances to the last" —
 * was wrong on four of them.
 */
describe("mergedReviewDestination", () => {
  const col = (id: string, role: string, order: number, flagged = false) =>
    ({ id, label: id, color: "#000", role, order, triggersPmReview: flagged }) as never;

  const board = (cols: unknown[]) => ({ columns: cols as never[] });

  it("skips the flagged column on the default board rather than parking merged work in it", () => {
    expect(mergedReviewDestination(null, "in_review")).toBe("ready_to_test");
  });

  it("never moves a task out of the flagged column, wherever that column sorts", () => {
    expect(mergedReviewDestination(null, "needs_human_review")).toBeUndefined();

    // Column order is whatever somebody last dragged it into, so it cannot be what decides this.
    const reordered = board([
      col("needs_human_review", "review", 0, true),
      col("in_review", "review", 1),
      col("ready_to_test", "review", 2),
      col("done", "done", 3),
    ]);
    expect(mergedReviewDestination(reordered, "needs_human_review")).toBeUndefined();
    expect(mergedReviewDestination(reordered, "in_review")).toBe("ready_to_test");
  });

  it("advances one step, not to the end, when the middle column is a real step", () => {
    const pipeline = board([
      col("code_review", "review", 0),
      col("qa", "review", 1),
      col("uat", "review", 2),
      col("shipped", "done", 3),
    ]);
    // "First advances to last" sent this straight to uat, skipping two columns somebody built.
    expect(mergedReviewDestination(pipeline, "code_review")).toBe("qa");
    expect(mergedReviewDestination(pipeline, "qa")).toBe("uat");
    expect(mergedReviewDestination(pipeline, "uat")).toBeUndefined();
  });

  it("transitions nothing on a board with one review column, or none", () => {
    const one = board([col("building", "active", 0), col("checking", "review", 1), col("shipped", "done", 2)]);
    expect(mergedReviewDestination(one, "checking")).toBeUndefined();

    const none = board([col("building", "active", 0), col("shipped", "done", 1)]);
    expect(mergedReviewDestination(none, "building")).toBeUndefined();
  });

  it("reads the board in its own order, not the order it happens to be stored in", () => {
    const unsorted = board([
      col("ready_to_test", "review", 2),
      col("in_review", "review", 0),
      col("needs_human_review", "review", 1, true),
    ]);
    expect(mergedReviewDestination(unsorted, "in_review")).toBe("ready_to_test");
  });

  it("says nowhere for a status the board has no column for", () => {
    expect(mergedReviewDestination(null, "a_column_somebody_deleted")).toBeUndefined();
  });

  it("steps over a non-review column standing between two review ones", () => {
    const interleaved = board([
      col("in_review", "review", 0),
      col("fixing", "active", 1),
      col("ready_to_test", "review", 2),
    ]);
    expect(mergedReviewDestination(interleaved, "in_review")).toBe("ready_to_test");
  });
});
