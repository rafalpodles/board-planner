// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, act, fireEvent, waitFor } from "@testing-library/react";
import SprintsPage from "./page";
import { ApiProject, ApiSprint, ApiTask } from "@/types";

const { api, toast, router, query, pathname, headerCalls } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
  // Stands in for the address bar: a test writes it and rerenders, as a navigation would
  query: { current: "" },
  pathname: { current: "/projects/p1/sprints" },
  // Every commit calls SprintHeader again, including ones a single act() flush discards
  // before the test can read the DOM — this is the only way to see a render that never
  // survives to be read back with screen.getByTestId
  headerCalls: [] as Array<{ name: string; doneCount: number; totalCount: number }>,
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

  // Opening a task pushes to /tasks/7 and unmounts this page, but React Testing Library's
  // rerender simulates the transition render that happens first: the route has already
  // moved, but this component (and its effect) is still on screen for one more commit.
  // Without a pathname guard, the effect sees `requested` as null (the task route carries
  // no ?sprint=) and replaces the address bar right back to the sprints tab.
  it("does not pull the user back to the sprints tab once a task navigation is underway", async () => {
    const { rerender } = await renderSprints();

    // Commit a render with the address bar as it actually reads after the earlier
    // replace landed — `requested` has to actually transition through "s1" for the
    // effect's dependency array to notice it later moving to null.
    query.current = "sprint=s1";
    rerender(<SprintsPage />);
    router.replace.mockReset();

    // A card click pushes to the task route first; both hooks report the new location
    // before this component unmounts, same as during a real App Router transition — the
    // destination carries no ?sprint=, so `requested` goes back to null.
    pathname.current = "/projects/p1/tasks/7";
    query.current = "";
    rerender(<SprintsPage />);

    expect(router.replace).not.toHaveBeenCalled();
  });

  // GET /tasks?sprint=<x> assigns straight into a Mongoose filter, so an id the project
  // does not have is a 500 and not a fallback. It must never leave the page.
  it("never asks for a sprint the URL named but the project does not have", async () => {
    query.current = "sprint=deadbeef";
    await renderSprints();

    expect(api.get.mock.calls.some(([url]) => String(url).includes("deadbeef"))).toBe(false);
    expect(screen.getByRole("heading", { name: "Sprint 12" })).toBeTruthy();
    expect(router.replace).toHaveBeenCalledWith("/projects/p1/sprints?sprint=s1");
  });

  it("reads the sprint list once, from the board", async () => {
    await renderSprints();
    // Both come from the hook's one batch, so a page-side /sprints fetch breaks the tie
    const count = (path: string) =>
      api.get.mock.calls.filter(([url]) => url === path).length;
    expect(count("/api/projects/p1/sprints")).toBe(count("/api/projects/p1"));
  });

  // Board.test.tsx and ProjectBoardView.test.tsx pin readOnly's effect once it is passed
  // through; this pins that the page actually passes it, not merely that the components
  // honour it when told to.
  it("keeps a completed sprint's board undraggable, not just its header", async () => {
    await renderSprints(completedOnly);
    const card = screen.getByRole("link", { name: /Task 1/i });
    expect(card.getAttribute("draggable")).toBe("false");
  });

  // readOnly is about not fumbling a finished sprint, not an integrity boundary — the
  // server enforces nothing about completed sprints either. Reopening one (Activate) stays
  // undecided and withheld, along with Complete; Edit and Delete are ordinary metadata
  // edits and stay offered.
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

  // Previously the only Create Task control lived inside the zero-task empty state, so a
  // sprint that already had cards offered no visible way to add another
  it("offers a Create Task action in the header even when the sprint already has cards", async () => {
    await renderSprints();
    await click(screen.getByRole("button", { name: "Create Task" }));
    expect(screen.getByRole("heading", { name: "New Task" })).toBeTruthy();
  });

  it("offers no Create Task action in the header on a completed sprint with cards", async () => {
    await renderSprints(completedOnly);
    expect(screen.queryByRole("button", { name: "Create Task" })).toBeNull();
  });

  it("shows 0/0 for a sprint with no tasks", async () => {
    await renderSprints(sprints, { tasks: [] });
    expect(screen.getByTestId("sprint-progress").textContent).toBe("0/0");
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
    // The page's own chrome survives the switch — a naive "spin the whole page whenever
    // tasks are loading" fix would take the title and selector off screen too
    expect(screen.getByRole("heading", { name: "Sprints" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Sprint list" })).toBeTruthy();
    expect(screen.queryByText("TP-1")).toBeNull();
    expect(screen.getByTestId("sprint-progress").textContent).toBe("0/0");
    // Sprint 13's tasks are still in flight, so this is the spinner a screen reader
    // must be able to name — it is ProjectBoardView's own, scoped to the task area,
    // not the page-level one
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
      if (url === "/api/users/list") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<SprintsPage />);

    // The sprint has resolved to s1 and its tasks are in flight — the window this test targets
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

// The wiring from each header button to its endpoint is new code, and swapping any two of
// them leaves every other test in this file green
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

  // The URL has two writers now: the sprint-scope normalizer (BP-200) and this toggle.
  // Order 1 — a view already in the address bar must survive the normalizer's own replace.
  it("keeps a view already chosen in the URL when the sprint scope gets normalized into it", async () => {
    query.current = "view=planning";
    await renderSprints();
    expect(router.replace).toHaveBeenCalledWith("/projects/p1/sprints?sprint=s1&view=planning");
  });

  // Order 2 — the toggle must push the sprint the page actually settled on, not the stale
  // or invalid one still sitting in `requested` at the moment of the click.
  it("switches to Planning using the sprint the page already settled on, not a stale URL value", async () => {
    query.current = "sprint=deadbeef";
    await renderSprints();
    router.push.mockReset();

    await click(screen.getByRole("button", { name: "Planning" }));

    expect(router.push).toHaveBeenCalledWith("/projects/p1/sprints?sprint=s1&view=planning");
  });

  // board.applySprintChange only ever drops a task out of board.tasks, never adds one in,
  // so the header must be fed from something else once a backlog task is pulled into the
  // sprint — this is the one place a planner is actually looking at the number.
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
      if (url === "/api/users/list") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    api.put.mockResolvedValue({});

    const { rerender } = render(<SprintsPage />);
    await screen.findByRole("heading", { name: "Sprints" });
    await screen.findByText("TP-1");
    expect(screen.getByTestId("sprint-progress").textContent).toBe("4/8");

    // Simulates the navigation the Planning button's router.push would have caused —
    // router.push is a spy here and does not itself move the mocked address bar.
    query.current = "sprint=s1&view=planning";
    rerender(<SprintsPage />);
    await screen.findByText("Backlog task");

    await click(screen.getByRole("button", { name: "Add Backlog task to the sprint" }));

    await waitFor(() =>
      expect(screen.getByTestId("sprint-progress").textContent).toBe("4/9")
    );
  });

  // PlanningView reports on every render, including the ones before its own tasksLoaded
  // is true for the new sprint — those report an empty array, which is truthy, so it used
  // to beat the selected?.doneCount fallback and paint "0/0" for one window per switch.
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
      // Sprint 13's tasks never arrive, keeping the mid-switch window open under test
      if (url === "/api/projects/p1/tasks?sprint=s2") return new Promise(() => {});
      if (url === "/api/projects/p1/sprints") return Promise.resolve(planningSprints);
      if (url === "/api/users/list") return Promise.resolve([]);
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
    // Sprint 13's own doneCount/taskCount (2/5) is the fallback while its tasks are still
    // in flight — never "0/0", which is what an empty, "loaded" report would produce
    expect(screen.getByTestId("sprint-progress").textContent).toBe("2/5");
  });

  // Milder than the 0/0 case above but the same bug: planningTasks from Sprint 12 outlives
  // the render where the header already reads Sprint 13's name off `selected`. Checking only
  // the settled DOM (as the test above does) can't see it — the stale render commits and
  // reverts within the same act() flush. Reading every SprintHeader call, not just the last
  // one still standing, is what catches it.
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
      // Sprint 13's tasks never arrive, keeping the mid-switch window open under test
      if (url === "/api/projects/p1/tasks?sprint=s2") return new Promise(() => {});
      if (url === "/api/projects/p1/sprints") return Promise.resolve(planningSprints);
      if (url === "/api/users/list") return Promise.resolve([]);
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

    // Sprint 13's only valid counts, ever, are its own (2/5) — never Sprint 12's
    // leftover 4/8 painted under Sprint 13's name for one frame along the way
    const mislabeled = headerCalls.filter(
      (call) => call.name === "Sprint 13" && (call.doneCount !== 2 || call.totalCount !== 5)
    );
    expect(mislabeled).toEqual([]);
  });

  // page.tsx:153 clamps the view back to "board" whenever the selected sprint is
  // read-only, even if the URL already asked for Planning — this exercises that guard
  // for a completed sprint reached with ?view=planning already set.
  it("clamps a completed sprint back to the board even when the URL already asks for Planning", async () => {
    query.current = "sprint=s3&view=planning";
    await renderSprints(completedOnly);

    expect(screen.queryByRole("button", { name: "Planning" })).toBeNull();
    expect(screen.queryByTestId("planning-pane-backlog")).toBeNull();
    expect(screen.getByRole("link", { name: /Task 1/i })).toBeTruthy();
  });
});
