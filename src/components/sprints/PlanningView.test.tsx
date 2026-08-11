// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PlanningView } from "./PlanningView";
import { ProjectBoard } from "@/hooks/use-project-board";
import { ApiProject, ApiSprint, ApiTask } from "@/types";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const project = {
  _id: "p1",
  key: "TP",
  name: "Test Project",
  columns: [
    { id: "todo", label: "To Do", color: "#3b82f6", role: "approved", order: 0 },
    // A done-role column under an id nothing hardcodes — pins that filtering goes through
    // columnIdsWithRole rather than a literal "done" comparison
    { id: "shipped", label: "Shipped", color: "#22c55e", role: "done", order: 1 },
  ],
  categories: [],
  customFields: [],
  taskTemplates: [],
} as unknown as ApiProject;

const sprints = [
  {
    _id: "s1",
    name: "Sprint 12",
    startDate: "2026-07-20T00:00:00Z",
    endDate: "2026-08-03T00:00:00Z",
    goal: "",
    status: "active",
    taskCount: 1,
    doneCount: 0,
  },
] as ApiSprint[];

const sprintTasks = [
  {
    _id: "t9",
    taskNumber: 9,
    title: "Ship the header",
    status: "todo",
    priority: "medium",
    category: "bug",
    order: 0,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
] as ApiTask[];

// One of the three sits in the done-role column; while the filter box is empty it is the
// difference between this list's length and the "Backlog (2)" count the pane shows
const backlogTasks = [
  {
    _id: "t1",
    taskNumber: 1,
    title: "Fix the login redirect",
    status: "todo",
    priority: "medium",
    category: "bug",
    order: 0,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
  {
    _id: "t2",
    taskNumber: 2,
    title: "Rename the export button",
    status: "todo",
    priority: "medium",
    category: "bug",
    order: 1,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
  {
    _id: "t3",
    taskNumber: 3,
    title: "Already shipped",
    status: "shipped",
    priority: "medium",
    category: "bug",
    order: 2,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
] as ApiTask[];

// Every field the hook exposes; PlanningView only reads project/tasks/sprints/applySprintChange,
// but it is typed to take the whole ProjectBoard
function makeBoard(overrides: Partial<ProjectBoard> = {}): ProjectBoard {
  return {
    project,
    tasks: sprintTasks,
    sprints,
    assignableUsers: [],
    loading: false,
    loadError: false,
    reload: vi.fn(),
    viewMode: "board",
    setViewMode: vi.fn(),
    showNewTask: false,
    setShowNewTask: vi.fn(),
    scope: "s1",
    loadedScope: "s1",
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

async function renderPlanning(overrides: Partial<ProjectBoard> = {}) {
  api.get.mockImplementation((url: string) => {
    if (url === "/api/projects/p1/tasks?sprint=backlog") {
      return Promise.resolve(backlogTasks.map((t) => ({ ...t })));
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });

  const board = makeBoard(overrides);
  const view = render(<PlanningView projectId="p1" board={board} sprintId="s1" />);
  // The backlog fetch is the async part; everything else is already on `board`
  await screen.findByText("Backlog (2)");
  return view;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(cleanup);

describe("PlanningView", () => {
  it("loads the backlog with the existing filter rather than a new one", async () => {
    await renderPlanning();
    expect(api.get).toHaveBeenCalledWith("/api/projects/p1/tasks?sprint=backlog");
  });

  it("shows a count on each pane", async () => {
    await renderPlanning();
    expect(screen.getByText("Backlog (2)")).toBeTruthy();
    expect(screen.getByText("Sprint 12 (1)")).toBeTruthy();
  });

  it("narrows the backlog with the text filter", async () => {
    await renderPlanning();
    fireEvent.change(screen.getByPlaceholderText("Filter backlog"), {
      target: { value: "login" },
    });
    expect(screen.getByText("Fix the login redirect")).toBeTruthy();
    expect(screen.queryByText("Rename the export button")).toBeNull();
  });

  it("hides a task sitting in a done column until something is typed", async () => {
    await renderPlanning();
    expect(screen.queryByText("Already shipped")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Filter backlog"), {
      target: { value: "shipped" },
    });
    expect(screen.getByText("Already shipped")).toBeTruthy();
  });
});
