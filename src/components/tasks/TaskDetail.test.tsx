// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { TaskDetail } from "./TaskDetail";

const { api, auth } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  auth: { user: { _id: "u1", username: "rpo", fullName: "Rafal Podles" } },
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
