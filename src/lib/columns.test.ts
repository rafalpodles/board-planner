import { describe, it, expect } from "vitest";
import { getColumnIds, roleOf } from "./columns";
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
