# Board Planner

## Documentation — Notion

All project documentation is stored in **Notion**. Use the Notion MCP tools to read and write docs.

### After completing a new feature

After every completed feature, create or update documentation in Notion:
- What the feature does (user-facing description)
- Key implementation details (architecture decisions, services involved)
- Any API changes or new endpoints
- Configuration or environment changes required

Search Notion first to check if a relevant page already exists before creating a new one.

---

## Board Planner integration
claudeplanner_project_key: CP

### Workflow
- On session start: run `list_tasks` for this project to see current work.
- When asked "what to work on" / "co robić" — list tasks and suggest next one.
- Log important decisions, blockers, or completion notes with `add_comment`.
- When user describes new work, ask if it should be tracked and `create_task` if yes.

### Task statuses
Since CP-128, statuses are project-defined **board columns** mapped to semantic roles (`backlog`, `approved`, `active`, `review`, `blocked`, `done`); automation keys on the **role**, not the display name. The ids below are the seeded defaults, which this project uses — the pipeline semantics per role: pick up tasks in an `approved`-role column, work in `active`, review in `review`, deliver to `done`.
- `planned` — idea/backlog, NOT approved for work. Claude never touches these.
- `todo` — approved for work. Claude picks these up automatically.
- `in_progress` — actively being worked on.
- `in_review` — code complete, awaiting automated/self code review.
- `needs_human_review` — implementation requires human review before proceeding. Used when Claude encounters ambiguous requirements, architectural decisions that need human judgment, or changes with significant impact that should be verified by a human before moving forward. Claude moves tasks here and **stops working on them** until a human reviews and advances the status.
- `ready_to_test` — review passed, ready for final verification and merge.
- `done` — merged to `main`, task complete.

### Autonomous task processing
Claude automatically picks up tasks in `todo` status (assigned to `claude` or unassigned) and processes them through the pipeline. No user confirmation needed for `todo` tasks.

#### Size-based approach
Size comes from the project's **Difficulty** field — an ordinary project-defined field since CP-213, not a column on the task. Read it from `customFieldValues`; a project that renamed or removed it has no size, and those tasks are treated as S/M.
- **S/M tasks** — Claude implements immediately, no upfront plan needed.
- **L/XL tasks** — Claude first writes a plan as a task comment and **waits for user approval** before writing any code.

#### Pipeline: todo → in_progress → in_review → ready_to_test → done

**1. todo → in_progress (Start work)**
- Pick the task, assign to `claude`, change status to `in_progress`.
- Add a comment: what approach will be taken (for S/M: brief, for L/XL: detailed plan — wait for approval).
- Create a feature branch from `main`: `cp-<number>/<short-slug>` (e.g. `cp-5/remove-in-testing`).
- Implement the task on that branch.

**1.1. needs_human_review**
- implementation requires human review before proceeding. Used when Claude encounters ambiguous requirements, architectural decisions that need human judgment, or changes with significant impact that should be verified by a human before moving forward. Claude moves tasks here and **stops working on them** until a human reviews and advances the status.

**2. in_progress → in_review (Implementation done)**
- Run `npm run build` to verify the build passes.
- Commit changes to the feature branch (conventional commits).
- Add a comment: summary of what was done, any decisions made.
- Change status to `in_review`.

**3. in_review → ready_to_test (Code review)**
- Review the diff between the feature branch and `main`.
- Check for: correctness, security, code style, missing edge cases.
- If issues found: fix them on the branch, re-commit, add comment with findings. Stay in `in_review`.
- If review passes: add comment confirming review OK. Change status to `ready_to_test`.
- Create a GitHub PR (`gh pr create`) for visibility and history.

**4. ready_to_test → done (Final check & merge)**
- Verify the branch is clean and build passes.
- Merge the PR into `main`.
- Delete the feature branch.
- Add a closing comment on the task.
- Change status to `done`.

#### Blocker handling
- If Claude gets stuck (missing info, external dependency, unclear requirements): stay in `in_progress`, add a comment describing the blocker, and **stop working on the task**.
- Do not brute-force or guess. Wait for user input.

### Conventions
- Task keys: `CP-1`, `CP-2` — use these when referencing tasks.
- **Project-defined fields go through the generic `fields` parameter**, keyed by field name: `fields: { "Difficulty": "L", "Component": "ui" }`. CP-214 removed the `difficulty` and `component` parameters that used to exist alongside it — a client still passing them gets nothing set. `get_project` lists the field names a project actually has.
- Assignees use **usernames** (not IDs). `claude` = Claude Code, `rpo` = you.
- Branch naming: `cp-<number>/<short-slug>` (e.g. `cp-3/dropdown-menu`)

### GitHub — always the `rafalpodles` account

This repo belongs to `rafalpodles`. The machine has a second `gh` account, `other-account`, which is
**not** a collaborator here, so anything it does fails with `must be a collaborator` — a message that
reads like a repository permission problem and is really the wrong identity.

```bash
gh api user -q .login            # must print rafalpodles
gh auth switch --user rafalpodles
```

`gh auth switch` is global machine state shared with every other session, so **the active account can
flip mid-session** — "it worked ten minutes ago" is not evidence it is still right. Check it
immediately before each of create / merge / delete, not once at the start.

**Never merge and delete the branch in one command.** `gh pr merge --delete-branch` is not atomic: a
flip between the two steps has already left a merge refused while the branch delete went through, and
**deleting the head branch closes the PR**. The result reads as `CLOSED` with the commit only in the
local worktree and `main` untouched, which is easy to mistake for "merged". Recovery: re-push the
branch, `gh pr reopen <n>`, merge.

## Tech stack
- Next.js 16 (App Router) + TypeScript
- MongoDB 4.4+ (Railway) + Mongoose ODM — aggregations must avoid 5.0-only operators (`$dateTrunc`, `$dateAdd`/`$dateDiff`, `$setWindowFields`, `$lookup` mixing `localField`/`foreignField` with an inline `pipeline`)
- Tailwind CSS 4
- Basic Auth + Bearer token (API tokens)
- MCP Server (separate package in `mcp-server/`)

## Project structure
```
src/
  app/
    api/              # ~40 REST API routes
    projects/         # Project pages (kanban, task detail, settings)
    login/, profile/, users/, tokens/, notifications/, search/, my-tasks/
  components/
    kanban/           # Board, Column, TaskCard, ListView
    tasks/            # TaskForm, Comments, TaskLinks, ActivityTimeline
    search/           # SearchLayer (⌘K), search core
    shell/            # Sidebar, ProjectTree, PageHeader
    pm/               # PM agent chat
    settings/         # Project settings sections
    ui/               # Button, Modal, Badge, Toast, etc.
    AuthGuard.tsx, AuthProvider.tsx, ThemeProvider.tsx
  hooks/
    use-api.ts        # HTTP client with auth headers
    use-auth.ts       # Auth state management
  lib/
    auth.ts           # Basic Auth + Bearer token verification
    db.ts             # MongoDB connection (cached)
    middleware.ts     # withAuth, withAdmin, withProjectAccess
    ai.ts             # OpenAI task generation
    notifications.ts  # Slack/Discord webhooks
    in-app-notifications.ts
    github.ts         # GitHub PR linking
    custom-fields.ts  # Custom field validation
    webhooks.ts, activity.ts, projectAudit.ts, checklist.ts
  models/             # Mongoose schemas
    user.ts, task.ts, project.ts, comment.ts, sprint.ts,
    apiToken.ts, notification.ts, activityLog.ts, projectAuditLog.ts, settings.ts
  types/index.ts      # Shared TypeScript types
mcp-server/           # Standalone MCP server (stdio transport)
  src/index.ts        # Tools: list/get/create/update tasks, sprints, comments, projects
  src/api-client.ts   # HTTP client to backend API
```

## Key patterns
- **Auth**: `getAuthUser(req)` tries Bearer token first, then Basic Auth
- **Middleware**: `withAuth` → `withAdmin` → `withProjectAccess` (composable)
- **Task numbers**: Auto-increment per project via atomic `$inc` on `Project.taskCounter`
- **Task keys**: `PROJECT_KEY-NUMBER` (e.g., `CP-5`), used in MCP and GitHub matching
- **Activity logging**: Fire-and-forget, doesn't block the main request
- **Notifications**: In-app + optional Slack/Discord webhooks + optional email
- **Recurrence**: When task → done with recurrence config, auto-creates next task
- **GitHub PR linking**: Matches PRs by branch/title pattern `CP-5` (case-insensitive)
- **Autonomous workers**: Opt-in per project (Settings → Workers, instance admin). A worker reports
  the checkouts it has — resolved from `repos.json` on its own machine — and the server matches
  those remotes against the project's `githubRepo`/`gitlabRepo`. **The server never sends a path**:
  an assignment names a remote and the worker resolves its own checkout, so where anything runs
  stays a local decision. Work policy (`autoMerge`, `baseBranch`, diff limits, models) lives on the
  project; only `pollIntervalMs` and the kill switch live on the worker. `autoMerge` defaults off,
  so an unconfigured project gets a pull request and nothing merged. See `worker/README.md`.
- **A held task refuses to move**: while a run holds a task (`execution.runId` set), a status change
  that would leave the column is refused with **409**, naming the worker and its phase — through
  every writer: the board, the edit form, MCP `update_task`, and the PM agent. `force: true` on the
  request is the way past it, and the board asks for it with a confirm dialog rather than a toast.
  The PM agent is deliberately given no way to force: an unattended agent must not take work off a
  machine. Staying in the column — a reorder, or resending the status already held — never touches
  the run. Staleness is **not** judged by silence: `agent` reports on tool use rather than on a
  clock, so a worker thinking for minutes is indistinguishable from a dead one. A genuinely
  abandoned run is reclaimed after `EXECUTION_LEASE_MS` (2 h) with attempt accounting.
- **PM autonomy**: Opt-in per project (Settings → PM Agent → Autonomy). Board reviews run from `pm.autonomy.reviewHour` every `pm.autonomy.reviewIntervalHours` in the project's own timezone; each slot is claimed atomically via `pm.autonomy.lastReviewSlot` (`YYYY-MM-DDTHH`) so it runs at most once. A review gets a server-computed digest (missing acceptance criteria, tasks stuck in a column, duplicate titles — `src/lib/pm/board-review.ts`) and runs with `change_status`/`create_task` withheld. Tasks entering `needs_human_review` are queued in `pmtriggers` and reviewed automatically. Autonomous turns count against `pm.dailyTurnCap` and are attributed to the `pm` user. See `docs/superpowers/specs/2026-07-28-pm-phase2-autonomous-triggers.md`.

## Environment variables
```
MONGODB_URI=              # Required — MongoDB connection string
OPENAI_API_KEY=           # Optional — AI task generation
OPENROUTER_API_KEY=       # Optional — PM agent (chat-driven project manager)
PM_MODEL=                 # Optional — PM agent model (default: moonshotai/kimi-k2.6)
PM_MAX_TOKENS=            # Optional — PM agent max output tokens per call (default: 8192)
PM_DAILY_TURN_CAP=        # Optional — PM agent turns per project per day (default: 100)
PM_SCHEDULER_TICK_MS=     # Optional — PM autonomy scheduler tick (default: 300000)
SMTP_HOST=                # Optional — Email notifications
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
NEXT_PUBLIC_APP_URL=      # Frontend URL for links
```

## Build
```bash
npm run build                    # Next.js app
cd mcp-server && npm run build   # MCP server
```

## Deploy
Railway auto-deploys from `main` branch.
App: https://board-planner.com
