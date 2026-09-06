// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ProjectBoardView } from "./ProjectBoardView";
import { ProjectBoard } from "@/hooks/use-project-board";
import { ApiProject, ApiTask } from "@/types";

vi.mock("@/hooks/use-api", () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { username: "rpo", collapseEmptyColumns: false }, isAdmin: false }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

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

  it("does not open the new-task modal on the n shortcut", () => {
    render(<ProjectBoardView board={makeBoard({ tasks })} readOnly />);
    fireEvent.keyDown(document, { key: "n" });
    expect(screen.queryByRole("heading", { name: "New Task" })).toBeNull();
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
});

describe("ProjectBoardView's loadedScope gate", () => {
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
});
