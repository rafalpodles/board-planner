# Agent catalog: composable steps and gates for worker runs

Date: 2026-08-13
Task: BP-331
Follow-up: BP-332 (project veto over risky agents)
State of the code this was designed against: `main @ ce71a83`, plus `9b350a9` on `bp-315`

## The problem

A worker run today is one opaque prompt with a fixed inspection afterwards.

`worker/src/executor.ts` makes exactly one `claude -p` call. Everything about *how* the task gets
done lives in six sentences of `--append-system-prompt` and one hardcoded `--allowedTools` string.
Whether the agent reads the codebase before writing, whether it runs the tests before committing,
whether it plans at all — none of that is directed or observable. The worker sees the tool-use
stream and does nothing with it; there is no point at which it can say "you skipped a step".

After that call, `worker/src/pipeline.ts` runs six gates from a hardcoded array and delivers. The
gates are the only part of a run that exists as separate, named, composable units.

Two consequences motivate this work:

1. **One session writes and self-assesses.** The review gate already exists because a second model
   reading a diff with no memory of writing it catches more. That argument is not specific to
   review — it applies to writing tests, to security review, to anything downstream of the change.
   Today only review gets it.
2. **Every task gets the same treatment.** Work policy sits on the project: one model, one diff
   limit, one gate list for a copy typo and for an auth refactor alike.

## Domain model

**Agent** — a named, described definition of *how* a task is to be done. Not a project setting: a
thing chosen for a task.

**Bucket** — a fixed triple in fixed order: `analysis` → `implementation` → `verification`. Three,
always; no fourth, no renaming. A bucket holds **one ordered list in which steps and gates are
interleaved**, so a gate may sit between two steps and stop the run before the next model call is
paid for.

**Step** — one `claude -p` call in a fresh session. Defined by four things: **prompt**, **permission
profile**, **model**, **response schema**. A step mutates the tree and **cannot refuse**; its only
escape is returning `blocked`, exactly as today.

**Gate** — a yes/no verdict about the tree as it stands at that moment. **Cannot change anything.**
Declares which buckets it may occupy, so `test-presence` cannot be dropped into `analysis` where
there is nothing to have tested yet.

The boundary that holds the whole design together:

> **A step may do anything except refuse. A gate may do nothing except refuse.**

This is what keeps a removable gate meaningful. A step cannot wave work through, because it has no
way to pass judgement; it can only write code that the remaining gates still read.

Because gates interleave, the same gate in two positions gives two different answers. That is
intended. Reports name the position, not just the gate: `diff-size refused (verification, #2)`.

## Where the truth lives

A step carries a prompt, a permission profile and a model — that is "what shall execute on someone
else's laptop". The worker's existing boundary is that the server never names a path and never names
a command; the machine resolves its own checkout and owns its own argv. Handing a server the power
to compose an arbitrary tool list would cross exactly that line.

So the split is:

| | Lives where | Editable without a worker release |
|---|---|---|
| Step prompt | Database, instance admin edits it | **yes** |
| Step permission profile | Worker code, keyed by step key | no |
| Step response schema | Worker code | no |
| Step model | Database, optional; falls back to the project policy | **yes** |
| Gate implementation | Worker code | no |
| Gate parameters | Database (in the agent) | **yes** |
| Catalog metadata (name, description, allowed buckets, params schema) | Database | **yes** |
| Agent composition and ordering | Database | **yes** |

`--allowedTools` is deliberately **not a field**. A step key maps, inside the worker, to a
permission profile the worker owns:

- `read-only` → `Read Grep Glob`
- `edit` → `read-only` plus `Edit Write`
- `deliver` → `edit` plus `Bash(git *) Bash(npm *)`

The server cannot raise a step's capability because there is no field in which to express it.
Prompts are speech and may be edited freely; tools are power and stay with the machine.

Honest limit: this containment is worth what the profiles are worth. `deliver` includes
`Bash(npm *)`, and `npm run <anything>` executes whatever `package.json` says, so `deliver` is close
to unbounded. `read-only` is a hard boundary; the writing profiles still rest on the gates and on
review, not on the tool list alone.

## Identity

Steps and gates are separate entities, referenced by a **stable slug**, never by `ObjectId`:
`"implement"`, `"write-tests"`, `"diff-size"`. The worker keys its implementations off something it
knows from its own source; it cannot know a Mongo id, and reseeding a database or standing up a
second instance must not invalidate every agent ever composed. `_id` stays internal to the server.

A worker reports the catalog keys it implements in its heartbeat. An agent referencing a key the
machine does not have is shown in the console as unable to run there — **before** anybody hands it a
task. At run time an unknown key refuses the run with a named reason, the same shape as an
unrecognised repository; it never silently skips the entry.

## Data model

```
Step    { key, name, description, prompt, allowedBuckets[], offersContextToggle, model? }
Gate    { key, name, description, allowedBuckets[], paramsSchema, isDefaultIn[] }

Agent   { name, description,
          scope: "global" | "user" | "project",
          ownerUserId | projectId,
          buckets: {
            analysis:       [ {kind:"step", key, passContext} | {kind:"gate", key, params} ],
            implementation: [ ... ],
            verification:   [ ... ]
          } }
```

Agents live in three scopes: **global** (seeded), **user** (anyone composes their own), **project**
(the project owner composes ones specific to that repository).

A task gains a field naming its agent, and a project gains a **default agent** — without it an
unassigned card under `claimScope: any` has nothing to run with.

Steps and gates themselves are seeded, not user-authored. Composing agents from ready blocks is the
whole surface for an ordinary user in this iteration; an instance admin may edit a seeded step's
prompt, but nobody creates new blocks. Authoring a block means authoring a prompt, and a prompt
paired with a profile the author also chose would make "predefined" guarantee nothing.

## Run flow

```
claim → worktree
  for each bucket: analysis → implementation → verification
     for each entry in order:
        step  → claude -p, fresh session, permission profile, prompt,
                optionally the previous step's summary
              → blocked  ⇒ run ends, card goes to a human
              → clean-tree check (always, not removable)
        gate  → diff recomputed, then verdict
              → refusal ⇒ branch pushed, review column, run ends
clean tree? → push → PR → merge (only when autoMerge and the agent contained review)
```

Four points that differ from today:

**The clean-tree check runs after every step**, not once at the end. Today one call means one check.
With six steps, a step that leaves uncommitted work poisons the next gate's diff — it would judge
something other than what is on disk. It is not a gate and cannot be removed from an agent: without
it nothing below it means anything.

**The diff is recomputed before every gate**, because interleaving changes the tree between them.

**`taskTimeoutMs` stays the budget for the whole run**, shared by every step *and* every gate that
spawns a process, not a per-entry limit — otherwise an agent with six steps runs for three hours
under a setting that says thirty minutes. An entry that exhausts the remainder ends the run as a
timeout. This is the deadline arithmetic `buildGate` already does across install and build, lifted
to the run; it replaces today's `taskTimeoutMs / 3` split in `buildGates`.

**An agent with no steps refuses to start.** Delivering an empty pull request is not a success.

Attempt accounting, the two-hour lease, usage-limit release and requeue-on-failure are unchanged.

## Context between steps

A fresh session is the point, so nothing carries by default. Each step in the builder has a toggle:
**take the previous step's summary**. When on, the worker threads the structured result of step N−1
into step N's prompt.

Only N−1, deliberately. Carrying every prior step's summary, and letting a step declare whether it
*exports* context, are both reasonable and both deferred — N−1 is enough to answer "what did the
step before me do" without the briefing growing to compete with the task itself.

The summary is model-authored and unverified, so it enters the prompt marked as a claim — "the
previous step **states** that it did X" — never as fact. Without that framing a test-writing step
trusts `filesChanged` instead of looking at the tree.

A gate never takes context. Gates read the tree, and `review` in particular exists precisely to have
no memory of the writing; a toggle there would quietly destroy the property it is there for, so the
catalog entry does not offer one.

## Safety properties

**Soft floor.** A new agent starts with the default gates already in its buckets. They can be
removed. Removing one marks the agent **risky** in the UI, and the project audit records who ran
what, when, with which defaults missing. An agent with no gates at all is legal — this was chosen
deliberately, in favour of visibility over prohibition. The project veto that would balance it is
BP-332 and is not in this iteration.

**Nothing merges unreviewed.** `applyPolicy` refuses `autoMerge` when the review gate is off, on the
machine, distrusting the server. That invariant is kept and extended: an agent containing no
`review` gate **in any bucket** never auto-merges, whatever the project policy says. Such an agent
remains perfectly usable — its pull request simply always goes to a human.

**Order is chosen by the composer, and a bad order is a risky order.** The static gates run before
`build` today because `build` runs npm on a tree no gate has read yet — a lifecycle script the agent
just wrote would execute before anything checked whether it was allowed to write it. An explicit
ordered sequence lets someone invert that. Rather than a phase model, this gets the same treatment
as removing a gate: an agent is **risky** when a `build` or `test-run` gate follows a step without a
`protected-paths` gate in between, and the audit records it. Seeded agents ship in the safe order.

**Parameters may only tighten.** Every gate parameter has a baseline in worker code and
configuration moves only towards the stricter side: `diff-size` thresholds downwards,
`protected-paths` adds paths and never replaces the built-in list, `test-presence` widens what
counts as needing a test. A loosening value is clamped by the worker rather than obeyed — the
existing `applyPolicy` posture, which fails safe rather than refusing the work.

## Toolchain

`build` and `test-run` are hardcoded to npm today, and `test-presence` recognises only
`.test.|.spec.` on `[jt]sx?`. A Python project fails at `test-presence` before it ever reaches
`build`, and — worse — `protected-paths` does not cover `pyproject.toml`, `poetry.lock`, `pom.xml`
or `build.gradle`, so a non-JS project is not merely unsupported but unprotected in exactly the file
whose content later gets executed.

**The worker detects the toolchain from the worktree.** The server says nothing about it, so there
is nothing to tighten or loosen. Detection carries the whole recipe: install and build commands,
test command, test-file patterns for `test-presence`, and the protected build-configuration paths.

- Nothing detected → **the run fails** with a named reason. "I do not know how to build this" is not
  the same as "there is nothing to build", and must not read as a green run.
- Several detected → **all of them run and all must pass**. A repository with both `package.json`
  and `pyproject.toml` satisfies npm and pytest. Ambiguity tightens; it never quietly drops a gate.

A named recipe chosen in configuration is the natural extension if a polyglot repository ever needs
to disown one half. Deferred.

## Legacy policy fields

`maxDiffLines`, `maxDiffFiles` and `reviewGate` are the only gate-related values crossing the wire
today. The agent becomes authoritative, and the server **additionally derives** these three from it
and keeps sending them.

A worker that predates this work ignores the agent it does not recognise — `applyPolicy` leaves
unknown fields alone — and reads the derived flat fields, with correct values. A current worker
reads the agent and ignores the flat fields. Removing them is separate cleanup for a day when no old
machine remains. Dropping them now would silently return a project that had tightened to 100 lines
back to the 400 default on any machine that had not yet updated, and nothing would fail to announce
it.

## Errors and exits

| Situation | Outcome |
|---|---|
| Step returns `blocked` | Run ends, card to a human, reason reported |
| Step leaves the tree dirty | Run ends, nothing pushed, worktree kept, path reported |
| Gate refuses | Branch pushed, card to the review column, gate and position named |
| Gate cannot run (usage limit) | Task released, attempt returned not burned |
| Run exceeds the budget | Requeued, attempt burned |
| Unknown step or gate key | Run refused before any model call, key named |
| Agent has no steps | Run refused |
| No toolchain detected | Run fails, named reason |

## Testing

- **Boundary contract**: a gate cannot mutate and a step cannot return a verdict — asserted against
  the catalog, so a new block cannot quietly acquire the wrong shape.
- **Permission profiles**: no path exists from a database record to `--allowedTools`. This is a
  contract test in the spirit of `child-env.contract.test.ts`, which already asserts that no secret
  reaches a child environment.
- **Ordering and interleaving**: a gate between two steps stops the run before the second step is
  invoked — asserted by the executor never being called, not by a report string.
- **Clean-tree after every step**, with a fixture where step 1 leaves work behind and step 2 must
  never run.
- **Budget arithmetic**: steps consume a shared deadline; the last step gets what is left.
- **Derivation**: an agent's `diff-size` parameters produce the legacy flat fields; an older worker
  fed only those behaves identically to a current one fed the agent.
- **Tightening**: a loosening parameter is clamped, and the clamp is reported.
- **Detection**: none found fails; two found runs both.

Tests live beside their subject, `vitest`, matching `worker/src/*.test.ts`. CI runs
`npx tsc --noEmit`, which is the only thing that type-checks test files.

## Deliberately deferred

Each of these was raised, considered and left out to keep the first cut small:

- **Project veto over risky agents** (BP-332) — visibility and audit only, for now.
- **Context from more than one step back**, and a separate "exports context" toggle.
- **User-authored steps** — composing agents from seeded blocks is the whole surface here.
- **Named toolchain recipes** — detection only.
- **A phase model constraining order** — risky-order marking instead.
- **Parallel runs on one machine** — independent of this work; a separate concern with its own
  hazard, namely semantic conflict between pull requests branched from the same base.
