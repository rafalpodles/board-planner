// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import KanbanPage from "./page";
import { ApiProject, ApiTask } from "@/types";

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
    if (url === "/api/users/list") return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  toast.mockReset();
  push.mockReset();
  replace.mockReset();
  currentSearchParams = new URLSearchParams();
  window.history.replaceState(null, "", "/projects/TP");
  localStorage.clear();
});
afterEach(cleanup);

// BP-293 follow-up: an unknown ?sprint= used to be sent straight to the API, which
// answers with a Mongoose CastError 500 for anything that isn't an ObjectId — and the
// hook's catch never sets `project`, so the board spun forever, re-toasting every poll
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
    // Native replaceState, not router.replace: this page sits under an @modal
    // parallel route, and a soft navigation risks waking it
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

// Previously: `if (loading || !project) return spinner`, and loading always ends up
// false once the request settles — success or failure — while a failed load never
// sets `project`. The page had no way out of the spinner and no way to tell the person.
describe("A board whose initial load fails", () => {
  it("does not spin forever — it offers a retry instead", async () => {
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1") return Promise.reject(new Error("boom"));
      if (url.startsWith("/api/projects/p1/tasks")) return Promise.resolve(tasks);
      if (url === "/api/projects/p1/sprints") return Promise.resolve([]);
      if (url === "/api/users/list") return Promise.resolve([]);
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
      if (url === "/api/users/list") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<KanbanPage />);
    await screen.findByText("Failed to load this board.");

    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByText("TP-1");
  });
});
