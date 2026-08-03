// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
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
    category: "bug",
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

describe("Board empty-column rail", () => {
  const twoColumns = [
    { id: "todo", label: "To Do", color: "#0ea5e9", role: "approved", order: 0 },
    { id: "done", label: "Done", color: "#22c55e", role: "done", order: 1 },
  ] as AnyColumn[];

  function renderTwoColumnBoard(collapseEmptyColumns?: boolean) {
    return render(
      <Board
        tasks={tasks}
        projectKey="TP"
        columns={twoColumns}
        collapseEmptyColumns={collapseEmptyColumns}
        onStatusChange={() => {}}
        onTaskClick={() => {}}
      />
    );
  }

  const rail = (container: HTMLElement) =>
    container.querySelector('[title="Done — 0 tasks. Click to expand."]') as HTMLElement | null;

  it("starts the empty column as a rail and the populated one open", () => {
    const { container } = renderTwoColumnBoard();
    expect(rail(container)).toBeTruthy();
    expect(screen.queryByLabelText("Collapse To Do")).toBeNull();
  });

  // CP-174 made expanding one-way: pinning had no inverse, so the only way back was a reload
  it("round-trips between rail and open column", async () => {
    const { container } = renderTwoColumnBoard();

    for (let pass = 0; pass < 3; pass++) {
      await act(async () => {
        rail(container)!.click();
      });
      expect(rail(container)).toBeNull();

      await act(async () => {
        screen.getByLabelText("Collapse Done").click();
      });
      expect(rail(container)).toBeTruthy();
    }
  });

  it("leaves the empty column at full width when the preference is off", () => {
    const { container } = renderTwoColumnBoard(false);
    expect(rail(container)).toBeNull();
    // Full width, not a 44px slot
    const grid = container.querySelector("[style*='grid-template-columns']") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("minmax(0, 1fr) minmax(0, 1fr)");
  });

  it("offers no collapse control when the preference is off, since there is no rail to return to", () => {
    renderTwoColumnBoard(false);
    expect(screen.queryByLabelText("Collapse Done")).toBeNull();
  });

  it("keeps the expansion out of localStorage", async () => {
    const { container } = renderTwoColumnBoard();
    await act(async () => {
      rail(container)!.click();
    });
    expect(Object.keys(localStorage)).toHaveLength(0);
  });
});
