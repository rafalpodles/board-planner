# Sprint view — design

Date: 2026-08-11
Tasks: BP-200 (sprint selector + the sprint's board), BP-207 (planning view), BP-208 (estimates and velocity)
Out of scope: BP-247 (member/owner line across sprints, custom fields, categories, templates), BP-227 (shipped in 6a4e4a2)

Revised after two independent reviews of the first draft. What they changed is recorded at the end.

## Why

The Sprints tab shows sprint metadata and the full lifecycle, and nothing else. You cannot see a
sprint's tasks from it, open one, or move one. Scope is decided today by right-clicking cards on the
project board one at a time, and there is no way to read what a sprint contains as a whole.

## What already exists and must not be rebuilt

- `src/app/(app)/projects/[projectId]/sprints/page.tsx` (413 lines) — card grid, Activate, Complete
  with the "move unfinished to backlog" choice, Edit, Delete, overlap validation, auto-suggested name
  and dates (`src/lib/sprint-defaults.ts`). All of it keeps working; only its layout changes.
- `GET /api/projects/[projectId]/tasks?sprint=<id|backlog>` and `src/lib/sprint-scope.ts` (BP-183).
- `GET /api/projects/[projectId]/sprints` — returns `taskCount` / `doneCount`, resolving done by
  column role through `columnIdsWithRole` (BP-227).
- `src/components/kanban/Board.tsx` / `Column.tsx` / `TaskCard.tsx` — the kanban, on native HTML5 DnD.
- `src/app/api/projects/[projectId]/stats/route.ts:30` — the precedent for reading a custom field
  value inside an aggregation.

## Architecture

`src/app/(app)/projects/[projectId]/page.tsx` is 795 lines, of which roughly 700 are the board. It
splits into a hook and a presentational shell, and both pages compose the two.

### `src/hooks/use-project-board.ts`

Owns data, writes, and the two pieces of view state the header needs:

- `loadData` for a scope, the 10 s `usePollWhileVisible`, `subscribeBoardRefresh`, the `loadSeq` guard
- `handleStatusChange`, `handleTaskDrop`, `handleReorder`, `parkIfHeld` / `forceHeldMove`,
  `handleBulkMove`, `handleBulkSprint`, `handleBulkDelete`, `applySprintChange`, `patchTask`,
  `handleAssigneeChange`, `handleFieldValueChange`, `handleRowSprintChange`,
  `handleContextDuplicate`, `handleContextDelete`
- `viewMode` + `setViewMode` (with its `localStorage` write) and `showNewTask` + `setShowNewTask`

Returns one `board` object: `{ project, tasks, sprints, loading, reload, viewMode, setViewMode,
showNewTask, setShowNewTask, heldMove, ...handlers }`.

**`scope` is an argument, never owned by the hook.** Changing it belongs to the page: the project
board pushes `projectPath(projectId) + sprintScopeToQuery(scope)`, the sprints page selects a row.

### `src/components/kanban/ProjectBoardView.tsx`

Takes `{ board, readOnly? }` and nothing else. Renders `BoardFilters`, `Board` or `ListView`,
`TaskContextMenu`, the held-move / delete / bulk-delete dialogs, the new-task `Modal`, the keyboard
shortcuts and the empty state.

**There is no `header` slot.** The first draft had one, and it does not close: `BoardHeader` requires
`viewMode`, `onViewModeChange`, `onRefresh` and `onNewTask`
(`src/components/kanban/BoardHeader.tsx:12-24`), all of which live inside the view. Instead each page
renders its own header *above* the view and feeds it from the same `board` object — `BoardHeader` on
the project board, `SprintHeader` on the sprints tab. That is also what lets the sprint header show
counts that move with every drag.

### Extraction hazards, named

- Every handler in `page.tsx` is a plain function closing over `tasks` — `parkIfHeld` (`:361`),
  `handleTaskDrop` (`:393`), `handleBulkMove` (`:254`), `patchTask` (`:476`),
  `handleContextDuplicate` (`:512`). **They must stay plain functions.** Wrapping them in
  `useCallback` to stabilise the hook's return — the natural instinct — hands them a stale `tasks`,
  which breaks the drop arithmetic and `parkIfHeld`'s task key.
- `loadData`'s eslint-disabled dep array (`:147`) is load-bearing, not debt. Carry it.
- `selectedSprint` must stay derived to a **string** on the page (`:62`). The board test mocks
  `useSearchParams` as a fresh `URLSearchParams` per call; memoising on that object gives `loadData` a
  new identity every render, and `usePollWhileVisible` calls its callback immediately — an infinite
  reload loop that no test would name.
- `now` / `setNow` (`:89`, `:106`, `:141`) is dead state: written in three places, read nowhere.
  Deleted during the extraction rather than carried, along with its 60 s timer.

### Proving the extraction is faithful

`src/app/(app)/projects/[projectId]/page.test.tsx` — **10 tests**, not the 13 the first draft claimed
— must pass with no edit to the test file, and `page.tsx` must keep its default export because the
test imports `./page`. It pins a bulk move with one task held by a worker, a drag through
`updateTask`, a status change through `changeStatus`, and re-issuing each with `force`; `:239` pins
the drop midpoint arithmetic against the pre-move task list. A test that needs adjusting means
behaviour changed.

The extraction lands as its **own commit** — a pure refactor, no behaviour change, tests green —
before any sprint work on the same branch, so it can be read on its own in the pull request.

## BP-200 — the Sprints tab

**Selector (left).** Sprints grouped Active / Planned / Completed, each row with name and done/total.
Selection lives in the URL as `?sprint=<id>`. Completed sprints beyond the three most recent collapse
behind a "Show N older" row.

Default selection: the active sprint; failing that, **the planned sprint that starts soonest**; failing
that, the most recently completed one; and with no sprints at all, the existing empty state with its
create button. "Starts soonest" is a deliberate reading of BP-200's "most recent planned" — the useful
default is the sprint about to run, not the one furthest in the future.

An `?sprint=` naming a sprint the project does not have falls back to that same default and drops the
parameter. This matters beyond tidiness: `GET /tasks?sprint=<x>` assigns straight into the Mongoose
filter with no ObjectId validation (`src/app/api/projects/[projectId]/tasks/route.ts:52-57`), so a
hand-edited or stale URL is a CastError and a 500. The page never sends an id it did not get from the
sprint list.

**Header (main, top).** Name, status badge, goal, date range, days remaining, done/total bar. Activate,
Complete, Edit and Delete move here from the cards with the same handlers and the same dialogs.

Counts come from `board.tasks` — every task in the sprint — **not** from `filteredTasks`, which is what
`BoardFilters` hands the board. Filtering to one assignee must not change what the sprint's progress
bar says. Before the task list arrives, the `taskCount`/`doneCount` already on the sprint list seed it.

The sprints page reads sprints from `board.sprints`; it does not fetch `/sprints` a second time.

**Board (main).** `<ProjectBoardView board={board} readOnly={sprint.status === "completed"} />`.

**Mobile.** Below `lg` the selector becomes a `Select` above the header, not a column beside the board:
the board already scrolls horizontally and a second horizontal element fights the same gesture.

**Read-only, in full.** A completed sprint withholds every write and keeps every read:

- `TaskCard` — `draggable` (`:72`) and `onDragStart` (`:77-80`), and the selection checkbox (`:285-301`)
- `Column` — the `onDragOver` / `onDragEnter` / `onDragLeave` / `onDrop` block (`:56-89`) including its
  `onStatusChange` fallback, and the "Drop tasks here" placeholder (`:189-192`)
- `Board` — the `dragOverColumn` state (`:55`, `:107-111`)
- the view — the context menu, the Select / bulk bar, the new-task button and the `n` shortcut, and
  `ListView`'s inline cells and row reorder
- the sprint header — Activate, Complete, Edit, Delete, and the Planning toggle

**Clicking a task still opens the normal task view.** That is a read, and BP-200 asks for it explicitly.

**Empty states.** The board's "No tasks yet / Create your first task" copy is written for a project and
offers a write; an empty sprint says so instead, and a read-only one offers no button. A sprint with no
tasks shows 0/0 rather than a divide-by-zero bar.

Tasks whose `status` names a column the project deleted render in no column (`Board.tsx:41-51`) but do
count in the header, exactly as they count in `GET /sprints`. Consistent with the server, and left alone.

The page splits into `src/components/sprints/`: `SprintSelector`, `SprintHeader`, `SprintFormModal`,
`CompleteSprintDialog`.

## BP-207 — planning view

A Board / Planning toggle in the sprint header, carried as `&view=planning`. Not shown for completed
sprints.

**Two scopes at once, and only one hook.** The sprint side is `board.tasks`. The backlog is a plain
fetch of `?sprint=backlog` held in `PlanningView`'s own state — not a second `useProjectBoard`, which
would bring a second 10 s poll, a second held-move dialog and a second copy of every handler for a list
that needs none of them.

A move is `PUT /api/projects/[projectId]/tasks/:id { sprint }` — the id one way, `null` the other —
applied optimistically to both lists first: `board.applySprintChange` already removes a task from the
scoped list, and the backlog list is local. A rejected move puts the card back in the pane it came from
and says so in a toast. Because both lists are local, counts and the header's done/total move with each
drop without a reload.

A 409 with a `runConflict` is **not** parked here. Changing a task's sprint does not move it out of the
column a worker is holding it in, so the server does not refuse it; if that ever changes, planning
reports it as an ordinary failure rather than growing a second force dialog.

**Dragging** reuses `TaskCard` as the drag source, and nothing else: `Column`'s drop handler produces a
status (`Column.tsx:83`), while a pane drop means "set sprint". The panes are a new, small drop
container on the same native HTML5 mechanism. dnd-kit stays where it is, in `ListView` and the sidebar.

**Mobile:** one column, a plus on backlog rows, a minus on scope rows. The same two writes, no gesture
competing with the scroll.

**Settled rather than left open** (BP-207 leaves this to implementation): tasks in a `done`-role column
are hidden from the backlog while the filter box is empty, and searchable the moment anything is typed.
Nobody plans a finished task, but finding one stays possible.

## BP-208 — estimates and velocity

**The designation.** `project.estimateFieldId: String`, default `""`. It is set through
`PUT /api/projects/[projectId]` — there is no PATCH on that route — which means adding the key to the
literal allowlist at `route.ts:53` and accepting either `""` or the `_id` of a **non-archived `number`**
custom field on that project.

The picker lives in **Task fields** and lists only non-archived numeric fields, plus "None".

`PUT` is `withProjectOwner` while the rest of that section writes through `/custom-fields/*` as
`withProjectAccess`. The designation row is therefore owner-only and disabled for a member, unlike its
neighbours — deliberate, and the row says why rather than failing on save.

**Clearing.** Both **archiving and deleting** the designated field clear the designation, in
`src/app/api/projects/[projectId]/custom-fields/[fieldId]/route.ts` (delete at `:69-90`, archive at
`:56`), in the same operation that already `$unset`s orphaned values. The first draft covered only
deletion; archiving is the path that actually produces the dangling pointer, because an archived field
disappears from every picker (`activeFields`, `custom-fields.ts:64-65`) while the pointer survives.

**The sums** are two more accumulators in the aggregation in `GET /api/projects/[projectId]/sprints`
that already produces `taskCount` / `doneCount`: total estimate, and estimate over the done-role
columns. The dotted path `$customFieldValues.<fieldId>` is established practice — `stats/route.ts:30`
builds exactly that — and field ids are ordinary Mongoose ObjectIds, so no character in them can break
the path.

The real hazard is the value's **type**, which the first draft never asked about. Writers coerce
(`TaskForm.tsx:459`, `custom-fields.ts:476-479`) and `validateCustomFieldValues` rejects non-numbers
(`:93-95`), but the board's own inline writer is typed `value: string` (`page.tsx:491`) and documents
written before CP-213 were never validated. A bare `$sum` ignores a string silently — a chart that
looks right and is wrong. So: `$convert` with explicit `onError: 0, onNull: 0`, and a test whose
fixture contains a string value, an absent value and a number.

`onError`/`onNull` are not optional politeness. This endpoint is on the project board's load path and
is polled every 10 s (`page.tsx:134`, `:158`); an aggregation that throws on one bad value takes down
the board, not the chart.

**Where the numbers show.** The sprint header adds estimated versus completed beside done/total; the
planning view shows the scope pane's estimate total, updating as tasks move; the Sprints tab gets a
velocity chart plotting **completed estimate per completed sprint**, oldest to newest, hand-written SVG
— the repo has no charting library and one bar chart does not justify adding one.

**Degradation.** No designated field: none of it renders — no frame, no zeroes, no explanation. Fewer
than two completed sprints: a sentence, not an empty grid. A task with no value counts as zero, which
is not the same as the project having no estimate field.

**An accepted limitation, stated rather than solved.** Completing a sprint with "move unfinished to
backlog" sets `sprint: null` on every unfinished task
(`sprints/[sprintId]/route.ts:64-71`), so that sprint afterwards contains only its finished work and
its estimated and completed totals are equal by construction. Sprints completed with "Keep in Sprint"
show two different numbers. The velocity chart plots completed estimate, which stays honest either way;
the header's estimated-versus-completed is informative for an active or planned sprint and degenerate
for a sprint completed the first way. Fixing it properly means snapshotting committed scope at
completion — a feature BP-208 does not ask for, and not something to smuggle in here.

## Delivery

Worktree `../ClaudePlanner-sprint-ui`, three branches in order, each merged before the next is cut:

1. `bp-200/sprints-tab` — commit 1 the extraction, commit 2 the tab
2. `bp-207/sprint-planning`
3. `bp-208/sprint-velocity`

## Verification

Per branch: `npm run build`, `npm test`, and a pass **clicked through the UI** against a local Mongo
with seeded data — never curl. Named tests beyond "page.test.tsx unedited":

- the selector's default with an active sprint, without one, and with no sprints at all
- an `?sprint=` naming a sprint that does not exist
- the read-only surface of a completed sprint, and that a card still opens
- a planning move in each direction, and a rejected one returning the card
- the sprint aggregation against a fixture holding a string, an absent and a numeric value
- the chart with zero, one and several completed sprints
- archiving and deleting the designated field

Live: an active, a planned and a completed sprint, at desktop and mobile width; for BP-208, a project
with completed sprints and a numeric field.

## What the reviews changed

Two independent reviewers read the first draft against the code and against the three checklists.
Verified before accepting; each of these was confirmed by reading the file named.

- The `header` slot did not close — `BoardHeader` needs state the draft had put inside the view.
- The draft hedged on whether a Mongoose `Map` is reachable by a dotted path in an aggregation. The
  repo answered that at `stats/route.ts:30`. The unasked question — string values — replaced it.
- `estimateFieldId` was specified against a PATCH endpoint that does not exist.
- Archiving a custom field was never mentioned, though BP-208 asks for it by name.
- `readOnly` covered about a third of the writing surface, and never said a task still opens.
- "13 tests" was wrong; there are 10.
- Velocity collides with the existing complete-sprint flow.
- BP-207 needs two scopes live at once, which a one-scope hook does not give it.

Two findings were rejected. Hiding done-role tasks from the backlog is not gold-plating — BP-207 leaves
that decision to implementation and leans this way. The full `ProjectBoardView` extraction was chosen
deliberately over two lighter options, though the reviewer's point that it should be readable on its own
is taken, and it is now its own commit.
