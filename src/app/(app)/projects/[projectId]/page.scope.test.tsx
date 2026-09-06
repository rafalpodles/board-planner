// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import KanbanPage from "./page";
import { ApiProject, ApiTask } from "@/types";
import type { ProjectBoard } from "@/hooks/use-project-board";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const { boardOverride } = vi.hoisted(() => ({
  boardOverride: { current: null as ProjectBoard | null },
}));

vi.mock("@/hooks/use-project-board", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-project-board")>();
  return {
    ...actual,
    useProjectBoard: (...args: Parameters<typeof actual.useProjectBoard>) =>
      boardOverride.current ?? actual.useProjectBoard(...args),
  };
});

function baseBoard(overrides: Partial<ProjectBoard>): ProjectBoard {
  return {
    project: null,
    tasks: [],
    sprints: [],
    assignableUsers: [],
    loading: false,
    loadError: false,
    reload: vi.fn(),
    viewMode: "board",
    setViewMode: vi.fn(),
    showNewTask: false,
    setShowNewTask: vi.fn(),
    scope: "all",
    loadedScope: undefined,
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

const { api, toast, push, replace } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));

let currentSearchParams = new URLSearchParams();

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { username: "rpo", collapseEmptyColumns: false },
    isAdmin: false,
  }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push, replace }),
  usePathname: () => "/projects/TP",
  useSearchParams: () => currentSearchParams,
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
  columns: [{ id: "todo", label: "To Do", color: "#3b82f6", role: "approved", order: 0 }],
  categories: [],
  customFields: [],
  taskTemplates: [],
} as unknown as ApiProject;

const tasks = [
  {
    _id: "t1",
    taskNumber: 1,
    title: "A task",
    status: "todo",
    priority: "medium",
    category: "bug",
    order: 0,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
] as ApiTask[];

function mockHappyApi() {
  api.get.mockImplementation((url: string) => {
    if (url === "/api/projects/p1") return Promise.resolve(project);
    if (url.startsWith("/api/projects/p1/tasks")) return Promise.resolve(tasks);
    if (url === "/api/projects/p1/sprints") return Promise.resolve([]);
    if (url.endsWith("/assignable-users")) return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  toast.mockReset();
  push.mockReset();
  replace.mockReset();
  boardOverride.current = null;
  currentSearchParams = new URLSearchParams();
  window.history.replaceState(null, "", "/projects/TP");
  localStorage.clear();
});
afterEach(cleanup);

describe("An unknown ?sprint= scope", () => {
  it("falls back to the unscoped board instead of sending the raw value to the API", async () => {
    currentSearchParams = new URLSearchParams("sprint=not-an-id");
    mockHappyApi();

    render(<KanbanPage />);
    await screen.findByText("TP-1");

    for (const [url] of api.get.mock.calls) {
      expect(url as string).not.toContain("sprint=");
    }
  });

  it("drops the malformed value from the address bar without a soft navigation", async () => {
    currentSearchParams = new URLSearchParams("sprint=not-an-id");
    mockHappyApi();

    render(<KanbanPage />);

    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe("/projects/p1")
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("leaves a well-formed sprint id alone", async () => {
    const sprintId = "69a52e3b399b27d3cbb2c5a5";
    currentSearchParams = new URLSearchParams(`sprint=${sprintId}`);
    mockHappyApi();

    render(<KanbanPage />);
    await screen.findByText("TP-1");

    expect(api.get).toHaveBeenCalledWith(`/api/projects/p1/tasks?sprint=${sprintId}`);
  });
});

describe("A board whose initial load fails", () => {
  it("does not spin forever — it offers a retry instead", async () => {
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1") return Promise.reject(new Error("boom"));
      if (url.startsWith("/api/projects/p1/tasks")) return Promise.resolve(tasks);
      if (url === "/api/projects/p1/sprints") return Promise.resolve([]);
      if (url.endsWith("/assignable-users")) return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<KanbanPage />);

    await screen.findByText("Failed to load this board.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("Failed to load board data", "error");
  });

  it("recovers once Retry succeeds", async () => {
    let shouldFail = true;
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1") {
        return shouldFail ? Promise.reject(new Error("boom")) : Promise.resolve(project);
      }
      if (url.startsWith("/api/projects/p1/tasks")) return Promise.resolve(tasks);
      if (url === "/api/projects/p1/sprints") return Promise.resolve([]);
      if (url.endsWith("/assignable-users")) return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<KanbanPage />);
    await screen.findByText("Failed to load this board.");

    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByText("TP-1");
  });
});

describe("A second load starting before the first settles", () => {
  it("never shows the Retry panel while the superseded request is the one that resolves first", async () => {
    const projectCalls = [deferred<ApiProject>(), deferred<ApiProject>()];
    let projectCallIndex = 0;
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1") return projectCalls[projectCallIndex++].promise;
      if (url.startsWith("/api/projects/p1/tasks")) return Promise.resolve(tasks);
      if (url === "/api/projects/p1/sprints") return Promise.resolve([]);
      if (url.endsWith("/assignable-users")) return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<KanbanPage />);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(projectCallIndex).toBe(2);

    await act(async () => {
      projectCalls[0].resolve(project);
    });
    expect(screen.queryByText("Failed to load this board.")).toBeNull();

    await act(async () => {
      projectCalls[1].resolve(project);
    });
    await screen.findByText("TP-1");
    expect(screen.queryByText("Failed to load this board.")).toBeNull();
  });
});

describe("Nothing loaded, but nothing has failed either", () => {
  it("keeps spinning instead of offering a retry", async () => {
    boardOverride.current = baseBoard({ loading: false, project: null, loadError: false });

    render(<KanbanPage />);

    expect(screen.queryByText("Failed to load this board.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.querySelector(".animate-spin")).toBeTruthy();
  });

  it("still offers a retry once the load has actually failed", async () => {
    boardOverride.current = baseBoard({ loading: false, project: null, loadError: true });

    render(<KanbanPage />);

    expect(screen.getByText("Failed to load this board.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
