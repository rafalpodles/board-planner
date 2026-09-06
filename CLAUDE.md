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

Working a task (picking it, statuses, worktree, tests, review, PR, merge, cleanup) is the `bp-task`
skill in `.claude/skills/bp-task/`. Invoke it before touching a task. Its references cover the
board's MCP conventions, the e2e suite, git and GitHub. On session start run `list_tasks` for BP to
see current work; when asked what to work on, list tasks and suggest the next one. When the user
describes new work, ask whether it should be tracked and `create_task` if so.

Every `gh` command here runs as `rafalpodles` and every commit is authored by
`Rafał Podleś <rafalpodles@gmail.com>`; any other account on this machine is not a collaborator.
The checks are in the skill's `references/git-github.md`.

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
  digest is assembled from those documents. Four of the five rows *filter* a recipient list built
  from a task's assignee and watchers; `task_created` has no such list and instead *selects* its
  audience from the ticks themselves (`src/lib/board-feed.ts`), bounded by
  `BOARD_FEED_FANOUT_LIMIT`. It is the one row the legacy fallback leaves off, so adding it
  subscribed nobody
- **Recurrence**: When task → done with recurrence config, auto-creates next task
- **GitHub PR linking**: Matches PRs by branch/title pattern `BP-5`, and by any key the project used to have (case-insensitive)
- **Autonomous workers**: Opt-in per project (Settings → Workers, instance admin). Enrolling a
  machine is self-service and needs no admin approval: whoever connects it owns it, and a machine
  reaches exactly the projects its owner reaches, resolved live from that person's grants rather
  than stored. A worker reports the checkouts it has — resolved from `repos.json` on its own
  machine — and the server matches those remotes against the project's `githubRepo`/`gitlabRepo`.
  **The server never sends a path**: an assignment names a remote and the worker resolves its own
  checkout, so where anything runs stays a local decision. What a run *does* is the **agent** the
  task names — an ordered list of steps and gates, composed in Agents. Merging is a **Merge step**
  in that sequence, not a setting: `autoMerge` and `reviewGate` left the project's settings along
  with the diff limits and the models, which now belong to the blocks that use them. A project
  keeps only `baseBranch` and the two timeouts, and the worker keeps `pollIntervalMs` and the kill
  switch. A task naming **no** agent is never claimed at all — there is no falling back to the
  project's default, which only pre-selects the picker. See `worker/README.md` and
  https://board-planner.com/docs/ai/agents/.
- **A held task refuses to move**: while a run holds a task (`execution.runId` set), a status change
  that would leave the column is refused with **409**, naming the worker and its phase — through
  every writer: the board, the edit form, MCP `update_task`, and the PM agent. `force: true` on the
  request is the way past it, and the board asks for it with a confirm dialog rather than a toast —
  but only from a person's session. `machineMayNotForce` (`src/lib/force-guard.ts`) refuses it from
  any machine credential, which is what every API token and MCP connection is, and the PM agent is
  given no way to name it at all: an unattended agent must not take work off a machine. Staying in the column — a reorder, or resending the status already held — never touches
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
PM_DAILY_TURN_CAP=        # Optional — PM agent turns per project per day (default: 100). A RATE
                          # limit, not a budget: one turn is up to 15 model round-trips, so this
                          # permits between 100 and 1500 calls (BP-284)
PM_DAILY_TOKEN_CAP=       # Optional — tokens per project per day; unset means no ceiling. The
                          # budget, in what the model bills. Settings → PM Agent shows the day's
                          # real turns, calls and tokens to set it from
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
