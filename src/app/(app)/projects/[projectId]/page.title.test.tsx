// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import KanbanPage from "./page";
import { APP_NAME } from "@/lib/brand";
import { ApiProject, ApiTask } from "@/types";
import type { ProjectBoard } from "@/hooks/use-project-board";

/**
 * BP-480. The board writes the browser tab's title — the project's name plus how much is in
 * progress and waiting — and nothing at any level read it back. It is painted outside the page,
 * so a coverage audit that looks for controls walks straight past it.
 *
 * The board is handed to the page directly, the way `page.scope.test.tsx` does it, rather than
 * fetched: the title is written by a passive effect, and a gate on rendered output — a heading —
 * can resolve on the commit before that effect has run. The first version of this file did exactly
 * that and flaked one run in eight.
 *
 * Two things rot quietly here. The counts come from column **roles** rather than ids, which is the
 * whole point: a board that renamed "To Do" counted nothing and showed a bare project name until
 * that was fixed. And the effect's cleanup puts the plain app name back — a stale title left
 * behind on the way out is the kind of bug nobody files and everybody sees.
 */

const { api, boardOverride } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
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

// Every field the page's own view needs; the test only ever varies the two the title reads
function board(project: ApiProject | null, tasks: ApiTask[]): ProjectBoard {
  return {
    project,
    tasks,
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
    loadedScope: "all",
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
    forcing: false,
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
  } as unknown as ProjectBoard;
}

/** Waits on the title itself: it is written by an effect, so no rendered output gates it */
async function expectTitle(expected: string) {
  await waitFor(() => expect(document.title).toBe(expected));
}

function renderBoard(proj: ApiProject, tasks: ApiTask[]) {
  boardOverride.current = board(proj, tasks);
  return render(<KanbanPage />);
}

beforeEach(() => {
  api.get.mockReset();
  boardOverride.current = null;
  document.title = APP_NAME;
});
afterEach(cleanup);

describe("the browser tab's title", () => {
  it("names the board and what is on it, counting by role rather than by column id", async () => {
    renderBoard(project(), [
      task("t1", "queued"),
      task("t2", "queued"),
      task("t3", "doing"),
      // None of these is counted: one is behind the board, two are finished. Two rather than one
      // on purpose — with a single finished task, counting `done` instead of `active` produces the
      // same sentence and this test cannot tell the two apart.
      task("t4", "icebox"),
      task("t5", "shipped"),
      task("t6", "shipped"),
    ]);

    await expectTitle(`Test Project (1 in progress, 2 todo) — ${APP_NAME}`);
  });

  it("leaves out a count that is zero rather than printing it", async () => {
    renderBoard(project(), [task("t1", "queued")]);
    await expectTitle(`Test Project (1 todo) — ${APP_NAME}`);
  });

  it("gives an empty board its plain name, with no empty parentheses", async () => {
    renderBoard(project(), [task("t4", "icebox"), task("t5", "shipped")]);
    await expectTitle(`Test Project — ${APP_NAME}`);
    expect(document.title).not.toContain("(");
  });

  it("puts the plain app name back on the way out", async () => {
    const view = renderBoard(project(), [task("t3", "doing")]);
    await expectTitle(`Test Project (1 in progress) — ${APP_NAME}`);

    view.unmount();

    expect(document.title).toBe(APP_NAME);
  });

  /**
   * The counts follow the board while it is open, not only at first paint. Without `tasks` in the
   * effect's dependency array every test above still passes — measured — and the title would sit
   * stale after an optimistic move, which the board makes on every drag without touching `project`.
   */
  it("follows the board when its tasks change under it", async () => {
    // The same project object on both renders, deliberately: build a fresh one and the effect
    // re-runs because `project` changed, which would pass with `tasks` missing from the deps —
    // measured, that is exactly what the first version of this test did
    const sameProject = project();
    const view = renderBoard(sameProject, [task("t1", "queued")]);
    await expectTitle(`Test Project (1 todo) — ${APP_NAME}`);

    boardOverride.current = board(sameProject, [task("t1", "doing")]);
    view.rerender(<KanbanPage />);

    await expectTitle(`Test Project (1 in progress) — ${APP_NAME}`);
  });
});
