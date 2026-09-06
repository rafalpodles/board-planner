// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, act, fireEvent, waitFor } from "@testing-library/react";
import SprintsPage from "./page";
import { ApiProject, ApiSprint, ApiTask } from "@/types";

const { api, toast, router, query, pathname, headerCalls } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
  query: { current: "" },
  pathname: { current: "/projects/p1/sprints" },
  headerCalls: [] as Array<{
    name: string;
    doneCount: number;
    totalCount: number;
    estimate?: { total: number; done: number };
  }>,
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/sprints/SprintHeader", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/sprints/SprintHeader")>();
  return {
    ...actual,
    SprintHeader: (props: Parameters<typeof actual.SprintHeader>[0]) => {
      headerCalls.push({
        name: props.sprint.name,
        doneCount: props.doneCount,
        totalCount: props.totalCount,
        estimate: props.estimate,
      });
      return actual.SprintHeader(props);
    },
  };
});
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { username: "rpo", collapseEmptyColumns: false },
    isAdmin: false,
  }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => router,
  usePathname: () => pathname.current,
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

const twoCompletedSprints = [
  {
    _id: "s5",
    name: "Sprint 9",
    startDate: "2026-06-08T00:00:00Z",
    endDate: "2026-06-22T00:00:00Z",
    goal: "",
    status: "completed",
    taskCount: 4,
    doneCount: 4,
    estimateTotal: 10,
    estimateDone: 10,
  },
  {
    _id: "s6",
    name: "Sprint 10",
    startDate: "2026-06-22T00:00:00Z",
    endDate: "2026-07-06T00:00:00Z",
    goal: "",
    status: "completed",
    taskCount: 6,
    doneCount: 6,
    estimateTotal: 15,
    estimateDone: 15,
  },
] as ApiSprint[];

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

const projectWithEstimate = {
  ...project,
  estimateFieldId: "f1",
  customFields: [{ _id: "f1", name: "Story points", fieldType: "number" }],
} as unknown as ApiProject;

const sprintTasksWithEstimate = sprintTasks.map((t, i) => ({
  ...t,
  customFieldValues: { f1: i < 4 ? 2 : 3 },
})) as ApiTask[];

const projectWithDanglingEstimate = {
  ...project,
  estimateFieldId: "gone",
  customFields: [],
} as unknown as ApiProject;

const sprintTasksWithLeftoverValue = sprintTasks.map((t, i) => ({
  ...t,
  customFieldValues: { gone: i < 4 ? 2 : 3 },
})) as ApiTask[];

async function renderSprints(
  data: ApiSprint[] = sprints,
  opts: { tasks?: ApiTask[]; project?: ApiProject } = {}
) {
  const tasks = opts.tasks ?? sprintTasks;
  const proj = opts.project ?? project;
  api.get.mockImplementation((url: string) => {
    if (url === "/api/projects/p1") return Promise.resolve(proj);
    if (url.startsWith("/api/projects/p1/tasks")) {
      return Promise.resolve(tasks.map((t) => ({ ...t })));
    }
    if (url === "/api/projects/p1/sprints") return Promise.resolve(data);
    if (url.endsWith("/assignable-users")) return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });

  const view = render(<SprintsPage />);
  await screen.findByRole("heading", { name: "Sprints" });
  if (data.length > 0) {
    await screen.findByRole("navigation", { name: "Sprint list" });
    if (tasks.length > 0) {
      await screen.findByText("TP-1");
    } else {
      await screen.findByText("No tasks in this sprint");
    }
  }
  return view;
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  toast.mockReset();
  router.push.mockReset();
  router.replace.mockReset();
  query.current = "";
  pathname.current = "/projects/p1/sprints";
  headerCalls.length = 0;
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

  it("does not pull the user back to the sprints tab once a task navigation is underway", async () => {
    const { rerender } = await renderSprints();

    query.current = "sprint=s1";
    rerender(<SprintsPage />);
    router.replace.mockReset();

    pathname.current = "/projects/p1/tasks/7";
    query.current = "";
    rerender(<SprintsPage />);

    expect(router.replace).not.toHaveBeenCalled();
  });

  it("never asks for a sprint the URL named but the project does not have", async () => {
    query.current = "sprint=deadbeef";
    await renderSprints();

    expect(api.get.mock.calls.some(([url]) => String(url).includes("deadbeef"))).toBe(false);
    expect(screen.getByRole("heading", { name: "Sprint 12" })).toBeTruthy();
    expect(router.replace).toHaveBeenCalledWith("/projects/p1/sprints?sprint=s1");
  });

  it("reads the sprint list once, from the board", async () => {
    await renderSprints();
    const count = (path: string) =>
      api.get.mock.calls.filter(([url]) => url === path).length;
    expect(count("/api/projects/p1/sprints")).toBe(count("/api/projects/p1"));
  });

  it("keeps a completed sprint's board undraggable, not just its header", async () => {
    await renderSprints(completedOnly);
    const card = screen.getByRole("link", { name: /Task 1/i });
    expect(card.getAttribute("draggable")).toBe("false");
  });

  it("withholds Activate and Complete on a completed sprint, but not Edit and Delete", async () => {
    await renderSprints(completedOnly);
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Delete sprint/ })).toBeTruthy();
  });

  it("keeps the sprint's progress on every task in it while the board is filtered", async () => {
    await renderSprints();
    expect(screen.getByTestId("sprint-progress").textContent).toBe("4/8");

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Search tasks, or TP-128…"), {
        target: { value: "Task 1" },
      });
    });

    expect(screen.getByText("TP-1")).toBeTruthy();
    expect(screen.queryByText("TP-2")).toBeNull();
    expect(screen.getByTestId("sprint-progress").textContent).toBe("4/8");
  });

  it("says the sprint is empty rather than offering to start the project", async () => {
    await renderSprints(sprints, { tasks: [] });
    expect(screen.getByText("No tasks in this sprint")).toBeTruthy();
    expect(screen.queryByText("Create your first task")).toBeNull();
  });

  it("offers no create button on an empty completed sprint", async () => {
    await renderSprints(completedOnly, { tasks: [] });
    expect(screen.queryByRole("button", { name: "Create Task" })).toBeNull();
  });

  it("offers a Create Task action in the header even when the sprint already has cards", async () => {
    await renderSprints();
    await click(screen.getByRole("button", { name: "Create Task" }));
    expect(screen.getByRole("heading", { name: "New Task" })).toBeTruthy();
  });

  it("offers no Create Task action in the header on a completed sprint with cards", async () => {
    await renderSprints(completedOnly);
    expect(screen.queryByRole("button", { name: "Create Task" })).toBeNull();
  });

  it("opens the new task modal from Planning, not just Board", async () => {
    query.current = "sprint=s1&view=planning";
    await renderSprints();
    await click(screen.getByRole("button", { name: "Create Task" }));
    expect(screen.getByRole("heading", { name: "New Task" })).toBeTruthy();
  });

  it("shows 0/0 for a sprint with no tasks", async () => {
    await renderSprints(sprints, { tasks: [] });
    expect(screen.getByTestId("sprint-progress").textContent).toBe("0/0");
  });

  it("never shows the previous sprint's tasks under the sprint just selected", async () => {
    const { rerender } = await renderSprints();
    expect(screen.getByText("TP-1")).toBeTruthy();

    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1") return Promise.resolve(project);
      if (url === "/api/projects/p1/tasks?sprint=s2") return new Promise(() => {});
      if (url.startsWith("/api/projects/p1/tasks")) return Promise.resolve(sprintTasks);
      if (url === "/api/projects/p1/sprints") return Promise.resolve(sprints);
      if (url.endsWith("/assignable-users")) return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    query.current = "sprint=s2";
    rerender(<SprintsPage />);

    await screen.findByRole("heading", { name: "Sprint 13" });
    expect(screen.getByRole("heading", { name: "Sprints" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Sprint list" })).toBeTruthy();
    expect(screen.queryByText("TP-1")).toBeNull();
    expect(screen.getByTestId("sprint-progress").textContent).toBe("0/0");
    expect(screen.getByRole("status", { name: "Loading tasks" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading sprint" })).toBeNull();
  });

  it("renders nothing — not the title, not the selector, not the header — until the first sprint's tasks have arrived", async () => {
    let resolveTasks: (tasks: ApiTask[]) => void = () => {};
    const pendingTasks = new Promise<ApiTask[]>((resolve) => {
      resolveTasks = resolve;
    });
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1") return Promise.resolve(project);
      if (url.startsWith("/api/projects/p1/tasks")) return pendingTasks;
      if (url === "/api/projects/p1/sprints") return Promise.resolve(sprints);
      if (url.endsWith("/assignable-users")) return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<SprintsPage />);

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/api/projects/p1/tasks?sprint=s1")
    );

    expect(screen.queryByRole("heading", { name: "Sprints" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Sprint list" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Sprint 12" })).toBeNull();

    await act(async () => {
      resolveTasks(sprintTasks.map((t) => ({ ...t })));
    });

    expect(await screen.findByRole("heading", { name: "Sprints" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Sprint list" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sprint 12" })).toBeTruthy();
    expect(screen.getByText("TP-1")).toBeTruthy();
  });
});

describe("Sprint lifecycle from the header", () => {
  it("activates a planned sprint", async () => {
    api.put.mockResolvedValue({});
    await renderSprints(sprintsWithNoActive);

    await click(screen.getByRole("button", { name: "Activate" }));

    expect(api.put).toHaveBeenCalledWith("/api/projects/p1/sprints/s2", { status: "active" });
    expect(toast).toHaveBeenCalledWith("Sprint activated", "success");
  });

  it("completes the active sprint through the dialog, carrying the backlog choice", async () => {
    api.put.mockResolvedValue({});
    await renderSprints();

    await click(screen.getByRole("button", { name: "Complete" }));
    expect(screen.getByRole("heading", { name: "Complete Sprint" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep in Sprint" })).toBeTruthy();

    await click(screen.getByRole("button", { name: "Move to Backlog" }));

    expect(api.put).toHaveBeenCalledWith("/api/projects/p1/sprints/s1", {
      status: "completed",
      moveIncompleteToBacklog: true,
    });
  });

  it("deletes the selected sprint once the confirmation is answered", async () => {
    api.del.mockResolvedValue({});
    await renderSprints();

    await click(screen.getByRole("button", { name: "Delete sprint Sprint 12" }));
    expect(api.del).not.toHaveBeenCalled();

    await click(screen.getByRole("button", { name: "Delete" }));

    expect(api.del).toHaveBeenCalledWith("/api/projects/p1/sprints/s1");
  });

  it("opens the edit form on the selected sprint", async () => {
    await renderSprints();

    await click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("heading", { name: "Edit Sprint" })).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Sprint 12");
  });

  it("still edits and deletes a completed sprint, since only its board is read-only", async () => {
    api.del.mockResolvedValue({});
    await renderSprints(completedOnly);

    await click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("heading", { name: "Edit Sprint" })).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Sprint 11");
    await click(screen.getByRole("button", { name: "Cancel" }));

    await click(screen.getByRole("button", { name: "Delete sprint Sprint 11" }));
    await click(screen.getByRole("button", { name: "Delete" }));
    expect(api.del).toHaveBeenCalledWith("/api/projects/p1/sprints/s3");
  });
});

describe("Board / Planning toggle", () => {
  it("offers the Planning toggle on an active sprint", async () => {
    await renderSprints();
    expect(screen.getByRole("button", { name: "Planning" })).toBeTruthy();
  });

  it("offers no Planning toggle on a completed sprint", async () => {
    await renderSprints(completedOnly);
    expect(screen.queryByRole("button", { name: "Planning" })).toBeNull();
  });

  it("keeps the chosen view in the URL", async () => {
    await renderSprints();
    await click(screen.getByRole("button", { name: "Planning" }));
    expect(router.push).toHaveBeenCalledWith("/projects/p1/sprints?sprint=s1&view=planning");
  });

  it("keeps a view already chosen in the URL when the sprint scope gets normalized into it", async () => {
    query.current = "view=planning";
    await renderSprints();
    expect(router.replace).toHaveBeenCalledWith("/projects/p1/sprints?sprint=s1&view=planning");
  });

  it("switches to Planning using the sprint the page already settled on, not a stale URL value", async () => {
    query.current = "sprint=deadbeef";
    await renderSprints();
    router.push.mockReset();

    await click(screen.getByRole("button", { name: "Planning" }));

    expect(router.push).toHaveBeenCalledWith("/projects/p1/sprints?sprint=s1&view=planning");
  });

  it("moves the header's counts when a planning move happens, not just the panes'", async () => {
    const backlogTasks = [
      {
        _id: "b1",
        taskNumber: 20,
        title: "Backlog task",
        status: "todo",
        priority: "medium",
        category: "bug",
        order: 0,
        sprint: null,
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-01T00:00:00Z",
      },
    ] as ApiTask[];

    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1") return Promise.resolve(project);
      if (url === "/api/projects/p1/tasks?sprint=s1") {
        return Promise.resolve(sprintTasks.map((t) => ({ ...t })));
      }
      if (url === "/api/projects/p1/tasks?sprint=backlog") {
        return Promise.resolve(backlogTasks.map((t) => ({ ...t })));
      }
      if (url === "/api/projects/p1/sprints") return Promise.resolve(sprints);
      if (url.endsWith("/assignable-users")) return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    api.put.mockResolvedValue({});

    const { rerender } = render(<SprintsPage />);
    await screen.findByRole("heading", { name: "Sprints" });
    await screen.findByText("TP-1");
    expect(screen.getByTestId("sprint-progress").textContent).toBe("4/8");

    query.current = "sprint=s1&view=planning";
    rerender(<SprintsPage />);
    await screen.findByText("Backlog task");

    await click(screen.getByRole("button", { name: "Add Backlog task to the sprint" }));

    await waitFor(() =>
      expect(screen.getByTestId("sprint-progress").textContent).toBe("4/9")
    );
  });

  it("keeps a task added in Planning once the view switches to Board", async () => {
    const backlogTasks = [
      {
        _id: "b1",
        taskNumber: 20,
        title: "Backlog task",
        status: "todo",
        priority: "medium",
        category: "bug",
        order: 0,
        sprint: null,
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-01T00:00:00Z",
      },
    ] as ApiTask[];

    let movedIn = false;
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1") return Promise.resolve(project);
      if (url === "/api/projects/p1/tasks?sprint=s1") {
        const list = movedIn
          ? [...sprintTasks, { ...backlogTasks[0], sprint: "s1" }]
          : sprintTasks;
        return Promise.resolve(list.map((t) => ({ ...t })));
      }
      if (url === "/api/projects/p1/tasks?sprint=backlog") {
        return Promise.resolve(movedIn ? [] : backlogTasks.map((t) => ({ ...t })));
      }
      if (url === "/api/projects/p1/sprints") return Promise.resolve(sprints);
      if (url.endsWith("/assignable-users")) return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    api.put.mockImplementation(() => {
      movedIn = true;
      return Promise.resolve({});
    });

    const { rerender } = render(<SprintsPage />);
    await screen.findByRole("heading", { name: "Sprints" });
    await screen.findByText("TP-1");

    query.current = "sprint=s1&view=planning";
    rerender(<SprintsPage />);
    await screen.findByText("Backlog task");

    await click(screen.getByRole("button", { name: "Add Backlog task to the sprint" }));
    await waitFor(() => expect(screen.getByTestId("sprint-progress").textContent).toBe("4/9"));

    query.current = "sprint=s1";
    rerender(<SprintsPage />);

    expect(await screen.findByText("TP-20")).toBeTruthy();
  });

  it("moves the header's count down immediately on a planning removal, before the server answers", async () => {
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1") return Promise.resolve(project);
      if (url === "/api/projects/p1/tasks?sprint=s1") {
        return Promise.resolve(sprintTasks.map((t) => ({ ...t })));
      }
      if (url === "/api/projects/p1/tasks?sprint=backlog") return Promise.resolve([]);
      if (url === "/api/projects/p1/sprints") return Promise.resolve(sprints);
      if (url.endsWith("/assignable-users")) return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    api.put.mockImplementation(() => new Promise(() => {}));

    const { rerender } = render(<SprintsPage />);
    await screen.findByRole("heading", { name: "Sprints" });
    await screen.findByText("TP-1");
    expect(screen.getByTestId("sprint-progress").textContent).toBe("4/8");

    query.current = "sprint=s1&view=planning";
    rerender(<SprintsPage />);
    await screen.findByTestId("planning-pane-sprint");

    await click(screen.getByRole("button", { name: "Remove Task 5 from the sprint" }));

    expect(screen.getByTestId("sprint-progress").textContent).toBe("4/7");
  });

  it("never shows 0/0 while switching sprints with Planning open", async () => {
    const planningSprints = [
      sprints[0],
      {
        _id: "s2",
        name: "Sprint 13",
        startDate: "2026-08-03T00:00:00Z",
        endDate: "2026-08-17T00:00:00Z",
        goal: "",
        status: "planned",
        taskCount: 5,
        doneCount: 2,
      },
    ] as ApiSprint[];

    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1") return Promise.resolve(project);
      if (url === "/api/projects/p1/tasks?sprint=s1") {
        return Promise.resolve(sprintTasks.map((t) => ({ ...t })));
      }
      if (url === "/api/projects/p1/tasks?sprint=backlog") return Promise.resolve([]);
      if (url === "/api/projects/p1/tasks?sprint=s2") return new Promise(() => {});
      if (url === "/api/projects/p1/sprints") return Promise.resolve(planningSprints);
      if (url.endsWith("/assignable-users")) return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    query.current = "sprint=s1&view=planning";
    const { rerender } = render(<SprintsPage />);
    await screen.findByRole("heading", { name: "Sprints" });
    await screen.findByTestId("planning-pane-sprint");
    expect(screen.getByTestId("sprint-progress").textContent).toBe("4/8");

    query.current = "sprint=s2&view=planning";
    await act(async () => {
      rerender(<SprintsPage />);
    });

    expect(screen.getByRole("heading", { name: "Sprint 13", level: 2 })).toBeTruthy();
    expect(screen.getByTestId("sprint-progress").textContent).toBe("2/5");
  });

  it("never renders a sprint's counts under a different sprint's name", async () => {
    const planningSprints = [
      sprints[0],
      {
        _id: "s2",
        name: "Sprint 13",
        startDate: "2026-08-03T00:00:00Z",
        endDate: "2026-08-17T00:00:00Z",
        goal: "",
        status: "planned",
        taskCount: 5,
        doneCount: 2,
      },
    ] as ApiSprint[];

    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1") return Promise.resolve(project);
      if (url === "/api/projects/p1/tasks?sprint=s1") {
        return Promise.resolve(sprintTasks.map((t) => ({ ...t })));
      }
      if (url === "/api/projects/p1/tasks?sprint=backlog") return Promise.resolve([]);
      if (url === "/api/projects/p1/tasks?sprint=s2") return new Promise(() => {});
      if (url === "/api/projects/p1/sprints") return Promise.resolve(planningSprints);
      if (url.endsWith("/assignable-users")) return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    query.current = "sprint=s1&view=planning";
    const { rerender } = render(<SprintsPage />);
    await screen.findByRole("heading", { name: "Sprints" });
    await screen.findByTestId("planning-pane-sprint");
    expect(screen.getByTestId("sprint-progress").textContent).toBe("4/8");

    headerCalls.length = 0;
    query.current = "sprint=s2&view=planning";
    await act(async () => {
      rerender(<SprintsPage />);
    });

    expect(screen.getByRole("heading", { name: "Sprint 13", level: 2 })).toBeTruthy();
    expect(screen.getByTestId("sprint-progress").textContent).toBe("2/5");

    const mislabeled = headerCalls.filter(
      (call) => call.name === "Sprint 13" && (call.doneCount !== 2 || call.totalCount !== 5)
    );
    expect(mislabeled).toEqual([]);
  });

  it("clamps a completed sprint back to the board even when the URL already asks for Planning", async () => {
    query.current = "sprint=s3&view=planning";
    await renderSprints(completedOnly);

    expect(screen.queryByRole("button", { name: "Planning" })).toBeNull();
    expect(screen.queryByTestId("planning-pane-backlog")).toBeNull();
    expect(screen.getByRole("link", { name: /Task 1/i })).toBeTruthy();
  });
});

describe("Sprint header estimate", () => {
  it("shows nothing about the estimate when the project designates no field", async () => {
    await renderSprints();
    expect(screen.queryByTestId("sprint-estimate-progress")).toBeNull();
  });

  it("shows nothing about the estimate when the designated field no longer exists on the project", async () => {
    await renderSprints(sprints, {
      tasks: sprintTasksWithLeftoverValue,
      project: projectWithDanglingEstimate,
    });
    expect(screen.queryByTestId("sprint-estimate-progress")).toBeNull();
  });

  it("shows the estimate total and done beside the task counts when the project designates a field", async () => {
    await renderSprints(sprints, { tasks: sprintTasksWithEstimate, project: projectWithEstimate });
    expect(screen.getByTestId("sprint-estimate-progress").textContent).toBe("8/20 Story points");
    expect(screen.getByTestId("sprint-progress").textContent).toBe("4/8");
  });

  it("keeps the estimate on every task in the sprint while the board is filtered", async () => {
    await renderSprints(sprints, { tasks: sprintTasksWithEstimate, project: projectWithEstimate });
    expect(screen.getByTestId("sprint-estimate-progress").textContent).toBe("8/20 Story points");

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Search tasks, or TP-128…"), {
        target: { value: "Task 1" },
      });
    });

    expect(screen.getByText("TP-1")).toBeTruthy();
    expect(screen.getByTestId("sprint-estimate-progress").textContent).toBe("8/20 Story points");
  });

  it("never carries one sprint's estimate under a different sprint's name mid-switch", async () => {
    const planningSprintsWithEstimate = [
      { ...sprints[0], estimateTotal: 20, estimateDone: 8 },
      {
        _id: "s2",
        name: "Sprint 13",
        startDate: "2026-08-03T00:00:00Z",
        endDate: "2026-08-17T00:00:00Z",
        goal: "",
        status: "planned",
        taskCount: 5,
        doneCount: 2,
        estimateTotal: 13,
        estimateDone: 6,
      },
    ] as ApiSprint[];

    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/p1") return Promise.resolve(projectWithEstimate);
      if (url === "/api/projects/p1/tasks?sprint=s1") {
        return Promise.resolve(sprintTasksWithEstimate.map((t) => ({ ...t })));
      }
      if (url === "/api/projects/p1/tasks?sprint=backlog") return Promise.resolve([]);
      if (url === "/api/projects/p1/tasks?sprint=s2") return new Promise(() => {});
      if (url === "/api/projects/p1/sprints") return Promise.resolve(planningSprintsWithEstimate);
      if (url.endsWith("/assignable-users")) return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    query.current = "sprint=s1&view=planning";
    const { rerender } = render(<SprintsPage />);
    await screen.findByRole("heading", { name: "Sprints" });
    await screen.findByTestId("planning-pane-sprint");
    expect(screen.getByTestId("sprint-estimate-progress").textContent).toBe("8/20 Story points");

    headerCalls.length = 0;
    query.current = "sprint=s2&view=planning";
    await act(async () => {
      rerender(<SprintsPage />);
    });

    expect(screen.getByRole("heading", { name: "Sprint 13", level: 2 })).toBeTruthy();
    expect(screen.getByTestId("sprint-estimate-progress").textContent).toBe("6/13 Story points");

    const mislabeled = headerCalls.filter(
      (call) =>
        call.name === "Sprint 13" && (call.estimate?.done !== 6 || call.estimate?.total !== 13)
    );
    expect(mislabeled).toEqual([]);
  });
});

describe("Velocity", () => {
  it("offers a Velocity button once two completed sprints exist and the project designates an estimate field", async () => {
    await renderSprints(twoCompletedSprints, { tasks: [], project: projectWithEstimate });
    expect(screen.getByRole("button", { name: "Velocity" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Velocity" })).toBeNull();
  });

  it("opens the velocity chart in a dialog on click, and closes it without leaving the page", async () => {
    await renderSprints(twoCompletedSprints, { tasks: [], project: projectWithEstimate });

    await click(screen.getByRole("button", { name: "Velocity" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Velocity", level: 2 })).toBeTruthy();
    expect(within(dialog).getByText("Sprint 9")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sprints" })).toBeTruthy();

    await click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no Velocity button when the project designates no estimate field, even with two completed sprints", async () => {
    await renderSprints(twoCompletedSprints, { tasks: [] });
    expect(screen.queryByRole("button", { name: "Velocity" })).toBeNull();
  });

  it("offers no Velocity button when the designated field no longer exists on the project, even with two completed sprints", async () => {
    await renderSprints(twoCompletedSprints, { tasks: [], project: projectWithDanglingEstimate });
    expect(screen.queryByRole("button", { name: "Velocity" })).toBeNull();
  });

  it("offers no Velocity button for a designating project with no completed sprint", async () => {
    await renderSprints(sprints, { tasks: [], project: projectWithEstimate });
    expect(screen.queryByRole("button", { name: "Velocity" })).toBeNull();
  });

  it("still offers the Velocity button on a planned sprint that has no velocity of its own, in Planning too", async () => {
    query.current = "sprint=s2&view=planning";
    await renderSprints([...twoCompletedSprints, sprints[1]], {
      tasks: [],
      project: projectWithEstimate,
    });
    expect(screen.getByRole("heading", { name: "Sprint 13", level: 2 })).toBeTruthy();
    await click(screen.getByRole("button", { name: "Velocity" }));
    expect(within(screen.getByRole("dialog")).getByText("Sprint 9")).toBeTruthy();
  });
});
