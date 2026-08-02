// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
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
    difficulty: "M",
    category: "bug",
    labels: [],
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
    const onExpand = vi.fn();
    const { container } = renderColumn({ collapsed: true, onExpand });
    await act(async () => {
      (container.firstElementChild as HTMLElement).click();
    });
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("does not fire expand when it is already open", async () => {
    const onExpand = vi.fn();
    const { container } = renderColumn({ collapsed: false, onExpand });
    await act(async () => {
      (container.firstElementChild as HTMLElement).click();
    });
    expect(onExpand).not.toHaveBeenCalled();
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
