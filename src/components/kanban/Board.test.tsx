// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { Board } from "./Board";
import { ApiTask, ApiProjectCategory } from "@/types";
import { ApiProjectColumn } from "@/types";

const columns: ApiProjectColumn[] = [
  { _id: "c1", id: "todo", label: "To Do", color: "#0ea5e9", role: "approved", order: 0, triggersPmReview: false },
];

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
  const twoColumns: ApiProjectColumn[] = [
    { _id: "c1", id: "todo", label: "To Do", color: "#0ea5e9", role: "approved", order: 0, triggersPmReview: false },
    { _id: "c2", id: "done", label: "Done", color: "#22c55e", role: "done", order: 1, triggersPmReview: false },
  ];

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

describe("A read-only board", () => {
  const columnsWithInProgress: ApiProjectColumn[] = [
    { _id: "c1", id: "todo", label: "To Do", color: "#0ea5e9", role: "approved", order: 0, triggersPmReview: false },
    { _id: "c2", id: "in_progress", label: "In Progress", color: "#f59e0b", role: "active", order: 1, triggersPmReview: false },
  ];

  function renderReadOnlyBoard(overrides: {
    onTaskDrop?: (taskId: string, status: string, dropIndex: number) => void;
    onStatusChange?: (taskId: string, status: string) => void;
  } = {}) {
    return render(
      <Board
        tasks={tasks}
        projectKey="TP"
        columns={columnsWithInProgress}
        readOnly
        onStatusChange={overrides.onStatusChange ?? (() => {})}
        onTaskDrop={overrides.onTaskDrop}
        onTaskClick={() => {}}
      />
    );
  }

  it("does not offer a card as a drag source", () => {
    renderReadOnlyBoard();
    const el = screen.getByRole("link", { name: /A bug/i });
    expect(el.getAttribute("draggable")).toBe("false");
  });

  it("still lets a card be opened", () => {
    renderReadOnlyBoard();
    const el = screen.getByRole("link", { name: /A bug/i });
    expect(el.getAttribute("href")).toContain("/TP/tasks/");
  });

  it("drops nothing when a task is dragged onto a column", () => {
    const onTaskDrop = vi.fn();
    const onStatusChange = vi.fn();
    renderReadOnlyBoard({ onTaskDrop, onStatusChange });
    const column = screen.getByTestId("column-in_progress");
    fireEvent.drop(column, { dataTransfer: { getData: () => "t1" } });
    expect(onTaskDrop).not.toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("does not invite a drop into an empty column", () => {
    renderReadOnlyBoard();
    expect(screen.queryByText("Drop tasks here")).toBeNull();
  });
});
