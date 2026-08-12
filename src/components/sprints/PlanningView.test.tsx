// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { PlanningView } from "./PlanningView";
import { ProjectBoard } from "@/hooks/use-project-board";
import { ApiProject, ApiSprint, ApiTask } from "@/types";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

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
    sprint: "s1",
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
    sprint: null,
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
    sprint: null,
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
    sprint: null,
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

// Only "text/plain" carries the dragged task's id, mirroring the one key PlanningPane
// actually reads — a stub that answers every key alike would never notice the source
// asking for the wrong one.
function dataTransferFor(taskId: string) {
  return { getData: (key: string) => (key === "text/plain" ? taskId : "") };
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
  toast.mockReset();
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

  it("sets the sprint when a task is added", async () => {
    await renderPlanning();
    fireEvent.click(screen.getByRole("button", { name: "Add Fix the login redirect to the sprint" }));
    expect(api.put).toHaveBeenCalledWith("/api/projects/p1/tasks/t1", { sprint: "s1" });
  });

  it("clears the sprint when a task is removed", async () => {
    await renderPlanning();
    fireEvent.click(screen.getByRole("button", { name: "Remove Ship the header from the sprint" }));
    expect(api.put).toHaveBeenCalledWith("/api/projects/p1/tasks/t9", { sprint: null });
  });

  it("moves the row across before the server answers", async () => {
    let settle: (v: unknown) => void = () => {};
    api.put.mockImplementation(() => new Promise((r) => { settle = r; }));
    await renderPlanning();
    fireEvent.click(screen.getByRole("button", { name: /Add Fix the login redirect/ }));
    expect(screen.getByText("Backlog (1)")).toBeTruthy();
    settle({});
  });

  it("returns the task to the pane it came from when adding fails", async () => {
    api.put.mockRejectedValue(new Error("nope"));
    await renderPlanning();
    fireEvent.click(screen.getByRole("button", { name: /Add Fix the login redirect/ }));
    await waitFor(() => expect(screen.getByText("Backlog (2)")).toBeTruthy());
    expect(screen.getByText("Fix the login redirect")).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("Failed to move task", "error");
  });

  // The clicked button unmounts the instant its task leaves the pane, dropping focus to
  // <body> — this pins that PlanningPane sends it somewhere useful instead
  it("moves focus to the next action button when a move unmounts the one that had it", async () => {
    await renderPlanning();
    const firstButton = screen.getByRole("button", {
      name: "Add Fix the login redirect to the sprint",
    });
    firstButton.focus();
    fireEvent.click(firstButton);

    const nextButton = await screen.findByRole("button", {
      name: "Add Rename the export button to the sprint",
    });
    await waitFor(() => expect(document.activeElement).toBe(nextButton));
  });

  it("returns the task to the pane it came from when removing fails", async () => {
    api.put.mockRejectedValue(new Error("nope"));
    await renderPlanning();
    fireEvent.click(screen.getByRole("button", { name: /Remove Ship the header/ }));
    await waitFor(() => expect(screen.getByText("Sprint 12 (1)")).toBeTruthy());
    expect(screen.getByText("Ship the header")).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("Failed to move task", "error");
  });

  it("drops a dragged task into the sprint pane", async () => {
    await renderPlanning();
    fireEvent.drop(screen.getByTestId("planning-pane-sprint"), {
      dataTransfer: dataTransferFor("t1"),
    });
    expect(api.put).toHaveBeenCalledWith("/api/projects/p1/tasks/t1", { sprint: "s1" });
  });

  it("drops a dragged task into the backlog pane", async () => {
    await renderPlanning();
    fireEvent.drop(screen.getByTestId("planning-pane-backlog"), {
      dataTransfer: dataTransferFor("t9"),
    });
    expect(api.put).toHaveBeenCalledWith("/api/projects/p1/tasks/t9", { sprint: null });
  });

  it("writes nothing when a task is dropped back onto the pane it is already in", async () => {
    await renderPlanning();
    fireEvent.drop(screen.getByTestId("planning-pane-backlog"), {
      dataTransfer: dataTransferFor("t1"),
    });
    fireEvent.drop(screen.getByTestId("planning-pane-sprint"), {
      dataTransfer: dataTransferFor("t9"),
    });
    expect(api.put).not.toHaveBeenCalled();
  });

  // PlanningPane's onDrop reads the id off "text/plain" specifically; a stub that answers
  // any key would never notice the source asking for a different one
  it("ignores a drop whose payload sits under a key the pane never asked for", async () => {
    await renderPlanning();
    fireEvent.drop(screen.getByTestId("planning-pane-sprint"), {
      dataTransfer: { getData: (key: string) => (key === "application/x-other" ? "t1" : "") },
    });
    expect(api.put).not.toHaveBeenCalled();
  });

  // onDragOver must call preventDefault, or the browser's native HTML5 DnD contract never
  // permits a drop at that position in the first place — fireEvent returns false exactly
  // when the default was prevented, mirroring Board.test.tsx:221's own drag-over check
  it("prevents the default drag-over so a drop can land", async () => {
    await renderPlanning();
    const notPrevented = fireEvent.dragOver(screen.getByTestId("planning-pane-sprint"));
    expect(notPrevented).toBe(false);
  });

  it("does not show the previous sprint's tasks under the new sprint's name mid-switch", async () => {
    const { rerender } = await renderPlanning();
    expect(screen.getByText("Sprint 12 (1)")).toBeTruthy();

    const otherSprints = [
      ...sprints,
      {
        _id: "s2",
        name: "Sprint 13",
        startDate: "2026-08-04T00:00:00Z",
        endDate: "2026-08-17T00:00:00Z",
        goal: "",
        status: "planned",
        taskCount: 0,
        doneCount: 0,
      },
    ] as ApiSprint[];

    // loadedScope still says "s1": board.tasks has not caught up with the new sprint yet
    rerender(
      <PlanningView
        projectId="p1"
        board={makeBoard({ sprints: otherSprints, loadedScope: "s1" })}
        sprintId="s2"
      />
    );

    expect(screen.queryByText("Ship the header")).toBeNull();
    expect(screen.getByText("Sprint 13")).toBeTruthy();
    expect(screen.queryByText("Sprint 13 (1)")).toBeNull();
  });

  it("shows the backlog as loading rather than claiming it is empty while its fetch is in flight", async () => {
    let resolveBacklog: (tasks: ApiTask[]) => void = () => {};
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1/tasks?sprint=backlog") {
        return new Promise((resolve) => {
          resolveBacklog = resolve;
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<PlanningView projectId="p1" board={makeBoard()} sprintId="s1" />);

    expect(screen.getByText("Backlog")).toBeTruthy();
    expect(screen.queryByText("No tasks in the backlog")).toBeNull();

    await act(async () => {
      resolveBacklog(backlogTasks.map((t) => ({ ...t })));
    });
    expect(await screen.findByText("Backlog (2)")).toBeTruthy();
  });

  it("offers a retry rather than pretending the backlog is empty when its fetch fails", async () => {
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1/tasks?sprint=backlog") {
        return Promise.reject(new Error("500"));
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<PlanningView projectId="p1" board={makeBoard()} sprintId="s1" />);

    expect(await screen.findByText("Couldn't load the backlog.")).toBeTruthy();
    expect(screen.queryByText("No tasks in the backlog")).toBeNull();
  });

  it("retries the backlog fetch when asked", async () => {
    api.get.mockImplementationOnce((url: string) =>
      url === "/api/projects/p1/tasks?sprint=backlog"
        ? Promise.reject(new Error("500"))
        : Promise.reject(new Error(`unexpected GET ${url}`))
    );
    render(<PlanningView projectId="p1" board={makeBoard()} sprintId="s1" />);
    await screen.findByRole("button", { name: "Retry" });

    api.get.mockImplementation((url: string) =>
      url === "/api/projects/p1/tasks?sprint=backlog"
        ? Promise.resolve(backlogTasks.map((t) => ({ ...t })))
        : Promise.reject(new Error(`unexpected GET ${url}`))
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Backlog (2)")).toBeTruthy();
  });
});
