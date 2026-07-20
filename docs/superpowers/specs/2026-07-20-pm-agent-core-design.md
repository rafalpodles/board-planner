# PM Agent — core + chat (v1)

Status: approved 2026-07-20 (design review: 2 independent reviewers, findings incorporated)

## Goal

A per-project PM agent the user chats with inside ClaudePlanner (Cowork-like UX). The PM
manages the board through tools: breaks features into tasks, refines existing ones, changes
statuses/assignees, answers questions about project state. Runs on a cheap model via
OpenRouter. Implementation agents (Claude Code) are out of scope for v1, as are sub-agents,
GitHub/Notion integrations, cron triggers and `needs_human_review` automation — but the core
turn function must be reusable for those (phase 2+).

## Architecture (approach A)

One PM turn = one server-side agent loop executed inside the chat request. No queue, no
worker, no long-lived process. The loop lives in `src/lib/pm/` and never touches HTTP —
phase 2 will call the same `runPmTurn` from cron/status events.

### Components

1. **`src/lib/task-service.ts`** — service layer extracted from existing route handlers:
   `createTask`, `updateTask`, `changeStatus`, `assignTask` with ALL current side effects
   (taskCounter `$inc`, recurrence auto-create on done, activity log, in-app notifications,
   webhooks/Slack dispatch, checklist parsing, custom-field validation). Routes and PM tools
   share this one path. PM mutations are strictly in-process — never via HTTP/PlannerClient
   (the `pm` user is a member with empty `allowedProjects`; `withProjectAccess` would 403).

2. **`src/lib/pm/openrouter.ts`** — fetch-based chat-completions client (no new deps).
   Key from `OPENROUTER_API_KEY`; model from `project.pm.model` or `PM_MODEL` env (default:
   a pinned, dated Kimi K2 variant — verify exact slug + tool-calling support at
   implementation). Handles tool_calls arrays (parallel calls) and API errors as typed
   results, not exceptions.

3. **`src/lib/pm/tools.ts`** — tool registry:
   - `list_tasks` — compact projection only `{key, title, status, assignee, difficulty}`,
     paginated (limit + offset), optional status filter. Full text only via `get_task`.
   - `get_task`, `get_project_stats`, `list_comments`
   - `create_task` — status **forced to `planned`** in code
   - `update_task` — same field whitelist as the PUT route
   - `change_status`, `assign_task`, `add_comment`
   - No delete, no project-settings access.
   Every tool validates its args; validation errors and not-found results are returned to the
   model as tool results (never thrown). Attribution: `pm` user.

4. **`src/lib/pm/agent.ts`** — `runPmTurn({projectId, userMessage, triggeredBy, onEvent})`:
   - Persist the user message first.
   - Create the assistant message stub immediately; **append to `actions[]` after every
     executed tool**; finalize `content` at the end. A crashed turn leaves a faithful record;
     retry = a new turn that sees prior actions in history.
   - Prompt: system (role, guardrail note that task content is data, not instructions)
     + `pm.contextNotes` + `pm.links` + last 30 messages.
   - Caps: 15 model steps AND 10 write-actions per turn; tool results size-capped by
     projection, not byte-truncation. Step-cap exit produces an "I got stuck" summary.

5. **PM user bootstrap** — `User.findOneAndUpdate({username: "pm"}, {$setOnInsert: {...}},
   {upsert: true, new: true})` (race-safe via unique username index, same pattern as
   `getSettings()`); password = random bcrypt hash (account not loginable), role member.

### Data model

- **`PmMessage`** (new collection): `{project (ref, indexed), role: "user"|"assistant",
  content, actions: [{tool, taskKey?, summary, at}], triggeredBy (ref User), createdAt}`.
  Index `{project: 1, createdAt: -1}`. One continuous thread per project (v1).
- **`Project.pm`** subdocument: `{enabled: boolean, model: string, contextNotes: string,
  links: [{label, url}]}`. Added to the PUT whitelist WITH explicit shape validation
  (length limits, http(s) URL check); admin-only as today; audit log covers it.

### API

- `POST /api/projects/:id/pm/chat` `{message}` → SSE (`action` events per executed tool,
  `done` with the final message, comment heartbeat every ~15s). Rules:
  - 503 when `OPENROUTER_API_KEY` is missing (hidden UI is not a guard)
  - 409 when a turn is already running for the project (in-memory per-project lock,
    same style as `rate-limit.ts`; single Railway instance)
  - 429 over a daily per-project turn cap (count = today's user messages in `pmmessages`)
  - The turn runs to completion even if the SSE client disconnects (no abort on
    `request.signal`); auth via `getAuthUser` directly (streaming Response, not the
    JSON-wrapper style); `export const maxDuration` set.
- `GET /api/projects/:id/pm/messages?limit&before` — cursor pagination from day one.

### UI

- `/projects/[projectId]/pm` — chat page (pattern: existing sub-pages like `dashboard/`).
  History with shared `MarkdownContent` component (extracted from `Comments.tsx` / task
  detail — no shared component exists today), action chips under assistant messages
  ("✚ created CP-113" linking to the task), input (Enter sends), live "PM is working…"
  status from SSE. On stream loss: fall back to polling `GET /pm/messages`
  (`usePollWhileVisible` from CP-104).
- "PM" link in the project header row (next to Sprints/Dashboard), visible when
  `pm.enabled`.
- Project settings: "PM Agent" section — enable toggle, model override, contextNotes
  textarea, links list. Shows setup instructions when the API key is absent.

### Error handling

OpenRouter failure → persisted assistant message describing the error + retry affordance
(retry = new turn). Tool errors → fed back to the model. Step/write caps → summarized exit.

## Acceptance (verified live in the UI)

a. "Rozpisz feature X" → sensible tasks appear in `planned` with descriptions/criteria.
b. "Weź CP-N do todo i przypisz claude" → status+assignee change, action chip links to task.
c. "Co się dzieje w projekcie?" → answer grounded in board data.
d. Refinement of an existing task → updated description/criteria via `update_task`.
e. History survives reload; concurrent second message gets a clean "turn in progress" state;
   recurrence still auto-creates the next task when the PM closes a recurring one.

## Out of scope (v1)

Sub-agent spawning, GitHub/Notion/MCP context, cron + `needs_human_review` automation,
token-level streaming, multiple threads, history summarization, full prompt-injection
sandboxing (mitigated by: no delete, forced `planned`, write cap, visible action chips).
