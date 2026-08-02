// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Board } from "./Board";
import { ApiTask, ApiProjectCategory } from "@/types";
import { AnyColumn } from "@/lib/columns";

const columns = [
  { id: "todo", label: "To Do", color: "#0ea5e9", role: "approved", order: 0 },
] as AnyColumn[];

const tasks = [
  {
    _id: "t1",
    taskNumber: 7,
    title: "A bug",
    status: "todo",
    priority: "medium",
    difficulty: "M",
    category: "bug",
    labels: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
] as ApiTask[];

const categories = [{ name: "bug", color: "#ef4444" }] as ApiProjectCategory[];

function renderBoard(projectCategories?: ApiProjectCategory[]) {
  return render(
    <Board
      tasks={tasks}
      projectKey="TP"
      columns={columns}
      projectCategories={projectCategories}
      onStatusChange={() => {}}
      onTaskClick={() => {}}
    />
  );
}

function card(container: HTMLElement) {
  const el = container.querySelector("[draggable]");
  if (!el) throw new Error("no card rendered");
  return el as HTMLElement;
}

afterEach(cleanup);

describe("Board category tinting", () => {
  // The board page silently stopped passing projectCategories during the (app)
  // route-group move, so every card lost its category colour while the list
  // view kept it. Nothing failed.
  it("carries the category colour down to the card", () => {
    const { container } = renderBoard(categories);
    const el = card(container);
    expect(el.className).toContain("cat-card");
    expect(el.style.getPropertyValue("--cat")).toBe("#ef4444");
  });

  it("falls back to the plain card when the project defines no colours", () => {
    const { container } = renderBoard([]);
    const el = card(container);
    expect(el.className).not.toContain("cat-card");
    expect(el.style.getPropertyValue("--cat")).toBe("");
  });

  it("falls back to the plain card when the prop is missing entirely", () => {
    const { container } = renderBoard(undefined);
    const el = card(container);
    expect(el.className).not.toContain("cat-card");
  });
});
