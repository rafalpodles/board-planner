// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor, within } from "@testing-library/react";
import { BoardFilters } from "./BoardFilters";
import { ApiCustomField, ApiTask } from "@/types";
import { UNFILED } from "@/lib/board-filters-state";
import type { ApiSavedView } from "@/types";

vi.mock("@/hooks/use-api", () => ({
  useApi: () => ({ get: vi.fn(async () => []), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

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

// BP-915: archived tasks are loaded by whoever owns the task list, so the option is handed up
describe("BoardFilters and archived tasks", () => {
  it("offers Show archived, and reports the choice upwards", async () => {
    const onShowArchivedChange = vi.fn();
    renderFilters({ onShowArchivedChange });
    await openPopover();

    await act(async () => screen.getByRole("checkbox", { name: "Show archived" }).click());

    expect(onShowArchivedChange).toHaveBeenCalledWith(true);
  });

  it("gives the checkbox's label a phone-sized touch target, like the buttons beside it", async () => {
    renderFilters({ onShowArchivedChange: vi.fn() });
    await openPopover();

    const label = screen.getByRole("checkbox", { name: "Show archived" }).closest("label")!;
    expect(label.className).toContain("min-h-11");
    expect(label.className).toContain("sm:min-h-[36px]");
  });

  it("offers nothing where the host does not load archived tasks", async () => {
    renderFilters();
    await openPopover();

    expect(screen.queryByRole("checkbox", { name: "Show archived" })).toBeNull();
  });

  it("counts it as an active filter, says so in a chip, and clears it with the rest", async () => {
    const onShowArchivedChange = vi.fn();
    renderFilters({ showArchived: true, onShowArchivedChange });
    await openPopover();

    const popover = within(screen.getByRole("dialog", { name: "Filters" }));
    expect(popover.getByText("Archived shown")).toBeTruthy();
    expect((popover.getByRole("checkbox", { name: "Show archived" }) as HTMLInputElement).checked).toBe(true);
    await act(async () => popover.getByRole("button", { name: "Clear all" }).click());

    expect(onShowArchivedChange).toHaveBeenCalledWith(false);
  });
});

describe("BoardFilters archived tasks while Show archived is off", () => {
  const withArchived = [...tasks, task({ _id: "4", taskNumber: 4, title: "Old", archivedAt: "2026-10-05T10:00:00.000Z" })];

  it("hands on no archived task until the choice is on, even if the list still holds one", () => {
    const { onFilter } = renderFilters({ tasks: withArchived, showArchived: false });
    expect((onFilter.mock.calls.at(-1)?.[0] as ApiTask[]).map((t) => t._id)).toEqual(["1", "2", "3"]);
  });

  it("hands them on once it is on", () => {
    const { onFilter } = renderFilters({ tasks: withArchived, showArchived: true });
    expect((onFilter.mock.calls.at(-1)?.[0] as ApiTask[]).map((t) => t._id)).toContain("4");
  });
});

describe("BoardFilters epic", () => {
  const link = (id: string, taskNumber: number, title: string) => ({ _id: id, taskNumber, title, status: "todo" });
  const epics = [
    task({ _id: "e1", taskNumber: 10, title: "Epic one", relations: [{ type: "parent_of", task: link("a", 11, "A") }] } as never),
    task({ _id: "e2", taskNumber: 20, title: "Epic two", relations: [{ type: "parent_of", task: link("c", 21, "C") }] } as never),
    task({ _id: "a", taskNumber: 11, title: "A", parent: link("e1", 10, "Epic one") } as never),
    task({ _id: "b", taskNumber: 12, title: "B, nobody's child" }),
    task({ _id: "c", taskNumber: 21, title: "C", parent: link("e2", 20, "Epic two") } as never),
  ];

  async function pick(value: string) {
    const select = screen.getByLabelText("Epic") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  const titlesShown = (onFilter: ReturnType<typeof vi.fn>) =>
    (onFilter.mock.calls.at(-1)![0] as ApiTask[]).map((t) => t.title).sort();

  it("offers the tasks that have children, named by key, and hides itself on a board with none", async () => {
    const { unmount } = renderFilters({ tasks: epics });
    await openPopover();
    const select = screen.getByLabelText("Epic") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["All epics", "TP-10 Epic one", "TP-20 Epic two"]);
    unmount();

    renderFilters();
    await openPopover();
    expect(screen.queryByLabelText("Epic")).toBeNull();
  });

  it("keeps only the children of the chosen epic, and a different epic changes it", async () => {
    const { onFilter } = renderFilters({ tasks: epics });
    await openPopover();

    await pick("e1");
    expect(titlesShown(onFilter)).toEqual(["A"]);

    await pick("e2");
    expect(titlesShown(onFilter)).toEqual(["C"]);

    await pick("");
    expect(titlesShown(onFilter)).toHaveLength(5);
  });

  it("offers an epic whose children are on the board and which is not, as a sprint's board has it", async () => {
    const onlyChild = [task({ _id: "a", taskNumber: 11, title: "A", parent: link("e1", 10, "Epic one") } as never)];
    renderFilters({ tasks: onlyChild });
    await openPopover();

    expect([...(screen.getByLabelText("Epic") as HTMLSelectElement).options].map((o) => o.value)).toContain("e1");
  });

  it("counts on the pill, shows a chip that clears it, and survives a reload", async () => {
    const { onFilter, unmount } = renderFilters({ tasks: epics });
    await openPopover();
    await pick("e1");

    expect(screen.getByLabelText("Remove Epic TP-10 filter")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Filters/ }).textContent).toContain("1");
    unmount();

    const again = renderFilters({ tasks: epics });
    await waitFor(() => expect(titlesShown(again.onFilter)).toEqual(["A"]));

    await act(async () => {
      screen.getByLabelText("Remove Epic TP-10 filter").click();
    });
    expect(titlesShown(again.onFilter)).toHaveLength(5);
    void onFilter;
  });

  it("leaves a chip to clear for a stored epic that is gone, rather than a filter nobody can see", async () => {
    localStorage.setItem(
      "board-filters:TP",
      JSON.stringify({ filters: { epic: "gone" }, sortField: "manual", sortDir: "asc", showFilters: false, hiddenColumns: [] })
    );
    const { onFilter } = renderFilters({ tasks: epics });
    await waitFor(() => expect(titlesShown(onFilter)).toEqual([]));

    await openPopover();
    expect(screen.getByLabelText("Remove Epic filter")).toBeTruthy();
    expect([...(screen.getByLabelText("Epic") as HTMLSelectElement).options].map((o) => o.textContent)).toContain(
      "Epic (not in this view)"
    );
    await act(async () => {
      screen.getByLabelText("Remove Epic filter").click();
    });
    expect(titlesShown(onFilter)).toHaveLength(5);
  });
});

const view = (over: Partial<ApiSavedView> = {}): ApiSavedView => ({
  _id: "v1",
  name: "A view",
  shared: false,
  mine: true,
  canEdit: true,
  filters: {},
  search: "",
  sortField: "manual",
  sortDir: "asc",
  viewMode: "board",
  groupBy: "",
  sprintScope: "all",
  hiddenColumns: [],
  ...over,
});

const lastShown = (onFilter: ReturnType<typeof vi.fn>) =>
  (onFilter.mock.calls.at(-1)![0] as ApiTask[]).map((t) => t.title);

const viewsProp = (onApplied = vi.fn()) => ({
  projectRef: "TP",
  canShare: false,
  viewMode: "board" as const,
  sprintScope: "all",
  onApplied,
});

describe("the assignee filter's Me", () => {
  const stored = (assignee: string) =>
    localStorage.setItem("board-filters:TP", JSON.stringify({ filters: { assignee } }));

  it("keeps the tasks of whoever is looking, and a different person sees theirs", async () => {
    stored("@me");
    const mine = renderFilters({ currentUsername: "owner" });
    await waitFor(() => expect(lastShown(mine.onFilter)).toEqual(["Assigned work"]));
    mine.unmount();

    const other = renderFilters({ currentUsername: "somebody-else" });
    await waitFor(() => expect(lastShown(other.onFilter)).toEqual([]));
  });

  it("says Me on the chip and offers it in the picker, and counts as a filter", async () => {
    stored("@me");
    renderFilters();
    await openPopover();

    const popover = screen.getByRole("dialog", { name: "Filters" });
    expect(within(popover).getByText("Me", { selector: "span" })).toBeTruthy();
    expect((within(popover).getByLabelText("Assignee") as HTMLSelectElement).value).toBe("@me");
    expect(screen.getByText("Filters").parentElement!.textContent).toContain("1");
  });
});

describe("applying a saved view", () => {
  it("replaces what was set with the view's filters, sort, grouping and columns, once", async () => {
    localStorage.setItem("board-filters:TP", JSON.stringify({ filters: { priority: "low" } }));
    const onGroupByChange = vi.fn();
    const onHiddenColumnsChange = vi.fn();
    const onApplied = vi.fn();
    const onPendingViewApplied = vi.fn();
    const { onFilter, onSortChange } = renderFilters({
      onGroupByChange,
      onHiddenColumnsChange,
      views: viewsProp(onApplied),
      pendingView: view({
        filters: { priority: "urgent" },
        sortField: "title",
        sortDir: "desc",
        groupBy: "priority",
        hiddenColumns: ["category"],
      }),
      onPendingViewApplied,
    });

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(lastShown(onFilter)).toEqual(["Urgent bug"]);
    expect(onSortChange).toHaveBeenLastCalledWith("title", "desc");
    expect(onGroupByChange).toHaveBeenLastCalledWith("priority");
    expect(onHiddenColumnsChange).toHaveBeenLastCalledWith(["category"]);
    expect(onPendingViewApplied).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("board-filters:TP")!).filters.priority).toBe("urgent");
  });

  it("applies its search text, and shows it as a chip that clears it", async () => {
    const { onFilter } = renderFilters({ views: viewsProp(), pendingView: view({ search: "chore" }), onPendingViewApplied: vi.fn() });
    await waitFor(() => expect(lastShown(onFilter)).toEqual(["Low chore"]));

    await openPopover();
    fireEvent.click(screen.getByRole("button", { name: "Remove Search: chore filter" }));

    await waitFor(() => expect(lastShown(onFilter)).toHaveLength(3));
  });

  it("waits for the stored filters to be read, so they cannot overwrite the view", async () => {
    localStorage.setItem("board-filters:TP", JSON.stringify({ filters: { priority: "low" } }));
    const { onFilter } = renderFilters({
      views: viewsProp(),
      pendingView: view({ filters: { category: "bug" } }),
      onPendingViewApplied: vi.fn(),
    });

    await waitFor(() => expect(lastShown(onFilter)).toHaveLength(3));
    expect(JSON.parse(localStorage.getItem("board-filters:TP")!).filters).toMatchObject({ category: "bug", priority: "" });
  });

  describe("a person it names", () => {
    const named = (assignee: string, over: Partial<React.ComponentProps<typeof BoardFilters>> = {}) =>
      renderFilters({
        views: viewsProp(),
        knownAssignees: ["owner"],
        pendingView: view({ filters: { assignee } }),
        onPendingViewApplied: vi.fn(),
        ...over,
      });

    it("is dropped when they are on no task and not on the roster", async () => {
      const { onFilter } = named("left-the-company");
      await waitFor(() => expect(lastShown(onFilter)).toHaveLength(3));
    });

    it("is kept when a task carries them, as a machine does, though the roster leaves them out", async () => {
      const withBot = [
        ...tasks,
        task({ _id: "4", taskNumber: 4, title: "Bot work", assignee: { _id: "m1", username: "worker-bot" } } as Partial<ApiTask> & { _id: string }),
      ];
      const { onFilter } = named("worker-bot", { tasks: withBot });
      await waitFor(() => expect(lastShown(onFilter)).toEqual(["Bot work"]));
    });

    it("is kept when the roster has them", async () => {
      const { onFilter } = named("owner");
      await waitFor(() => expect(lastShown(onFilter)).toEqual(["Assigned work"]));
    });
  });
});
