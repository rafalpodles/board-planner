// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor, within } from "@testing-library/react";
import KanbanPage from "./page";
import { ApiProject, ApiTask } from "@/types";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    // Off so every column keeps a body: a rail has no drop area to aim a card at
    user: { username: "rpo", collapseEmptyColumns: false },
    isAdmin: false,
  }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/projects/TP",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/board-refresh", () => ({
  subscribeBoardRefresh: () => () => {},
  emitBoardRefresh: vi.fn(),
}));

const project = {
  _id: "p1",
  key: "TP",
  name: "Test Project",
  columns: [
    { id: "todo", label: "To Do", color: "#3b82f6", role: "approved", order: 0 },
    { id: "in_progress", label: "In Progress", color: "#f59e0b", role: "active", order: 1 },
  ],
  categories: [],
  customFields: [],
  taskTemplates: [],
} as unknown as ApiProject;

const tasks = [
  {
    _id: "t2",
    taskNumber: 2,
    title: "A free task",
    status: "todo",
    priority: "medium",
    category: "bug",
    order: 0,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
  {
    _id: "t3",
    taskNumber: 3,
    title: "A task a worker is running",
    status: "todo",
    priority: "medium",
    category: "bug",
    order: 1,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
] as ApiTask[];

const conflict = {
  workerId: "w1",
  workerName: "mac-mini",
  phase: "implementing",
  phaseAt: null,
};

// Exactly what use-api throws: the message every existing caller reports, with the
// status and parsed body riding along
function apiError(status: number, body: Record<string, unknown>) {
  return Object.assign(new Error(String(body.error ?? "Request failed")), { status, body });
}

const heldError = () =>
  apiError(409, { error: "Task is being executed by a worker", runConflict: conflict });

async function renderBoard() {
  api.get.mockImplementation((url: string) => {
    if (url === "/api/projects/p1") return Promise.resolve(project);
    if (url.startsWith("/api/projects/p1/tasks")) {
      return Promise.resolve(tasks.map((t) => ({ ...t })));
    }
    if (url === "/api/projects/p1/sprints") return Promise.resolve([]);
    if (url.endsWith("/assignable-users")) return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  const view = render(<KanbanPage />);
  // The cards, not the column: the board renders its columns a beat before the filter
  // bar hands back the rows to put in them
  for (const key of ["TP-2", "TP-3"]) await screen.findByText(key);
  return view;
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function cardFor(taskKey: string) {
  return screen.getByText(taskKey).closest("a")!;
}

function columnOf(taskKey: string) {
  return cardFor(taskKey).closest("[data-testid^='column-']")!.getAttribute("data-testid");
}

async function rightClick(taskKey: string) {
  await act(async () => {
    cardFor(taskKey).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    );
  });
}

// The context menu's "Move to" entries; the column headings are plain headings
async function moveTo(label: string) {
  await click(screen.getByRole("button", { name: label }));
}

async function select(...taskKeys: string[]) {
  await click(screen.getByTitle("Select multiple tasks, then right-click one of them"));
  for (const key of taskKeys) {
    await click(screen.getByLabelText(`Select ${key}`));
  }
}

// Native DnD: the column reads the drop index from a dragover, then the id off the
// drop's dataTransfer
async function dragCardInto(taskId: string, columnId: string) {
  const column = screen.getByTestId(`column-${columnId}`);
  const body = column.querySelector("[data-column-body]")!;

  await act(async () => {
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(over, "dataTransfer", { value: { dropEffect: "" } });
    body.dispatchEvent(over);
  });
  await act(async () => {
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { getData: () => taskId } });
    column.dispatchEvent(drop);
  });
}

function heldDialog() {
  const heading = screen.queryByRole("heading", { name: "This task is being executed" });
  return heading && within(heading.closest("[role='dialog']") as HTMLElement);
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  toast.mockReset();
  localStorage.clear();
});
afterEach(cleanup);

/**
 * BP-337 review. DELETE could not answer 409 until this change, so `Promise.all` was safe here and
 * `handleBulkMove` two functions above already carried the lesson. The moment delete learned to
 * refuse, one held task rejected the whole batch while the rest were already gone server-side.
 */
describe("Bulk delete with one task held by a worker", () => {
  async function bulkDeleteBoth() {
    api.del.mockImplementation((url: string) =>
      url.endsWith("/t3") ? Promise.reject(heldError()) : Promise.resolve({})
    );
    await renderBoard();
    await select("TP-2", "TP-3");
    await rightClick("TP-2");
    await click(screen.getByRole("button", { name: "Delete 2 tasks" }));
    // The menu entry and the dialog's confirm carry the same label; the dialog's is the later one
    const confirms = screen.getAllByRole("button", { name: "Delete 2 tasks" });
    await click(confirms[confirms.length - 1]);
  }

  it("removes the tasks that were deleted, rather than leaving them on the board", async () => {
    await bulkDeleteBoth();

    await waitFor(() => expect(screen.queryByText("A free task")).toBeNull());
    expect(screen.getByText("A task a worker is running")).toBeTruthy();
  });

  it("names the refused task rather than reporting a wholesale failure", async () => {
    await bulkDeleteBoth();

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Deleted 1 of 2. TP-3 being executed by a worker.",
        "error"
      )
    );
    expect(toast).not.toHaveBeenCalledWith("Failed to delete tasks", "error");
  });

  // The dialog stayed open over cards that were already gone, and clicking it again re-deleted
  // them into a 404
  it("closes the confirmation even when part of the batch was refused", async () => {
    await bulkDeleteBoth();

    await waitFor(() => expect(screen.queryByText(/Delete 2 tasks\?/)).toBeNull());
  });
});

/**
 * BP-337 review. The board parks a refused *move* and asks; a refused delete reached the same
 * endpoint shape and got a flat error, which is this ticket's own asymmetry one layer out.
 */
describe("Deleting one held task from the context menu", () => {
  async function deleteHeldFromMenu() {
    api.del.mockImplementation((url: string) =>
      url.endsWith("/t3") ? Promise.reject(heldError()) : Promise.resolve({})
    );
    await renderBoard();
    await rightClick("TP-3");
    await click(screen.getByRole("button", { name: "Delete", exact: true }));
    const confirms = screen.getAllByRole("button", { name: "Delete", exact: true });
    await click(confirms[confirms.length - 1]);
  }

  it("asks instead of reporting a failure", async () => {
    await deleteHeldFromMenu();

    await waitFor(() => expect(heldDialog()).toBeTruthy());
    expect(heldDialog()!.getByRole("button", { name: "Delete anyway" })).toBeTruthy();
    expect(toast).not.toHaveBeenCalledWith("Failed to delete task", "error");
    expect(screen.getByText("A task a worker is running")).toBeTruthy();
  });

  it("re-issues the delete with force when the person confirms", async () => {
    await deleteHeldFromMenu();
    await waitFor(() => expect(heldDialog()).toBeTruthy());
    api.del.mockResolvedValue({});

    await click(heldDialog()!.getByRole("button", { name: "Delete anyway" }));

    await waitFor(() =>
      expect(api.del).toHaveBeenLastCalledWith("/api/projects/p1/tasks/t3", { force: true })
    );
  });
});

describe("Bulk move with one task held by a worker", () => {
  async function bulkMoveBothToInProgress() {
    api.patch.mockImplementation((url: string) =>
      url.includes("/t3/") ? Promise.reject(heldError()) : Promise.resolve({})
    );
    await renderBoard();
    await select("TP-2", "TP-3");
    await rightClick("TP-2");
    await moveTo("In Progress");
  }

  // The whole batch used to be rejected over the one held task, so the board said nothing
  // had moved while the server had already moved the rest
  it("applies the tasks that did move", async () => {
    await bulkMoveBothToInProgress();

    await waitFor(() => expect(columnOf("TP-2")).toBe("column-in_progress"));
    expect(columnOf("TP-3")).toBe("column-todo");
  });

  it("names the refused task rather than reporting a wholesale failure", async () => {
    await bulkMoveBothToInProgress();

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Moved 1 of 2. TP-3 being executed by a worker.",
        "error"
      )
    );
    expect(toast).not.toHaveBeenCalledWith("Failed to move tasks", "error");
  });

  it("keeps a batch that fails for an ordinary reason free of worker talk", async () => {
    api.patch.mockImplementation((url: string) =>
      url.includes("/t3/") ? Promise.reject(apiError(500, { error: "boom" })) : Promise.resolve({})
    );
    await renderBoard();
    await select("TP-2", "TP-3");
    await rightClick("TP-2");
    await moveTo("In Progress");

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Moved 1 of 2", "error"));
    expect(columnOf("TP-2")).toBe("column-in_progress");
  });
});

describe("Dragging a task a worker is running", () => {
  it("asks instead of reporting a failure", async () => {
    api.put.mockRejectedValue(heldError());
    await renderBoard();
    await dragCardInto("t3", "in_progress");

    await waitFor(() => expect(heldDialog()).toBeTruthy());
    expect(
      heldDialog()!.getByText(
        "TP-3 is being executed by mac-mini (phase implementing). Moving it takes the task off that worker and its work is lost."
      )
    ).toBeTruthy();
    expect(toast).not.toHaveBeenCalledWith("Failed to move task", "error");
  });

  it("re-issues the move with force when the person confirms", async () => {
    api.put.mockImplementation((_url: string, body: { force?: boolean }) =>
      body.force ? Promise.resolve({}) : Promise.reject(heldError())
    );
    await renderBoard();
    await dragCardInto("t3", "in_progress");
    await waitFor(() => expect(heldDialog()).toBeTruthy());

    await click(heldDialog()!.getByRole("button", { name: "Move anyway" }));

    await waitFor(() =>
      expect(api.put).toHaveBeenLastCalledWith("/api/projects/p1/tasks/t3", {
        order: 0,
        status: "in_progress",
        force: true,
      })
    );
    expect(toast).toHaveBeenCalledWith("TP-3 taken from the worker", "success");
  });

  it("still reports an ordinary failure as one", async () => {
    api.put.mockRejectedValue(apiError(500, { error: "boom" }));
    await renderBoard();
    await dragCardInto("t3", "in_progress");

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Failed to move task", "error"));
    expect(heldDialog()).toBeNull();
  });
});

// The status endpoint is a second way to the same refusal, and used to answer it with
// nothing but "Failed to update status"
describe("Moving a held task through the status endpoint", () => {
  async function moveTP3ViaContextMenu() {
    await renderBoard();
    await rightClick("TP-3");
    await moveTo("In Progress");
  }

  it("asks instead of reporting a failure", async () => {
    api.patch.mockRejectedValue(heldError());
    await moveTP3ViaContextMenu();

    await waitFor(() => expect(heldDialog()).toBeTruthy());
    expect(toast).not.toHaveBeenCalledWith("Failed to update status", "error");
  });

  it("re-issues the status change with force when the person confirms", async () => {
    api.patch.mockImplementation((_url: string, body: { force?: boolean }) =>
      body.force ? Promise.resolve({}) : Promise.reject(heldError())
    );
    await moveTP3ViaContextMenu();
    await waitFor(() => expect(heldDialog()).toBeTruthy());

    await click(heldDialog()!.getByRole("button", { name: "Move anyway" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenLastCalledWith("/api/projects/p1/tasks/t3/status", {
        status: "in_progress",
        force: true,
      })
    );
    expect(toast).toHaveBeenCalledWith("TP-3 taken from the worker", "success");
  });

  it("still reports an ordinary failure as one", async () => {
    api.patch.mockRejectedValue(apiError(500, { error: "boom" }));
    await moveTP3ViaContextMenu();

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Failed to update status", "error"));
    expect(heldDialog()).toBeNull();
  });

  // A 409 is also how a stale write is refused; only the runConflict body means a worker
  it("still reports a 409 that carries no run conflict as an ordinary failure", async () => {
    api.patch.mockRejectedValue(apiError(409, { error: "Conflict" }));
    await moveTP3ViaContextMenu();

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Failed to update status", "error"));
    expect(heldDialog()).toBeNull();
  });
});
