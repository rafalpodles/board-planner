// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

// Every field the hook exposes; individual tests override only what they need
function makeBoard(overrides: Partial<ProjectBoard> = {}): ProjectBoard {
  return {
    project,
    tasks: [],
    sprints: [],
    assignableUsers: [],
    loading: false,
    reload: vi.fn(),
    viewMode: "board",
    loadedScope: undefined,
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
    confirmContextDelete: null,
    setConfirmContextDelete: vi.fn(),
    heldMove: null,
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
