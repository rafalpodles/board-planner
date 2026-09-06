// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act, within } from "@testing-library/react";
import { TaskDetail } from "./TaskDetail";

const { api, auth } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  auth: { user: { _id: "u1", username: "rpo", fullName: "Rafal Podles" }, isAdmin: false },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/projects/TP",
}));
vi.mock("@/lib/board-refresh", () => ({
  subscribeBoardRefresh: () => () => {},
  emitBoardRefresh: vi.fn(),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("./TaskActivityPanel", () => ({
  TaskActivityPanel: () => <div data-testid="activity-panel" />,
}));
vi.mock("./TaskLinks", () => ({ TaskLinks: () => <div data-testid="task-links" /> }));
vi.mock("./GitlabActivity", () => ({ GitlabActivity: () => <div data-testid="gitlab" /> }));
vi.mock("./TaskForm", () => ({ TaskForm: () => <div data-testid="task-form" /> }));
vi.mock("@/components/ui/MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => <div data-testid="md">{value}</div>,
}));

const task = {
  _id: "t1",
  taskNumber: 6,
  title: "Recurring one",
  description: "Some description",
  status: "todo",
  priority: "high",
  difficulty: "L",
  category: "idea",
  component: "",
  assignee: null,
  dueDate: null,
  checklist: [
    { _id: "c1", text: "First criterion", done: true },
    { _id: "c2", text: "Second criterion", done: false },
  ],
  labels: [],
  watchers: [],
  linkedPRs: [],
  relations: [],
  blockedBy: [],
  customFieldValues: { f1: "XL" },
  recurrence: null,
  sprint: null,
  createdBy: { _id: "u2", username: "claude", fullName: "Claude Code" },
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

const project = {
  _id: "p1",
  key: "TP",
  name: "Test Project",
  components: [],
  categories: [{ name: "idea" }],
  columns: [],
  labels: [],
  customFields: [],
};

beforeEach(() => {
  api.get.mockReset();
  api.put.mockReset();
  api.del.mockReset();
  api.put.mockResolvedValue({});
  api.get.mockImplementation((url: string) => {
    if (url === "/api/projects/TP/assignable-users") return Promise.resolve([]);
    if (url.startsWith("/api/agent")) return Promise.resolve([]);
    if (url.includes("/tasks/")) return Promise.resolve(task);
    if (url.includes("/sprints")) return Promise.resolve([]);
    return Promise.resolve(project);
  });
});

afterEach(cleanup);

function renderDetail(over: Partial<React.ComponentProps<typeof TaskDetail>> = {}) {
  return render(<TaskDetail projectId="TP" taskId="6" onClose={() => {}} {...over} />);
}

async function loaded() {
  await waitFor(() => expect(screen.getByTestId("activity-panel")).toBeTruthy());
}

describe("TaskDetail", () => {
  it("renders every panel, not a subset", async () => {
    renderDetail();
    await loaded();
    expect(screen.getByTestId("task-links")).toBeTruthy();
    expect(screen.getByTestId("gitlab")).toBeTruthy();
    expect(screen.getByText("Linked work")).toBeTruthy();
    expect(screen.getByText("Acceptance criteria")).toBeTruthy();
    expect(screen.getByText("Description")).toBeTruthy();
  });

  it("renders a task whose creator was deleted", async () => {
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/TP/assignable-users") return Promise.resolve([]);
    if (url.startsWith("/api/agent")) return Promise.resolve([]);
      if (url.includes("/tasks/")) return Promise.resolve({ ...task, createdBy: null });
      if (url.includes("/sprints")) return Promise.resolve([]);
      return Promise.resolve(project);
    });

    renderDetail();
    await loaded();

    expect(screen.getByLabelText("Task title")).toBeTruthy();
    expect(screen.queryByText(/Reported by/)).toBeNull();
  });

  it("puts the title in an editable field rather than a heading", async () => {
    renderDetail();
    await loaded();
    const title = screen.getByLabelText("Task title") as HTMLTextAreaElement;
    expect(title.value).toBe("Recurring one");
  });

  it("offers the status as a picker carrying the column label", async () => {
    renderDetail();
    await loaded();
    const pill = screen.getByRole("combobox", { name: "Status" });
    expect(pill.textContent).toMatch(/To Do/i);
    await act(async () => pill.click());
    expect(screen.getByRole("listbox", { name: "Status" })).toBeTruthy();
  });

  it("moves status changes through the endpoint that runs the transition", async () => {
    api.patch.mockResolvedValue({});
    renderDetail();
    await loaded();

    await act(async () => screen.getByRole("combobox", { name: "Status" }).click());
    await act(async () => screen.getByRole("option", { name: /In Progress/i }).click());

    expect(api.patch).toHaveBeenCalledWith("/api/projects/TP/tasks/t1/status", {
      status: "in_progress",
    });
  });

  it("counts the acceptance criteria that are done", async () => {
    renderDetail();
    await loaded();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("shows the property rail and the mobile way into it", async () => {
    renderDetail();
    await loaded();
    expect(screen.getAllByText("Details").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Assignee").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "All details" })).toBeTruthy();
  });

  it("opens the details sheet from the mobile summary", async () => {
    renderDetail();
    await loaded();
    await act(async () => screen.getByRole("button", { name: "All details" }).click());
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("keeps delete out of the main surface and behind a confirmation", async () => {
    renderDetail();
    await loaded();
    const del = screen.getAllByRole("button", { name: "Delete task" })[0];
    await act(async () => del.click());
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    expect(api.del).not.toHaveBeenCalled();
  });

  it("asks again when a run holds the task, and resends the delete with force", async () => {
    api.del
      .mockRejectedValueOnce({
        status: 409,
        body: {
          runConflict: { workerId: "w1", workerName: "mac", phase: "agent", phaseAt: null },
        },
      })
      .mockResolvedValueOnce({});
    const onClose = vi.fn();
    renderDetail({ onClose });
    await loaded();

    await act(async () => screen.getByRole("button", { name: "More actions" }).click());
    const menu = within(screen.getByRole("listbox", { name: "More actions" }));
    await act(async () => menu.getByRole("option", { name: "Delete task" }).click());
    await act(async () => screen.getByRole("button", { name: "Delete" }).click());

    expect(screen.getByText(/being executed by mac \(phase agent\)/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => screen.getByRole("button", { name: "Delete anyway" }).click());

    expect(api.del).toHaveBeenLastCalledWith("/api/projects/TP/tasks/t1", { force: true });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("offers delete from the overflow menu, behind the same confirmation", async () => {
    api.del.mockResolvedValue({});
    const onClose = vi.fn();
    renderDetail({ onClose });
    await loaded();

    await act(async () => screen.getByRole("button", { name: "More actions" }).click());
    const menu = within(screen.getByRole("listbox", { name: "More actions" }));
    await act(async () => menu.getByRole("option", { name: "Delete task" }).click());

    expect(api.del).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();

    await act(async () => screen.getByRole("button", { name: "Delete" }).click());

    expect(api.del).toHaveBeenCalledWith("/api/projects/TP/tasks/t1", undefined);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("leaves the task alone when the confirmation is dismissed", async () => {
    renderDetail();
    await loaded();

    await act(async () => screen.getByRole("button", { name: "More actions" }).click());
    const menu = within(screen.getByRole("listbox", { name: "More actions" }));
    await act(async () => menu.getByRole("option", { name: "Delete task" }).click());
    await act(async () => screen.getByRole("button", { name: "Cancel" }).click());

    expect(api.del).not.toHaveBeenCalled();
    expect(screen.queryByText(/cannot be undone/)).toBeNull();
  });

  it("duplicates without dictating a status, and carries the custom fields over", async () => {
    api.post.mockResolvedValue({ taskNumber: 7 });
    renderDetail();
    await loaded();

    await act(async () => screen.getByRole("button", { name: /^Duplicate$/ }).click());

    const [url, body] = api.post.mock.calls.at(-1)!;
    expect(url).toBe("/api/projects/TP/tasks");
    expect(body).not.toHaveProperty("status");
    expect(body.customFieldValues).toEqual(task.customFieldValues);
    expect(body.title).toBe("Copy of Recurring one");
  });

  it("duplicates the rhythm and the priority, and unticks the criteria", async () => {
    api.post.mockResolvedValue({ taskNumber: 7 });
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/TP/assignable-users") return Promise.resolve([]);
      if (url.startsWith("/api/agent")) return Promise.resolve([]);
      if (url.includes("/tasks/"))
        return Promise.resolve({
          ...task,
          recurrence: { frequency: "weekly", interval: 2 },
          assignee: { _id: "u1", username: "rpo", fullName: "Rafal Podles" },
          sprint: "s1",
          agent: { _id: "a1", name: "Default" },
        });
      if (url.includes("/sprints")) return Promise.resolve([]);
      return Promise.resolve(project);
    });

    renderDetail();
    await loaded();

    await act(async () => screen.getByRole("button", { name: /^Duplicate$/ }).click());

    const body = api.post.mock.calls.at(-1)![1];
    expect(body.recurrence).toEqual({ frequency: "weekly", interval: 2 });
    expect(body.priority).toBe("high");
    expect(body.checklist).toEqual([
      { text: "First criterion", done: false },
      { text: "Second criterion", done: false },
    ]);
    for (const field of ["assignee", "sprint", "agent"]) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it("closes rather than navigating when the top bar is dismissed", async () => {
    const onClose = vi.fn();
    renderDetail({ onClose });
    await loaded();
    await act(async () => screen.getByRole("button", { name: "Close task" }).click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports the loaded task so a container can title itself", async () => {
    const onLoaded = vi.fn();
    renderDetail({ onLoaded });
    await waitFor(() => expect(onLoaded).toHaveBeenCalled());
    const [loadedTask, loadedProject] = onLoaded.mock.calls.at(-1)!;
    expect(loadedTask.taskNumber).toBe(6);
    expect(loadedProject.key).toBe("TP");
  });

  it("loads the task, the project and its sprints", async () => {
    renderDetail();
    await loaded();
    const urls = api.get.mock.calls.map((c) => c[0]);
    expect(urls.some((u: string) => u.includes("/tasks/6"))).toBe(true);
    expect(urls.some((u: string) => u.endsWith("/sprints"))).toBe(true);
    expect(urls.some((u: string) => u === "/api/projects/TP/assignable-users")).toBe(true);
  });
});

describe("TaskDetail, moving a task a worker is running", () => {
  const refusal = () =>
    Object.assign(new Error("held"), {
      status: 409,
      body: {
        runConflict: { workerId: "w1", workerName: "mac-mini", phase: "agent", phaseAt: null },
      },
    });

  it("asks instead of reporting a failure", async () => {
    api.patch.mockRejectedValueOnce(refusal());
    renderDetail();
    await loaded();

    await act(async () => screen.getByRole("combobox", { name: "Status" }).click());
    await act(async () => screen.getByRole("option", { name: /In Progress/i }).click());

    expect(screen.getByText("This task is being executed")).toBeTruthy();
    expect(screen.getByText(/mac-mini/)).toBeTruthy();
    expect(screen.getByText(/phase agent/)).toBeTruthy();
  });

  it("re-issues the change with force when the person confirms", async () => {
    api.patch.mockRejectedValueOnce(refusal());
    api.patch.mockResolvedValueOnce({});
    renderDetail();
    await loaded();

    await act(async () => screen.getByRole("combobox", { name: "Status" }).click());
    await act(async () => screen.getByRole("option", { name: /In Progress/i }).click());
    await act(async () => screen.getByRole("button", { name: "Move anyway" }).click());

    expect(api.patch).toHaveBeenLastCalledWith("/api/projects/TP/tasks/t1/status", {
      status: "in_progress",
      force: true,
    });
  });

  it("still reports an ordinary failure", async () => {
    api.patch.mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 500 }));
    renderDetail();
    await loaded();

    await act(async () => screen.getByRole("combobox", { name: "Status" }).click());
    await act(async () => screen.getByRole("option", { name: /In Progress/i }).click());

    expect(screen.queryByText("This task is being executed")).toBeNull();
  });
});

describe("TaskDetail, the agent picker's project default", () => {
  const AGENTS = [
    { _id: "ag1", name: "Default", scope: "global", description: "" },
    { _id: "ag2", name: "With security review", scope: "global", description: "" },
  ];

  beforeEach(() => {
    auth.isAdmin = true;
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/TP/assignable-users") return Promise.resolve([]);
      if (url === "/api/agents") return Promise.resolve(AGENTS);
      if (url.startsWith("/api/agent")) return Promise.resolve([]);
      if (url.includes("/tasks/")) return Promise.resolve(task);
      if (url.includes("/sprints")) return Promise.resolve([]);
      return Promise.resolve({ ...project, worker: { agent: "ag2" } });
    });
  });

  afterEach(() => {
    auth.isAdmin = false;
  });

  it("offers it first on the desktop rail", async () => {
    renderDetail();
    await loaded();

    const aside = within(screen.getByRole("complementary"));
    await act(async () => aside.getByRole("combobox", { name: "Agent" }).click());

    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options[0]).toContain("No agent");
    expect(options[1]).toContain("With security review");
  });

  it("offers it first on the mobile sheet too", async () => {
    renderDetail();
    await loaded();
    await act(async () => screen.getByRole("button", { name: "All details" }).click());

    const dialog = within(screen.getByRole("dialog"));
    await act(async () => dialog.getByRole("combobox", { name: "Agent" }).click());

    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options[0]).toContain("No agent");
    expect(options[1]).toContain("With security review");
  });
});

describe("TaskDetail, the Agent row's handover notice", () => {
  const handedOver = {
    ...task,
    status: "todo",
    agent: "ag1",
    assignee: { _id: "u1", username: "rpo", fullName: "Rafal Podles" },
    assignedBy: { _id: "u2", username: "kmk", fullName: "Krzysiek" },
  };

  function serve(over: Record<string, unknown> = {}) {
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/TP/assignable-users") return Promise.resolve([]);
      if (url.startsWith("/api/agent")) return Promise.resolve([]);
      if (url.includes("/tasks/")) return Promise.resolve({ ...handedOver, ...over });
      if (url.includes("/sprints")) return Promise.resolve([]);
      return Promise.resolve(project);
    });
  }

  beforeEach(() => serve());

  it("reaches the desktop rail", async () => {
    renderDetail();
    await loaded();

    const notice = within(screen.getByRole("complementary")).getByTestId("handover-notice");
    expect(notice.dataset.reason).toBe("assigned-by-someone-else");
    expect(notice.textContent).toContain("Krzysiek");
  });

  it("reaches the mobile sheet too", async () => {
    renderDetail();
    await loaded();
    await act(async () => screen.getByRole("button", { name: "All details" }).click());

    const notice = within(screen.getByRole("dialog")).getByTestId("handover-notice");
    expect(notice.dataset.reason).toBe("assigned-by-someone-else");
    expect(notice.textContent).toContain("Krzysiek");
  });

  it("reads the assigner off the task the page loaded", async () => {
    serve({ assignedBy: { _id: "u3", username: "ada", fullName: "Ada" } });
    renderDetail();
    await loaded();

    expect(
      within(screen.getByRole("complementary")).getByTestId("handover-notice").textContent
    ).toContain("Ada");
  });

  const inTheBacklog = {
    status: "planned",
    assignedBy: { _id: "u1", username: "rpo", fullName: "Rafal Podles" },
  };

  it("carries the board's columns to the rail, naming a backlog task as not there yet", async () => {
    serve(inTheBacklog);
    renderDetail();
    await loaded();

    expect(
      within(screen.getByRole("complementary")).getByTestId("handover-notice").dataset.reason
    ).toBe("not-approved-yet");
  });

  it("carries them to the mobile sheet too", async () => {
    serve(inTheBacklog);
    renderDetail();
    await loaded();
    await act(async () => screen.getByRole("button", { name: "All details" }).click());

    expect(
      within(screen.getByRole("dialog")).getByTestId("handover-notice").dataset.reason
    ).toBe("not-approved-yet");
  });

  it.each(["in_progress", "done"])(
    "says nothing about a task in %s, whatever the rest of its hand-over is",
    async (status) => {
      serve({ status, assignedBy: { _id: "u1", username: "rpo", fullName: "Rafal Podles" } });
      renderDetail();
      await loaded();

      expect(screen.queryByTestId("handover-notice")).toBeNull();
    }
  );

  it("says nothing when the hand-over is sound", async () => {
    serve({ assignedBy: { _id: "u1", username: "rpo", fullName: "Rafal Podles" } });
    renderDetail();
    await loaded();

    expect(screen.queryByTestId("handover-notice")).toBeNull();
  });
});

describe("TaskDetail, re-assigning a task whose assigner was never recorded", () => {
  const RAFAL = { _id: "u1", username: "rpo", fullName: "Rafal Podles" };
  const legacy = {
    ...task,
    status: "todo",
    agent: "ag1",
    assignee: RAFAL,
    assignedBy: undefined,
  };

  function serve(over: Record<string, unknown> = {}) {
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/TP/assignable-users") return Promise.resolve([RAFAL, { _id: "u2", username: "claude", fullName: "Claude Code" }]);
      if (url.startsWith("/api/agent")) return Promise.resolve([]);
      if (url.includes("/tasks/")) return Promise.resolve({ ...legacy, ...over });
      if (url.includes("/sprints")) return Promise.resolve([]);
      return Promise.resolve(project);
    });
  }

  async function pickAssignee(name: RegExp) {
    const rail = within(screen.getByRole("complementary"));
    await act(async () => rail.getByRole("combobox", { name: "Assignee" }).click());
    const option = screen.getAllByRole("option").find((o) => name.test(o.textContent || ""));
    await act(async () => option!.click());
  }

  it("sends the assignee it already has, which the diff would have dropped", async () => {
    serve();
    renderDetail();
    await loaded();

    await pickAssignee(/Rafal Podles/);

    expect(api.put).toHaveBeenCalledWith("/api/projects/TP/tasks/t1", { assignee: "rpo" });
  });

  it("re-reads the task, so the notice it just fixed goes", async () => {
    serve();
    renderDetail();
    await loaded();
    const readsBefore = api.get.mock.calls.filter((c: unknown[]) => String(c[0]).includes("/tasks/")).length;

    await pickAssignee(/Rafal Podles/);

    await waitFor(() =>
      expect(
        api.get.mock.calls.filter((c: unknown[]) => String(c[0]).includes("/tasks/")).length
      ).toBeGreaterThan(readsBefore)
    );
  });

  it("sends nothing when the assigner is already recorded", async () => {
    serve({ assignedBy: RAFAL });
    renderDetail();
    await loaded();

    await pickAssignee(/Rafal Podles/);

    expect(api.put).not.toHaveBeenCalled();
  });
});

describe("TaskDetail, whether the rail knows who is reading", () => {
  const MINE = { _id: "ag9", name: "My own agent", scope: "user", description: "" };

  function serve(over: Record<string, unknown> = {}) {
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/TP/assignable-users")
        return Promise.resolve([{ _id: "u1", username: "rpo", fullName: "Rafal Podles" }]);
      if (url === "/api/agents") return Promise.resolve([MINE]);
      if (url.startsWith("/api/agent")) return Promise.resolve([]);
      if (url.includes("/tasks/")) return Promise.resolve({ ...task, status: "todo", ...over });
      if (url.includes("/sprints")) return Promise.resolve([]);
      return Promise.resolve(project);
    });
  }

  const mine = { assignee: { _id: "u1", username: "rpo", fullName: "Rafal Podles" } };
  const theirs = { assignee: { _id: "u2", username: "claude", fullName: "Claude Code" } };

  async function openSheet() {
    await act(async () => screen.getByRole("button", { name: "All details" }).click());
    return screen.getByRole("dialog");
  }

  it("offers the reader their own agent on their own task, in the desktop rail", async () => {
    serve(mine);
    renderDetail();
    await loaded();

    expect(
      within(screen.getByRole("complementary")).queryByTestId("personal-agents-withheld")
    ).toBeNull();
  });

  it("withholds it on somebody else's task, in the desktop rail", async () => {
    serve(theirs);
    renderDetail();
    await loaded();

    expect(
      within(screen.getByRole("complementary")).queryByTestId("personal-agents-withheld")
    ).not.toBeNull();
  });

  it("offers it on their own task in the mobile sheet too", async () => {
    serve(mine);
    renderDetail();
    await loaded();

    expect(within(await openSheet()).queryByTestId("personal-agents-withheld")).toBeNull();
  });

  it("withholds it on somebody else's task in the mobile sheet too", async () => {
    serve(theirs);
    renderDetail();
    await loaded();

    expect(within(await openSheet()).queryByTestId("personal-agents-withheld")).not.toBeNull();
  });
});

describe("TaskDetail, the mobile summary's assignee chip", () => {
  it("names an assignee the roster no longer carries, rather than reading as unassigned", async () => {
    api.get.mockImplementation((url: string) => {
      if (url === "/api/projects/TP/assignable-users") return Promise.resolve([]);
      if (url.startsWith("/api/agent")) return Promise.resolve([]);
      if (url.includes("/tasks/")) {
        return Promise.resolve({
          ...task,
          assignee: { _id: "u9", username: "kasia", fullName: "Kasia Nowak" },
        });
      }
      if (url.includes("/sprints")) return Promise.resolve([]);
      return Promise.resolve(project);
    });

    renderDetail();
    await loaded();

    const chip = await screen.findByTestId("mobile-assignee-chip");
    expect(chip.textContent).toContain("Kasia Nowak");
    expect(chip.textContent).not.toContain("Unassigned");
  });

  it("still reads unassigned when the task genuinely has nobody on it", async () => {
    renderDetail();
    await loaded();

    const chip = await screen.findByTestId("mobile-assignee-chip");
    expect(chip.textContent).toContain("Unassigned");
  });
});
