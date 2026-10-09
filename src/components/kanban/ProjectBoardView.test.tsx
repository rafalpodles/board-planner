// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ProjectBoardView } from "./ProjectBoardView";
import { ProjectBoard } from "@/hooks/use-project-board";
import { ApiProject, ApiTask } from "@/types";
import { OWNS_ITS_KEYS } from "@/lib/keyboard-scope";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { username: "owner", collapseEmptyColumns: false }, isAdmin: false }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const project = {
  _id: "p1",
  key: "TP",
  name: "Test Project",
  columns: [{ id: "todo", label: "To Do", color: "#3b82f6", role: "approved", order: 0 }],
  categories: [],
  customFields: [],
  taskTemplates: [],
} as unknown as ApiProject;

const tasks = [
  {
    _id: "t1",
    taskNumber: 1,
    title: "A bug",
    status: "todo",
    priority: "medium",
    category: "bug",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
] as ApiTask[];

// Every field the hook exposes; individual tests override only what they need
function makeBoard(overrides: Partial<ProjectBoard> = {}): ProjectBoard {
  return {
    project,
    tasks: [],
    sprints: [],
    assignableUsers: [],
    loading: false,
    loadError: false,
    reload: vi.fn(),
    viewMode: "board",
    loadedScope: "all",
    setViewMode: vi.fn(),
    showNewTask: false,
    setShowNewTask: vi.fn(),
    scope: "all",
    selectedTasks: new Set(),
    setSelectedTasks: vi.fn(),
    selectionMode: false,
    setSelectionMode: vi.fn(),
    confirmBulkDelete: false,
    setConfirmBulkDelete: vi.fn(),
    bulkDeleting: false,
    deleting: false,
    confirmContextDelete: null,
    setConfirmContextDelete: vi.fn(),
    heldMove: null,
    heldDelete: null,
    setHeldDelete: () => {},
    forceHeldDelete: async () => {},
    setHeldMove: vi.fn(),
    forceHeldMove: vi.fn(),
    forcing: false,
    handleStatusChange: vi.fn(),
    handleTaskDrop: vi.fn(),
    handleReorder: vi.fn(),
    handleBulkMove: vi.fn(),
    handleBulkSprint: vi.fn(),
    handleBulkDelete: vi.fn(),
    applySprintChange: vi.fn(),
    patchTask: vi.fn(),
    handleAssigneeChange: vi.fn(),
    handleFieldValueChange: vi.fn(),
    handleRowSprintChange: vi.fn(),
    handleContextDuplicate: vi.fn(),
    handleContextDelete: vi.fn(),
    showArchived: false,
    setShowArchived: vi.fn(),
    heldArchive: null,
    setHeldArchive: vi.fn(),
    forceHeldArchive: vi.fn(),
    handleContextArchive: vi.fn(),
    handleContextRestore: vi.fn(),
    handleBulkArchive: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe("A read-only ProjectBoardView", () => {
  it("does not offer the empty-state Create Task button", () => {
    render(<ProjectBoardView board={makeBoard({ tasks: [] })} readOnly />);
    expect(screen.queryByRole("button", { name: "Create Task" })).toBeNull();
  });

  it("still offers the Create Task button when not read-only", () => {
    render(<ProjectBoardView board={makeBoard({ tasks: [] })} />);
    expect(screen.getByRole("button", { name: "Create Task" })).toBeTruthy();
  });

  it("does not carry a selection made elsewhere into a read-only render", () => {
    render(
      <ProjectBoardView
        board={makeBoard({ tasks, selectedTasks: new Set(["t1"]) })}
        readOnly
      />
    );
    const card = screen.getByRole("link", { name: /A bug/i });
    expect(card.className).not.toContain("border-primary");
  });

  it("paints the card as selected outside read-only mode", () => {
    render(<ProjectBoardView board={makeBoard({ tasks, selectedTasks: new Set(["t1"]) })} />);
    const card = screen.getByRole("link", { name: /A bug/i });
    expect(card.className).toContain("border-primary");
  });
});

describe("A read-only ProjectBoardView's other write paths", () => {
  it("does not offer the Select control", () => {
    render(<ProjectBoardView board={makeBoard({ tasks })} readOnly />);
    expect(screen.queryByRole("button", { name: /^Select/ })).toBeNull();
  });

  it("still offers the Select control when not read-only", () => {
    render(<ProjectBoardView board={makeBoard({ tasks })} />);
    expect(screen.getByRole("button", { name: /^Select/ })).toBeTruthy();
  });

  /**
   * The call rather than the modal: readOnly withholds the modal at the render too, so an
   * assertion that only looks for it stays green with the handler's own `!readOnly` deleted.
   * A test that did exactly that stood here and was removed with this one's arrival — measured,
   * not reasoned about: no single mutation could turn it red, the render gate included, which
   * "never mounts the new-task modal, even if showNewTask is already true" pins on its own.
   */
  it("does not even ask for the new-task modal on the n shortcut", () => {
    const setShowNewTask = vi.fn();
    render(<ProjectBoardView board={makeBoard({ tasks, setShowNewTask })} readOnly />);
    fireEvent.keyDown(document, { key: "n" });
    expect(setShowNewTask).not.toHaveBeenCalled();
  });

  it("opens the new-task modal on the n shortcut when not read-only", () => {
    const setShowNewTask = vi.fn();
    render(<ProjectBoardView board={makeBoard({ tasks, setShowNewTask })} />);
    fireEvent.keyDown(document, { key: "n" });
    expect(setShowNewTask).toHaveBeenCalledWith(true);
  });

  it("never mounts the new-task modal, even if showNewTask is already true", () => {
    render(<ProjectBoardView board={makeBoard({ tasks, showNewTask: true })} readOnly />);
    expect(screen.queryByRole("heading", { name: "New Task" })).toBeNull();
  });

  it("does not open the context menu on right-click", () => {
    render(<ProjectBoardView board={makeBoard({ tasks })} readOnly />);
    const card = screen.getByRole("link", { name: /A bug/i });
    fireEvent.contextMenu(card);
    expect(screen.queryByText("Duplicate")).toBeNull();
  });

  it("still opens the context menu on right-click when not read-only", () => {
    render(<ProjectBoardView board={makeBoard({ tasks })} />);
    const card = screen.getByRole("link", { name: /A bug/i });
    fireEvent.contextMenu(card);
    expect(screen.getByText("Duplicate")).toBeTruthy();
  });

  // A sprint can complete while the menu from an earlier, still-open right-click is on
  // screen; onTaskContextMenu being withheld only stops a NEW menu from opening.
  it("closes an already-open context menu once readOnly turns on", () => {
    const { rerender } = render(<ProjectBoardView board={makeBoard({ tasks })} />);
    const card = screen.getByRole("link", { name: /A bug/i });
    fireEvent.contextMenu(card);
    expect(screen.getByText("Duplicate")).toBeTruthy();

    rerender(<ProjectBoardView board={makeBoard({ tasks })} readOnly />);
    expect(screen.queryByText("Duplicate")).toBeNull();
  });

  it("closes an already-open delete confirmation once readOnly turns on", () => {
    const { rerender } = render(
      <ProjectBoardView board={makeBoard({ tasks, confirmContextDelete: "t1" })} />
    );
    expect(screen.getByRole("heading", { name: "Delete Task" })).toBeTruthy();

    rerender(
      <ProjectBoardView board={makeBoard({ tasks, confirmContextDelete: "t1" })} readOnly />
    );
    expect(screen.queryByRole("heading", { name: "Delete Task" })).toBeNull();
  });

  it("closes an already-open bulk-delete confirmation once readOnly turns on", () => {
    const { rerender } = render(
      <ProjectBoardView board={makeBoard({ tasks, confirmBulkDelete: true })} />
    );
    expect(screen.getByRole("heading", { name: "Delete Selected Tasks" })).toBeTruthy();

    rerender(
      <ProjectBoardView board={makeBoard({ tasks, confirmBulkDelete: true })} readOnly />
    );
    expect(screen.queryByRole("heading", { name: "Delete Selected Tasks" })).toBeNull();
  });
});

describe("ProjectBoardView's pinViewMode prop", () => {
  it("renders the board even when the stored preference is list", () => {
    const { container } = render(
      <ProjectBoardView board={makeBoard({ tasks, viewMode: "list" })} pinViewMode="board" />
    );
    expect(screen.getByTestId("column-todo")).toBeTruthy();
    expect(container.querySelector("table")).toBeNull();
  });

  it("renders list view when the stored preference is list and nothing is pinned", () => {
    const { container } = render(<ProjectBoardView board={makeBoard({ tasks, viewMode: "list" })} />);
    expect(container.querySelector("table")).toBeTruthy();
    expect(screen.queryByTestId("column-todo")).toBeNull();
  });

  it("leaves the view alone when v is pressed on a pinned board", () => {
    const setViewMode = vi.fn();
    render(<ProjectBoardView board={makeBoard({ tasks, setViewMode })} pinViewMode="board" />);
    fireEvent.keyDown(document, { key: "v" });
    expect(setViewMode).not.toHaveBeenCalled();
  });

  it("switches the view on v when nothing is pinned", () => {
    const setViewMode = vi.fn();
    render(<ProjectBoardView board={makeBoard({ tasks, setViewMode })} />);
    fireEvent.keyDown(document, { key: "v" });
    expect(setViewMode).toHaveBeenCalledWith("list");
  });
});

/**
 * The tag test stands on its own rather than being folded into one shortcut's test: the handler
 * reads the three tags on a single line, and dropping one of them leaves the other two green.
 */
/**
 * BP-654. A non-modal panel is on screen without being a layer, so `openLayerCount()` does not see
 * it and every board shortcut stayed live behind the PM chat. The rule is the subtree, not the
 * component: the board asks `ownsItsKeys`, and whatever sets the attribute is answered for.
 */
describe("ProjectBoardView and a surface that owns its keys", () => {
  it("fires no shortcut from inside one", () => {
    const setShowNewTask = vi.fn();
    const setViewMode = vi.fn();
    const reload = vi.fn();
    const { container } = render(
      <ProjectBoardView board={makeBoard({ tasks, setShowNewTask, setViewMode, reload })} />
    );
    const panel = container.appendChild(document.createElement("div"));
    panel.setAttribute(OWNS_ITS_KEYS, "");
    const button = panel.appendChild(document.createElement("button"));

    for (const key of ["v", "r", "n", "?"]) fireEvent.keyDown(button, { key });

    expect(setShowNewTask).not.toHaveBeenCalled();
    expect(setViewMode).not.toHaveBeenCalled();
    // `r` is in the loop above, so it is asserted here rather than left as a key nobody watches
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Keyboard Shortcuts" })).toBeNull();
  });

  // The control, and the point of the whole design: the board keeps its keys while the panel is
  // open, because the panel is not a layer
  it("fires them from a button that is not inside one", () => {
    const setShowNewTask = vi.fn();
    const { container } = render(
      <ProjectBoardView board={makeBoard({ tasks, setShowNewTask })} />
    );
    const elsewhere = container.appendChild(document.createElement("button"));

    fireEvent.keyDown(elsewhere, { key: "n" });

    expect(setShowNewTask).toHaveBeenCalledWith(true);
  });

  it("leaves Escape to the board when it was pressed outside one", () => {
    const setSelectedTasks = vi.fn();
    const { container } = render(
      <ProjectBoardView board={makeBoard({ tasks, setSelectedTasks })} />
    );
    const panel = container.appendChild(document.createElement("div"));
    panel.setAttribute(OWNS_ITS_KEYS, "");

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(setSelectedTasks).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(setSelectedTasks).toHaveBeenCalled();
  });
});

describe("ProjectBoardView's typed-field guard", () => {
  for (const tag of ["input", "textarea", "select"] as const) {
    it(`fires no shortcut from a ${tag}`, () => {
      const setShowNewTask = vi.fn();
      const setViewMode = vi.fn();
      const { container } = render(
        <ProjectBoardView board={makeBoard({ tasks, setShowNewTask, setViewMode })} />
      );
      const target = container.appendChild(document.createElement(tag));

      fireEvent.keyDown(target, { key: "n" });
      fireEvent.keyDown(target, { key: "v" });
      fireEvent.keyDown(target, { key: "?" });

      expect(setShowNewTask).not.toHaveBeenCalled();
      expect(setViewMode).not.toHaveBeenCalled();
      expect(screen.queryByRole("heading", { name: "Keyboard Shortcuts" })).toBeNull();
    });
  }

  // BP-656: the arm the board's own copy of this rule was missing, before both call sites moved
  // to `isTypingTarget`. No product surface is contentEditable today, so this is the test that
  // keeps the rule the docs promise from rotting before the first rich-text field arrives.
  it("fires no shortcut from a contentEditable element", () => {
    const setShowNewTask = vi.fn();
    const setViewMode = vi.fn();
    const { container } = render(
      <ProjectBoardView board={makeBoard({ tasks, setShowNewTask, setViewMode })} />
    );
    const target = container.appendChild(document.createElement("div"));
    target.setAttribute("contenteditable", "true");

    fireEvent.keyDown(target, { key: "n" });
    fireEvent.keyDown(target, { key: "v" });
    fireEvent.keyDown(target, { key: "?" });

    expect(setShowNewTask).not.toHaveBeenCalled();
    expect(setViewMode).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Keyboard Shortcuts" })).toBeNull();
  });

  // The control: the same three keys, dispatched anywhere else, all land
  it("fires every one of them from outside a field", () => {
    const setShowNewTask = vi.fn();
    const setViewMode = vi.fn();
    render(<ProjectBoardView board={makeBoard({ tasks, setShowNewTask, setViewMode })} />);

    fireEvent.keyDown(document, { key: "n" });
    fireEvent.keyDown(document, { key: "v" });
    fireEvent.keyDown(document, { key: "?" });

    expect(setShowNewTask).toHaveBeenCalledWith(true);
    expect(setViewMode).toHaveBeenCalledWith("list");
    expect(screen.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeTruthy();
  });
});

describe("ProjectBoardView's loadedScope gate", () => {
  // board.tasks still holds the previous scope's list until its own request lands;
  // showing them under the new scope would be the board stating something untrue
  it("shows a spinner instead of stale cards while the new scope's tasks are in flight", () => {
    render(
      <ProjectBoardView board={makeBoard({ tasks, scope: "sprint-2", loadedScope: "sprint-1" })} />
    );
    expect(screen.queryByText("A bug")).toBeNull();
    expect(screen.getByRole("status", { name: "Loading tasks" })).toBeTruthy();
  });

  it("keeps the filter bar visible while the task area is blank", () => {
    render(
      <ProjectBoardView board={makeBoard({ tasks, scope: "sprint-2", loadedScope: "sprint-1" })} />
    );
    expect(screen.getByRole("button", { name: /^Select/ })).toBeTruthy();
  });

  it("renders the tasks once loadedScope catches up to scope", () => {
    render(<ProjectBoardView board={makeBoard({ tasks, scope: "sprint-2", loadedScope: "sprint-2" })} />);
    expect(screen.getByText("A bug")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading tasks" })).toBeNull();
  });

  it("does not blank the board on an ordinary poll that returns the same scope", () => {
    const { rerender } = render(
      <ProjectBoardView board={makeBoard({ tasks, scope: "all", loadedScope: "all" })} />
    );
    expect(screen.getByText("A bug")).toBeTruthy();

    rerender(<ProjectBoardView board={makeBoard({ tasks, scope: "all", loadedScope: "all" })} />);
    expect(screen.getByText("A bug")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading tasks" })).toBeNull();
  });
});

describe("ProjectBoardView's emptyState prop", () => {
  it("renders nothing when emptyState is explicitly null", () => {
    render(<ProjectBoardView board={makeBoard({ tasks: [] })} emptyState={null} />);
    expect(screen.queryByText("No tasks yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create Task" })).toBeNull();
  });

  it("renders the project's own default when emptyState is omitted", () => {
    render(<ProjectBoardView board={makeBoard({ tasks: [] })} />);
    expect(screen.getByText("No tasks yet")).toBeTruthy();
  });

  /**
   * BP-588 review. `ConfirmDialog` hard-coded "Deleting…" as its busy label, and this was the first
   * change to give the *move* dialog a busy state — so a forced move announced itself as a delete,
   * beside a message saying the task's work would be lost.
   */
  it("says what a forced move is doing, not what a delete would be", () => {
    render(
      <ProjectBoardView
        board={makeBoard({
          tasks,
          heldMove: {
            taskKey: "TP-1",
            conflict: { workerName: "mac", phase: "agent" } as never,
            retry: async () => {},
          },
          forcing: true,
        })}
      />
    );

    expect(screen.getByRole("button", { name: "Moving..." })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deleting..." })).toBeNull();
  });
});

const twoColumns = {
  ...project,
  columns: [
    { id: "todo", label: "To Do", color: "#3b82f6", role: "approved", order: 0 },
    { id: "shipped", label: "Shipped", color: "#22c55e", role: "done", order: 1 },
  ],
} as unknown as ApiProject;

describe("The list view with a filter that matches nothing", () => {
  // The panel's open state is persisted; without this the next click closes it
  beforeEach(() => localStorage.clear());

  function renderList() {
    return render(
      <ProjectBoardView
        board={makeBoard({ project: twoColumns, tasks, viewMode: "list" })}
        pinViewMode="list"
      />
    );
  }

  function filterToNothing() {
    fireEvent.click(screen.getByText("Filters"));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "done" } });
  }

  it("shows the rows while nothing is filtered", () => {
    renderList();
    expect(screen.getByText("A bug")).toBeTruthy();
    expect(screen.queryByText("No tasks match the filters")).toBeNull();
  });

  it("says so instead of rendering a blank page", () => {
    renderList();
    filterToNothing();

    expect(screen.queryByText("A bug")).toBeNull();
    expect(screen.getByText("No tasks match the filters")).toBeTruthy();
  });

  it("says search when a search is all that narrowed it", () => {
    renderList();
    fireEvent.change(screen.getByPlaceholderText(/Search tasks/), {
      target: { value: "nothing here matches" },
    });

    expect(screen.getByText("No tasks match the search")).toBeTruthy();
    expect(screen.queryByText("No tasks match the filters")).toBeNull();
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
  });

  it("offers a way back that actually brings the rows back", () => {
    renderList();
    fireEvent.change(screen.getByPlaceholderText(/Search tasks/), {
      target: { value: "nothing here matches" },
    });
    filterToNothing();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(screen.getByText("A bug")).toBeTruthy();
    expect(screen.queryByText("No tasks match the filters")).toBeNull();
  });
});

describe("The board view with a filter that matches nothing", () => {
  beforeEach(() => localStorage.clear());

  it("filters the cards away without the list's empty state", () => {
    render(<ProjectBoardView board={makeBoard({ project: twoColumns, tasks, viewMode: "board" })} />);
    expect(screen.getByText("A bug")).toBeTruthy();

    fireEvent.click(screen.getByText("Filters"));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "done" } });

    expect(screen.queryByText("A bug")).toBeNull();
    expect(screen.queryByText(/No tasks match/)).toBeNull();
    expect(screen.getByText("To Do")).toBeTruthy();
  });
});

describe("ProjectBoardView and a ?view= link", () => {
  const savedView = (over: Record<string, unknown> = {}) => ({
    _id: "v1",
    name: "Urgent list",
    shared: true,
    mine: false,
    canEdit: false,
    filters: {},
    search: "",
    sortField: "manual",
    sortDir: "asc",
    viewMode: "list",
    groupBy: "",
    sprintScope: "all",
    hiddenColumns: [],
    ...over,
  });

  const at = (url: string) => window.history.replaceState(null, "", url);

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    api.get.mockResolvedValue([]);
    at("/projects/TP");
  });

  it("applies the view it names, and takes the parameter off the address, keeping the rest", async () => {
    api.get.mockResolvedValue([savedView({ viewMode: "list", sprintScope: "s9" })]);
    at("/projects/TP?sprint=s9&view=v1#top");
    const setViewMode = vi.fn();
    const onScopeChange = vi.fn();

    render(
      <ProjectBoardView
        board={makeBoard({ tasks, setViewMode, sprints: [{ _id: "s9" } as never] })}
        onScopeChange={onScopeChange}
      />
    );

    await waitFor(() => expect(setViewMode).toHaveBeenCalledWith("list"));
    expect(window.location.search).toBe("?sprint=s9");
    expect(window.location.hash).toBe("#top");
    expect(api.get).toHaveBeenCalledWith("/api/projects/p1/views");
  });

  it("asks for the list once, however often it renders", async () => {
    at("/projects/TP?view=v1");
    const { rerender } = render(<ProjectBoardView board={makeBoard({ tasks })} />);
    rerender(<ProjectBoardView board={makeBoard({ tasks })} />);
    rerender(<ProjectBoardView board={makeBoard({ tasks })} />);

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  });

  it("says so, and still cleans the address, when the view is gone or not for this reader", async () => {
    api.get.mockResolvedValue([savedView({ _id: "other" })]);
    at("/projects/TP?view=v1");

    render(<ProjectBoardView board={makeBoard({ tasks })} />);

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("gone"), "error"));
    expect(window.location.search).toBe("");
  });

  it("says so when the views could not be read", async () => {
    api.get.mockRejectedValue(new Error("down"));
    at("/projects/TP?view=v1");

    render(<ProjectBoardView board={makeBoard({ tasks })} />);

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("could not be opened"), "error"));
  });

  it("does nothing without the parameter", async () => {
    render(<ProjectBoardView board={makeBoard({ tasks })} />);
    await Promise.resolve();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("leaves a pinned host alone, address included", async () => {
    at("/projects/TP?view=v1");

    render(<ProjectBoardView board={makeBoard({ tasks })} pinViewMode="board" readOnly />);
    await Promise.resolve();

    expect(api.get).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?view=v1");
    expect(screen.queryByRole("button", { name: "Views" })).toBeNull();
  });

  it("offers the Views menu on the board's own page", () => {
    render(<ProjectBoardView board={makeBoard({ tasks })} />);
    expect(screen.getByRole("button", { name: "Views" })).toBeTruthy();
  });

  it("moves to the view's sprint scope when the sprint exists, and to all when it does not", async () => {
    api.get.mockResolvedValue([savedView({ sprintScope: "ghost" })]);
    at("/projects/TP?view=v1");
    const onScopeChange = vi.fn();

    render(
      <ProjectBoardView board={makeBoard({ tasks, scope: "backlog" })} onScopeChange={onScopeChange} />
    );

    await waitFor(() => expect(onScopeChange).toHaveBeenCalledWith("all"));
  });

  it("leaves the scope alone when the view is already on it", async () => {
    api.get.mockResolvedValue([savedView({ sprintScope: "backlog" })]);
    at("/projects/TP?view=v1");
    const onScopeChange = vi.fn();
    const setViewMode = vi.fn();

    render(
      <ProjectBoardView board={makeBoard({ tasks, scope: "backlog", setViewMode })} onScopeChange={onScopeChange} />
    );

    await waitFor(() => expect(setViewMode).toHaveBeenCalled());
    expect(onScopeChange).not.toHaveBeenCalled();
  });
});
