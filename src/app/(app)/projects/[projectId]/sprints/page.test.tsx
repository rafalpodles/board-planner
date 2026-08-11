// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import SprintsPage from "./page";
import { ApiProject, ApiSprint, ApiTask } from "@/types";

const { api, toast, router, query } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
  // Stands in for the address bar: a test writes it and rerenders, as a navigation would
  query: { current: "" },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { username: "rpo", collapseEmptyColumns: false },
    isAdmin: false,
  }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => router,
  usePathname: () => "/projects/p1/sprints",
  useSearchParams: () => new URLSearchParams(query.current),
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
    { id: "shipped", label: "Shipped", color: "#22c55e", role: "done", order: 1 },
  ],
  categories: [],
  customFields: [],
  taskTemplates: [],
} as unknown as ApiProject;

// doneCount/taskCount disagree with the task list on purpose: they are what the sprint
// list reports, and the header must prefer what the tasks actually say
const sprints = [
  {
    _id: "s1",
    name: "Sprint 12",
    startDate: "2026-07-20T00:00:00Z",
    endDate: "2026-08-03T00:00:00Z",
    goal: "Ship the layout pass",
    status: "active",
    taskCount: 2,
    doneCount: 1,
  },
  {
    _id: "s2",
    name: "Sprint 13",
    startDate: "2026-08-03T00:00:00Z",
    endDate: "2026-08-17T00:00:00Z",
    goal: "",
    status: "planned",
    taskCount: 0,
    doneCount: 0,
  },
] as ApiSprint[];

const sprintsWithNoActive = [
  {
    _id: "s4",
    name: "Sprint 14",
    startDate: "2026-08-17T00:00:00Z",
    endDate: "2026-08-31T00:00:00Z",
    goal: "",
    status: "planned",
    taskCount: 0,
    doneCount: 0,
  },
  sprints[1],
] as ApiSprint[];

const completedOnly = [
  {
    _id: "s3",
    name: "Sprint 11",
    startDate: "2026-07-06T00:00:00Z",
    endDate: "2026-07-20T00:00:00Z",
    goal: "",
    status: "completed",
    taskCount: 5,
    doneCount: 5,
  },
] as ApiSprint[];

// Four of eight in a column whose role is "done", under an id nothing hardcodes
const sprintTasks = Array.from({ length: 8 }, (_, i) => ({
  _id: `t${i + 1}`,
  taskNumber: i + 1,
  title: `Task ${i + 1}`,
  status: i < 4 ? "shipped" : "todo",
  priority: "medium",
  category: "bug",
  order: i,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
})) as ApiTask[];

async function renderSprints(
  data: ApiSprint[] = sprints,
  opts: { tasks?: ApiTask[] } = {}
) {
  const tasks = opts.tasks ?? sprintTasks;
  api.get.mockImplementation((url: string) => {
    if (url === "/api/projects/p1") return Promise.resolve(project);
    if (url.startsWith("/api/projects/p1/tasks")) {
      return Promise.resolve(tasks.map((t) => ({ ...t })));
    }
    if (url === "/api/projects/p1/sprints") return Promise.resolve(data);
    if (url === "/api/users/list") return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });

  const view = render(<SprintsPage />);
  await screen.findByRole("heading", { name: "Sprints" });
  if (data.length > 0) {
    await screen.findByRole("navigation", { name: "Sprint list" });
    // The scoped task list is a second round trip after the sprint is resolved
    if (tasks.length > 0) await screen.findByText("TP-1");
  }
  return view;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  toast.mockReset();
  router.push.mockReset();
  router.replace.mockReset();
  query.current = "";
  localStorage.clear();
});
afterEach(cleanup);

describe("Sprints tab", () => {
  it("selects the active sprint on load", async () => {
    await renderSprints();
    expect(screen.getByRole("heading", { name: "Sprint 12" })).toBeTruthy();
  });

  it("selects the planned sprint that starts soonest when none is active", async () => {
    await renderSprints(sprintsWithNoActive);
    expect(screen.getByRole("heading", { name: "Sprint 13" })).toBeTruthy();
  });

  it("lists every sprint in the selector, grouped", async () => {
    await renderSprints();
    // Scoped to the selector: the header's status badge says "Active" too
    const selector = within(screen.getByRole("navigation", { name: "Sprint list" }));
    expect(selector.getByRole("button", { name: /Sprint 13/ })).toBeTruthy();
    expect(selector.getByText("Active")).toBeTruthy();
    expect(selector.getByText("Planned")).toBeTruthy();
  });

  it("keeps the empty state when a project has no sprints", async () => {
    await renderSprints([]);
    expect(screen.getByText("No sprints yet")).toBeTruthy();
    expect(screen.getByText("Create your first sprint")).toBeTruthy();
  });

  it("asks for the selected sprint's tasks and nothing else", async () => {
    await renderSprints();
    expect(api.get).toHaveBeenCalledWith("/api/projects/p1/tasks?sprint=s1");
    expect(api.get).not.toHaveBeenCalledWith("/api/projects/p1/tasks");
  });

  it("asks for no tasks at all until a sprint has been resolved", async () => {
    await renderSprints([]);
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining("/tasks"));
  });

  it("puts the resolved sprint in the URL without adding a history entry", async () => {
    await renderSprints();
    expect(router.replace).toHaveBeenCalledWith("/projects/p1/sprints?sprint=s1");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("reads the sprint list once, from the board", async () => {
    await renderSprints();
    // Both come from the hook's one batch, so a page-side /sprints fetch breaks the tie
    const count = (path: string) =>
      api.get.mock.calls.filter(([url]) => url === path).length;
    expect(count("/api/projects/p1/sprints")).toBe(count("/api/projects/p1"));
  });

  it("offers no lifecycle buttons on a completed sprint", async () => {
    await renderSprints(completedOnly);
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete sprint/ })).toBeNull();
  });

  it("shows the sprint's progress from every task in it, not the filtered subset", async () => {
    await renderSprints();
    expect(screen.getByText("4/8")).toBeTruthy();
  });

  // The window this pins is a request long: without it the tab shows Sprint 12's cards and
  // Sprint 12's done/total under Sprint 13's name, which is the page stating something untrue
  it("never shows the previous sprint's tasks under the sprint just selected", async () => {
    const { rerender } = await renderSprints();
    expect(screen.getByText("TP-1")).toBeTruthy();

    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1") return Promise.resolve(project);
      // Sprint 13's tasks stay in flight, so the tab sits in the window under test
      if (url === "/api/projects/p1/tasks?sprint=s2") return new Promise(() => {});
      if (url.startsWith("/api/projects/p1/tasks")) return Promise.resolve(sprintTasks);
      if (url === "/api/projects/p1/sprints") return Promise.resolve(sprints);
      if (url === "/api/users/list") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    query.current = "sprint=s2";
    rerender(<SprintsPage />);

    await screen.findByRole("heading", { name: "Sprint 13" });
    expect(screen.queryByText("TP-1")).toBeNull();
    expect(screen.queryByText("4/8")).toBeNull();
  });
});
