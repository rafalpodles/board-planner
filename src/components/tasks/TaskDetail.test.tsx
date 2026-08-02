// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { TaskDetail } from "./TaskDetail";

const { api, auth } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  auth: { user: { _id: "u1", username: "rpo" } },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock("@/lib/board-refresh", () => ({ subscribeBoardRefresh: () => () => {} }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

// The four panels self-fetch; stubbing them keeps this spec about the assembly
vi.mock("./TaskActivityPanel", () => ({
  TaskActivityPanel: () => <div data-testid="activity-panel" />,
}));
vi.mock("./TaskLinks", () => ({ TaskLinks: () => <div data-testid="task-links" /> }));
vi.mock("./GitlabActivity", () => ({ GitlabActivity: () => <div data-testid="gitlab" /> }));
vi.mock("./TaskForm", () => ({ TaskForm: () => <div data-testid="task-form" /> }));

const task = {
  _id: "t1",
  taskNumber: 6,
  title: "Recurring one",
  status: "todo",
  priority: "high",
  difficulty: "L",
  category: "idea",
  labels: [],
  watchers: [],
  linkedPRs: [],
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

const project = {
  _id: "p1",
  key: "TP",
  name: "Test Project",
  components: [],
  categories: [],
  columns: [],
  labels: [],
  customFields: [],
};

beforeEach(() => {
  api.get.mockReset();
  api.get.mockImplementation((url: string) => {
    if (url.includes("/tasks/")) return Promise.resolve(task);
    if (url.includes("/sprints")) return Promise.resolve([]);
    return Promise.resolve(project);
  });
});

afterEach(cleanup);

function renderDetail(over: Partial<React.ComponentProps<typeof TaskDetail>> = {}) {
  return render(
    <TaskDetail projectId="TP" taskId="6" onClose={() => {}} {...over} />
  );
}

describe("TaskDetail", () => {
  // The whole point of the task: the modal was a strict subset of the page
  it("renders every panel, not a subset", async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByTestId("task-form")).toBeTruthy());
    expect(screen.getByTestId("activity-panel")).toBeTruthy();
    expect(screen.getByTestId("task-links")).toBeTruthy();
    expect(screen.getByTestId("gitlab")).toBeTruthy();
    expect(screen.getByText("Dependencies")).toBeTruthy();
    expect(screen.getByText("Duplicate")).toBeTruthy();
    expect(screen.getByText("Watch")).toBeTruthy();
  });

  it("no longer apologises for being incomplete", async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByTestId("task-form")).toBeTruthy());
    expect(screen.queryByText(/Open full task page/i)).toBeNull();
  });

  it("lays out content and activity as two columns", async () => {
    const { container } = renderDetail();
    await waitFor(() => expect(screen.getByTestId("task-form")).toBeTruthy());
    const grid = container.querySelector(".lg\\:grid");
    expect(grid).toBeTruthy();
    expect(grid!.className).toContain("lg:grid-cols-[minmax(0,1fr)_360px]");
    expect(container.querySelector("aside")).toBeTruthy();
    expect(container.querySelector("aside")!.contains(screen.getByTestId("activity-panel"))).toBe(
      true
    );
  });

  // The page navigates back to the board; the modal has its own dismiss
  it("shows the back link only when asked", async () => {
    renderDetail({ showBackLink: true });
    await waitFor(() => expect(screen.getByText(/Back to board/)).toBeTruthy());

    cleanup();
    renderDetail();
    await waitFor(() => expect(screen.getByTestId("task-form")).toBeTruthy());
    expect(screen.queryByText(/Back to board/)).toBeNull();
  });

  it("reports the loaded task so a container can title itself", async () => {
    const onLoaded = vi.fn();
    renderDetail({ onLoaded });
    await waitFor(() => expect(onLoaded).toHaveBeenCalled());
    const [loadedTask, loadedProject] = onLoaded.mock.calls.at(-1)!;
    expect(loadedTask.taskNumber).toBe(6);
    expect(loadedProject.key).toBe("TP");
  });

  it("closes rather than navigating when the back link is used", async () => {
    const onClose = vi.fn();
    renderDetail({ showBackLink: true, onClose });
    await waitFor(() => expect(screen.getByText(/Back to board/)).toBeTruthy());
    await act(async () => {
      screen.getByText(/Back to board/).click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("loads the task, the project and its sprints", async () => {
    renderDetail();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    const urls = api.get.mock.calls.map((c) => c[0]);
    expect(urls.some((u: string) => u.includes("/tasks/6"))).toBe(true);
    expect(urls.some((u: string) => u.endsWith("/sprints"))).toBe(true);
  });
});
