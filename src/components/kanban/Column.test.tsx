// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { Column } from "./Column";
import { ApiTask } from "@/types";
import { AnyColumn } from "@/lib/columns";

const column = {
  id: "needs_human_review",
  label: "Needs Human Review",
  color: "#f43f5e",
  role: "review",
  order: 4,
} as AnyColumn;

const oneTask = [
  {
    _id: "t1",
    taskNumber: 7,
    title: "A task",
    status: "needs_human_review",
    priority: "medium",
    category: "bug",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
] as ApiTask[];

function renderColumn(over: Partial<React.ComponentProps<typeof Column>> = {}) {
  return render(
    <Column
      column={column}
      tasks={[]}
      projectKey="TP"
      onStatusChange={() => {}}
      onTaskClick={() => {}}
      {...over}
    />
  );
}

afterEach(cleanup);

describe("Column, collapsed to a rail", () => {
  it("shows the count, a vertical label and a chevron", () => {
    const { container } = renderColumn({ collapsed: true });
    expect(screen.getByText("0")).toBeTruthy();
    const label = screen.getByText("Needs Human Review");
    expect(label.className).toContain("[writing-mode:vertical-rl]");
    expect(label.className).toContain("truncate");
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("explains itself on hover", () => {
    const { container } = renderColumn({ collapsed: true });
    expect(container.firstElementChild!.getAttribute("title")).toBe(
      "Needs Human Review — 0 tasks. Click to expand."
    );
  });

  it("does not render the card body while collapsed", () => {
    const { container } = renderColumn({ collapsed: true });
    expect(container.querySelector("[data-column-body]")).toBeNull();
    expect(screen.queryByText("Drop tasks here")).toBeNull();
  });

  it("renders the full column when not collapsed", () => {
    const { container } = renderColumn({ collapsed: false });
    expect(container.querySelector("[data-column-body]")).toBeTruthy();
    expect(screen.getByText("Drop tasks here")).toBeTruthy();
  });

  it("expands on click", async () => {
    const onToggleCollapsed = vi.fn();
    const { container } = renderColumn({ collapsed: true, onToggleCollapsed });
    await act(async () => {
      (container.firstElementChild as HTMLElement).click();
    });
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  // Clicking anywhere in an open column would collapse it out from under a card click
  it("does not toggle when the open column body is clicked", async () => {
    const onToggleCollapsed = vi.fn();
    const { container } = renderColumn({ collapsed: false, onToggleCollapsed });
    await act(async () => {
      (container.firstElementChild as HTMLElement).click();
    });
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  it("offers a collapse control in the header of an open empty column", async () => {
    const onToggleCollapsed = vi.fn();
    renderColumn({ collapsed: false, onToggleCollapsed });
    const button = screen.getByLabelText("Collapse Needs Human Review");
    await act(async () => {
      button.click();
    });
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  // A column holding tasks never becomes a rail, so a collapse control would lie
  it("offers no collapse control once the column holds a task", () => {
    renderColumn({ collapsed: false, tasks: oneTask, onToggleCollapsed: () => {} });
    expect(screen.queryByLabelText("Collapse Needs Human Review")).toBeNull();
  });

  // The rail stays a div because it is also the drop target, so it has to borrow
  // the keyboard contract a button would have given it for free
  it("is reachable and operable from the keyboard", async () => {
    const onToggleCollapsed = vi.fn();
    const { container } = renderColumn({ collapsed: true, onToggleCollapsed });
    const rail = container.firstElementChild as HTMLElement;

    expect(rail.getAttribute("role")).toBe("button");
    expect(rail.getAttribute("tabindex")).toBe("0");
    expect(rail.getAttribute("aria-label")).toBe("Expand Needs Human Review");

    for (const key of ["Enter", " "]) {
      await act(async () => {
        rail.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    }
    expect(onToggleCollapsed).toHaveBeenCalledTimes(2);
  });

  it("does not present the open column as a button", () => {
    const { container } = renderColumn({ collapsed: false });
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("role")).toBeNull();
    expect(root.getAttribute("tabindex")).toBeNull();
  });

  // Without this there is nowhere to drop a card into an empty column
  it("reports a drag entering and leaving so the board can expand it", async () => {
    const onDragOverColumn = vi.fn();
    const { container } = renderColumn({ collapsed: true, onDragOverColumn });
    const root = container.firstElementChild as HTMLElement;

    await act(async () => {
      root.dispatchEvent(new Event("dragenter", { bubbles: true }));
    });
    expect(onDragOverColumn).toHaveBeenCalledWith(true);

    await act(async () => {
      root.dispatchEvent(new Event("dragleave", { bubbles: true }));
    });
    expect(onDragOverColumn).toHaveBeenLastCalledWith(false);
  });

  it("keeps its own count when it holds tasks", () => {
    renderColumn({ tasks: oneTask });
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.queryByText("Drop tasks here")).toBeNull();
  });
});

describe("Column without onStatusChange", () => {
  it("drops a card without calling anything", () => {
    const { container } = renderColumn({ onStatusChange: undefined, collapsed: false });
    const root = container.firstElementChild as HTMLElement;
    expect(() =>
      fireEvent.drop(root, { dataTransfer: { getData: () => "t1" } })
    ).not.toThrow();
  });
});
