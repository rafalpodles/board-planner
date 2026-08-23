# Accepting a refused change

Design, 2026-08-23. Tracked as BP-381. Builds directly on BP-380 (`e855703`) and the refusal that
carries its own patch (`1f4dcac`), neither of which is on `main` at the time of writing.

## The problem

The protected-paths gate says a human has to review the change, and then makes reviewing as hard as
it can. `pipeline.ts` withholds the push for exactly this gate — on purpose, because what the
branch carries is what the gate refused — so the work exists only as a commit in a worktree on
whichever machine claimed the task. Twice in one afternoon (MP-75, MP-71) good work went to sit on
a laptop.

Two thirds of the answer already exist. BP-380 tells the agent the rule up front, so a task whose
whole subject is a protected file ends in a minute with a written proposal instead of a spent run.
The refused patch now travels into the task comment, so the change can be *read* on the board.

What is missing is the reply. Reading it leaves the operator holding a diff and no way to say yes.
This is that button: **accept what you have read, and the machine that wrote it pushes the branch
and opens a pull request.** Not a merge — the pull request is still reviewed. The gate demanded a
human; the button is that human, exercised where the task is rather than over a shell on the
machine that happens to hold the worktree.

## What accepting actually consents to

The task's premise was that pushing a Dockerfile or a `package.json` means "put it where I can read
it in a pull request", and that nothing executes until somebody merges. **That is not true of this
repository, and the design says so out loud rather than working around it.**

`.github/workflows/ci.yml` is triggered `on: push` with no branch filter. A pushed branch runs in
Actions immediately, from that branch, with the repository's token: `npm ci`, `npm run build`, the
suite. So accepting a change to `package.json`, `next.config.ts` or anything under `scripts/`
executes that change in CI before any pull request is read. Withholding the pull request would not
help; the push alone is the trigger.

The decision (rpo, 2026-08-23) is to keep the button and make the label honest. The person clicking
has the diff in front of them — it is in the task comment — and the panel states plainly that the
push will run this repository's CI on this change. The gate's demand was human judgement, and this
is human judgement being exercised with the relevant fact in view.

**Workflow files stay excluded anyway.** Not because nothing else executes, but because a workflow
diff is the hardest thing on this list to read for safety, and because "run this now with my keys"
and "push this so CI builds it" are different enough sentences that one button should not mean
both. That family keeps the boring path: a person applies it by hand.

## The record

A `decision` subdocument on `Task`, not a collection of its own: it has to be readable exactly
where the task is read and has to die exactly when the task does.

```
decision: {
  gate, files[], commit, branch, workerId, worktreePath,
  acceptable, unacceptableReason,
  state: "pending" | "accepted" | "declined"
       | "delivered" | "refused" | "discarded" | "superseded",
  decidedBy, decidedAt, prUrl, error, createdAt
}
```

The first three states are live, the last four terminal. `pending` is what the refusal writes;
`accepted` and `declined` are what a person writes; `delivered`, `refused` and `discarded` are what
the machine writes back once it has acted, and `superseded` is what a second claim writes. Only the
live states are ever handed to a machine, which is what stops `settleDecisions` from cleaning up
the same declined worktree on every pass of the loop.

The **worker** writes it, on the machine credential, from the same branch of `pipeline.ts` that
already decides `withholdsPush` (`entry.gateKind === "protected-paths"`). That single condition is
what keeps this feature from leaking into any other gate's rejection.

`commit` is a fresh `git rev-parse HEAD` in the worktree, taken beside `collectDiff`. It is not
folded into `DiffStats`, which every gate shares — one gate's need is not a reason to change what
all of them are handed.

The sha is well defined at that moment, and this is worth stating because the whole "you accept
exactly what you read" guarantee rests on it: `collectDiff` diffs `baseBranch...HEAD`, which sees
only committed work, and `steps.ts` commits after every step with `capability: "edit"`. A gate that
fires therefore has a commit to name. `pipeline.ts` also refuses to continue past an edit step that
left the tree dirty, so at refusal time HEAD is exactly what the patch in the comment showed.

The record is written **before** the report. If the write fails the run reports as it does today —
comment with patch, no button — which is a degradation to BP-380's behaviour, not a break.

`execution.workerId` survives the move to review (`RUN_FIELDS` clears `runId` and the phase trio,
not the machine), but the decision keeps its **own** `workerId`: the one on `execution` would be
overwritten by the next run of any machine on that task.

## The screen

A new `PendingDecision` component in `src/components/tasks/`, rendered by `TaskDetail` beside
`ExecutionPanel` rather than inside it — `ExecutionPanel` describes a live run and returns `null`
without a phase, and by this point there is no run.

It shows the gate, the files, the short sha, the branch and the machine, and the sentence about CI
above. Two buttons. When `acceptable` is false there is no Accept button at all — only Decline, and
the reason that family is different.

## Two writers, two routes

The record has two authors and they must not share a door.

`POST /api/projects/:projectId/tasks/:taskId/decision` is the **machine's**: it creates the record
at refusal time and reports the settlement afterwards (`delivered` with a url, `refused` with what
the worktree holds instead, `discarded` once a declined worktree is gone). It takes the worker
credential, it may only address a task its own run touched, and it can never set a verdict.

`PATCH` on the same path is the **person's**, and carries the verdict alone.

## The verdict

`PATCH /api/projects/:projectId/tasks/:taskId/decision`, body `{ verdict: "accept" | "decline" }`.

- `withProjectAccess`: reaching the project is the bar, as the checklist says.
- `user.viaMachineCredential` → 403, the rule the project picker already follows
  (`src/app/api/workers/[workerId]/projects/route.ts`). An unattended agent must not clear a
  security gate.
- 409 when the state is not `pending`, and when `verdict === "accept"` on a record with
  `acceptable: false`.
- `logInstanceAudit` with a new action naming who accepted what and which files. This is a security
  gate being let through; it belongs in the instance log next to `worker_command_sent`.

## How the machine hears

`refreshServerState()` (`worker/src/wiring.ts:349`) already fetches `GET /api/workers/:workerId`
and reads `policy`, `assignments`, `offers` and `catalogue`. It gains `decisions`: the tasks whose
`decision.workerId` is this machine and whose state is `accepted` or `declined`. One more field on
a call that already happens, rather than a second endpoint and a second round trip per poll.

That query needs an index on `decision.workerId`, for the reason `execution.workerId` already has
one: this call happens on every drain of every machine, and unindexed it scans the task collection
each time.

The command channel was considered and rejected: `worker.command` is a single-valued kill switch
(`pause`/`resume`/`stop`), not a queue, and turning it into one to carry something that is not a
command is the wrong shape.

`refreshServerState()` is called from `drain()` (`wiring.ts:497`), and `drain()` runs on every pass
of the loop **including while the worker is paused** — exactly as the outbox flush does. That is
the right precedent: pause stops a machine taking new work, it has never stopped it finishing work
it already has.

## What the machine does

A new `settleDecisions()` in the worker, called from `drain()`:

**Accepted.** Resolve the worktree as `<worktreeRoot>/<taskKey>` — the server never sends a path,
the same rule every other assignment follows. Then, before anything is pushed:

- `git rev-parse HEAD` must equal the accepted `commit`;
- `git status --porcelain` must be empty.

Either check failing means the tree is no longer what was read. The push is refused, the state
becomes `refused`, and a comment on the task says what is in the worktree now. Passing both, the
push and the pull request go through the **same** `createDelivery` the run uses — hardened git
config, pinned GitHub account (BP-373) — because a second way to push is a second way to get it
wrong. Then `delivered` with the url, a comment naming who accepted, and the worktree removed.

**Declined.** The worktree is removed and the task says so, rather than leaving it to be found
months later.

## Keeping the worktree alive until the decision

Three things can take it away, and each needs a different answer.

**`reapOrphans`** (`worker/src/workspace.ts:17`) removes everything under the worktree root, once
per project per process. A marker file at `<stateDir>/decisions/<projectId>/<taskKey>.json`
carrying the sha and the path is written with the record; the reaper skips what it names. Local
rather than server-side on purpose: the reaper runs during binding, before the machine has
necessarily heard anything back.

**The lease** does not reach it. `releaseExpiredTasks` matches only columns with role `active`
(`src/lib/task-service.ts:1071`) and the task is in review. This is a fact to pin down with a test,
not a thing to fix.

**A second claim of the same task** does reach it: somebody drags the card back to the approved
column, a run claims it, and `workspace.create`'s `git worktree add -B` resets the branch over the
accepted commit. The claim is not refused — instead the claim path in `src/lib/task-service.ts`
marks any live decision on that task `superseded` in the same update that hands the task out, and
the worker drops the marker when it next sees the task claimed. The button disappears before it can
lie. An acceptance clicked in the same second
still cannot do damage: the sha check is what catches it.

## Out of scope, deliberately

- No other gate's rejection gains a button. `protected-paths` is named explicitly, once.
- Nothing about a passing run changes.
- Accepting never merges. The pull request is reviewed like any other.
- Workflow files are never acceptable through this path.

## Testing

- **Worker** — a protected-paths refusal records a decision carrying the HEAD sha; a refusal
  touching a workflow file records `acceptable: false`; `settleDecisions` pushes on a matching sha,
  refuses on a moved HEAD and on a dirty tree; a declined decision removes the worktree;
  `reapOrphans` skips a marked worktree; delivery goes through the same hardened path as a run.
- **Server** — the verdict endpoint refuses a machine credential, refuses accepting an unacceptable
  record, refuses a non-pending record, writes the audit row; a re-claim supersedes a pending
  decision; the lease leaves a task in review alone.
- **UI** — the panel renders gate, files, sha and the CI sentence; no Accept button when the record
  is unacceptable; the buttons disappear once a verdict is in.

## Shape of the work

One branch, `bp-381/accept-refused-change`, off `main` once BP-380 has landed there. Two commits:

1. the record, the marker, the reaper exemption and the read-only panel;
2. the verdict endpoint, the audit row, `settleDecisions` and the buttons.

The first is worth having on its own — a task that says a decision is pending, on which commit, and
where — but the button only makes sense with the second.
