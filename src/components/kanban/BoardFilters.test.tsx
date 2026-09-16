// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { BoardFilters } from "./BoardFilters";
import { ApiCustomField, ApiTask } from "@/types";
import { UNFILED } from "@/lib/board-filters-state";

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
    assignee: { _id: "u1", username: "owner" },
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
      currentUsername="owner"
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

  it("holds exactly five controls in the popover", async () => {
    renderFilters();
    await openPopover();
    const popover = screen.getByRole("dialog", { name: "Filters" });
    const labels = [...popover.querySelectorAll("label > span")].map((s) => s.textContent);
    expect(labels).toEqual(["Assignee", "Category", "Priority", "Status", "Updated"]);
    expect(popover.querySelectorAll("select").length).toBe(5);
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

  describe("the status filter", () => {
    const columns = [
      { id: "parked", label: "Parked", color: "#000", role: "backlog" as const, order: 0 },
      { id: "cooking", label: "Cooking", color: "#000", role: "active" as const, order: 1 },
      { id: "checking", label: "Checking", color: "#000", role: "review" as const, order: 2 },
      { id: "signed-off", label: "Signed off", color: "#000", role: "review" as const, order: 3 },
    ];
    const on = (column: string) => column as ApiTask["status"];
    const board = [
      task({ _id: "a", taskNumber: 1, title: "Being worked on", status: on("cooking") }),
      task({ _id: "b", taskNumber: 2, title: "First review", status: on("checking") }),
      task({ _id: "c", taskNumber: 3, title: "Second review", status: on("signed-off") }),
      task({ _id: "d", taskNumber: 4, title: "Parked idea", status: on("parked") }),
      // Shares "Second" with a review task, so composition cannot pass on the search alone
      task({ _id: "e", taskNumber: 5, title: "Second thoughts", status: on("cooking") }),
    ];

    const statusSelect = () => screen.getByLabelText("Status") as HTMLSelectElement;

    async function chooseStatus(value: string) {
      const status = statusSelect();
      await act(async () => {
        status.value = value;
        status.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    it("narrows the board to the chosen role, across every column carrying it", async () => {
      const { onFilter } = renderFilters({ tasks: board, columns });
      await openPopover();
      await chooseStatus("review");

      const last = onFilter.mock.calls.at(-1)![0] as ApiTask[];
      expect(last.map((t) => t._id)).toEqual(["b", "c"]);
    });

    it("offers the board's own roles, labelled for a human", async () => {
      renderFilters({ tasks: board, columns });
      await openPopover();
      const status = statusSelect();
      expect([...status.options].map((o) => o.textContent)).toEqual([
        "All statuses",
        "Ideas & backlog",
        "In progress",
        "Awaiting review",
      ]);
    });

    it("shows a removable chip naming the role", async () => {
      const { onFilter } = renderFilters({ tasks: board, columns });
      await openPopover();
      await chooseStatus("active");

      expect(screen.getByLabelText("Remove In progress filter")).toBeTruthy();
      expect((onFilter.mock.calls.at(-1)![0] as ApiTask[]).length).toBe(2);

      await act(async () => {
        screen.getByLabelText("Remove In progress filter").click();
      });

      expect(screen.queryByLabelText("Remove In progress filter")).toBeNull();
      expect((onFilter.mock.calls.at(-1)![0] as ApiTask[]).length).toBe(board.length);
    });

    it("keeps a chosen status in the picker after the board stops offering it", async () => {
      const { rerender } = renderFilters({ tasks: board, columns });
      await openPopover();
      await chooseStatus("backlog");
      expect(statusSelect().value).toBe("backlog");

      rerender(
        <BoardFilters
          tasks={board.filter((t) => t.status !== on("parked"))}
          columns={columns.filter((c) => c.role !== "backlog")}
          categories={["bug", "doc"]}
          projectKey="TP"
          projectId="TP"
          currentUsername="owner"
          sortField="manual"
          sortDir="asc"
          onSortChange={vi.fn()}
          onFilter={vi.fn()}
        />
      );

      expect(statusSelect().value).toBe("backlog");
      expect([...statusSelect().options].map((o) => o.textContent)).toContain("Ideas & backlog");
      expect(screen.getByLabelText("Remove Ideas & backlog filter")).toBeTruthy();
    });

    it("offers No column, and only to a board that has an orphaned task", async () => {
      const orphan = task({ _id: "x", taskNumber: 9, title: "Column deleted", status: on("gone") });

      renderFilters({ tasks: board, columns });
      await openPopover();
      expect([...statusSelect().options].map((o) => o.textContent)).not.toContain("No column");
      cleanup();
      // The panel's open state is persisted; without this the next click closes it
      localStorage.clear();

      const { onFilter } = renderFilters({ tasks: [...board, orphan], columns });
      await openPopover();
      expect([...statusSelect().options].map((o) => o.textContent)).toContain("No column");

      await chooseStatus(UNFILED);
      expect((onFilter.mock.calls.at(-1)![0] as ApiTask[]).map((t) => t._id)).toEqual(["x"]);
      expect(screen.getByLabelText("Remove No column filter")).toBeTruthy();
    });

    it("composes with the search box rather than replacing it", async () => {
      const { onFilter, container } = renderFilters({ tasks: board, columns });
      const search = container.querySelector("input[type=text]") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "Second" } });
      });
      await openPopover();
      await chooseStatus("review");

      const last = onFilter.mock.calls.at(-1)![0] as ApiTask[];
      expect(last.map((t) => t._id)).toEqual(["c"]);
    });

    it("hands the host a way to clear everything, search included", async () => {
      const { onFilter, container } = renderFilters({ tasks: board, columns });
      const search = container.querySelector("input[type=text]") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "nothing matches this" } });
      });
      await openPopover();
      await chooseStatus("review");
      expect((onFilter.mock.calls.at(-1)![0] as ApiTask[]).length).toBe(0);

      await act(async () => {
        onFilter.mock.calls.at(-1)![1].clearAll();
      });

      const last = onFilter.mock.calls.at(-1)!;
      expect((last[0] as ApiTask[]).length).toBe(board.length);
      expect(last[1].activeCount).toBe(0);
    });
  });

  it("shows a removable chip per set filter", async () => {
    renderFilters();
    await openPopover();

    const assignee = screen.getByRole("dialog").querySelectorAll("select")[0];
    await act(async () => {
      assignee.value = "owner";
      assignee.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(screen.getByLabelText("Remove owner filter")).toBeTruthy();

    await act(async () => {
      screen.getByLabelText("Remove owner filter").click();
    });
    expect(screen.queryByLabelText("Remove owner filter")).toBeNull();
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
    expect(screen.getByLabelText("Remove owner filter")).toBeTruthy();
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

describe("BoardFilters field filters", () => {
  const field = (over: Record<string, unknown>) =>
    ({
      _id: "f1",
      name: "Component",
      fieldType: "dropdown",
      options: [],
      required: false,
      order: 1,
      showOnCard: false,
      showInList: true,
      filterable: true,
      archived: false,
      ...over,
    }) as unknown as ApiCustomField;

  function openFilters(fields: ApiCustomField[]) {
    renderFilters({ customFields: fields });
    act(() => {
      (screen.getByRole("button", { name: "Filters" }) as HTMLButtonElement).click();
    });
  }

  // The picker's only entry would be "All", so it could never narrow anything
  it("hides an option field that has no options", () => {
    openFilters([field({ options: [] })]);
    expect(screen.queryByLabelText("Component")).toBeNull();
  });

  it("shows an option field once it has options", () => {
    openFilters([
      field({ options: [{ id: "o1", value: "ui", color: "#fff", order: 1 }] }),
    ]);
    expect(screen.getByLabelText("Component")).toBeTruthy();
  });

  // These carry their own values rather than a list, so emptiness means nothing
  it("keeps a text field with no options", () => {
    openFilters([field({ fieldType: "text", name: "Notes" })]);
    expect(screen.getByLabelText("Notes")).toBeTruthy();
  });
});

describe("BoardFilters unassigned", () => {
  // "" already means "any assignee", so the empty case needs a value of its own
  it("keeps only tasks with nobody assigned", async () => {
    const { onFilter } = renderFilters();
    act(() => {
      (screen.getByRole("button", { name: "Filters" }) as HTMLButtonElement).click();
    });
    const select = screen.getByLabelText("Assignee") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toContain("Unassigned");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
        select,
        "@none"
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const last = onFilter.mock.calls.at(-1)?.[0] as ApiTask[];
    expect(last.map((t) => t._id).sort()).toEqual(["1", "3"]);
  });
});
