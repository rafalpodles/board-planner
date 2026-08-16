# Sprint View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Sprints tab a sprint selector with that sprint's own board, a planning view where scope is decided, and estimates with a velocity chart.

**Architecture:** The 795-line project board page splits into `useProjectBoard` (data + writes + the two pieces of view state a header needs) and `ProjectBoardView` (the shell). Each page renders its own header above the view and feeds it from the same `board` object. The sprints page composes the same two pieces with a sprint selector, a sprint header and a planning view.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind 4, Mongoose 9 / MongoDB 4.4, Vitest + @testing-library/react + happy-dom.

**Spec:** `docs/superpowers/specs/2026-08-11-sprint-view-design.md`

## Global Constraints

- MongoDB 4.4: no `$dateTrunc`, `$dateAdd`/`$dateDiff`, `$setWindowFields`, and no `$lookup` mixing `localField`/`foreignField` with an inline `pipeline`.
- No new npm dependencies. The velocity chart is hand-written SVG; the repo has no charting library and one bar chart does not justify adding one.
- Comments: default to none. Only a `// TODO(scope):` marker or a one-liner explaining a non-obvious workaround. No javadoc, no narration.
- Columns are resolved by **role**, never by literal id — use `columnIdsWithRole(project, "done")` / `roleOf()` from `src/lib/columns.ts`.
- `src/app/(app)/projects/[projectId]/page.test.tsx` must pass **with no edit to the test file**, and `page.tsx` must keep its default export (the test imports `./page`).
- Every branch ends with `npm run build` and `npm test` green, plus a pass clicked through the UI against a local Mongo. Never curl as verification.
- Conventional commits, English. No `Co-Authored-By`, no generated-with footer.
- Tests run with `npm test` (vitest run). A single file: `npx vitest run <path>`.

---

## File Structure

**Phase A — BP-200, branch `bp-200/sprints-tab`**

| File | Responsibility |
|---|---|
| `src/hooks/use-project-board.ts` (create) | Board data and every task write, for one scope |
| `src/components/kanban/ProjectBoardView.tsx` (create) | Filters, Board/ListView, context menu, dialogs, new-task modal, shortcuts, empty state |
| `src/app/(app)/projects/[projectId]/page.tsx` (rewrite, ~60 lines) | URL scope, `BoardHeader`, the view |
| `src/components/kanban/Board.tsx`, `Column.tsx`, `TaskCard.tsx` (modify) | `readOnly` |
| `src/lib/sprint-selection.ts` (create) | Which sprint is selected, and how the list is grouped |
| `src/components/sprints/SprintSelector.tsx` (create) | The grouped list, and the mobile `Select` |
| `src/components/sprints/SprintHeader.tsx` (create) | Name, dates, progress, lifecycle buttons, the view toggle |
| `src/components/sprints/SprintFormModal.tsx` (create) | The create/edit form lifted out of the page |
| `src/components/sprints/CompleteSprintDialog.tsx` (create) | The complete dialog lifted out of the page |
| `src/app/(app)/projects/[projectId]/sprints/page.tsx` (rewrite) | Composition and the sprint lifecycle handlers |

**Phase B — BP-207, branch `bp-207/sprint-planning`**

| File | Responsibility |
|---|---|
| `src/components/sprints/PlanningView.tsx` (create) | Two panes, the backlog fetch, the moves |
| `src/components/sprints/PlanningPane.tsx` (create) | One pane: rows, count, drop target, add/remove button |

**Phase C — BP-208, branch `bp-208/sprint-velocity`**

| File | Responsibility |
|---|---|
| `src/lib/estimates.ts` (create) | Which field is the estimate, and summing it client-side |
| `src/models/project.ts`, `src/types/index.ts` (modify) | `estimateFieldId` |
| `src/app/api/projects/[projectId]/route.ts` (modify) | Accept and validate `estimateFieldId` |
| `src/app/api/projects/[projectId]/custom-fields/[fieldId]/route.ts` (modify) | Clear the designation on archive and on delete |
| `src/app/api/projects/[projectId]/sprints/route.ts` (modify) | `estimateTotal` / `estimateDone` per sprint |
| `.../settings/sections/TaskFieldsSection.tsx` (modify) | The designation row |
| `src/components/sprints/VelocityChart.tsx` (create) | The SVG bar chart |

---

# Phase A — BP-200

## Task 1: Extract `useProjectBoard` and `ProjectBoardView`

A pure refactor. No behaviour changes, no new props used by anyone yet. Its own commit so it can be read on its own in the pull request.

**Files:**
- Create: `src/hooks/use-project-board.ts`
- Create: `src/components/kanban/ProjectBoardView.tsx`
- Modify: `src/app/(app)/projects/[projectId]/page.tsx` (795 lines → ~60)
- Test: `src/app/(app)/projects/[projectId]/page.test.tsx` — **read only, never edited**

**Interfaces:**
- Produces:

```ts
export interface ProjectBoard {
  project: ApiProject | null;
  tasks: ApiTask[];
  sprints: ApiSprint[];
  assignableUsers: ApiUserSummary[];
  loading: boolean;
  reload: () => Promise<void>;
  viewMode: "board" | "list";
  setViewMode: (mode: "board" | "list") => void;
  showNewTask: boolean;
  setShowNewTask: (open: boolean) => void;
  scope: string;
  heldMove: { retry: () => Promise<unknown>; conflict: RunConflict; taskKey: string } | null;
  setHeldMove: (held: ProjectBoard["heldMove"]) => void;
  forceHeldMove: () => Promise<void>;
  handleStatusChange: (taskId: string, status: string) => Promise<void>;
  handleTaskDrop: (taskId: string, status: string, dropIndex: number) => Promise<void>;
  handleReorder: (orderedIds: string[]) => Promise<void>;
  handleBulkMove: (status: string) => Promise<void>;
  handleBulkSprint: (sprintId: string | null) => Promise<void>;
  handleBulkDelete: () => Promise<void>;
  applySprintChange: (taskIds: string[], sprintId: string | null) => void;
  patchTask: (taskId: string, patch: Record<string, unknown>, label: string) => Promise<void>;
  handleAssigneeChange: (taskId: string, username: string) => Promise<void>;
  handleFieldValueChange: (taskId: string, fieldId: string, value: string) => Promise<void>;
  handleRowSprintChange: (taskId: string, sprintId: string | null) => Promise<void>;
  handleContextDuplicate: (taskId: string) => Promise<void>;
  handleContextDelete: (taskId: string) => Promise<void>;
}

// scope null means "no scope resolved yet": the hook loads the project and the sprint list
// but does NOT fetch tasks, and `tasks` stays empty. The project board never passes null;
// the sprints page must, because which sprint is selected can only be decided once the
// sprint list has arrived, and firing /tasks?sprint=<unvalidated> is a 500 (Task 3, Step 1).
export function useProjectBoard(projectId: string, scope: string | null): ProjectBoard;
```

```ts
// src/components/kanban/ProjectBoardView.tsx
interface ProjectBoardViewProps {
  board: ProjectBoard;
  readOnly?: boolean;          // wired in Task 2, accepted and ignored here
  emptyState?: React.ReactNode; // wired in Task 5, defaults to the current copy
}
export function ProjectBoardView({ board, readOnly, emptyState }: ProjectBoardViewProps): JSX.Element;
```

- [ ] **Step 1: Run the board test first, to record the green baseline**

```bash
npx vitest run "src/app/(app)/projects/[projectId]/page.test.tsx"
```

Expected: 10 passing. Write the number down — it is the only check on this task.

- [ ] **Step 2: Create the hook by moving code, not rewriting it**

Move into `src/hooks/use-project-board.ts`, verbatim: the state declarations at `page.tsx:69-103` **except** `filteredTasks`, `selectedTasks`, `selectionMode`, `confirmBulkDelete`, `bulkDeleting`, `contextMenu`, `confirmContextDelete`, `sortField`, `sortDir`, `hiddenColumns`, `showShortcutHelp`, `focusedTaskIndex` (those are the view's); `loadSeq`; `loadData` (`:127-148`) with its eslint-disable comment intact; the `assignableUsers` effect (`:151-154`); `usePollWhileVisible(loadData, 10_000)`; the `subscribeBoardRefresh` effect; and every handler from `:242` to `:544` except `handleTaskSelect`.

`viewMode` (`:96-99`) and `showNewTask` (`:73`) move into the hook — `BoardHeader` needs both and it is rendered by the page, not by the view.

One behaviour is **added** while moving `loadData`, because the sprints page needs it in Task 4: when
`scope` is `null`, fetch the project and the sprint list but skip the tasks request and leave `tasks`
at `[]`. Everything else about `loadData` — the `loadSeq` guard, the `Promise.all`, the toast on
failure — is unchanged, and the board page never passes `null`, so the 10 existing tests still cover
the path they always covered.

Three things do **not** move:
- the document-title effect (`:164-178`) stays on the project board page;
- `withIncomingRelations` (`:32-51`) moves to the hook file as a module-level function;
- `now` / `setNow` (`:89`, `:106`, `:141`) and its `usePollWhileVisible(tick, 60_000)` are **deleted** — written in three places, read nowhere.

- [ ] **Step 3: Keep the handlers as plain function declarations**

Do not wrap them in `useCallback` while moving them. `parkIfHeld` (`:361`), `handleTaskDrop` (`:393`), `handleBulkMove` (`:254`), `patchTask` (`:476`) and `handleContextDuplicate` (`:512`) all read `tasks` from the render closure; memoising them hands them a stale list, which silently breaks the drop arithmetic and the task key in the held-move dialog.

`loadData` keeps its `useCallback` **and** its `// eslint-disable-next-line react-hooks/exhaustive-deps` — the incomplete dep array is load-bearing.

- [ ] **Step 4: Create the view by moving the JSX**

Move `page.tsx:572-792` — `BoardFilters` through the last `ConfirmDialog` — into `ProjectBoardView`, minus `BoardHeader`. The view keeps its own `filteredTasks`, `selectedTasks`, `selectionMode`, `contextMenu`, the two delete confirmations, the sort and hidden-column state, `focusedTaskIndex`, `showShortcutHelp`, `handleTaskSelect`, the `sortContext` memo (`:118-125`) and the keyboard-shortcut effect (`:180-240`). Everything it needs from data or writes comes off `board`.

- [ ] **Step 5: Reduce the page to composition**

```tsx
export default function KanbanPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const scope = sprintScopeFromParam(searchParams.get("sprint"));
  const board = useProjectBoard(projectId, scope);

  useCanonicalUrl(board.project?.key);
  useBoardDocumentTitle(board.project, board.tasks);

  if (board.loading || !board.project) return <BoardSpinner />;

  return (
    <div className="lg:flex-1 lg:min-h-0 lg:flex lg:flex-col lg:overflow-hidden">
      <BoardHeader
        projectName={board.project.name}
        projectIcon={board.project.icon}
        projectDescription={board.project.description}
        sprints={board.sprints}
        scope={scope}
        onScopeChange={(next) => router.push(projectPath(projectId) + sprintScopeToQuery(next))}
        viewMode={board.viewMode}
        onViewModeChange={board.setViewMode}
        onRefresh={board.reload}
        onNewTask={() => board.setShowNewTask(true)}
      />
      <ProjectBoardView board={board} />
    </div>
  );
}
```

`scope` stays a **string** derived immediately from `searchParams`, exactly as today. The test mocks `useSearchParams` as a fresh `URLSearchParams` on every call; memoising on that object gives `loadData` a new identity each render, and `usePollWhileVisible` invokes its callback immediately — an infinite reload loop no test would name.

- [ ] **Step 6: Run the board test — unedited**

```bash
npx vitest run "src/app/(app)/projects/[projectId]/page.test.tsx"
```

Expected: the same 10 passing. If a test now fails, behaviour changed during the move — fix the code, never the test. `:239` pins `handleTaskDrop`'s midpoint arithmetic against the pre-move task list and is the assertion that catches a stale closure.

- [ ] **Step 7: Run the whole suite and the build**

```bash
npm test && npm run build
```

Expected: both green.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/use-project-board.ts src/components/kanban/ProjectBoardView.tsx "src/app/(app)/projects/[projectId]/page.tsx"
git commit -m "refactor(board): split the board page into a data hook and a view"
```

---

## Task 2: `readOnly` on the board

**Files:**
- Modify: `src/components/kanban/TaskCard.tsx:72,77-80,285-301`
- Modify: `src/components/kanban/Column.tsx:56-89,143-161,189-192`
- Modify: `src/components/kanban/Board.tsx:55,107-111`
- Modify: `src/components/kanban/ProjectBoardView.tsx`
- Test: `src/components/kanban/Board.test.tsx`

**Interfaces:**
- Consumes: `ProjectBoardView({ board, readOnly })` from Task 1.
- Produces: `readOnly?: boolean` on `Board`, `Column` and `TaskCard`. Default `false` everywhere, so no existing call site changes.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/kanban/Board.test.tsx`, following the render helper already at the top of that file:

```tsx
describe("A read-only board", () => {
  it("does not offer a card as a drag source", () => {
    renderBoard({ readOnly: true });
    const card = screen.getByRole("link", { name: /Add the sprint selector/i });
    expect(card.getAttribute("draggable")).toBe("false");
  });

  it("still lets a card be opened", () => {
    renderBoard({ readOnly: true });
    const card = screen.getByRole("link", { name: /Add the sprint selector/i });
    expect(card.getAttribute("href")).toContain("/BP-");
  });

  it("drops nothing when a task is dragged onto a column", () => {
    const onTaskDrop = vi.fn();
    const onStatusChange = vi.fn();
    renderBoard({ readOnly: true, onTaskDrop, onStatusChange });
    const column = screen.getByTestId("column-in_progress");
    fireEvent.drop(column, { dataTransfer: { getData: () => "t1" } });
    expect(onTaskDrop).not.toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("does not invite a drop into an empty column", () => {
    renderBoard({ readOnly: true });
    expect(screen.queryByText("Drop tasks here")).toBeNull();
  });
});
```

Adjust the card's accessible name to whatever the existing fixture in that file uses; do not invent a second fixture.

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run src/components/kanban/Board.test.tsx
```

Expected: FAIL — `draggable` is `"true"`, and the drop handler still fires.

- [ ] **Step 3: Thread the prop**

`TaskCard`: `draggable={!readOnly}` — the card is an `<a>`, and an anchor drags by default, so the attribute must be explicitly false rather than absent. Guard `onDragStart`, and render the selection button only when `!readOnly`.

`Column`: when `readOnly`, pass `undefined` for `onDragOver`, `onDragEnter`, `onDragLeave` and `onDrop`, hide the "Drop tasks here" placeholder, and keep the collapse control (it is a reading choice, not a write).

`Board`: skip the `dragOverColumn` bookkeeping and pass `readOnly` down.

`ProjectBoardView`: when `readOnly`, pass `undefined` for `onTaskDrop`, `onTaskSelect`, `onTaskContextMenu` and `onReorder`; withhold the Select button from `extraControls`; ignore the `n` shortcut; render no new-task `Modal`; and pass `undefined` for `ListView`'s `onStatusChange`, `onAssigneeChange`, `onPriorityChange`, `onCategoryChange`, `onSprintChange`, `onFieldChange`. Where `ListView` requires a handler rather than accepting `undefined`, pass a no-op and hide the control.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/components/kanban/Board.test.tsx && npx vitest run "src/app/(app)/projects/[projectId]/page.test.tsx"
```

Expected: new tests PASS, the 10 board-page tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/kanban
git commit -m "feat(board): a read-only board keeps every read and refuses every write"
```

---

## Task 3: Sprint selection rules

Pure functions first, so the page composition in Task 4 has nothing to decide.

**Files:**
- Create: `src/lib/sprint-selection.ts`
- Test: `src/lib/sprint-selection.test.ts`

**Interfaces:**
- Produces:

```ts
export const OLDER_COMPLETED_THRESHOLD = 3;

export interface GroupedSprints {
  active: ApiSprint[];
  planned: ApiSprint[];
  completed: ApiSprint[];      // newest first
  recentCompleted: ApiSprint[]; // the first OLDER_COMPLETED_THRESHOLD of completed
  olderCompleted: ApiSprint[];  // the rest
}

export function groupSprints(sprints: ApiSprint[]): GroupedSprints;
export function defaultSprintId(sprints: ApiSprint[]): string | null;
export function resolveSelectedSprint(sprints: ApiSprint[], requested: string | null): string | null;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { ApiSprint } from "@/types";
import { groupSprints, defaultSprintId, resolveSelectedSprint } from "./sprint-selection";

function sprint(over: Partial<ApiSprint> & { _id: string }): ApiSprint {
  return {
    name: over._id,
    startDate: "2026-08-01T00:00:00Z",
    endDate: "2026-08-15T00:00:00Z",
    goal: "",
    status: "planned",
    taskCount: 0,
    doneCount: 0,
    ...over,
  } as ApiSprint;
}

describe("defaultSprintId", () => {
  it("picks the active sprint", () => {
    const sprints = [
      sprint({ _id: "p1", status: "planned" }),
      sprint({ _id: "a1", status: "active" }),
    ];
    expect(defaultSprintId(sprints)).toBe("a1");
  });

  it("picks the planned sprint that starts soonest when none is active", () => {
    const sprints = [
      sprint({ _id: "later", startDate: "2026-09-01T00:00:00Z" }),
      sprint({ _id: "sooner", startDate: "2026-08-20T00:00:00Z" }),
    ];
    expect(defaultSprintId(sprints)).toBe("sooner");
  });

  it("falls back to the most recently completed sprint", () => {
    const sprints = [
      sprint({ _id: "old", status: "completed", endDate: "2026-06-01T00:00:00Z" }),
      sprint({ _id: "recent", status: "completed", endDate: "2026-07-01T00:00:00Z" }),
    ];
    expect(defaultSprintId(sprints)).toBe("recent");
  });

  it("has no answer for a project with no sprints", () => {
    expect(defaultSprintId([])).toBeNull();
  });
});

describe("resolveSelectedSprint", () => {
  it("honours a requested sprint that exists", () => {
    const sprints = [sprint({ _id: "a1", status: "active" }), sprint({ _id: "p1" })];
    expect(resolveSelectedSprint(sprints, "p1")).toBe("p1");
  });

  it("falls back to the default when the requested sprint is gone", () => {
    const sprints = [sprint({ _id: "a1", status: "active" })];
    expect(resolveSelectedSprint(sprints, "deleted-id")).toBe("a1");
  });

  it("falls back to the default for a value that is not an id at all", () => {
    const sprints = [sprint({ _id: "a1", status: "active" })];
    expect(resolveSelectedSprint(sprints, "../../etc/passwd")).toBe("a1");
  });
});

describe("groupSprints", () => {
  it("keeps the three most recent completed sprints out of the older pile", () => {
    const completed = ["c1", "c2", "c3", "c4"].map((id, i) =>
      sprint({ _id: id, status: "completed", endDate: `2026-0${i + 1}-01T00:00:00Z` })
    );
    const grouped = groupSprints(completed);
    expect(grouped.recentCompleted.map((s) => s._id)).toEqual(["c4", "c3", "c2"]);
    expect(grouped.olderCompleted.map((s) => s._id)).toEqual(["c1"]);
  });
});
```

The last `resolveSelectedSprint` test is the one that matters operationally: `GET /tasks?sprint=<x>` assigns straight into the Mongoose filter with no validation (`src/app/api/projects/[projectId]/tasks/route.ts:52-57`), so an id the project does not have is a CastError and a 500. The page must never send one.

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run src/lib/sprint-selection.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { ApiSprint } from "@/types";

export const OLDER_COMPLETED_THRESHOLD = 3;

const byStart = (a: ApiSprint, b: ApiSprint) => a.startDate.localeCompare(b.startDate);
const byEndDesc = (a: ApiSprint, b: ApiSprint) => b.endDate.localeCompare(a.endDate);

export interface GroupedSprints {
  active: ApiSprint[];
  planned: ApiSprint[];
  completed: ApiSprint[];
  recentCompleted: ApiSprint[];
  olderCompleted: ApiSprint[];
}

export function groupSprints(sprints: ApiSprint[]): GroupedSprints {
  const active = sprints.filter((s) => s.status === "active");
  const planned = sprints.filter((s) => s.status === "planned").sort(byStart);
  const completed = sprints.filter((s) => s.status === "completed").sort(byEndDesc);
  return {
    active,
    planned,
    completed,
    recentCompleted: completed.slice(0, OLDER_COMPLETED_THRESHOLD),
    olderCompleted: completed.slice(OLDER_COMPLETED_THRESHOLD),
  };
}

// "Most recent planned" reads as the sprint about to run, not the one furthest out
export function defaultSprintId(sprints: ApiSprint[]): string | null {
  const { active, planned, completed } = groupSprints(sprints);
  return active[0]?._id ?? planned[0]?._id ?? completed[0]?._id ?? null;
}

export function resolveSelectedSprint(
  sprints: ApiSprint[],
  requested: string | null
): string | null {
  if (requested && sprints.some((s) => s._id === requested)) return requested;
  return defaultSprintId(sprints);
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/lib/sprint-selection.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sprint-selection.ts src/lib/sprint-selection.test.ts
git commit -m "feat(sprints): rules for grouping sprints and choosing the selected one"
```

---

## Task 4: The Sprints tab — selector, header, board

**Files:**
- Create: `src/components/sprints/SprintSelector.tsx`
- Create: `src/components/sprints/SprintHeader.tsx`
- Create: `src/components/sprints/SprintFormModal.tsx`
- Create: `src/components/sprints/CompleteSprintDialog.tsx`
- Modify: `src/app/(app)/projects/[projectId]/sprints/page.tsx` (rewrite)
- Test: `src/app/(app)/projects/[projectId]/sprints/page.test.tsx` (extend; the two existing tests change because the card grid is gone — that is this task's deliverable, unlike the board page's tests)

**Interfaces:**
- Consumes: `useProjectBoard`, `ProjectBoardView` (Task 1); `readOnly` (Task 2); `groupSprints`, `resolveSelectedSprint` (Task 3).
- Produces:

```tsx
interface SprintSelectorProps {
  sprints: ApiSprint[];
  selectedId: string | null;
  onSelect: (sprintId: string) => void;
}
interface SprintHeaderProps {
  sprint: ApiSprint;
  doneCount: number;   // from board.tasks, not from filteredTasks
  totalCount: number;
  onActivate: () => void;
  onComplete: () => void;
  onEdit: () => void;
  onDelete: () => void;
}
```

- [ ] **Step 1: Write the failing tests**

Replace the body of `sprints/page.test.tsx`, keeping its mock harness (`vi.hoisted` api, `next/navigation`, Toast) and adding `useSearchParams: () => new URLSearchParams()` to the `next/navigation` mock, plus mocks for `@/hooks/use-auth` and `@/lib/board-refresh` matching `page.test.tsx:13,27`. `api.get` must answer three URLs — `/sprints`, `/tasks…`, and the project — so use `mockImplementation` keyed on the path rather than `mockResolvedValue`.

```tsx
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
    expect(screen.getByRole("button", { name: /Sprint 13/ })).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Planned")).toBeTruthy();
  });

  it("keeps the empty state when a project has no sprints", async () => {
    await renderSprints([]);
    expect(screen.getByText("No sprints yet")).toBeTruthy();
  });

  it("asks for the selected sprint's tasks and nothing else", async () => {
    await renderSprints();
    expect(api.get).toHaveBeenCalledWith("/api/projects/p1/tasks?sprint=s1");
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
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run "src/app/(app)/projects/[projectId]/sprints/page.test.tsx"
```

Expected: FAIL — the page still renders the card grid.

- [ ] **Step 3: Lift the modals out unchanged**

Move the create/edit `Modal` and its form (`sprints/page.tsx:301-371`) into `SprintFormModal`, and the complete dialog (`:373-401`) into `CompleteSprintDialog`. Same markup, same `sprint-defaults` helpers, same overlap warning; props are the values and the two callbacks. No behaviour change here.

- [ ] **Step 4: Write the selector**

Grouped Active / Planned / Completed from `groupSprints`. Each row is a `button` showing the name and `doneCount/taskCount`. `olderCompleted` sits behind a `Show {n} older` toggle. Below `lg`, render a `Select` of the same options instead of the column — the board already scrolls horizontally and a second horizontal element beside it fights the same gesture. Use `useMediaQuery("(min-width: 1024px)")`, remembering it returns `false` until the effect runs.

- [ ] **Step 5: Write the header**

Name, `statusBadge` (moved from the page), goal, date range, days remaining and one done/total bar. Lifecycle buttons for a planned or active sprint; **none at all for a completed one**.

- [ ] **Step 6: Compose the page**

The scope and the sprint list are circular — the hook loads the sprints, and which sprint is
selected can only be decided once they have arrived. Break it with one piece of state, starting at
`null`:

```tsx
const searchParams = useSearchParams();
const router = useRouter();
const requested = searchParams.get("sprint");

// Starts null on purpose: passing `requested` straight through would fire
// /tasks?sprint=<unvalidated>, and that endpoint casts the value into a Mongoose filter
// with no validation, so a stale bookmark is a 500 rather than a fallback.
const [scope, setScope] = useState<string | null>(null);
const board = useProjectBoard(projectId, scope);

useEffect(() => {
  if (board.loading) return;
  const next = resolveSelectedSprint(board.sprints, requested);
  if (next !== scope) setScope(next);
  if (next && next !== requested) {
    router.replace(`/projects/${projectId}/sprints?sprint=${next}`);
  }
}, [board.loading, board.sprints, requested, scope, projectId, router]);

const selected = board.sprints.find((s) => s._id === scope) ?? null;
const readOnly = selected?.status === "completed";
const doneIds = new Set(columnIdsWithRole(board.project, "done"));
const doneCount = board.tasks.filter((t) => doneIds.has(t.status)).length;
```

`router.replace`, not `push`: a URL that named a sprint the project does not have should not become
a back-button destination. Selecting a sprint from the selector pushes
`/projects/${projectId}/sprints?sprint=${id}` as an ordinary navigation.

Sprints come from `board.sprints`; the page does not fetch `/sprints` a second time. Lifecycle handlers keep their current bodies but call `board.reload()` instead of a local `loadSprints()`.

- [ ] **Step 7: Run the tests**

```bash
npx vitest run "src/app/(app)/projects/[projectId]/sprints/page.test.tsx" && npm test
```

Expected: the new sprint tests PASS and the whole suite is green, the 10 board-page tests included.

- [ ] **Step 8: Commit**

```bash
git add src/components/sprints "src/app/(app)/projects/[projectId]/sprints"
git commit -m "feat(sprints): the Sprints tab shows the selected sprint's own board"
```

---

## Task 5: Empty states, and the live pass

**Files:**
- Modify: `src/components/kanban/ProjectBoardView.tsx`
- Modify: `src/app/(app)/projects/[projectId]/sprints/page.tsx`
- Test: `src/app/(app)/projects/[projectId]/sprints/page.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
it("says the sprint is empty rather than offering to start the project", async () => {
  await renderSprints(sprints, { tasks: [] });
  expect(screen.getByText("No tasks in this sprint")).toBeTruthy();
  expect(screen.queryByText("Create your first task")).toBeNull();
});

it("offers no create button on an empty completed sprint", async () => {
  await renderSprints(completedOnly, { tasks: [] });
  expect(screen.queryByRole("button", { name: "Create Task" })).toBeNull();
});

it("shows 0/0 for a sprint with no tasks", async () => {
  await renderSprints(sprints, { tasks: [] });
  expect(screen.getByText("0/0")).toBeTruthy();
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run "src/app/(app)/projects/[projectId]/sprints/page.test.tsx"
```

Expected: FAIL — the board's project-shaped copy renders.

- [ ] **Step 3: Implement**

`ProjectBoardView` renders `emptyState` when it is given one, otherwise the existing "No tasks yet / Create your first task" block. The sprints page passes an empty-sprint message, with a create button only when the sprint is not read-only. Guard the progress bar so `taskCount === 0` renders `0/0` and a 0% bar rather than dividing by zero.

- [ ] **Step 4: Run the tests and the build**

```bash
npm test && npm run build
```

Expected: green.

- [ ] **Step 5: The live pass — this is the acceptance, not the tests**

Start the app against a local Mongo (see `memory/local-ui-verification.md`) and, in the browser:

1. A project with an active, a planned and a completed sprint. The active one is selected on load.
2. Drag a card between columns on the sprint board; the header's done/total moves with it.
3. Open a card; the normal task view opens; go back.
4. Select the completed sprint: no lifecycle buttons, cards do not drag, cards still open.
5. Delete the selected sprint; the tab falls back to another sprint instead of erroring.
6. Hand-edit the URL to `?sprint=nonsense`; the tab falls back and the parameter goes away.
7. At 375px: the selector is a dropdown above the header, the board scrolls horizontally.

- [ ] **Step 6: Commit and open the pull request**

```bash
git add -A
git commit -m "feat(sprints): an empty sprint says so instead of offering to start the project"
gh api user -q .login   # must print rafalpodles
gh pr create --title "Sprints tab — sprint selector with the sprint's own board (BP-200)" --body "$(printf 'What changed, why, and what was verified live — one short paragraph each. Link the task key in the title so the PR matcher picks it up.')"
```

---

# Phase B — BP-207, branch `bp-207/sprint-planning`

Cut from `main` after Phase A merges.

## Task 6: The backlog pane

**Files:**
- Create: `src/components/sprints/PlanningPane.tsx`
- Create: `src/components/sprints/PlanningView.tsx`
- Test: `src/components/sprints/PlanningView.test.tsx`

**Interfaces:**
- Consumes: `board.tasks`, `board.applySprintChange`, `board.project` from `ProjectBoard`.
- Produces:

```tsx
interface PlanningViewProps {
  projectId: string;
  board: ProjectBoard;
  sprintId: string;
}
interface PlanningPaneProps {
  title: string;
  tasks: ApiTask[];
  projectKey: string;
  emptyMessage: string;
  action: { label: (task: ApiTask) => string; onClick: (task: ApiTask) => void };
  onDropTask?: (taskId: string) => void;
}
```

- [ ] **Step 1: Write the failing tests**

```tsx
it("loads the backlog with the existing filter rather than a new one", async () => {
  await renderPlanning();
  expect(api.get).toHaveBeenCalledWith("/api/projects/p1/tasks?sprint=backlog");
});

it("shows a count on each pane", async () => {
  await renderPlanning();
  expect(screen.getByText("Backlog (2)")).toBeTruthy();
  expect(screen.getByText("Sprint 12 (1)")).toBeTruthy();
});

it("narrows the backlog with the text filter", async () => {
  await renderPlanning();
  fireEvent.change(screen.getByPlaceholderText("Filter backlog"), {
    target: { value: "login" },
  });
  expect(screen.getByText("Fix the login redirect")).toBeTruthy();
  expect(screen.queryByText("Rename the export button")).toBeNull();
});

it("hides a task sitting in a done column until something is typed", async () => {
  await renderPlanning();
  expect(screen.queryByText("Already shipped")).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("Filter backlog"), {
    target: { value: "shipped" },
  });
  expect(screen.getByText("Already shipped")).toBeTruthy();
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run src/components/sprints/PlanningView.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the panes and the fetch**

`PlanningView` fetches `?sprint=backlog` once on mount into local state — not a second `useProjectBoard`, which would bring a second 10 s poll, a second held-move dialog and a second copy of every handler for a list that needs none of them. The sprint pane renders `board.tasks`.

Done-role filtering uses `columnIdsWithRole(board.project, "done")`; the hidden rows come back the moment the filter box is non-empty.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/components/sprints/PlanningView.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/sprints/PlanningView.tsx src/components/sprints/PlanningPane.tsx src/components/sprints/PlanningView.test.tsx
git commit -m "feat(sprints): the planning view shows backlog beside the sprint's scope"
```

---

## Task 7: Moving tasks in and out of scope

**Files:**
- Modify: `src/components/sprints/PlanningView.tsx`, `PlanningPane.tsx`
- Test: `src/components/sprints/PlanningView.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
it("sets the sprint when a task is added", async () => {
  await renderPlanning();
  fireEvent.click(screen.getByRole("button", { name: "Add Fix the login redirect to the sprint" }));
  expect(api.put).toHaveBeenCalledWith("/api/projects/p1/tasks/t1", { sprint: "s1" });
});

it("clears the sprint when a task is removed", async () => {
  await renderPlanning();
  fireEvent.click(screen.getByRole("button", { name: "Remove Ship the header from the sprint" }));
  expect(api.put).toHaveBeenCalledWith("/api/projects/p1/tasks/t9", { sprint: null });
});

it("moves the row across before the server answers", async () => {
  let settle: (v: unknown) => void = () => {};
  api.put.mockImplementation(() => new Promise((r) => { settle = r; }));
  await renderPlanning();
  fireEvent.click(screen.getByRole("button", { name: /Add Fix the login redirect/ }));
  expect(screen.getByText("Backlog (1)")).toBeTruthy();
  settle({});
});

it("returns the task to the pane it came from when the move fails", async () => {
  api.put.mockRejectedValue(new Error("nope"));
  await renderPlanning();
  fireEvent.click(screen.getByRole("button", { name: /Add Fix the login redirect/ }));
  await waitFor(() => expect(screen.getByText("Backlog (2)")).toBeTruthy());
  expect(toast).toHaveBeenCalledWith("Failed to move task", "error");
});

it("drops a dragged task into the sprint pane", async () => {
  await renderPlanning();
  fireEvent.drop(screen.getByTestId("planning-pane-sprint"), {
    dataTransfer: { getData: () => "t1" },
  });
  expect(api.put).toHaveBeenCalledWith("/api/projects/p1/tasks/t1", { sprint: "s1" });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run src/components/sprints/PlanningView.test.tsx
```

Expected: FAIL — no buttons, no drop target.

- [ ] **Step 3: Implement the move**

One writer for both directions and both gestures:

```ts
async function move(task: ApiTask, sprintId: string | null) {
  const from = sprintId ? "backlog" : "scope";
  applyLocally(task, sprintId);
  try {
    await api.put(`/api/projects/${projectId}/tasks/${task._id}`, { sprint: sprintId });
  } catch {
    applyLocally(task, sprintId ? null : sprintId === null ? sprintIdOfView : null);
    toast("Failed to move task", "error");
  }
}
```

`applyLocally` updates the backlog list (local state) and calls `board.applySprintChange([task._id], sprintId)`, which already knows how to drop a task out of the scoped list. Reverting means putting the task back in `from`.

Drag reuses `TaskCard`'s drag source — it already sets `text/plain` to the task id (`TaskCard.tsx:79`). `Column` is not reusable here: its drop handler produces a **status** (`Column.tsx:83`), while a pane drop means a sprint. `PlanningPane` is a new, small drop target on the same native mechanism.

A 409 carrying a `runConflict` is not parked: changing a sprint does not move a task out of the column a worker holds it in, so the server does not refuse it. If that ever changes, this reports it as an ordinary failure rather than growing a second force dialog.

Below `lg`, the panes stack and each row carries its add or remove button; above it, both gestures work.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/components/sprints/PlanningView.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/sprints
git commit -m "feat(sprints): move tasks between the backlog and a sprint's scope"
```

---

## Task 8: The Board / Planning toggle, and the live pass

**Files:**
- Modify: `src/components/sprints/SprintHeader.tsx`
- Modify: `src/app/(app)/projects/[projectId]/sprints/page.tsx`
- Test: `src/app/(app)/projects/[projectId]/sprints/page.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
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
  fireEvent.click(screen.getByRole("button", { name: "Planning" }));
  expect(push).toHaveBeenCalledWith("/projects/p1/sprints?sprint=s1&view=planning");
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run "src/app/(app)/projects/[projectId]/sprints/page.test.tsx"
```

Expected: FAIL — no toggle.

- [ ] **Step 3: Implement**

Two buttons in the header for a planned or active sprint. The page reads `view` from the search params; anything other than `planning` means the board. Build the URL by hand — `sprintScopeToQuery` emits a leading `?` (`src/lib/sprint-scope.ts:12-14`) and cannot produce a second parameter.

- [ ] **Step 4: Run the suite and the build**

```bash
npm test && npm run build
```

- [ ] **Step 5: The live pass**

1. Drag a backlog task into the sprint; both counts and the header's done/total change with no reload.
2. Drag it back out.
3. Stop the dev server and try a move: the card returns to its pane and a toast says so.
4. At 375px: the panes stack and the plus/minus buttons do the same two writes.
5. A completed sprint offers no Planning toggle.

- [ ] **Step 6: Commit and open the pull request**

```bash
git add -A
git commit -m "feat(sprints): a Board and Planning toggle on the sprint header"
gh api user -q .login   # must print rafalpodles
gh pr create --title "Sprint planning view — move tasks between backlog and sprint scope (BP-207)" --body "$(printf 'What changed, why, and what was verified live — one short paragraph each. Link the task key in the title so the PR matcher picks it up.')"
```

---

# Phase C — BP-208, branch `bp-208/sprint-velocity`

Cut from `main` after Phase B merges.

## Task 9: `estimateFieldId` — the designation and its lifetime

**Files:**
- Modify: `src/types/index.ts` (add `estimateFieldId: string` to `IProject` and `ApiProject`)
- Modify: `src/models/project.ts` (`estimateFieldId: { type: String, default: "" }`)
- Modify: `src/app/api/projects/[projectId]/route.ts:53` (allowlist) and its validation block
- Modify: `src/app/api/projects/[projectId]/custom-fields/[fieldId]/route.ts` (PATCH `:56`, DELETE `:69-90`)
- Test: `src/app/api/projects/[projectId]/custom-fields/[fieldId]/route.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

```ts
it("refuses a designation naming a field the project does not have", async () => {
  const res = await PUT(req({ estimateFieldId: "6a70afff45d39cd9bc8bb5ff" }), ctx);
  expect(res.status).toBe(400);
});

it("refuses a designation naming a field that is not numeric", async () => {
  const res = await PUT(req({ estimateFieldId: textFieldId }), ctx);
  expect(res.status).toBe(400);
});

it("refuses a designation naming an archived field", async () => {
  const res = await PUT(req({ estimateFieldId: archivedNumberFieldId }), ctx);
  expect(res.status).toBe(400);
});

it("accepts an empty designation", async () => {
  const res = await PUT(req({ estimateFieldId: "" }), ctx);
  expect(res.status).toBe(200);
});

it("clears the designation when the field is deleted", async () => {
  await DELETE(req(), fieldCtx(numberFieldId));
  expect((await Project.findById(projectId))!.estimateFieldId).toBe("");
});

it("clears the designation when the field is archived", async () => {
  await PATCH(req({ archived: true }), fieldCtx(numberFieldId));
  expect((await Project.findById(projectId))!.estimateFieldId).toBe("");
});

it("leaves the designation alone when a different field is archived", async () => {
  await PATCH(req({ archived: true }), fieldCtx(otherFieldId));
  expect((await Project.findById(projectId))!.estimateFieldId).toBe(numberFieldId);
});
```

Follow the mocking already used by `src/app/api/projects/[projectId]/route.test.ts` for `connectDB`, the middleware and the models — do not invent a second harness.

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run "src/app/api/projects/[projectId]/custom-fields/[fieldId]/route.test.ts"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Add `"estimateFieldId"` to the `allowed` array at `route.ts:53`, then validate beside the `icon` block:

```ts
if (updates.estimateFieldId !== undefined) {
  const id = String(updates.estimateFieldId);
  if (id !== "") {
    const field = (project.customFields || []).find((f) => f._id.toString() === id);
    if (!field || field.fieldType !== "number" || field.archived) {
      return NextResponse.json(
        { error: "estimateFieldId must name a numeric field that is not archived" },
        { status: 400 }
      );
    }
  }
}
```

In the field route, clear the designation in both handlers — inside DELETE next to the existing `$unset`, and inside PATCH when `body.archived` is turned on:

```ts
if (project.estimateFieldId === fieldId) project.estimateFieldId = "";
```

Archiving is the path that actually strands the pointer: an archived field vanishes from every picker (`activeFields`, `src/lib/custom-fields.ts:64-65`) while the designation survives. Deletion alone was the first draft's mistake.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run "src/app/api/projects/[projectId]/custom-fields/[fieldId]/route.test.ts" && npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/models/project.ts "src/app/api/projects/[projectId]"
git commit -m "feat(projects): a project can designate which numeric field is its estimate"
```

---

## Task 10: The designation in settings

**Files:**
- Modify: `src/app/(app)/projects/[projectId]/settings/sections/TaskFieldsSection.tsx`
- Test: `src/app/(app)/projects/[projectId]/settings/sections/TaskFieldsSection.test.tsx` (create)

- [ ] **Step 1: Write the failing tests**

```tsx
it("lists only the project's non-archived numeric fields, and None", async () => {
  render(<TaskFieldsSection {...props} />);
  const select = screen.getByLabelText("Estimate field") as HTMLSelectElement;
  expect([...select.options].map((o) => o.text)).toEqual(["None", "Story points"]);
});

it("saves the designation on the project", async () => {
  render(<TaskFieldsSection {...props} />);
  fireEvent.change(screen.getByLabelText("Estimate field"), { target: { value: numberFieldId } });
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith("/api/projects/p1", { estimateFieldId: numberFieldId })
  );
});

it("disables the row for somebody who does not own the project", () => {
  render(<TaskFieldsSection {...props} project={{ ...project, canAdmin: false }} />);
  expect((screen.getByLabelText("Estimate field") as HTMLSelectElement).disabled).toBe(true);
});

it("offers to create a field when the project has no numeric one", () => {
  render(<TaskFieldsSection {...props} project={{ ...project, customFields: noNumericFields }} />);
  expect(screen.queryByLabelText("Estimate field")).toBeNull();
  expect(screen.getByRole("button", { name: /Create .Story points./ })).toBeTruthy();
});

it("creates the field and designates it in one action", async () => {
  api.post.mockResolvedValue([{ _id: "f-new", name: "Story points", fieldType: "number" }]);
  render(<TaskFieldsSection {...props} project={{ ...project, customFields: noNumericFields }} />);
  fireEvent.click(screen.getByRole("button", { name: /Create .Story points./ }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith("/api/projects/p1/custom-fields", {
      name: "Story points",
      fieldType: "number",
    })
  );
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith("/api/projects/p1", { estimateFieldId: "f-new" })
  );
});

it("does not designate anything when creating the field fails", async () => {
  api.post.mockRejectedValue({ status: 409 });
  render(<TaskFieldsSection {...props} project={{ ...project, customFields: noNumericFields }} />);
  fireEvent.click(screen.getByRole("button", { name: /Create .Story points./ }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  expect(api.put).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run "src/app/(app)/projects/[projectId]/settings/sections/TaskFieldsSection.test.tsx"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

A `SettingRow` labelled "Estimate field", hint "Summed for sprint progress and velocity", holding a `Select` over `activeFields(project.customFields).filter(f => f.fieldType === "number")` plus a "None" option. Saving goes through `PUT /api/projects/:id`, then `patchProject({ estimateFieldId })`.

**When the project has no numeric field at all, the row shows a create button instead of the picker.** This is not polish — without it the whole task ships dark. Checked against the development database on 2026-08-12: `TP`, `MOB` and `ORB` between them have dropdowns, multiselects and a checkbox, and **not one field of type `number`**. A picker whose only option is "None" would leave every existing project with no estimates, no header figures and no chart, and no hint as to why.

So: no numeric fields → the row reads that there are none and offers `Create "Story points"`, which POSTs a `number` field of that name to `/api/projects/:id/custom-fields` and, on success, designates the id it gets back. One action, from the place the person is already looking. If the create fails — a name clash returns 409, since a project may already have a "Story points" dropdown — nothing is designated and the error is surfaced; a half-done setup that silently points at nothing is worse than a refusal.

Once the project has at least one numeric field the shortcut disappears and the picker takes over. Creating a second one belongs to the custom-field editor in this same section, which already does it properly.

The row is disabled when `!project.canAdmin`, unlike its neighbours in this section: the project `PUT` is `withProjectOwner` (`route.ts:48`) while the custom-field writes beside it are `withProjectAccess` (`custom-fields/[fieldId]/route.ts:13`). The hint says so, rather than letting a member discover it on save. Note this means a member may create a custom field but not designate it — deliberate, and the reason the create button is gated on the same `canAdmin` as the picker.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run "src/app/(app)/projects/[projectId]/settings/sections/TaskFieldsSection.test.tsx"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/projects/[projectId]/settings/sections"
git commit -m "feat(settings): choose which numeric field is the estimate"
```

---

## Task 11: Estimate sums on the sprint list

**Files:**
- Modify: `src/app/api/projects/[projectId]/sprints/route.ts:20-47`
- Test: `src/app/api/projects/[projectId]/sprints/route.test.ts` (create)

**Interfaces:**
- Produces: `estimateTotal: number` and `estimateDone: number` on every element of `GET /sprints`, present only when the project designates a field.

- [ ] **Step 1: Write the failing tests**

```ts
it("sums the designated field across a sprint's tasks", async () => {
  const body = await json(await GET(req(), ctx));
  expect(body[0].estimateTotal).toBe(8);
});

it("counts only done-role columns towards the completed estimate", async () => {
  const body = await json(await GET(req(), ctx));
  expect(body[0].estimateDone).toBe(3);
});

it("counts a task with no value as zero", async () => { /* fixture: one task without the key */ });

it("counts a value stored as a string as zero rather than failing the request", async () => {
  // A pre-CP-213 document, never validated. $sum would ignore it silently;
  // $convert without onError would throw and take the board's poll down with it.
  const res = await GET(req(), ctx);
  expect(res.status).toBe(200);
});

it("omits the estimate fields entirely when the project designates none", async () => {
  const body = await json(await GET(req(), ctxWithoutDesignation));
  expect(body[0].estimateTotal).toBeUndefined();
});
```

These need a real aggregation, so run them against `mongodb-memory-server` if the repo already has it, and otherwise against a local Mongo with the suite's existing integration pattern. A test that mocks `Task.aggregate` proves the pipeline's shape and nothing about what it returns — the whole point here is what the database does with a string.

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run "src/app/api/projects/[projectId]/sprints/route.test.ts"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
const project = await Project.findById(projectId, "columns customFields estimateFieldId").lean();
const doneIds = columnIdsWithRole(project, "done");
const estimateId = project?.estimateFieldId || "";
const estimate = estimateId
  ? { $convert: { input: `$customFieldValues.${estimateId}`, to: "double", onError: 0, onNull: 0 } }
  : null;

const counts = await Task.aggregate([
  { $match: { project: new mongoose.Types.ObjectId(projectId), sprint: { $in: sprintIds } } },
  {
    $group: {
      _id: "$sprint",
      total: { $sum: 1 },
      done: { $sum: { $cond: [{ $in: ["$status", doneIds] }, 1, 0] } },
      ...(estimate
        ? {
            estimateTotal: { $sum: estimate },
            estimateDone: { $sum: { $cond: [{ $in: ["$status", doneIds] }, estimate, 0] } },
          }
        : {}),
    },
  },
]);
```

The dotted path is established practice — `src/app/api/projects/[projectId]/stats/route.ts:30` builds exactly `` `$customFieldValues.${field._id}` `` — and field ids are ObjectId hex, so nothing in them can break the path.

`onError` and `onNull` are not politeness. This endpoint is on the project board's load path and is polled every 10 s (`page.tsx:134`, `:158`); an aggregation that throws on one legacy string value takes down the board, not the chart. A bare `$sum` would be the opposite failure — a silently wrong number that looks right.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run "src/app/api/projects/[projectId]/sprints/route.test.ts"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/projects/[projectId]/sprints/route.ts" "src/app/api/projects/[projectId]/sprints/route.test.ts"
git commit -m "feat(sprints): the sprint list carries estimated and completed totals"
```

---

## Task 12: Estimates in the header and in planning

**Files:**
- Create: `src/lib/estimates.ts`
- Test: `src/lib/estimates.test.ts`
- Modify: `src/components/sprints/SprintHeader.tsx`, `src/components/sprints/PlanningView.tsx`

**Interfaces:**
- Produces:

```ts
export function estimateOf(task: ApiTask, fieldId: string): number;
export function sumEstimates(tasks: ApiTask[], fieldId: string): number;
```

- [ ] **Step 1: Write the failing tests**

```ts
it("reads the designated field", () => {
  expect(estimateOf(task({ f1: 3 }), "f1")).toBe(3);
});

it("treats an absent value as zero", () => {
  expect(estimateOf(task({}), "f1")).toBe(0);
});

it("treats a value that is not a number as zero", () => {
  expect(estimateOf(task({ f1: "three" }), "f1")).toBe(0);
});

it("treats a numeric string as its number, as the writers store it", () => {
  expect(estimateOf(task({ f1: "3" }), "f1")).toBe(3);
});

it("sums nothing to zero", () => {
  expect(sumEstimates([], "f1")).toBe(0);
});
```

The board's inline field writer is typed `value: string` (`page.tsx:491`), so `"3"` is a shape that genuinely occurs and must not read as zero.

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run src/lib/estimates.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement, then wire the two places**

```ts
export function estimateOf(task: ApiTask, fieldId: string): number {
  const raw = task.customFieldValues?.[fieldId];
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function sumEstimates(tasks: ApiTask[], fieldId: string): number {
  return tasks.reduce((sum, t) => sum + estimateOf(t, fieldId), 0);
}
```

`SprintHeader` gains an optional `estimate?: { total: number; done: number }`, rendered beside done/total only when the project designates a field. The sprints page computes it from `board.tasks` — the same source as done/total, so filtering the board cannot change it. `PlanningView` shows the scope pane's total the same way, and it moves as tasks move because both lists are local.

With no designated field, neither renders: no label, no zero, no dash.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/lib/estimates.test.ts && npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/estimates.ts src/lib/estimates.test.ts src/components/sprints
git commit -m "feat(sprints): show estimated against completed where a project estimates"
```

---

## Task 13: The velocity chart, and the live pass

**Files:**
- Create: `src/components/sprints/VelocityChart.tsx`
- Test: `src/components/sprints/VelocityChart.test.tsx`
- Modify: `src/app/(app)/projects/[projectId]/sprints/page.tsx`

**Interfaces:**
- Produces: `<VelocityChart sprints={ApiSprint[]} />` — given every sprint, it selects the completed ones itself.

- [ ] **Step 1: Write the failing tests**

```tsx
it("plots one bar per completed sprint, oldest first", () => {
  render(<VelocityChart sprints={threeCompleted} />);
  const bars = screen.getAllByRole("img", { hidden: true });
  expect(bars).toHaveLength(3);
});

it("says there is not enough history rather than drawing an empty frame", () => {
  render(<VelocityChart sprints={oneCompleted} />);
  expect(screen.getByText(/two completed sprints/i)).toBeTruthy();
  expect(document.querySelector("svg")).toBeNull();
});

it("renders nothing at all with no completed sprints", () => {
  const { container } = render(<VelocityChart sprints={[]} />);
  expect(container.firstChild).toBeNull();
});

it("labels each bar with its sprint and completed estimate", () => {
  render(<VelocityChart sprints={threeCompleted} />);
  expect(screen.getByText("Sprint 10")).toBeTruthy();
  expect(screen.getByText("13")).toBeTruthy();
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run src/components/sprints/VelocityChart.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Hand-written SVG: one rect per completed sprint, height scaled to the largest `estimateDone` in the set, oldest to newest, each labelled with the sprint name and its number. Use the existing CSS variables (`var(--color-primary)`, `text-text-muted`) rather than literal colours; the chart must read in both themes. Give the `svg` a `role="img"` and an `aria-label` naming what it plots.

The sprints page renders it under the selector only when `project.estimateFieldId` is set. With a designation but fewer than two completed sprints, the component says so; with none, it returns `null` and the page shows no heading either — a project that does not estimate must not be told it has no velocity.

- [ ] **Step 4: Run the tests and the build**

```bash
npm test && npm run build
```

Expected: green.

- [ ] **Step 5: The live pass**

On a project with completed sprints and a numeric field:

1. Designate the field in Settings → Task fields; the header gains estimated versus completed and the chart appears.
2. Set the designation back to None; every trace of it disappears — no empty frame, no zeroes.
3. Archive the designated field; the designation clears and the UI disappears with it.
4. A sprint completed with "move unfinished to backlog" shows equal estimated and completed — expected, and recorded in the spec as an accepted limitation.
5. A project with one completed sprint shows the sentence, not a frame.

- [ ] **Step 6: Commit and open the pull request**

```bash
git add -A
git commit -m "feat(sprints): a velocity chart across completed sprints"
gh api user -q .login   # must print rafalpodles
gh pr create --title "Sprint velocity on a designated estimate field (BP-208)" --body "$(printf 'What changed, why, and what was verified live — one short paragraph each. Link the task key in the title so the PR matcher picks it up.')"
```

---

## Board Planner bookkeeping

Per `CLAUDE.md`, each phase runs its task through the pipeline: assign to `claude` and move to `in_progress` **before** any code, comment the approach, then `in_review` after the build passes, `ready_to_test` after the diff review, and `done` on merge. BP-200 is L, so its plan comment waits for approval before code — this document is that plan.

## Notes carried from the spec

- BP-200's "the most recent planned one" is implemented as **the planned sprint that starts soonest**. Flagged for rpo; one line to change if the literal reading was meant.
- Velocity is distorted by "move unfinished to backlog" (`sprints/[sprintId]/route.ts:64-71`): such a sprint keeps only its finished work, so estimated equals completed by construction. Accepted, not solved — fixing it means snapshotting committed scope at completion, which BP-208 does not ask for.
- Tasks whose `status` names a deleted column render in no column (`Board.tsx:41-51`) but still count in the header, matching what `GET /sprints` counts.
