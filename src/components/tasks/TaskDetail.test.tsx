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
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock("@/lib/board-refresh", () => ({
  subscribeBoardRefresh: () => () => {},
  emitBoardRefresh: vi.fn(),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

// The self-fetching panels are stubbed; this spec is about the assembly
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
  api.put.mockResolvedValue({});
  api.get.mockImplementation((url: string) => {
    if (url === "/api/users") return Promise.resolve([]);
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

  // typeof null === "object", so a deleted creator used to take the populated branch and throw
  it("renders a task whose creator was deleted", async () => {
    api.get.mockImplementation((url: string) => {
      if (url === "/api/users") return Promise.resolve([]);
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
    // "todo" is the seeded column's id; the pill shows its label
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

  // Columns are per project since CP-128, so sending a literal "planned" is a 400 in any
  // project that renamed or rebuilt its board — the server picks the backlog column itself
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
    expect(urls.some((u: string) => u === "/api/users")).toBe(true);
  });
});

// CP-235. The board asks before taking a task off a worker; this view reaches the same refusal
// through the same endpoint, and used to answer it with "Failed to update status" — an error
// message for something that is not an error, and no way to proceed.
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

  // A refusal for any other reason is still a failure, and must not be dressed up as a question
  it("still reports an ordinary failure", async () => {
    api.patch.mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 500 }));
    renderDetail();
    await loaded();

    await act(async () => screen.getByRole("combobox", { name: "Status" }).click());
    await act(async () => screen.getByRole("option", { name: /In Progress/i }).click());

    expect(screen.queryByText("This task is being executed")).toBeNull();
  });
});

// BP-358 review round 1: PropertyRail's `projectDefaultAgent` sort is unit-tested in isolation, but
// nothing pinned TaskDetail actually carrying it to either call site — removing the prop from either
// the desktop aside or the mobile sheet left every test above green, because the shared `auth` mock
// never set `isAdmin` (so the Agent row took the read-only branch, which ignores the prop) and the
// shared `/api/agent*` mock returned `[]` (nothing to order even if it hadn't). Scoped to its own
// describe rather than changed file-wide, so the other 19 tests keep their current, unrelated shape.
describe("TaskDetail, the agent picker's project default", () => {
  const AGENTS = [
    { _id: "ag1", name: "Default", scope: "global", description: "" },
    { _id: "ag2", name: "With security review", scope: "global", description: "" },
  ];

  beforeEach(() => {
    auth.isAdmin = true;
    api.get.mockImplementation((url: string) => {
      if (url === "/api/users") return Promise.resolve([]);
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

/**
 * BP-358 fix wave: the same escape as the block above, for the prop that carries the whole
 * user-visible half of this branch. `handoverOf` and the notice it renders are unit-tested in
 * PropertyRail.test.tsx, where `stored` is passed directly — so blanking `stored={task}` on the
 * desktop aside, or on the mobile sheet, or nulling `assignedBy` inside it, left the entire suite
 * green while the product went back to saying nothing about why a task will never run.
 *
 * Both call sites are asserted separately, because that is what "removing it from either" means.
 */
describe("TaskDetail, the Agent row's handover notice", () => {
  // Assigned to one person BY ANOTHER, which is the branch with something to say. `todo` carries
  // the approved role in DEFAULT_PROJECT_COLUMNS, which is what the empty `columns` above resolves
  // to — a task outside that column would report "not-approved-yet" instead and pass for the wrong
  // reason.
  const handedOver = {
    ...task,
    status: "todo",
    agent: "ag1",
    assignee: { _id: "u1", username: "rpo", fullName: "Rafal Podles" },
    assignedBy: { _id: "u2", username: "kmk", fullName: "Krzysiek" },
  };

  function serve(over: Record<string, unknown> = {}) {
    api.get.mockImplementation((url: string) => {
      if (url === "/api/users") return Promise.resolve([]);
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

  // The stored task, not a blank: reading `assignedBy` off anything else is how the notice would
  // silently stop describing this task
  it("reads the assigner off the task the page loaded", async () => {
    serve({ assignedBy: { _id: "u3", username: "ada", fullName: "Ada" } });
    renderDetail();
    await loaded();

    expect(
      within(screen.getByRole("complementary")).getByTestId("handover-notice").textContent
    ).toContain("Ada");
  });

  // The board's own columns have to reach the rail as well, or a task sitting in the backlog with
  // an agent reports that its hand-over is fine. Asserted at both call sites for the same reason
  // `stored` is: dropping it from either one alone is what a test on the other misses.
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

  /**
   * The reproduction, at the assembly rather than in the unit: a task with an agent, handed to
   * itself, under a run — and the rail told the reader beside the live indicator that nothing would
   * run it. `done` printed the same sentence. Reading the board's ROLES rather than a list of its
   * approved ids is what distinguishes "not there yet" from "already past there".
   */
  it.each(["in_progress", "done"])(
    "says nothing about a task in %s, whatever the rest of its hand-over is",
    async (status) => {
      serve({ status, assignedBy: { _id: "u1", username: "rpo", fullName: "Rafal Podles" } });
      renderDetail();
      await loaded();

      expect(screen.queryByTestId("handover-notice")).toBeNull();
    }
  );

  // Nothing to say about a task whose assignee handed it to themselves — the everyday case, and a
  // notice on it would be on almost every task on the board
  it("says nothing when the hand-over is sound", async () => {
    serve({ assignedBy: { _id: "u1", username: "rpo", fullName: "Rafal Podles" } });
    renderDetail();
    await loaded();

    expect(screen.queryByTestId("handover-notice")).toBeNull();
  });
});

/**
 * The notice above tells the reader to "assign it again to record that", and this is the view that
 * prints it. Auto-save sends the diff, so re-picking the person already on the task sent nothing at
 * all: no PUT, no toast, no change — the recovery the product documents was a no-op exactly where
 * it was documented. The e2e that proves the repair calls updateTask directly and steps over this.
 *
 * Asserted on the request rather than on a callback, because the callback is the half that already
 * worked: what broke is between the picker and the wire.
 */
describe("TaskDetail, re-assigning a task whose assigner was never recorded", () => {
  const RAFAL = { _id: "u1", username: "rpo", fullName: "Rafal Podles" };
  const legacy = {
    ...task,
    status: "todo",
    agent: "ag1",
    assignee: RAFAL,
    // The absence itself. A null would take the same branch, but an old document has no key at all.
    assignedBy: undefined,
  };

  function serve(over: Record<string, unknown> = {}) {
    api.get.mockImplementation((url: string) => {
      if (url === "/api/users") return Promise.resolve([RAFAL, { _id: "u2", username: "claude", fullName: "Claude Code" }]);
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

  // The task is re-read afterwards, or the reader performs the repair and watches the complaint it
  // fixed stay on screen until they navigate away
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

  // The forced write is for the missing assigner and nothing else. A task that records one is
  // already correct, and re-picking on it must stay the no-op the diff makes it.
  it("sends nothing when the assigner is already recorded", async () => {
    serve({ assignedBy: RAFAL });
    renderDetail();
    await loaded();

    await pickAssignee(/Rafal Podles/);

    expect(api.put).not.toHaveBeenCalled();
  });
});

/**
 * A personal agent runs only on a task its owner assigned to themselves, so the rail withholds one
 * from the picker anywhere else — which it can only do if it is told who is reading. The prop is
 * required, so dropping it from a call site is a `tsc` error; passing the WRONG thing is not, and a
 * rail that never matches the reader silently offers nobody their own agents anywhere.
 *
 * Both call sites, separately, and in both polarities: the note is the only visible difference, so
 * a test asserting it in one state alone would pass with a rail that always printed it.
 */
describe("TaskDetail, whether the rail knows who is reading", () => {
  const MINE = { _id: "ag9", name: "My own agent", scope: "user", description: "" };

  function serve(over: Record<string, unknown> = {}) {
    api.get.mockImplementation((url: string) => {
      if (url === "/api/users")
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
