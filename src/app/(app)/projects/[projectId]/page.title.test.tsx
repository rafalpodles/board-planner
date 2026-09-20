// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import KanbanPage from "./page";
import { APP_NAME } from "@/lib/brand";
import { ApiProject, ApiTask } from "@/types";

/**
 * BP-480. The board writes the browser tab's title — the project's name plus how much is in
 * progress and waiting — and nothing at any level read it back. It is painted outside the page,
 * so a coverage audit that looks for controls walks straight past it.
 *
 * Two things rot quietly here. The counts come from column **roles** rather than ids, which is the
 * whole point: a board that renamed "To Do" counted nothing and showed a bare project name until
 * that was fixed. And the effect's cleanup puts the plain app name back — a stale title left
 * behind on the way out is the kind of bug nobody files and everybody sees.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { username: "owner", collapseEmptyColumns: false }, isAdmin: false }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/projects/TP",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/board-refresh", () => ({
  subscribeBoardRefresh: () => () => {},
  emitBoardRefresh: vi.fn(),
}));

/** Ids deliberately unlike their roles, so nothing can pass by matching the word "todo" */
const RENAMED_COLUMNS = [
  { id: "icebox", label: "Icebox", color: "#888", role: "backlog", order: 0 },
  { id: "queued", label: "Queued up", color: "#3b82f6", role: "approved", order: 1 },
  { id: "doing", label: "Doing", color: "#f59e0b", role: "active", order: 2 },
  { id: "shipped", label: "Shipped", color: "#22c55e", role: "done", order: 3 },
];

function project(over: Partial<ApiProject> = {}): ApiProject {
  return {
    _id: "p1",
    key: "TP",
    name: "Test Project",
    columns: RENAMED_COLUMNS,
    categories: [],
    customFields: [],
    taskTemplates: [],
    ...over,
  } as unknown as ApiProject;
}

function task(id: string, status: string): ApiTask {
  return {
    _id: id,
    taskNumber: Number(id.slice(1)),
    title: `Task ${id}`,
    status,
    priority: "medium",
    category: "bug",
    order: 0,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  } as ApiTask;
}

async function renderBoard(proj: ApiProject, tasks: ApiTask[]) {
  api.get.mockImplementation((url: string) => {
    if (url === "/api/projects/p1") return Promise.resolve(proj);
    if (url.startsWith("/api/projects/p1/tasks")) return Promise.resolve(tasks.map((t) => ({ ...t })));
    if (url === "/api/projects/p1/sprints") return Promise.resolve([]);
    if (url.endsWith("/assignable-users")) return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  const view = render(<KanbanPage />);
  // The heading is the board's own, and waiting for it means the project request has landed —
  // the title is written from the same data
  await screen.findByRole("heading", { name: "Test Project" });
  return view;
}

beforeEach(() => {
  api.get.mockReset();
  document.title = APP_NAME;
});
afterEach(cleanup);

describe("the browser tab's title", () => {
  it("names the board and what is on it, counting by role rather than by column id", async () => {
    await renderBoard(project(), [
      task("t1", "queued"),
      task("t2", "queued"),
      task("t3", "doing"),
      // Neither of these is counted: one is behind the board, one is finished
      task("t4", "icebox"),
      task("t5", "shipped"),
    ]);

    expect(document.title).toBe(`Test Project (1 in progress, 2 todo) — ${APP_NAME}`);
  });

  it("leaves out a count that is zero rather than printing it", async () => {
    await renderBoard(project(), [task("t1", "queued")]);
    expect(document.title).toBe(`Test Project (1 todo) — ${APP_NAME}`);
  });

  it("gives an empty board its plain name, with no empty parentheses", async () => {
    await renderBoard(project(), [task("t4", "icebox"), task("t5", "shipped")]);
    expect(document.title).toBe(`Test Project — ${APP_NAME}`);
    expect(document.title).not.toContain("(");
  });

  it("puts the plain app name back on the way out", async () => {
    const view = await renderBoard(project(), [task("t3", "doing")]);
    expect(document.title).toContain("Test Project");

    view.unmount();

    expect(document.title).toBe(APP_NAME);
  });
});
