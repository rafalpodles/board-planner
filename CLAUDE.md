# Board Planner

## Documentation — two homes, one rule each

**Product documentation** — anything a user reads — lives in the `board-planner-site` repo as Markdown under
`src/content/docs/docs/**` and is published at https://board-planner.com/docs. That repo is the single source
of truth: edit the page there and open a pull request. Notion keeps no copy of it. Railway deploys that repo
**automatically from `main`**, so merging publishes — verify with `railway deployment list` rather than
assuming either way.

**Project documentation** — architecture, decisions, implementation notes, anything a user never sees — lives
in **Notion** under the `🗂️ Board Planner` root. Use the Notion MCP tools, and search first so an existing
page is updated rather than duplicated.

The split is the outcome of BP-234. The two copies of the product docs had already drifted on five of
twenty-seven pages within eleven days, and a sync script would have been a machine maintaining a mirror for
readers who do not exist.

### After completing a feature

Ask which of the two homes it touches — often both:
- **Changed what a user sees or does?** Update the page under `src/content/docs/docs/**` in `board-planner-site`
  and open a pull request there. A new endpoint belongs in `reference/rest-api.md`.
- **Made an architectural decision, added a service, changed configuration?** Write it up in Notion.

---

## Board Planner integration
boardplanner_project_key: BP

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
Claude automatically picks up tasks in `todo` status and processes them through the pipeline. No user confirmation needed for `todo` tasks. A **machine** taking one is a further step with its own requirements, below.

Which of them a project's autonomous worker (Settings → Workers) may take follows the task's assignee, not a project-wide setting. A machine belongs to one person — whoever enrolled it — and it takes a task only when **all** of these hold:

- the task is assigned to that person, and **that same person did the assigning** (`assignedBy`). Work somebody else hands you is a proposal; nothing runs it unattended, and the surface for accepting one does not exist yet.
- the task **names an agent**. Choosing one is the hand-over gesture; the field is `agent` on the task, set from the Agent row in the task detail or `update_task`'s `agent` parameter. No agent means a person is doing it, which is the default.
- the project is enabled for workers, and the machine's owner can reach that project.

So the old instruction — assign the task to `claude` — no longer hands it to anything. `claude` is a person-shaped account; the machine belongs to **you**, and a task assigned to somebody else is exactly what it will not take. A task assigned before this change has no `assignedBy` recorded and is deliberately never claimed; assigning it again records one. When an agent is chosen and nothing will run the task, the Agent row says so and why.

#### Size-based approach
Size comes from the project's **Difficulty** field — an ordinary project-defined field since CP-213, not a column on the task. Read it from `customFieldValues`; a project that renamed or removed it has no size, and those tasks are treated as S/M.
- **S/M tasks** — Claude implements immediately, no upfront plan needed.
- **L/XL tasks** — Claude first writes a plan as a task comment and **waits for user approval** before writing any code.

#### Pipeline: todo → in_progress → in_review → ready_to_test → done

**1. todo → in_progress (Start work)**
- Pick the task, assign it to yourself (`rpo`), change status to `in_progress`. Assigning it to `claude` hands it to nobody — see *Autonomous task processing* above.
- To run it on a machine rather than by hand, also choose an agent: `update_task` with `agent: "<agent name>"`. Without one no machine looks at it; with one, and with the task assigned to the machine owner by the machine owner, the worker takes it on its next poll.
- Add a comment: what approach will be taken (for S/M: brief, for L/XL: detailed plan — wait for approval).
- Create a feature branch from `main`: `bp-<number>/<short-slug>` (e.g. `bp-5/remove-in-testing`).
- Implement the task on that branch.

**1.1. needs_human_review**
- implementation requires human review before proceeding. Used when Claude encounters ambiguous requirements, architectural decisions that need human judgment, or changes with significant impact that should be verified by a human before moving forward. Claude moves tasks here and **stops working on them** until a human reviews and advances the status.

**2. in_progress → in_review (Implementation done)**
- Run `npm run build` to verify the build passes.
- **Cover the behaviour with an end-to-end test** — see *End-to-end coverage is not optional* below.
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

#### End-to-end coverage is not optional

**If a task touches functionality a person can reach — a screen, a route, a flow — it ships with an
end-to-end test in `e2e/`.** Not instead of unit tests: as well as them. Unit tests answer whether a
function does what its author meant; the e2e answers whether the feature works, and the bugs that
reach the product live in the seam between the two.

Skip it only for work with no user-reachable surface at all — a build script, a type-only change, a
refactor with no behavioural delta. "The unit tests cover it" is not a reason; neither is "the flow is
fiddly to drive". The friction is where the bugs are.

**The test has to be able to fail.** Before calling it done, remove the fix, run the spec, and watch
it go red for the right reason — then put the fix back. A spec that passes against the broken code
proves nothing, and that is the ordinary outcome of writing it afterwards.

**Include a control.** Assert the thing works in the case it is *supposed* to work, next to the case
it must refuse. Otherwise a silence caused by a mis-wired fixture reads exactly like a silence caused
by the fix.

Practicalities that cost real time to rediscover:

- Run one spec with `npx playwright test e2e/<name>.spec.ts`. Machines here are shared, so give a run
  its own ports and database: `E2E_PORT=…  PM_STUB_PORT=…  E2E_MONGODB_URI=mongodb://localhost:27017/<name>_e2e`.
  The fixture refuses any database whose name does not end in `_e2e`, deliberately.
- A git worktree needs its own `npm ci`. A symlinked `node_modules` fails: Turbopack refuses a symlink
  pointing outside the project root, and the dev server dies before the first test runs.
- **Do not synchronise on rendered text.** Lists here render optimistically, so the text is on screen
  before the server has done anything. Wait for the response (`page.waitForResponse`) whenever the
  server-side effect is what the test is about. This exact mistake made BP-328's spec pass and fail at
  random, because a comment's `watchers` write had not landed when the next request read the task.
- Notification writes are deliberately fire-and-forget, so a feed assertion needs `toPass` retries
  rather than a single load.

#### Blocker handling
- If Claude gets stuck (missing info, external dependency, unclear requirements): stay in `in_progress`, add a comment describing the blocker, and **stop working on the task**.
- Do not brute-force or guess. Wait for user input.

### Conventions
- Task keys: `BP-1`, `BP-2` — use these when referencing tasks. Pull requests opened under the old `CP-` prefix still link, because the project keeps its former keys.
- **Project-defined fields go through the generic `fields` parameter**, keyed by field name: `fields: { "Difficulty": "L", "Component": "ui" }`. CP-214 removed the `difficulty` and `component` parameters that used to exist alongside it — a client still passing them gets nothing set. `get_project` lists the field names a project actually has.
- Assignees use **usernames** (not IDs). `claude` = Claude Code, `rpo` = you. Routing keys on the assignee, so a task meant to run on your machine is assigned to `rpo`, not to `claude`.
- **Handing work to a machine is `update_task`'s `agent` parameter**, named rather than by id — the id appears in no MCP response. Instance admins only, and refused for an agent nobody has composed yet.
- Branch naming: `bp-<number>/<short-slug>` (e.g. `bp-3/dropdown-menu`)

### GitHub — always the `rafalpodles` account

This repo belongs to `rafalpodles`. The machine has a second `gh` account, `podlesrafal`, which is
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
- Session cookie (browser) + Bearer token (API tokens, OAuth)
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
    auth.ts           # Bearer token + session cookie verification
    session.ts        # session cookie: issue, resolve, revoke, provenance check
    db.ts             # MongoDB connection (cached)
    middleware.ts     # withAuth, withAdmin, withProjectAccess
    ai.ts             # OpenAI task generation
    notifications.ts  # a project's shared Slack/Discord channel
    notification-prefs.ts # resolveChannels: which channels an event may use, per project
    personal-chat.ts  # the reader's own Slack/Discord webhook
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
- **Auth**: `getAuthUser(req)` tries Bearer token first (`cpat_` OAuth, `cp_` API token), then the session cookie. A presented Bearer that resolves to nothing returns null rather than falling back to the cookie. Basic Auth was removed in BP-293; the browser holds an opaque `cps_` session token in an httpOnly cookie, never a password. Only the cookie path yields `viaMachineCredential = false`.
- **Middleware**: `withAuth` → `withAdmin` → `withProjectAccess` (composable)
- **Task numbers**: Auto-increment per project via atomic `$inc` on `Project.taskCounter`
- **Task keys**: `PROJECT_KEY-NUMBER` (e.g., `CP-5`), used in MCP and GitHub matching
- **Activity logging**: Fire-and-forget, doesn't block the main request
- **Notifications**: a per-user grid of `event × channel` (`src/lib/notification-prefs.ts`),
  resolved by `resolveChannels(user, projectId, event)` — global, with a per-project override whose
  presence in `user.notifications.projects` *is* the override switch. Channels are the bell, e-mail
  and a **personal** Slack/Discord webhook (`src/lib/personal-chat.ts`), distinct from a project's
  shared team channel in `project.notificationChannels`, which is unchanged and has no recipient.
  Accounts with no stored grid fall back to the old `emailNotifications` boolean, so nothing was
  migrated. The bell hides rows rather than skipping the write — `Notification.inApp` — because the
  digest is assembled from those documents
- **Recurrence**: When task → done with recurrence config, auto-creates next task
- **GitHub PR linking**: Matches PRs by branch/title pattern `BP-5`, and by any key the project used to have (case-insensitive)
- **Autonomous workers**: Opt-in per project (Settings → Workers, instance admin). Enrolling a
  machine is self-service and needs no admin approval: whoever connects it owns it, and a machine
  reaches exactly the projects its owner reaches, resolved live from that person's grants rather
  than stored. A worker reports the checkouts it has — resolved from `repos.json` on its own
  machine — and the server matches those remotes against the project's `githubRepo`/`gitlabRepo`.
  **The server never sends a path**: an assignment names a remote and the worker resolves its own
  checkout, so where anything runs stays a local decision. Work policy (`autoMerge`, `baseBranch`, diff limits, models) lives on the
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
WEBHOOK_SIGNING_SECRET=   # Optional — HMACs outgoing webhook deliveries (x-boardplanner-signature)
DIGEST_HOUR=              # Optional — hour the opt-in daily digest goes out (default 7)
DIGEST_TIMEZONE=          # Optional — the zone that hour is read in (default Europe/Warsaw)
DIGEST_TICK_MS=           # Optional — digest scheduler tick (default 300000)
SMTP_HOST=                # Optional — Email notifications
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
ENCRYPTION_KEY=           # 32 bytes (hex or base64) — without it integration tokens cannot be saved;
                          # a wrong-length key stops the app from starting
ENCRYPTION_KEYS_OLD=      # Optional — comma-separated retired keys, so a rotation can still decrypt
NEXT_PUBLIC_APP_URL=      # Frontend URL for links — read at BUILD time, not runtime
APP_ORIGIN=               # Comma-separated origins allowed to write — the CSRF allowlist
TRUSTED_PROXY_HOPS=       # Proxies appending to X-Forwarded-For in front of the app; default 0,
                          # which ignores the header. The login throttle keys on it, so on a
                          # proxy-less deployment a forged header used to reset every counter (BP-318)
PUBLIC_ORIGIN=            # This instance's own address, at runtime. Required for /api/mcp, both
                          # /.well-known documents and the PM OAuth redirect_uri, which answer 500
                          # without it rather than falling back to a request header (BP-316).
                          # Falls back to APP_ORIGIN only when that names exactly one origin —
                          # never to NEXT_PUBLIC_APP_URL, which is a build-machine literal
```

## Build
```bash
npm run build                    # Next.js app
cd mcp-server && npm run build   # MCP server
docker compose up -d --build     # app + MongoDB 4.4, no local Node or Mongo needed
```
`next.config.ts` emits `output: "standalone"` only when `BUILD_STANDALONE` is set, which the Dockerfile
does — `next start` refuses standalone output, and Railway deploys with `next start`.
`NEXT_PUBLIC_APP_URL` is baked in at build time — the compose file passes it as a build arg. See
[README.md](README.md).

## Deploy
Railway auto-deploys from `main` branch.
App: https://app.board-planner.com

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
