# The gate reads a diff the agent can rewrite

Design, 2026-08-23. Tracked as BP-382. Found while reviewing BP-381; independent of it.

## The problem

Every gate judges `DiffStats`, and `collectDiff` computes it as `${baseBranch}...HEAD`
(`worker/src/diff.ts:70`) — where `baseBranch` is a **ref name**, resolved to a local
`refs/heads/main` in the clone the worktree is linked to.

The agent runs with `--permission-mode bypassPermissions` and `--tools "Read Edit Write Grep Glob"`
(`worker/src/executor.ts:215`). `cwd` is the worktree, but nothing confines it there — no
`--add-dir`, no sandbox — and `Write` takes absolute paths. A linked worktree's `.git` is a file
naming the common directory, so the ref store is reachable with Read and Write alone.

**So the diff every gate reads is computed against something the subject of the measurement can
rewrite.** This was proved, not argued (see *Proof* below): one file write into `refs/heads/main`
takes `protected-paths` from REFUSES to PASSES on a `package.json` carrying a `postinstall`, while
the payload stays in the branch and reaches the remote. `diff-size` measures the emptied diff too,
and `review` reads the emptied patch.

Two neighbouring facts, both reachable without an attacker:

- Nothing under `worker/src/` ever runs `git fetch`, and `workspace.create` calls
  `git worktree add -B <branch> <path>` with no commit-ish (`worker/src/workspace.ts:80`), so the
  branch is based on whatever the parent clone's HEAD happens to be. The diff range is already only
  as trustworthy as the last thing an operator did in that checkout.
- `delivery.push` pushes `-- <branch>`, which git resolves in the **shared ref store** rather than
  from the worktree's HEAD. Anything that checks `git rev-parse HEAD` before pushing is not
  checking what gets sent.

## What this changes

The principle is one sentence: **nothing the worker checks may name a git ref.**

### The base becomes a sha, captured before the agent runs

`workspace.create` resolves the base branch to a commit sha in the parent clone, creates the
worktree **at that sha**, and returns it alongside the path. The sha lives in the worker process
for the rest of the run. `collectDiff` takes it instead of a branch name.

Held in memory rather than written anywhere: a sha stored in the repository is a sha the agent can
edit, which is the whole bug repeating one level down.

### The diff compares two trees, not two ranges

`git diff <baseSha> HEAD` rather than `git diff <base>...HEAD`. Three-dot was there so a base branch
moving concurrently could not pollute the diff; a captured sha does not move, and a direct tree
comparison cannot be narrowed by any history the agent constructs. A rewritten merge-base is exactly
the trick the range form fell for.

### A run verifies its own commits before delivering

`commitAll` is the only thing in the worker that commits, so the run knows every sha it created.
Before the first delivery step, `git rev-list <baseSha>..HEAD` must be exactly those shas, newest
first, and `HEAD` must be the last of them. Anything else — a rewritten HEAD, a grafted commit, an
unreadable range — refuses the delivery rather than shipping a tree nothing judged.

### Delivery names the commit

`git push origin <commit>:refs/heads/<branch>` instead of `-- <branch>`. Measured: `--force-with-lease`
with an explicit refspec works both when the branch is new on the remote and when it is being
updated, so the existing flags are kept as they are.

### Fetching the base is a separate, droppable step

Resolving the base to a sha closes the hole whether or not the sha is fresh. Fetching first fixes a
different complaint — a stale parent clone — and needs credentials the workspace module does not
have today, since nothing in the worker has ever talked to a remote outside `delivery.ts`. It is
last in the plan, and a fetch that fails falls back to the local ref with a warning rather than
stopping the run: freshness degrades, the security property does not.

### Deliberately not in scope

Confining the agent to its worktree. `Write` reaching the ref store is what makes this exploitable,
and a sandbox would close a family of holes rather than this one — but it is a larger question about
how the CLI is invoked, and not trusting the ref store is the cheaper half that closes this on its
own.

## Proof

Run 2026-08-23 in a throwaway repository, measured with the worker's own compiled `collectDiff` and
`protectedPathsGate` rather than a re-implementation.

```
CONTROL — no ref rewritten
  changedFiles : ["README.md","package.json"]
  gate verdict : REFUSES

ATTACK — refs/heads/main advanced by a single file write
  changedFiles : ["README.md"]
  gate verdict : PASSES

FIXED — same tampered repository, collectDiff handed the captured base sha
  changedFiles : ["README.md","package.json"]
  gate verdict : REFUSES
```

And separately, for the push:

```
accepted commit                             : e6ffd1e…
git rev-parse HEAD                          : e6ffd1e…   ("matches, push it")
refs/heads/bp-2/worker (what push resolves) : 832dc21…
remote received                             : the payload
```

## Testing

The two attacks above become integration tests against real git repositories, in the style of
`delivery.hooks.integration.test.ts` — a mocked runner could only show that the flags were spelled
correctly. Each is checked for vacuity by reverting the fix and confirming it goes red.
