# Accepting a refused change

Design, 2026-08-23. Tracked as BP-381. Rewritten after an independent review of the first draft
found that its central guarantee did not hold.

Both prerequisites have since landed on `main`:

- **BP-380** and the refusal that carries its own patch, merged as `32c83fd`.
- **BP-382**, which stops the gates reading a diff the agent can rewrite, merged as `4f1657b`. It
  was a prerequisite rather than a neighbour: everything below rests on "the commit named in the
  record is the change that was judged", and before BP-382 that sentence was false.

## The problem

The protected-paths gate says a human has to review the change, and then makes reviewing as hard as
it can. `pipeline.ts` withholds the push for exactly this gate — on purpose, because what the
branch carries is what the gate refused — so the work exists only as a commit in a worktree on
whichever machine claimed the task. Twice in one afternoon (MP-75, MP-71) good work went to sit on
a laptop.

Two thirds of the answer already exist. BP-380 tells the agent the rule up front. The refused patch
now travels into the task comment, so the change can be *read* on the board.

What is missing is the reply: **accept what you have read, and the machine that wrote it pushes the
branch and opens a pull request.** Not a merge — the pull request is still reviewed.

## What accepting actually consents to

The first draft claimed that for a Dockerfile or a `package.json`, accepting means "push it so I can
read it in a pull request", and that nothing executes until somebody merges. That is false here.

`.github/workflows/ci.yml` is `on: push` with no branch filter, and runs `npm ci` **without**
`--ignore-scripts` in four jobs, plus `npx tsc --noEmit`, which loads `next.config.ts`. So
`package.json`, the lockfile, `.npmrc`, every bundler and test-runner config, and anything under
`scripts/` is code execution on the runner the moment the branch is pushed. Withholding the pull
request would not help; the push alone is the trigger.

The decision (rpo, 2026-08-23) is to keep the button and make the label honest. The panel states
that the push will run this repository's CI on this change, and the person clicking has the whole
diff in front of them — see the next section, which is what makes that sentence mean anything.

**Workflow files stay excluded, for a smaller reason than the first draft gave.** They are not the
line between "executes" and "does not"; almost everything on the protected list executes. What
excluding them buys is that the agent cannot change *what CI does* — for a `push` event GitHub runs
the workflow from the pushed ref — and a workflow diff is the hardest thing on the list to read for
safety. That is worth keeping. It is not a safety boundary, and the spec no longer pretends it is.

## What the person must actually have read

The gate's demand is that a human read the change. Three things stood between the reader and the
change, and each is closed here.

**The comment is not the reading surface.** `safePatch` scrubs and truncates the board comment at
12 000 characters (`worker/src/reporter.ts:10`), and `DEFAULT_COMPOSITION` runs `protected-paths`
*before* `diff-size` (`src/lib/agent-seed.ts:71`), so a refused change larger than that is ordinary,
not exotic. The comment stays as it is — it belongs to the activity feed. The **decision record
carries the patch** as `collectDiff` bounded it (200 000 characters), and the panel renders that,
scrolling, as the thing being accepted.

**Accept is refused when even that was cut.** `DiffStats.truncated` already exists and the first
draft never consulted it. A change too large to show is a change nobody can honestly accept: the
panel says so and offers only Decline.

**The file list is the whole change, not the gate's hits.** `protectedPaths(changedFiles)` is the
subset that tripped the gate; accepting pushes the commit, all of it. The panel shows
`changedFiles`, with the gate's hits marked.

**`.gitattributes` and `.gitmodules` become protected paths.** Two regexes. Without them an agent
adds `package.json -diff`, the gate still fires on the path, and the patch the human reads is
`Binary files a/package.json and b/package.json differ` — a lie that costs nothing to tell. The
settle-time re-diff below also runs `--no-textconv`.

**The rule, in code, not only in prose.** `isWorkflowPath()` sits beside `isProtectedPath()` in
`worker/src/gates/protected-paths.ts` and matches `.github/workflows/**` and
`.github/actions/**/action.y?ml` — the second because a local composite action is executed by a
workflow and is matched by none of the three existing regexes today. A refusal whose hits include
one of those is recorded `acceptable: false`. `protected-paths.test.ts` holds the predicate and the
brief together, the way it already holds the brief and the patterns together.

## The record

A `decision` subdocument on `Task` — readable exactly where the task is read, dying exactly when the
task does.

```
decision: {
  gate, files[], protectedFiles[], patch, patchTruncated, patchSha256,
  commit, workerId, taskKey,
  title,                       // for the pull request; no ClaimedTask exists at settlement
  acceptable, unacceptableReason,
  state, decidedBy, decidedAt, prUrl, error, attempts, createdAt
}
```

`branch` is **not** stored. The first draft kept it and would have handed a server-supplied string
to `git push`; `main` in that field is a force-push to the default branch. The worker recomputes it
as `runTask` does, from the task key.

`worktreePath` is not stored either — the first draft stored it *and* said the server never sends a
path. The worker resolves its own, the rule every assignment already follows.

States:

```
pending → accepted | declined | abandoned      (live)
accepted → delivered | refused | failed        (terminal)
declined → discarded                           (terminal)
any live → superseded                          (terminal)
```

`refused` means the tree no longer matches what was accepted. `failed` means the push or the pull
request would not go through for some other reason, after bounded retries, with the error recorded.
Neither is a dead end: a `refused` or `failed` record can be accepted again, which is what makes a
transient network failure recoverable without a human reading the diff a second time.

The record is written by the worker at refusal time, from the one branch of `pipeline.ts` that
already decides `withholdsPush` (`entry.gateKind === "protected-paths"`) — the single condition that
keeps this out of every other gate's rejection.

**Written before the report, and that ordering is load-bearing** — it is what proves the machine
was entitled to write it. See *Two writers, two routes*. If the write fails, the run reports as it
does today: comment with patch, no button.

## Two writers, two routes

The machine writes through `POST /api/workers/:workerId/decisions`, under **`withWorker`** — beside
the route it already reads decisions from, and deliberately not on a `/api/projects/...` path. On a
project path a worker needs `withProjectAccessOrWorker`, which falls through to `withProjectAccess`
whenever no `x-worker-id` header is present (`src/lib/middleware.ts:239`): under it any project
member could create a record with `acceptable: true` and then accept it, and the split would have
bought nothing.

`withWorker` says which machine is calling, not what it may touch, so the route checks entitlement
itself:

- **creating** a record requires the machine to hold a live run on that task —
  `execution.runId` set and `execution.workerId` its own. This is why the record must be written
  before `reporter.gateRejected` moves the task out of the active column and clears `runId`. The
  ordering is not a nicety; it is the entitlement.
- **settling** one requires `decision.workerId` to be its own.

The record is immutable after creation. The settlement write may set only
`state ∈ {delivered, refused, failed, discarded}`, `prUrl`, `error`, `attempts` — never `files`,
`patch`, `commit` or `acceptable`. Otherwise a machine could rewrite what a person had already
accepted.

The machine is matched on `decision.workerId`, never `execution.workerId`, which the next run of any
machine overwrites.

`decision` must stay outside `updateTask`'s field whitelist (`src/lib/task-service.ts:572`). It is
today, which is why MCP `update_task`, the edit form and the PM agent cannot reach it. This spec
requires it rather than leaving it to chance.

## Who may accept

The machine's **owner**, or an instance admin. Interactive session only —
`user.viaMachineCredential` → 403, the rule the project picker follows.

Project membership was the first draft's bar and it is below the one this repo already sets:
*pausing* a machine is `withAdmin` + interactive + audited. Accepting is heavier than pausing. It
executes a hostile agent's code in Actions, pushed under the machine owner's pinned GitHub identity
(BP-373) — so a board member with no repository access would be borrowing a credential they do not
hold, with `decidedBy` as the only trace.

Both verdicts are written to the instance audit, naming who and which files. The first draft audited
only Accept; a decline destroys work and deserves the same row, and so does abandonment.
`InstanceAuditAction` (`src/types/index.ts`) is a closed literal union and has to gain the three
names — a detail worth stating because a missing member is a type error at the call site, not a
silently absent row.

The transition is **one conditional `findOneAndUpdate`** filtered on `state: "pending"` and, for
accept, `acceptable: true`. No match is the 409. "Check the state, then write" lets a simultaneous
Accept and Decline both through.

## How the machine hears

`refreshServerState()` (`worker/src/wiring.ts:349`) already fetches `GET /api/workers/:workerId` and
reads `policy`, `assignments`, `offers` and `catalogue`. It gains `decisions`: for each task whose
`decision.workerId` is this machine and whose state is live —
`{ projectId, taskId, taskKey, commit, title, state }`. Needs an index on `decision.workerId`, for
the reason `execution.workerId` already has one.

`pending` records are included even though there is nothing to do with them yet. That is what lets
the worker drop a marker for a decision that ended some other way — deleted task, superseded by
another machine — instead of protecting its worktree from the reaper for ever.

The list is filtered by the same reach check `assignmentsFor` and `offersFor` apply on that route. A
revoked grant, or a project whose worker support was switched off, stops the delivery rather than
letting it proceed on a stale record.

Two honest limits, neither of which the first draft named:

- **Pickup is floored at 30 seconds.** `refreshServerState` opens with
  `MIN_REFRESH_INTERVAL_MS = 30_000`, so "on its next poll" means that, whatever `pollIntervalMs`
  says.
- **A locked or disabled machine never hears anything.** That route 403s with `abort: true` when
  `!enabled || lockedByInstance`. See *When nobody comes back*.

It is drained from `drain()` (`wiring.ts:497`), which runs on every pass of the loop **including
while the worker is paused** — as the outbox flush does. Pause stops a machine taking new work; it
has never stopped it finishing work it already holds.

## What the machine does

**Accepted.** Resolve the worktree, recompute the branch, then:

- `git rev-parse --verify refs/heads/<branch>` must equal the accepted `commit`. Not
  `rev-parse HEAD`: `git push … -- <branch>` resolves the branch in the shared ref store, so a
  detached worktree HEAD can match everything the run checked while a different tree goes to the
  remote.
- Re-derive the patch over the same range with `--no-textconv` and compare `patchSha256`.

Then push the commit explicitly — `git push origin <commit>:refs/heads/<branch>` — through the same
`createDelivery` a run uses (hardened git config, pinned account). A second way to push is a second
way to get it wrong.

**There is no clean-tree precondition.** The first draft required `git status --porcelain` to be
empty, inheriting a false positive the pipeline deliberately avoids (`worker/src/pipeline.ts:401`):
a `build` gate runs `npm ci` and leaves artifacts the target repo may not ignore. Pushing a named
commit rather than a tree makes the working tree's state irrelevant.

`openPr` is fed from the record — the run's `ClaimedTask` and summary are gone and must not be
pretended into existence. The body is a fixed sentence naming the gate, who accepted, and the sha.

**Declined.** Remove the worktree, report `discarded`, say so on the task.

**Settlement is an outbox op.** `OutboxOp` is a closed union and the first draft's report was not in
it: push succeeds, report fails, state stays `accepted`, and the next poll pushes again. It gains a
kind. A delivery failure that is not the sha check is retried against `attempts` and then lands in
`failed`.

## Keeping the worktree alive until the decision

**The reaper.** The marker moves to `<stateDir>/decisions/<taskKey>.json`, keyed by worktree root
rather than by project: `worktreeRoot` is per *repository*
(`dirname(repoPath)/cp-worktrees/<workerId>`), so two projects bound to one checkout share a root,
and a per-project marker directory meant reaping for project A would destroy project B's held
worktree. `reapOrphans` takes the marker reader as a dependency. `mkdir 0o700`, `writeFile 0o600` —
the state-dir discipline `worker.json` and `repos.json` already enforce. A marker that cannot be
written aborts the decision record: a button over a reapable worktree is worse than no button.

**The lease.** `releaseExpiredTasks` matches only columns with role `active`
(`src/lib/task-service.ts:1072`) and the task is in review — but that is conditional, not absolute.
`resolveStatusIds` (`worker/src/pipeline.ts:63`) checks only that the review id is *among* the
project's column ids, never that its role is `review`, and `statusIdsFrom` falls back to the literal
`"in_review"`. A project whose `in_review` column carries role `active` routes the rejection into an
active column, where the lease reclaims it and `-B` resets the branch over the accepted commit. So
`resolveStatusIds` gains a role check, and the test asserts the routing, not just the lease.

**A second claim.** Somebody drags the card back to the approved column and a run resets the branch.
The claim is not refused; `claimNextTask` marks any live decision `superseded` in the same update
that hands the task out. Note the PM agent can cause this: `decision` is outside its reach, but
`change_status` is not withheld outside board reviews, so an autonomous agent can destroy a pending
decision. Denial, not escalation, and named here because "the PM agent is deliberately given no way
to force" is a precedent this brushes against.

## When nobody comes back

The first draft had no answer, and every route to "found months later" came back through it. A
machine that is re-imaged, deregistered, disabled or locked never hears the verdict; the record sits
live for ever and the marker protects a worktree nothing will ever settle.

So: the panel renders the machine's liveness from `lastSeenAt` (`WORKER_STALE_MS` exists), and a
person may **abandon** any live decision — `abandoned`, audited like the other verdicts. Abandoning
is what makes every stranded case recoverable, including the ones nobody anticipated.

## What the board shows

`PendingDecision` renders every state, not only `pending`. Between Accept and delivery it names the
machine it is waiting on; after delivery it shows the pull request; after a refusal it shows what
the worktree holds instead. `ExecutionPanel` is untouched and does not collide with it: without a
`runId`, `toApiExecution` withholds the execution subdocument entirely
(`src/lib/task-service.ts:1426`), so nothing run-shaped renders beside this.

## Out of scope, deliberately

- No other gate's rejection gains a button.
- Nothing about a passing run changes.
- Accepting never merges.
- Workflow files are never acceptable through this path.
- The run record stays `gateRejected` and the attempt is not refunded. A delivery writes no
  `RunRecord`. Stated so it does not get "fixed" later by mutating a settled run.
- Confining the agent to its worktree is tracked as BP-349 and is not answered here.

## Testing

- **Worker** — the refusal records the patch, its hash, the truncation flag and the HEAD sha; a
  workflow file makes it unacceptable; settlement pushes on a matching branch ref, refuses on a
  moved ref, refuses on a patch whose hash changed, and is unaffected by an unclean working tree;
  the push names a sha, not a branch; a declined decision removes the worktree; `reapOrphans` skips
  a marked worktree and drops a marker the server no longer lists; the settlement survives a
  failed report through the outbox.
- **Server** — the machine route refuses a person; the person route refuses a machine credential
  and a non-owner; accepting an unacceptable or truncated record 409s; simultaneous accept and
  decline resolve to one; both verdicts and abandonment write audit rows; a re-claim supersedes; a
  revoked grant stops the delivery; `resolveStatusIds` refuses a review id whose role is not
  `review`.
- **UI** — the panel shows the full changed-file list with gate hits marked, the patch, and the CI
  sentence; no Accept when unacceptable or truncated; every state renders; a stale machine is
  shown as stale.

## Shape of the work

Off `main`, now that BP-380 and BP-382 are there. Two commits:

1. the record, the marker, the reaper exemption, the `resolveStatusIds` role check, the two new
   protected paths, and the read-only panel;
2. the verdict routes, the audit rows, the abandon path, `settleDecisions` and the buttons.

The first is worth having alone — a task that says a decision is pending, on which commit, showing
the change. The button only makes sense with the second.
