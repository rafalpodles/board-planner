# Autonomous execution worker

Status: designed 2026-07-31 (approved by rpo)

## Goal

Close the last gap in the autonomy loop. The PM agent already decides *what* should be worked
on; the MCP server already lets Claude Code read and write the board. Nothing runs Claude Code
when a task lands in `todo`. Today that role is played by a human-started interactive session,
which dies with the terminal, shares one context across every task and works in a single
checkout.

The worker replaces it: a long-lived process that claims `todo` tasks, runs Claude Code headless
in an isolated worktree, enforces merge gates and reports back to the board — carrying a task
from `todo` to `done` with no human in the loop.

Two deployment shapes from one core:

1. **rpo's machine** — worker runs on the laptop against the local clone, using the Claude Code
   subscription (not an API key). This is the first installation, not a prototype.
2. **Customer install** — the same binary in a container next to their repository. Only
   configuration differs: API base URL, token, repository path, Claude credentials.

## Architecture

### Topology

The app runs on Railway; the git checkout lives on the developer machine. The worker therefore
cannot be part of the Next.js process — it is a separate program that talks to the app over
**REST with a Bearer token, never directly to MongoDB**. The same boundary is what makes the
customer shape free: a machine executing agent-written code never needs database credentials.

Work is **polled**, not pushed. The worker sits behind NAT, so an outbound webhook from Railway
cannot reach it. Default interval 30 s, configurable.

### Components

New package `worker/`, sibling to `mcp-server/`, with its own `package.json` and build.

1. **`worker/src/config.ts`** — environment parsing and validation. Fails loudly at startup on
   missing API URL, token, or repository path.
2. **`worker/src/queue.ts`** — `claimNext()`: asks the app for a claimable task and atomically
   takes ownership. Returns `null` when the queue is empty.
3. **`worker/src/workspace.ts`** — worktree lifecycle: `create(taskKey)` → branch + worktree,
   `destroy()`, and `reapOrphans()` at startup for worktrees left by a killed worker.
4. **`worker/src/executor.ts`** — builds the prompt, spawns `claude`, parses the schema-validated
   result. The spawn sits behind an interface so tests never invoke a real model.
5. **`worker/src/gates/`** — one file per gate, each exporting the same
   `(context) => Promise<GateResult>` shape: `diff-size.ts`, `test-presence.ts`, `build.ts`,
   `review.ts`.
6. **`worker/src/delivery.ts`** — `gh pr create`, merge, branch deletion.
7. **`worker/src/reporter.ts`** — status transitions and comments back onto the task. The only
   module that formats human-facing text.
8. **`worker/src/loop.ts`** — the run loop: concurrency limit, graceful shutdown, backoff.

### Data model changes in the main app

- **`Project.repository`** — `{ url, defaultBranch, localPath }`. Without it the worker cannot
  map a project to a checkout. `localPath` is worker-side and may be empty for projects the
  worker does not serve.
- **`Task.execution`** — `{ runId, workerId, attempts, startedAt, lastError }`. Drives retries
  and gives the board something to display while a task is being worked.

### New endpoint: atomic claim

`POST /api/projects/:projectId/tasks/claim` — conditional `findOneAndUpdate` that moves the
oldest eligible task (`status` in an `approved`-role column, assignee `claude` or unassigned)
to `in_progress` and stamps `execution`, returning the task or `204`. The condition on the
current status is what makes it a claim: two workers racing produce one winner and one `204`.

This mirrors the slot claim already used in `src/lib/pm/scheduler.ts`. A plain read-then-update
is not sufficient — both workers would read `todo` and both would write `in_progress`.

## Task lifecycle

```
todo ──claim──> in_progress ──execute──> gates ──> in_review ──merge──> done
                     │                     │
                     │                     └─ rejected ────> needs_human_review
                     ├─ agent reports blocked ─────────────> needs_human_review
                     ├─ usage limit reached ───────────────> todo (no attempt consumed)
                     └─ crash / timeout ───────────────────> todo (attempt n+1; 3 → needs_human_review)
```

Intermediate statuses are written even though nobody is waiting on them, so the board shows
where the agent is and a human can interrupt.

**A usage limit is not a failure.** It returns the task to `todo` without consuming an attempt.
Treating it as an error would drain the whole queue into `needs_human_review` overnight when
the subscription limit is hit.

## Isolation

One `git worktree` per task under `<repo>/../cp-worktrees/<task-key>`, on branch
`<task-key>/<slug>` — the convention already documented in CLAUDE.md. Removal happens in a
`finally`, so a thrown exception cannot leak a worktree. Orphans from a killed process are
reaped at startup by comparing `git worktree list` against tasks currently in `in_progress`.

Concurrency defaults to **1**. On a laptop two concurrent Claude Code processes contend for CPU
and burn the subscription limit twice as fast.

## Executing Claude Code

```
claude -p "<task title, description, acceptance criteria, project context>"
  --output-format json
  --json-schema '{status, summary, filesChanged, testsAdded, blockedReason}'
  --permission-mode bypassPermissions
  --allowedTools "Read Edit Write Grep Glob Bash(git *) Bash(npm *)"
  --mcp-config <boardplanner mcp>
  --append-system-prompt <pipeline rules>
  --model opus --fallback-model sonnet
```

`--json-schema` is load-bearing: it forces a machine-readable verdict, so the worker never
infers success by pattern-matching prose. `--allowedTools` is an allowlist — no `rm`, no
network fetches — which bounds the damage a confused agent can do inside the worktree.

Credentials come from the logged-in CLI session, **not** `ANTHROPIC_API_KEY`. Passing an API key
would silently bill per token instead of using the subscription. The customer shape may set an
API key instead; that is a configuration decision, not a code path.

Per-task timeout: 30 minutes. Longer runs almost always mean a stuck agent rather than a hard
task, and the task returns to `todo` for a retry.

## Gates

Evaluated in order, cheapest first, so the expensive gate only runs on a candidate that already
passed the cheap ones. Any failure routes the task to `needs_human_review` with a comment naming
the gate and the reason.

1. **`diff-size`** — reject above 400 changed lines or 10 changed files. A crude but effective
   proxy for "this turned out bigger than the agent understood". Both thresholds are worker
   configuration, not per-project settings — one knob until a second project needs a different
   one.
2. **`test-presence`** — the diff must touch at least one `*.test.ts` file. Requires a test
   framework in the repository (see prerequisite below); without one this gate is vacuous.
3. **`build`** — `npm run build` must pass.
4. **`review`** — a fresh `claude -p` invocation with an inline `--agents` reviewer that receives
   **only the diff and the task text**, with no history from the authoring session. Returns a
   verdict through `--json-schema`; a veto blocks the merge.

`build` runs before `review` because it is faster and deterministic, and because reviewing code
that does not compile wastes a model call on a defect the compiler already found.

## Error handling

| Condition | Action |
|---|---|
| Agent returns `blocked` | `needs_human_review`, comment carries `blockedReason` |
| Gate rejects | `needs_human_review`, comment names gate and reason |
| Usage limit | back to `todo`, no attempt consumed, loop backs off |
| Timeout or crash | back to `todo`, attempt incremented; at 3 → `needs_human_review` |
| PR or merge failure | `needs_human_review`, worktree and branch preserved for inspection |
| App unreachable | exponential backoff, keep retrying, never drop a claimed task silently |

A claimed task whose worker dies is recovered by the startup reaper: tasks in `in_progress`
whose `execution.workerId` matches this worker and whose worktree is gone are returned to
`todo` with `attempts` incremented, so a task that reliably kills the worker reaches
`needs_human_review` after three crashes instead of looping forever.

## Testing

Vitest, in both the worker and the main app. `executor.ts` and `delivery.ts` hide their
subprocess calls behind interfaces so no test spawns a model or touches GitHub.

Coverage targets what can actually break: the claim race (two workers, one task), each gate's
accept and reject paths, every error branch in the table above, and worktree cleanup after a
thrown exception.

## Prerequisite

The repository has no test framework — `package.json` declares no test runner and every
`*.test.ts` on disk belongs to `node_modules`. The `test-presence` gate is meaningless until
Vitest is added. This is stage 0 of the plan, not an optional follow-up.

## Decisions

1. **Separate process over an app mode.** The app is on Railway, the checkout is on a laptop;
   they cannot be the same process. Making that boundary explicit also means the customer
   deployment never grants database access to the machine running agent-written code.
2. **REST over direct MongoDB.** Costs a thin API client. Buys a worker that runs anywhere and
   an app that stays the single writer to its own database.
3. **Polling over webhooks.** The worker is behind NAT. Polling is also self-healing: a worker
   that was offline simply picks up whatever accumulated.
4. **Subscription credentials over API key.** For rpo's install the subscription is a flat cost
   while per-token billing scales with every autonomous run.
5. **Schema-forced output over prose parsing.** `--json-schema` turns "did it work?" into a field
   read instead of a heuristic.
6. **Usage limits are not failures.** Without this distinction one exhausted limit poisons the
   whole queue.
7. **Gates ordered by cost.** Three cheap deterministic checks filter the candidates that reach
   the one model-based check.
8. **Concurrency 1 by default.** The first deployment target is a laptop that its owner is also
   using for other work.

## Stages

| Stage | Scope | Outcome |
|---|---|---|
| 0 | Vitest in the main repo | `test-presence` gate becomes meaningful |
| 1 | Atomic claim endpoint, `Project.repository`, `Task.execution` | app is worker-ready |
| 2 | Worker: loop, claim, worktree, executor, reporter — **stops at PR** | first hands-off task |
| 3 | Four gates | merge safety |
| 4 | Auto-merge to `main` | full loop |
| 5 | `launchd` service, concurrency, orphan reaping | survives restarts |

Stage 2 is already demonstrable: a task moves from `todo` to a PR with nobody at the keyboard.
Stages 3 and 4 buy the confidence required to remove the last human step.
