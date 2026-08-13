# Recipes: a chosen treatment for a worker run

Date: 2026-08-13
Task: BP-331
Prerequisite: BP-333 (gate hardening) — parts of this design assume its fixes have landed
Supersedes: the composable-agent design committed as 083e447, withdrawn after review

## What changed and why

The first version of this document proposed a user-composed agent: an ordered, interleaved sequence
of steps and gates in three buckets, assembled by drag-and-drop from a catalog, with prompts stored
in the database. Three independent reviews — security, codebase-fit, product — each concluded it
should not be built as specified. They converged on defects that were structural rather than
fixable:

- **The permission ladder deadlocked.** Steps were given an `edit` profile without `Bash`, and the
  run required a clean tree after every step. An `edit` step writes files and cannot commit them, so
  every such step ended its own run. The only working profile was `deliver`, which carried
  `Bash(git *)` — and that is not "git": `git -c core.pager='sh -c …'` and `git config
  core.hooksPath` match the pattern. The worker neutralises exactly this in its own git calls
  (`-c core.pager=cat`, `GIT_CONFIG_NOSYSTEM=1`) and nothing wrapped the agent's.
- **"Prompts are speech, tools are power" was false.** Capability is the tool list composed with the
  prompt. Moving prompts into the database moved the deciding half to the server, and `childEnv()`
  passes `HOME` deliberately, so a directed agent reaches `~/.boardplanner/worker.json` — the
  worker's own credential — along with `~/.ssh` and `~/.config/gh`.
- **Multi-step created an instruction-injection window that does not exist today.** Step 1 writes
  `CLAUDE.md`, step 2 starts with it loaded as its own instructions, step 3 deletes it. Net diff:
  nothing. Neither `protected-paths` nor `review` sees it.
- **The fresh-session argument was applied to the wrong half.** Freshness helps *judging*, because a
  verdict is fully specified by the artefact judged. It hurts *producing*, because "write a test for
  this change" needs intent that the diff does not carry. The context toggle existed to patch that
  hole and then instructed the receiving step to distrust the patch.

This version keeps the two motivations and drops the mechanism.

## The problem, restated

1. **Every task gets the same treatment.** Work policy sits on the project: one model, one diff
   limit, one gate list for a copy typo and for an auth refactor alike.
2. **One session writes and self-assesses.** The review gate exists because a second model reading a
   diff with no memory of writing it catches more. That argument generalises to *other judgements* —
   security, acceptance criteria — not to other production.

## The design

A **recipe** is a named, whole, immutable treatment: **one implementation step, plus an ordered list
of gates**. It is chosen from a list. It is not composed, not edited, not parameterised.

Recipes are **seeded in worker code** and referenced by a stable slug. Nothing about a recipe travels
from the server except its slug. This is not a limitation to be lifted later by degrees — it is what
makes every finding above inapplicable: no database-authored prompt, no permission ladder, no
parameter validation, no risky-composition predicate, no audit apparatus, no versioning problem, no
mid-run edit.

The name is `recipe`, not `agent`. `Settings → PM Agents` already exists, `agent` is already a worker
telemetry phase, and CLAUDE.md calls these things workers.

### The seeded catalog

| Slug | Implementation | Gates | Merges |
|---|---|---|---|
| `standard` | today's implementer | diff-size, protected-paths, test-presence, build, test-run, review | when `autoMerge` is on |
| `careful` | today's implementer | as `standard`, plus `security-review` before `review`, and `review` runs twice at two models | when `autoMerge` is on |
| `quick` | today's implementer | diff-size, protected-paths, build, test-run | never |

`standard` reproduces current behaviour exactly, so adopting recipes is a no-op for every existing
project and the migration is a backfill of one slug.

`quick` never merges, and that needs no new rule: it contains no `review`, and the worker already
refuses `autoMerge` without review.

Two new gates, both pure verdicts over a diff, both fresh sessions — this is where the quality
argument actually applies:

- **`security-review`** — a second model reading the diff for injection, credential handling,
  authorization and path traversal, with no memory of writing it.
- **`acceptance-criteria`** — reads the task's acceptance criteria and the diff, and refuses when a
  criterion is unaddressed. Not in any seeded recipe yet; specified here because it is the clearest
  candidate for the next one and it shapes the gate interface (it needs the task, which
  `GateContext` already carries).

### Selection

A project names a **default recipe**. That is the whole required configuration; a project that names
nothing gets `standard`.

Optionally, a project maps **Difficulty** to a recipe — S/M → `quick`, L/XL → `careful`. Difficulty
already exists as a project field and the user already maintains it, so this expresses "heavier
treatment for heavier work" without inventing a per-task control. A per-task recipe override is
deferred; note that it would have to resolve server-side at claim time, because the assignment
payload is built at heartbeat time, long before any task is claimed.

### What reaches the worker

The slug, on the claim response, resolved server-side. Not in the assignment `policy` patch: that
payload only carries fields listed in `policyOverrides`, deliberately, so that a changed default
still reaches every machine — writing derived values into it would defeat the mechanism it rides on.

The server needs recipe names and descriptions to render the choice. It mirrors them the way
`src/lib/worker-policy.ts` already mirrors the worker's defaults, with the same comment explaining
why the duplication is deliberate. A worker also reports the slugs it implements in its heartbeat, so
a project defaulting to a recipe an enrolled machine does not have is visible in the console before
anyone hands over a task.

An unknown slug refuses the run before any model call, naming the slug. It never silently falls back.

## Corrections to the current pipeline that this design depends on

**The worker commits, not the agent.** Today `SYSTEM_PROMPT` asks the agent to commit and
`ALLOWED_TOOLS` grants `Bash(git *)` for it. With the worker committing after the implementation step
returns, no step needs `Bash` at all, and the implementer's allowlist drops to `Read Edit Write Grep
Glob`. This removes the arbitrary-execution channel described above and is worth doing on its own
merits, independent of recipes.

`Bash(npm *)` goes with it. The agent does not need to run the build — the build gate does, moments
later, under a timeout, with `--ignore-scripts`.

**The gate invariant, stated honestly.** "A gate cannot change anything" is false of the existing
catalog: `build` runs `npm ci` and the repository's build script, `test-run` runs the suite, and a
suite may write tracked snapshots. The truthful invariant is: **a gate's only output is a verdict**,
and a gate that spawns a process still executes repository content. Consequently the clean-tree check
runs after **every entry**, gate as well as step — a gate that dirties the tree fails the run and is
named, rather than leaving content for something later to commit.

The corresponding test asserts the *return type* and the absence of a write path in pure gates. It
does not assert that `build` and `test-run` do not touch the tree, because they do.

**`autoMerge` is decided by inspecting the recipe, not a derived boolean.** The worker's refusal
(`if (next.autoMerge && !next.reviewGate) next.autoMerge = false`) works today because it recomputes
an implication over a value whose meaning it owns. A server-derived `reviewGate` would turn that into
trusting the server's claim about a recipe. The worker asks its own question instead: *does the
recipe I am about to run contain a `review` gate?* The flat `reviewGate` field remains only as wire
compatibility for pre-BP-331 workers and is never an input to a merge decision.

Note the polarity trap this avoids: today `reviewGate !== false` means absence implies review —
default closed. A composition where absence means "the gate is not there" is default open. The
worker-side inspection keeps the safe polarity by asking about presence explicitly.

**`protected-paths` is in every recipe and is not removable.** It is the only gate whose subject
matter escapes the machine. Per BP-333 its refusal must also stop pushing, since a pushed branch
carrying `.github/workflows/*.yml` executes in Actions with the repository's secrets regardless of
any verdict.

## Run record

Recipes need somewhere to be recorded, and the product needs it anyway.

Today a finished run is forensically empty: `execution.runId` lives on the task and every exit clears
it, so the only durable trace is prose in a comment. This adds a run record carrying: task, worker,
recipe slug, start and end, outcome, the gate that refused if any, and **cost**.

Cost is already measured and thrown away — `worker/src/stream.ts` reads `total_cost_usd` and
telemetry maps it to `costUsd`. `careful` runs review twice; shipping a recipe that multiplies model
calls without showing the user what a run costs would surface the change as an unexplained
usage-limit wall.

## Budget and the lease

Today `taskTimeoutMs` is not a run budget: the implementation call gets the whole value, and each
timed gate gets up to another `min(600_000, taskTimeoutMs / 3)`. Worst case is roughly twice
`taskTimeoutMs`. `careful` adds two more model-backed gates, so the ceiling rises further.

Per-entry timeouts stay as they are, including the ten-minute cap, which is a real bound that a
shared budget would have silently removed. What is added is a **run ceiling**, default 90 minutes,
enforced by the worker.

The ceiling must stay below `EXECUTION_LEASE_MS` (2 h) or the server reclaims a task under a running
worker, the next phase post returns `applied: false`, and the run is aborted — which looks exactly
like the machine dying. That coupling is a comment today; this makes it a validated constraint in
`src/lib/project-worker-config.ts`.

## Errors and exits

| Situation | Outcome |
|---|---|
| Implementation returns `blocked` | Run ends, card to a human, reason reported |
| Tree dirty after any entry | Run ends, nothing pushed, worktree kept, path and entry reported |
| `protected-paths` refuses | **Not pushed**, worktree kept, path reported (BP-333) |
| Any other gate refuses | Branch pushed, card to the review column, gate named |
| Gate cannot run | Task released, attempt returned not burned |
| Run exceeds the ceiling | Requeued, attempt burned |
| Unknown recipe slug | Run refused before any model call, slug named |

A gate returns a typed `couldNotRun` state rather than being classified by matching prose against
`/usage limit reached/i`, so a gate reason that happens to contain the phrase cannot convert a real
failure into a refunded attempt.

## Testing

- `standard` produces byte-identical behaviour to the current pipeline, asserted on gate verdicts and
  ordering — the migration guarantee.
- The implementer's allowlist contains no `Bash`, asserted on the argv actually passed.
- The worker commits after the implementation step and the tree is clean without the agent having
  committed.
- `autoMerge` is refused for `quick` even when the server sends `{autoMerge: true, reviewGate: true}`
  — the worker's own inspection wins over the derived field.
- `protected-paths` refusal does not push, asserted by the delivery double never being called.
- Clean-tree runs after gates too, with a fixture where a gate leaves a tracked file modified.
- Unknown slug refuses before the executor is invoked.
- Run ceiling: a run that exceeds it requeues; a project cannot save a ceiling above the lease.

Worker tests live in `worker/src/*.test.ts` under vitest. They are **not** type-checked today
(BP-334); until that lands, a type error in a new test file will not be caught by anything.

## Deferred to a later slice

Composition — user-assembled sequences of multiple steps — is deferred, and the reviews named its
prerequisites. If it is ever built, it needs: resume across usage limits, so hitting the ceiling at
step five does not discard five committed steps; versioned recipes snapshotted onto the run record,
so a report's positions still mean something after an edit; a typed projection rather than a
free-text summary as the inter-step channel, so injected text cannot be replayed into a
higher-privileged step; and a working-tree assertion that no agent-instruction file exists between
entries, closing the `CLAUDE.md` window.

The intent is that `careful` and `quick` earn their keep first. After a month of runs there will be
evidence about which recipe gets reached for and what it was missing — which is the argument for
composition, or against it.

Also deferred: per-task recipe override, user-authored recipes, project veto (BP-332, now moot while
recipes are immutable and seeded), and parallel runs on one machine.
