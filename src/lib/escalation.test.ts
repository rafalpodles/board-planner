import { describe, it, expect } from "vitest";
import {
  escalationColumnId,
  explicitEscalationColumnId,
  flaggedColumnIds,
  withEscalationColumn,
} from "./escalation";
import { AnyColumn } from "./columns";
import { ColumnRole } from "@/types";

function col(id: string, role: ColumnRole, triggersPmReview = false): AnyColumn {
  return { id, label: id, color: "#000000", role, order: 0, triggersPmReview };
}

const BOARD: AnyColumn[] = [
  col("todo", "approved"),
  col("in_progress", "active"),
  col("in_review", "review"),
  col("needs_human_review", "review", true),
  col("done", "done"),
];

describe("escalationColumnId", () => {
  it("picks the flagged review column", () => {
    expect(escalationColumnId(BOARD)).toBe("needs_human_review");
  });

  it("falls back to the first review column when none is flagged", () => {
    expect(escalationColumnId(BOARD.map((c) => ({ ...c, triggersPmReview: false })))).toBe(
      "in_review"
    );
  });

  // The three readers disagreed on this: task-service and the worker only ever looked at
  // review columns, while the PM trigger fired on any flagged column whatever its role
  it("ignores a flagged column that is not a review column", () => {
    const columns = [col("todo", "approved", true), col("in_review", "review")];
    expect(escalationColumnId(columns)).toBe("in_review");
  });

  it("returns undefined when the board has no review column", () => {
    expect(escalationColumnId([col("todo", "approved"), col("done", "done")])).toBeUndefined();
  });
});

describe("explicitEscalationColumnId", () => {
  // A PM trigger is opt-in. The falling-back resolver turned zero flags into "the first
  // review column", so every routine move into review would queue a turn against the cap
  it("is undefined when no column carries the flag", () => {
    expect(
      explicitEscalationColumnId(BOARD.map((c) => ({ ...c, triggersPmReview: false })))
    ).toBeUndefined();
  });

  it("is the flagged review column when there is one", () => {
    expect(explicitEscalationColumnId(BOARD)).toBe("needs_human_review");
  });

  it("ignores a flag on a column that is not a review column", () => {
    expect(explicitEscalationColumnId([col("todo", "approved", true)])).toBeUndefined();
  });
});

describe("flaggedColumnIds", () => {
  it("lists every flagged column, including ones a review column would shadow", () => {
    const columns = [
      col("todo", "approved", true),
      col("in_review", "review", true),
      col("needs_human_review", "review", true),
    ];
    expect(flaggedColumnIds(columns)).toEqual(["todo", "in_review", "needs_human_review"]);
  });

  it("is empty for a board nobody has configured", () => {
    expect(flaggedColumnIds([col("todo", "approved")])).toEqual([]);
  });
});

describe("withEscalationColumn", () => {
  it("flags the chosen column and clears every other", () => {
    const columns = [
      col("todo", "approved", true),
      col("in_review", "review", true),
      col("needs_human_review", "review"),
    ];

    const next = withEscalationColumn(columns, "needs_human_review");

    expect(next.map((c) => [c.id, c.triggersPmReview])).toEqual([
      ["todo", false],
      ["in_review", false],
      ["needs_human_review", true],
    ]);
  });

  it("clears the flag everywhere when nothing is chosen", () => {
    const next = withEscalationColumn(BOARD, null);
    expect(next.some((c) => c.triggersPmReview)).toBe(false);
  });

  it("refuses to flag a column that is not a review column", () => {
    const next = withEscalationColumn(BOARD, "todo");
    expect(next.some((c) => c.triggersPmReview)).toBe(false);
  });

  it("leaves the rest of each column untouched", () => {
    const next = withEscalationColumn(BOARD, "in_review");
    expect(next[0]).toMatchObject({ id: "todo", role: "approved", color: "#000000" });
  });
});
