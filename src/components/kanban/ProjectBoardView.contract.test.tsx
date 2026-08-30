// @vitest-environment happy-dom
//
// The read-only flag reaches Board and ListView through roughly a dozen independent
// ternaries in ProjectBoardView, one per write-carrying prop. Nothing stops a fifteenth
// prop, added later, from being wired straight through and forgotten. This test does not
// know the list in advance: it captures every prop ProjectBoardView actually passes and
// requires each one to be named on a small read-safe allowlist, or be undefined under
// readOnly. An unlisted write prop fails loudly instead of shipping quietly.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ProjectBoardView } from "./ProjectBoardView";
import { ProjectBoard } from "@/hooks/use-project-board";
import { ApiProject, ApiTask } from "@/types";

let boardProps: Record<string, unknown> | null = null;
let listProps: Record<string, unknown> | null = null;

vi.mock("./Board", () => ({
  Board: (props: Record<string, unknown>) => {
    boardProps = props;
    return null;
  },
}));
vi.mock("./ListView", () => ({
  ListView: (props: Record<string, unknown>) => {
    listProps = props;
    return null;
  },
}));
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
    tasks,
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

// Everything ProjectBoardView hands down that is not a write. A prop must be named here
// on purpose; anything else has to come back undefined once readOnly is set.
const BOARD_READ_SAFE_PROPS = new Set([
  "tasks",
  "projectKey",
  "customFields",
  "projectCategories",
  "columns",
  "collapseEmptyColumns",
  "onTaskClick",
  "readOnly",
]);

const LIST_READ_SAFE_PROPS = new Set([
  "tasks",
  "projectKey",
  "projectId",
  "customFields",
  "sprints",
  "categories",
  "columns",
  "focusedIndex",
  "sortField",
  "sortDir",
  "onSortChange",
  "hiddenColumns",
  "assignableUsers",
  "onTaskClick",
]);

afterEach(() => {
  cleanup();
  boardProps = null;
  listProps = null;
});

describe("ProjectBoardView's read-only contract with Board", () => {
  it("withholds every prop not on the read-safe allowlist", () => {
    render(<ProjectBoardView board={makeBoard()} readOnly pinViewMode="board" />);
    expect(boardProps).toBeTruthy();
    for (const [key, value] of Object.entries(boardProps!)) {
      if (BOARD_READ_SAFE_PROPS.has(key)) continue;
      expect(value, `Board prop "${key}" must be withheld when readOnly`).toBeUndefined();
    }
  });

  it("still supplies those props when not read-only, so the gate is real", () => {
    render(<ProjectBoardView board={makeBoard()} pinViewMode="board" />);
    for (const key of Object.keys(boardProps!)) {
      if (BOARD_READ_SAFE_PROPS.has(key)) continue;
      expect(boardProps![key], `Board prop "${key}" should be supplied outside readOnly`).toBeDefined();
    }
  });
});

describe("ProjectBoardView's read-only contract with ListView", () => {
  it("withholds every prop not on the read-safe allowlist", () => {
    render(<ProjectBoardView board={makeBoard()} readOnly pinViewMode="list" />);
    expect(listProps).toBeTruthy();
    for (const [key, value] of Object.entries(listProps!)) {
      if (LIST_READ_SAFE_PROPS.has(key)) continue;
      expect(value, `ListView prop "${key}" must be withheld when readOnly`).toBeUndefined();
    }
  });

  it("still supplies those props when not read-only, so the gate is real", () => {
    render(<ProjectBoardView board={makeBoard()} pinViewMode="list" />);
    for (const key of Object.keys(listProps!)) {
      if (LIST_READ_SAFE_PROPS.has(key)) continue;
      expect(listProps![key], `ListView prop "${key}" should be supplied outside readOnly`).toBeDefined();
    }
  });
});
