# PM Agent — phase 2: autonomous triggers (CP-121)

Status: implemented 2026-07-29 (plan approved by rpo; see
`docs/superpowers/plans/2026-07-28-pm-phase2-autonomous-triggers.md`)

## Goal

Make the PM act without being spoken to. Two triggers, both opt-in per project:

1. **Daily board review** — once a day at a configured local hour, the PM reviews the board
   (stale tasks, missing acceptance criteria, likely duplicates, `ready_to_test` pile-ups),
   refines what is unambiguous and posts a summary into its chat thread.
2. **`needs_human_review` event** — when a task enters that status, the PM reads the task and
   its comments and either answers with a rationale comment or posts one concrete question
   for rpo, plus an in-app notification to the task's watchers.

`runPmTurn` was built HTTP-free in v1 exactly so phase 2 could call it; both triggers are new
callers, not a new agent.

## Architecture

### Components

1. **`src/lib/pm/autonomy.ts`** — pure and side-effect-free: `hourInTimezone`,
   `dayKeyInTimezone`, `isValidTimezone` (all built on `Intl`, no dependency), the slot
   helpers (`currentReviewSlot` / `dueReviewSlot`, see the CP-154 update below), and the two
   prompt builders.
2. **`src/models/pmTrigger.ts`** — the `pmtriggers` queue.
3. **`src/lib/pm/triggers.ts`** — `enqueuePmTrigger`, `onTaskStatusChanged` (the hook
   task-service calls), `runPmTrigger`, `drainPmTriggers`, watcher notification.
4. **`src/lib/pm/scheduler.ts`** — `startPmScheduler` / `pmSchedulerTick`, owns the day-claim.
5. **`src/lib/pm/turn-cap.ts`** — `isOverDailyTurnCap`, shared by the chat route, the trigger
   executor and the scheduler so one rate limit cannot drift into three.

### Data model

- **`Project.pm.autonomy`**: `{ dailyReview, reviewHour (0-23), reviewIntervalHours (1-24),
  timezone (IANA), handleNeedsHumanReview, lastReviewSlot ("YYYY-MM-DDTHH") }`.
  `lastReviewSlot` is server-managed — the validator forces it to `""` and the PUT route
  carries the stored value across, alongside a guard that a body omitting `autonomy` does not
  wipe it. The last two fields are the CP-154 shape; see the update below.
- **`PmMessage.trigger`**: `{ type: "chat" | "daily_review" | "needs_human_review", taskKey }`,
  a separate `Schema` with `_id: false`. Declaring it inline breaks the build — Mongoose reads
  the nested `type` key as the SchemaType for `trigger` itself.
- **`PmTrigger`**: `{ project, type, taskKey, task, state, active, attempts, lastError }`.

## Decisions

1. **In-process interval + atomic day-claim, not external cron.** Railway runs a single
   instance and we did not want extra infra. "Run once today" is a `findOneAndUpdate` on
   `pm.autonomy.lastDailyReviewDay`, so overlapping instances during a rolling deploy cannot
   both review. The claim is written **before** the turn runs: a crash costs that day's review
   rather than risking a restart loop that spends money on every boot.
2. **A durable queue rather than firing inside the request.** If the project's turn lock is
   held, `runPmTrigger` hands the trigger back as `pending` and returns `"deferred"`; the next
   tick picks it up. A busy lock never loses an event and never burns a retry.
3. **The status hook lives on both `changeStatus` and `updateTask`.** The board and the
   list-view dropdown go through `PATCH .../status`; the task edit form sends `status` inside
   the `PUT` body. Hooking only one silently misses half the transitions.
4. **The partial unique index filters on a plain boolean, not on `state`.** MongoDB 4.4
   rejects `$in` inside `partialFilterExpression` and Mongoose swallows the failure, so the
   index silently does not exist and idempotency silently does not work. `active` mirrors
   `state ∈ {pending, running}` and keeps the index portable across server versions.
5. **The daily review may not change statuses or create tasks.** The prompt forbids both.
   Editing text is reversible; a status change is not. Worth revisiting once there are real
   reviews to judge.

## Guardrails (unchanged from v1)

Tasks are still created only in `planned`; `MAX_STEPS = 15` and `MAX_WRITE_ACTIONS = 10` still
bound a turn. Autonomous turns get no extra powers, count against `pm.dailyTurnCap` (they
create a `role: "user"` message, which is what the cap counts), and are attributed to the `pm`
user with `trigger` recording why they ran. A PM-initiated move into `needs_human_review` does
not trigger a review of itself — the hook compares the actor against the `pm` user.

## Configuration

- Per project, in Settings → PM Agent → Autonomy.
- `PM_SCHEDULER_TICK_MS` (default 300000) controls the tick.
- With `pm.autonomy` untouched, behaviour is exactly what it was before this change.

## Update 2026-07-30 — reviews several times a day (CP-154)

The once-a-day review became an N-times-a-day one, plus deterministic detection.

- **`pm.autonomy.reviewIntervalHours`** (1-24, default 24 = the old behaviour). Slots start at
  `reviewHour` and repeat every interval until the day ends in the project timezone, so 9 + 4h
  gives 09, 13, 17, 21. `lastDailyReviewDay` became **`lastReviewSlot`** holding
  `YYYY-MM-DDTHH`; the claim is the same atomic `findOneAndUpdate`, one review per slot. The
  rename orphans the old value, so the first tick after the deploy runs one review for the
  current slot — the claim still bounds it to one.
- **`dailyReview` keeps its name** even though it now means "review on a schedule". Renaming
  the field would read as `false` on every existing project document and silently switch
  autonomy off. The stored `PmMessage.trigger.type` stays `daily_review` for the same reason.
- **`src/lib/pm/board-review.ts`** computes the digest the review used to hunt for: tasks in
  approved/active/review/blocked columns with no acceptance criteria or no description, tasks
  whose last `status_changed` activity is older than a per-role threshold (7 days approved, 3
  active/review/blocked), and title pairs with Jaccard similarity ≥ 0.6. Plain `find().lean()`
  and JS, no aggregation — nothing to break on MongoDB 4.4. Scans the 500 newest open tasks.
  Also exposed as the read-only `get_board_digest` tool so the same scan is available in chat.
- **`runPmTurn({ disallowedTools })`** — the review runs without `change_status` and
  `create_task`: they are dropped from the tool list sent to the model, rejected if called
  anyway, and named in the system prompt. Decision 5 below was a prompt-only promise; this
  makes it structural. Refining text (`update_task`, `add_comment`) is still allowed.

## Out of scope

Multi-instance scheduling (Railway runs one), PM-initiated Slack/e-mail, autonomous status
changes during the daily review, and a dedicated `NotificationType` for PM reviews — the
watcher notification reuses `comment_added` rather than touching the enum, the model and the
notifications UI.
