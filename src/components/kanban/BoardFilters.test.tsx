// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import { BoardFilters } from "./BoardFilters";
import { ApiTask } from "@/types";

function task(over: Partial<ApiTask> & { _id: string }): ApiTask {
  return {
    taskNumber: 1,
    title: "A task",
    status: "todo",
    priority: "medium",
    category: "bug",
    order: 0,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...over,
  } as ApiTask;
}

const tasks = [
  task({ _id: "1", taskNumber: 1, title: "Urgent bug", priority: "urgent" }),
  task({
    _id: "2",
    taskNumber: 2,
    title: "Assigned work",
    assignee: { _id: "u1", username: "rpo" },
  } as Partial<ApiTask> & { _id: string }),
  task({ _id: "3", taskNumber: 3, title: "Low chore", priority: "low" }),
];

function renderFilters(over: Partial<React.ComponentProps<typeof BoardFilters>> = {}) {
  const onFilter = vi.fn();
  const onSortChange = vi.fn();
  const utils = render(
    <BoardFilters
      tasks={tasks}
      categories={["bug", "doc"]}
      projectKey="TP"
      projectId="TP"
      currentUsername="rpo"
      sortField="manual"
      sortDir="asc"
      onSortChange={onSortChange}
      onFilter={onFilter}
      {...over}
    />
  );
  return { ...utils, onFilter, onSortChange };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

async function openPopover() {
  await act(async () => {
    screen.getByText("Filters").click();
  });
}

describe("BoardFilters", () => {
  it("rests as a single row with no popover open", () => {
    renderFilters();
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
    expect(screen.getByPlaceholderText(/Search tasks, or TP-128/)).toBeTruthy();
  });

  // happy-dom has no layout engine, so this guards the contract that keeps the
  // row single at a 663px content column: search must be free to shrink below
  // its target width rather than forcing Select onto a second line
  it("gives search a shrinkable basis under its target width", () => {
    const { container } = renderFilters();
    const searchBox = container.firstElementChild!.firstElementChild!;
    expect(searchBox.className).toContain("flex-[1_1_120px]");
    expect(searchBox.className).toContain("max-w-[200px]");
    expect(searchBox.className).toContain("min-w-0");
  });

  it("holds exactly four controls in the popover", async () => {
    renderFilters();
    await openPopover();
    const popover = screen.getByRole("dialog", { name: "Filters" });
    const labels = [...popover.querySelectorAll("label > span")].map((s) => s.textContent);
    expect(labels).toEqual(["Assignee", "Category", "Priority", "Updated"]);
    expect(popover.querySelectorAll("select").length).toBe(4);
  });

  // Sprint is scope and lives in the board header — it must not reappear here
  it("has no sprint control anywhere", async () => {
    renderFilters();
    await openPopover();
    expect(screen.queryByText(/sprint/i)).toBeNull();
  });

  it("keeps sort and select outside the popover", async () => {
    renderFilters({ extraControls: <button>Select</button> });
    expect(screen.getByLabelText(/Sort (ascending|descending)/)).toBeTruthy();
    expect(screen.getByText("Select")).toBeTruthy();

    await openPopover();
    const popover = screen.getByRole("dialog", { name: "Filters" });
    expect(popover.textContent).not.toContain("Select");
  });

  it("counts set filters on the pill and drops the count when cleared", async () => {
    renderFilters();
    await openPopover();

    const priority = screen.getByRole("dialog").querySelectorAll("select")[2];
    await act(async () => {
      priority.value = "urgent";
      priority.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(screen.getByText("1")).toBeTruthy();

    await act(async () => {
      screen.getByText("Clear all").click();
    });
    expect(screen.queryByText("Clear all")).toBeNull();
  });

  it("shows a removable chip per set filter", async () => {
    renderFilters();
    await openPopover();

    const assignee = screen.getByRole("dialog").querySelectorAll("select")[0];
    await act(async () => {
      assignee.value = "rpo";
      assignee.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(screen.getByLabelText("Remove rpo filter")).toBeTruthy();

    await act(async () => {
      screen.getByLabelText("Remove rpo filter").click();
    });
    expect(screen.queryByLabelText("Remove rpo filter")).toBeNull();
  });

  it("applies filters to the task set without any request", async () => {
    const { onFilter } = renderFilters();
    await openPopover();

    const priority = screen.getByRole("dialog").querySelectorAll("select")[2];
    await act(async () => {
      priority.value = "urgent";
      priority.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => {
      const last = onFilter.mock.calls.at(-1)![0] as ApiTask[];
      expect(last.map((t) => t.title)).toEqual(["Urgent bug"]);
    });
  });

  it("searches by task key as well as title", async () => {
    const { onFilter } = renderFilters();
    const search = screen.getByPlaceholderText(/Search tasks/) as HTMLInputElement;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search,
        "TP-2"
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitFor(() => {
      const last = onFilter.mock.calls.at(-1)![0] as ApiTask[];
      expect(last.map((t) => t.taskNumber)).toEqual([2]);
    });
  });

  // The migration this release depends on. The popover starts closed, so what a
  // returning user actually sees is the count pill and a narrowed board.
  it("restores a legacy myTasks toggle as the assignee filter", async () => {
    localStorage.setItem(
      "board-filters:TP",
      JSON.stringify({ myTasks: true, filters: {}, sortField: "manual", sortDir: "asc" })
    );
    const { onFilter } = renderFilters();

    await waitFor(() => {
      const last = onFilter.mock.calls.at(-1)![0] as ApiTask[];
      expect(last.map((t) => t.title)).toEqual(["Assigned work"]);
    });
    expect(screen.getByText("1")).toBeTruthy();

    await openPopover();
    expect(screen.getByLabelText("Remove rpo filter")).toBeTruthy();
  });

  // Search sits in the resting row, outside the popover, so clearing filters
  // must not throw away what the user typed
  it("keeps the search text when clearing filters", async () => {
    renderFilters();
    const search = screen.getByPlaceholderText(/Search tasks/) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search,
        "chore"
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await openPopover();
    const priority = screen.getByRole("dialog").querySelectorAll("select")[2];
    await act(async () => {
      priority.value = "low";
      priority.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      screen.getByText("Clear all").click();
    });

    expect((screen.getByPlaceholderText(/Search tasks/) as HTMLInputElement).value).toBe("chore");
  });

  it("no longer offers a standalone My tasks toggle", () => {
    renderFilters();
    expect(screen.queryByText("My tasks")).toBeNull();
  });

  it("stops writing the legacy myTasks field back to storage", async () => {
    renderFilters();
    await waitFor(() => expect(localStorage.getItem("board-filters:TP")).toBeTruthy());
    const stored = JSON.parse(localStorage.getItem("board-filters:TP")!);
    expect("myTasks" in stored).toBe(false);
    expect("search" in stored.filters).toBe(false);
  });
});
