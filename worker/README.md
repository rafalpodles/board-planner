# Board Planner execution worker

Claims approved tasks, runs Claude Code headless in an isolated git worktree, enforces the merge
gates and carries a task through to `done` — with nobody at the keyboard.

The worker talks to the app over REST with a Bearer token and never touches MongoDB directly: the
app runs on Railway while the checkout lives on a laptop behind NAT, and a machine executing
agent-written code has no business holding database credentials.

A single worker process can serve more than one project: it registers once, it is offered whichever
projects its owner can reach and it has a checkout of, and the poll loop claims from each in turn.

User-facing documentation lives on the docs site, under **AI and automation → Execution
workers**: what the gates do, how to enable a project, which tasks get picked up, and how to stop a
machine. This file is the operator's view — what has to be true on the box itself.

## How one task runs

```
claim → worktree → claude -p → clean-tree check → gates → push → PR → merge → done
```

Every step reports to the board, so the task's comments are the run log.

The gates and their order are the **agent's** — the shipped Default agent runs them roughly
cheapest first, and a `protected-paths` gate always stands before anything that executes the
repository's own scripts. The first rejection stops the run:

| Gate | Rejects when |
|---|---|
| `diff-size` | the diff is larger than the limit on the Size gate that rejected it, or the worker's `maxDiffLines`/`maxDiffFiles` where that gate names none |
| `protected-paths` | the change touches files a later step executes or loads as instructions |
| `test-presence` | the change touches code without touching a test |
| `build` | `npm run build` fails |
| `test-run` | the test suite fails |
| `review` | a second Claude, with a clean context, rejects the diff — present because the agent carries a Reviewed gate |

A rejection pushes the branch — unless the run committed nothing, the provenance check refuses the
history, or `protected-paths` is what refused, which withholds the push deliberately — comments which gate said no, and routes the task to the review column. A usage limit returns the task to the queue with its attempt refunded — it is not the
task's failure. A crash or timeout also returns it to the queue, but spends the attempt, so a
repeating failure runs out of retries and lands in front of a human instead of cycling forever.

## Configuration

Bootstrap is everything the worker needs before it can even register — where the server is, how
to authenticate to it once, a name to register under, and where to keep the identity that
registration mints. Nothing else is read from the environment.

| Variable | Required | Default |
|---|---|---|
| `CP_API_URL` | yes | — |
| `CP_ENROLMENT_TOKEN` or `CP_ENROLMENT_TOKEN_FILE` | first start only | — |
| `CP_WORKER_NAME` | yes | — |
| `CP_STATE_DIR` | no | `~/.boardplanner` |

A worker holds **one** credential. An enrolment token is spent by the first registration, and
everything after that — claiming, reporting status, commenting, releasing, and all of
`/api/workers/**` — authenticates with the `cpw_` credential registration returns. See Registration
below.

There is deliberately no second, project-scoped API token. Its scope would be a list fixed when it
was minted, while a worker's grant is recomputed every heartbeat from the checkouts it reports
crossed with every enabled project — so enabling a second project would let the claim succeed on the
worker credential while the report 403'd on the API one, stranding the task until its lease expired.
`CP_API_TOKEN` is still read if present, so an existing plist keeps booting, but nothing uses it.

Claude Code runs on the logged-in CLI session. Never set `ANTHROPIC_API_KEY`, or runs bill per
token instead of drawing on the subscription.

`gh` is the identity every branch and pull request is pushed under, and on a machine with more than
one GitHub account that identity is **global state**: `gh auth switch` is shared with every process
on the box, so a worker left to gh's own resolution pushes as whichever account somebody switched to
last. Name one instead, in `<CP_STATE_DIR>/github.json`:

```json
{ "account": "rafalpodles" }
```

The menubar app writes it — Preferences → Connection, or the picker during onboarding, both offered
only where gh holds more than one account. The worker resolves that login's token by name
(`gh auth token --user`) at the start of each task and carries it on its own delivery calls, so a
switch in another terminal cannot change who a run in flight pushes as. The file holds a login, not
a secret; the token is never written to disk. With nothing pinned the behaviour is what it always
was — whatever gh has active — and preflight then says so, rather than reporting a bare
`authenticated`. That silence was BP-373: the check was green for an account with no write access,
and the truth arrived from GitHub as a 403 half an hour into the run.

Everything that used to be an environment variable beyond the four above — base branch, poll
interval, task timeout, diff caps, model — is now worker policy, set by an instance or project
admin in `/settings/workers`, not by whoever starts the process:

| Policy field | Default |
|---|---|
| `baseBranch` | `main` |
| `pollIntervalMs` | `30000` |
| `taskTimeoutMs` | `1800000` |
| `maxDiffLines` | `400` |
| `maxDiffFiles` | `10` |
| `model` | `opus` |

A policy change takes effect on the worker's own refresh cycle, without a restart.

## Registration

A worker has no identity until somebody enrols it — from the machine itself, confirmed in a browser,
or with an enrolment token. Whoever does that owns it, and no admin approval stands in between
(BP-358). Until then it polls but claims nothing: `/tasks/claim` and the rest of `/api/workers/**`
refuse any request without a credential the server itself issued.

On first run the worker registers itself with its enrolment token and persists the response — a
`workerId` and a `cpw_`-prefixed credential — to `<CP_STATE_DIR>/worker.json`, mode `0600`. Every
later run reuses that file; the worker registers again only if the file is missing or the server
rejects its stored credential with 401. A run that reuses a stored identity, rather than
registering fresh, reads its current policy and assignments back from `GET /api/workers/:id`.

Registration settles which projects are offered, but not a filesystem. The repository behind each
offered project must still be approved on this machine, by listing its checkout in
`<CP_STATE_DIR>/repos.json`. A worker with no entry for a project leaves that one unbound and idle,
with the reason visible as `bindingError` in `/settings/workers` — its other assignments keep
working normally.

## Running

```bash
npm install && npm run build && npm start
```

As a macOS service:

The plist ships with `REPO_DIR` and `HOME_DIR` placeholders rather than one developer's
absolute paths, so substitute them as you install it:

```bash
sed -e "s|REPO_DIR|$(cd .. && pwd)|g" -e "s|HOME_DIR|$HOME|g" \
  launchd/com.boardplanner.worker.plist > ~/Library/LaunchAgents/com.boardplanner.worker.plist
launchctl load ~/Library/LaunchAgents/com.boardplanner.worker.plist
```

Put the enrolment token in a file only you can read, and point `CP_ENROLMENT_TOKEN_FILE` at it —
never in the plist, which sits at `0644` and rides along into Time Machine:

```bash
install -m 600 /dev/null ~/.boardplanner/token && pbpaste > ~/.boardplanner/token
```

The worker refuses to read a secret file that is readable by group or others. The inline variable
still works for a container, where there is no file to protect.

The plist carries the paths for this machine — check `ProgramArguments` and `PATH` before loading
it anywhere else. Logs go to `/tmp/boardplanner-worker.log` and
`/tmp/boardplanner-worker.error.log`.

Stop it with `launchctl unload ~/Library/LaunchAgents/com.boardplanner.worker.plist`. `SIGTERM`
and `SIGINT` both finish the task in flight before the loop exits.

## Safety

- **Nothing is claimed that was not offered.** A machine takes only a task its own owner asked to
  have — and only once that task names an agent, which is the hand-over gesture. A task with no
  agent is one a person is doing by hand, and no machine looks at it. A task another *person*
  assigned is never taken: the approval surface for work somebody else hands you is a separate,
  later change.

  Two shapes qualify, and no others:

  - `{ assignee: ownerId, assignedBy: ownerId }` — the owner handed it to themselves.
  - `{ assignee: ownerId, assignedBy: <the PM>, pmAssignedFor: ownerId }` — the PM handed it over,
    on the owner's own instruction. Since BP-419 the PM's assignment is a real hand-over rather
    than a proposal nothing could accept; the second field is what keeps that narrow. The PM chat
    is open to every project member, so without it a member could ask the PM to assign a task they
    wrote to a colleague and have their own text run on that colleague's machine. An unattended PM
    turn records nobody, so nothing it assigns is ever claimed.

  The owner is the account that enrolled this machine, deliberately not the worker's own identity:
  that is an auto-created `worker-<id>` account with kind `machine`, excluded from every list the
  product offers. Keying the predicate on it would have described a hand-over nobody could perform.
- **Nothing starts before its blockers finish.** A task whose `blockedBy` still names an unfinished
  task is passed over, and the claim takes the next one that is free instead. Finished means the
  blocker sits in a column with the `done` role, so a board that renamed its last column is read
  correctly. Nothing is pushed when a blocker finishes: the dependent simply stops being skipped,
  and the next poll — seconds later — picks it up.

  A board with no `done`-role column at all cannot say what finished means, so it cannot say what
  blocked means either; there the gate is skipped rather than freezing every dependent for good
  with nothing on the task to say why.
- **Nothing merges unreviewed.** The review gate is a separate Claude with no memory of writing
  the code, and it sees only the diff.
- **Nothing executes before the static gates have read the diff.** `protected-paths` refuses
  changes to `package.json`, lockfiles, `.npmrc`, hooks and workflows *before* the build gate runs
  npm on the worktree, and installs run with `--ignore-scripts`. Cost ordering alone would have
  executed agent-written lifecycle scripts first.
- **No subprocess inherits the worker's secrets through its environment.** The child environment is
  an allowlist, so the worker's credential reaches neither the agent nor any dependency's install
  script. Only delivery carries what `git` and `gh` need for the remote — and it runs inside the
  worktree the agent just wrote, so running "our own commands" there is not by itself a guarantee.
  Every key git treats as *run this program* — hooks, `credential.helper`, `core.askPass`,
  `core.sshCommand`, `core.pager`, `core.fsmonitor`, `receivepack`, `core.gitProxy` — is overridden
  on those calls, `/etc/gitconfig` and `~/.gitconfig` are taken out of the picture, and the push
  adds `--no-verify`. It travels in `GIT_CONFIG_*` rather than `-c` so it also reaches the `git`
  that `gh` shells out to.

  Two of those keys cannot be won in the config at all, because git keeps the **first** value it is
  given for them rather than the last: `receivepack` is passed on the command line and
  `core.gitProxy` is emptied in the environment. Each was measured losing as an ordinary override
  first. Enumerating this list is not a converging exercise — three passes over the same code each
  found another key — which is why **BP-330**, pushing from a checkout the agent never touched, is
  the fix that ends the question rather than answering it again.

  The transport is fixed on those calls too, because the way in was not always a program named in
  the config: `ext::` hands the URL to one, and a local push runs `git-receive-pack` as delivery's
  own child, so the destination's `post-receive` would hold the credentials. Both are refused.

  What this does **not** claim: the allowlist includes `HOME`, because the CLI authenticates from
  its logged-in session there. An agent that goes looking can read what is under it — the
  environment is the boundary, the filesystem is not.

  **What it costs.** `~/.gitconfig` is not read on those calls, so anything an operator keeps there
  no longer applies to delivery: a deploy key set through `core.sshCommand`, a `url.*.insteadOf`
  rewrite pointing at a mirror, or an https credential helper other than `gh`'s. Delivery
  authenticates over ssh with the agent socket, or over https through `gh auth git-credential`.
  Nothing here touches the agent's own commits, which are made in a different environment that does
  read your config.
- **Nothing the server sends becomes a path or an option.** Everything below arrives over HTTP from
  whichever server this worker is enrolled with, and everything past that boundary runs on somebody's
  laptop at their uid. Two of these were live: a `workerId` of `../../../../Users/rpo/Library/LaunchAgents`
  relocated the worktree root outside the `repos.json` allowlist, and a `baseBranch` of
  `--output=/tmp/pwned` was read by `git diff` as an option rather than a revision — measured on git
  2.50.1, exit 0, file created. Both are fixed; the rest of the table is the sweep that found them
  (BP-327), including the values judged not to need a check.

  | Value | Comes from | Ends up as | What holds it |
  | --- | --- | --- | --- |
  | `workerId` | register response | `<repo parent>/cp-worktrees/<workerId>`, and every API path | a 24-character ObjectId, checked on the wire *and* on the way back off disk; `bindRepository` then refuses a root that has left `cp-worktrees/` |
  | `credential` | register response | an `Authorization` header | never argv, never a path; `fetch` itself refuses a header value carrying a newline |
  | `heartbeatMs` | register response | `setTimeout` | a positive number or the bootstrap retry |
  | `command` | heartbeat, SSE, socket | a handler name | matched against a closed list |
  | `project`, `taskId`, `runId` | assignment, claim | path segments in a URL on this worker's own server | deliberately unchecked: whatever they contain, the request still goes to the server that sent them, and a server addressing itself is not a boundary |
  | `remote` | assignment | compared for equality against `repos.json` | never a path — the checkout is found by lookup, and the server never names a directory |
  | `baseBranch` | project policy | `git ls-remote -- <url> refs/heads/<baseBranch>`, `git fetch --no-tags -- <url> <baseBranch>`, `gh pr create --base` | a git ref name, refused where an admin sets it and again in `applyPolicy`; delivery re-checks it and drops `--base` rather than pass a value that is not one, and the two remote calls keep it behind `--`. It no longer reaches `git diff` at all: since BP-382 the gates diff against the resolved base **sha**, and that sink refuses anything that is not `[0-9a-f]{7,64}` |
  | `model`, `fallbackModel`, `reviewModel` | project policy, a step, a review gate's params | `claude --model` | a model name, at `modelOr` — the one place all three overrides meet |
  | limits and timeouts | policy, gate params | numbers | parsed as numbers; a value that is not one is the default, never zero |
  | `taskKey` | the project's key and the task number | a directory under the worktree root, and a git branch | `^[A-Za-z0-9][A-Za-z0-9_-]*-\d+$`, `pathFor` refuses a path that leaves the root, and `push` refuses a branch that is not a git ref name before building `<commit>:refs/heads/<branch>` out of it — git splits a push refspec at its *last* colon |
  | `capability`, `gateKind` | agent snapshot | a tool list, a gate | closed maps this side, so a server cannot widen what a step may do |
  | `title`, `description`, `prompt`, `focus`, summaries | claim, agent snapshot | prompt text, the PR title and body | option *values*, never positionals, and scrubbed before they reach a pull request. Prompt injection is a different problem and nothing here claims to solve it |

  Every git call also separates its options from its positionals with `--`, and most of them go
  through `gitArgs`, which refuses an argument after that separator beginning with a dash — so a
  call site inherits the rule instead of having to remember it. Two do not. Delivery's `push`
  hardens through the environment rather than through `gitArgs` (so that the hardening also reaches
  the git `gh` shells out to), and calls the same refusal, `refuseOptionShapedPositionals`, itself.
  The base lookup's `git ls-remote` and `git fetch` compose their environment the same way and are
  held by `--` alone: their positional is a remote URL, which is not a shape that refusal can
  describe. `gate-integrity.integration.test.ts` runs a real git against a `--upload-pack=` URL to
  show the separator is what holds there.

  **The menubar app is swept separately**, in [`menubar/README.md`](../menubar/README.md). It had
  the same two shapes — the server's `repositoryUrl` as a bare positional to `git clone`, and the
  destination built from the server's project key — and one this package does not: a transport that
  runs a program can be reached from a well-formed `https://` remote, because the operator's own
  `url.*.insteadOf` rewrites it (BP-399).
- **The executor runs with `bypassPermissions` inside the worktree**, so the worktree is checked
  for uncommitted files before the gates run — an agent cannot hide a change from the gates by
  never staging it.
- **A rejected branch is pushed** before its worktree is discarded, unless the run made no commit
  at all or its history fails the provenance check below; if the push fails the worktree is kept
  and the comment says where it is. The push names the commit (`<sha>:refs/heads/<branch>`) rather
  than the branch, so the shared ref store cannot decide what is sent — which also means the
  pushed branch gets no upstream in that kept worktree, because git ignores `-u` for a refspec
  whose source is an object id.
- **The base a run is judged against comes off the wire, every run.** Before the agent starts, the
  worker asks the project's own remote for `refs/heads/<baseBranch>`, keeps the sha that answer
  carried, fetches the branch, and then requires that exact object to be present locally; the
  worktree is created at it and every gate diffs against it. The local ref is never read, because
  an agent of any earlier run on this checkout can write it and that writing outlives the run — a
  poisoned base would put a payload *underneath* an innocent run's own change, where no gate looks.
  The lookup runs in a fresh directory the worker creates, with `GIT_DIR` set so git skips
  repository discovery entirely: a repository-local `url.<x>.insteadOf` rewrites even a URL given
  literally on the command line, no `GIT_CONFIG_*` variable turns that off, and `$TMPDIR` is not a
  safe place to run it either — the agent is given `TMPDIR` and what it writes there persists.
- **A base that cannot be established releases the task and pauses the worker**, rather than
  falling back to the local ref: a machine that cannot reach the remote is a machine that cannot
  gate anything, and an agent able to break the fetch would otherwise choose which of the two paths
  the next run takes. The failure is charged to the machine, not the task — the attempt is
  refunded, the task returns to its column, and the worker stops claiming for the rest of the pass
  and waits out its poll interval. It says why in three places: the board comment, the worker's own
  stderr, and the run record. `bindingError` is **not** one of them; that field is about repository
  binding and stays empty for this. A worker whose credentials do not cover the transport the
  server recorded for a project will do this on every pass until that is fixed.
- **The worktree is based on `<baseBranch>`, not on whatever the checkout has checked out.** A
  clone parked on a feature branch used to hand the agent that branch while the gates diffed
  against the base; runs on such a checkout now start from the base instead.
- **Worktrees left by a killed worker are reaped**, the first time this process binds each
  project's repository, but only under that project's own derived worktree root (`<repo
  parent>/cp-worktrees/<workerId>`) — the repository checkout and any worktree of your own are
  left alone.
- **A report that cannot be delivered is not lost.** Merging to `main` redeploys the app, so the
  report right after a merge is the one most likely to fail — and a lost one would leave the task
  sitting in the active column where nothing can claim it again. Undelivered reports persist to
  `<CP_STATE_DIR>/outbox.jsonl` and go out before the next task is claimed.
- **A task abandoned by a dead worker comes back.** The claim endpoint frees anything whose lease
  has outlived it, without refunding the attempt, so a task that repeatedly outlives its worker
  runs out of attempts and reaches a human.

## Tests

```bash
npm test
```

Every subprocess call — `claude`, `git`, `gh`, `npm` — sits behind the `Runner` interface, so the
suite runs without spawning a model, touching GitHub or creating a worktree.

`wiring.integration.test.ts` goes one layer further than the rest: the api client, the identity on
disk, the telemetry bus, the heartbeat, the local socket and the abort plumbing are all the real
ones, driven against a stub board served over loopback HTTP. The `Runner` is still the only thing
replaced. Nothing leaves the machine.

## Credentials

Two, and neither of them can lift this worker's kill switch. That is the point: the worker runs the
coding agent at the same uid with `Read` and `bypassPermissions`, so anything on this disk is
readable by the agent, and an unscoped instance-admin token there would let it clear
`lockedByInstance` on itself.

**`CP_ENROLMENT_TOKEN` / `CP_ENROLMENT_TOKEN_FILE`** — single-use, one hour to live. Mint one from
Settings → Workers → "Enrol a worker" and put it on the machine. The first registration spends it
server-side, the worker deletes the file, and it is never needed again — a worker with an identity
in `worker.json` does not re-register. Optional by design: an enrolled worker must keep booting
after you remove it.

**`CP_API_TOKEN` / `CP_API_TOKEN_FILE`** — **no longer used.** The worker's own `cpw_` credential
does the claiming and the reporting, and its scope is re-derived on every call from the projects
this machine is actually assigned to, so it cannot drift the way a minted list does. The kill switch
still holds: `PATCH /api/workers/:id` refuses every machine credential, worker credentials included.

Claiming itself uses neither: `worker.json` holds a `cpw_` credential minted at registration, which
no route outside the worker API accepts.

## Which repositories this machine will run

`repos.json` in `CP_STATE_DIR` is the only thing that decides where anything runs:

```json
{ "repos": ["/Users/you/code/the-repo"] }
```

Mode 0600, absolute paths only. On every refresh the worker resolves each entry's `origin` and
reports `{remote, path}` upward. The server matches those remotes against each project's configured
repository and answers with the projects this machine may serve — **as remotes, never as paths.**

That direction matters. The server cannot name a directory on this machine: it says "this project is
enabled and its repository is X", and the worker looks X up in its own inventory. A project whose
repository is not in `repos.json` here is simply reported unbound, and no amount of server-side
configuration changes that.

An entry that has gone missing, or has no `origin`, is skipped rather than failing the whole list —
one stale line must not cost this machine every other checkout it could serve.

## What a worker's credential grants

**Exactly what its owner can reach, and nothing else.** A worker is offered a project when three
things hold at once: the project is enabled for workers, the machine's **owner** can reach it, and
that machine reports a checkout whose remote matches the project's repository.

The owner's reach is resolved from their own grants on every heartbeat, every assignment list and
every claim — not stored on the worker. A grant revoked from the person is revoked from their
machine on its next poll, with nothing to remember to un-tick.

Reporting a remote it does not really have gains a worker nothing it could run: it resolves the
checkout from `repos.json` on its own disk, so a false remote earns an assignment it then fails to
bind.

Until BP-358 this was instance-wide, and an instance admin had to approve every enrolment. That was
the right shape while a machine took work assigned to a project-wide nominee — anyone's work — so
admitting a machine was an instance-level decision. A machine now runs only its owner's own work, on
its owner's own hardware, entirely inside permissions that person already holds, so the approval
signed off on something already permitted. **Enrolling is self-service:** whoever connects the
machine owns it. An instance admin keeps the fleet console and the kill switch (`enabled`,
`lockedByInstance`) and is no longer a required step.

A machine with **no owner** — every worker enrolled before BP-358 — reaches nothing: no assignments,
no claim, refused by the middleware. That is deliberate rather than a fallback to the old behaviour,
which would keep the race this replaces alive indefinitely. The fleet console's Owner column says
so; the fix is to enrol the machine again from the machine.

## Where settings live

**On the agent** (Agents): what the run actually does — the steps, the gates, their limits and the
models each block calls. `autoMerge` and `reviewGate` used to be project settings and are retired:
an agent merges because its sequence ends with a **Merge** step, and a change is reviewed because a
**Reviewed** gate stands after the last step that writes. The diff limits and the models moved onto
the blocks that use them.

**On the project** (Settings → Workers, instance admin): whether workers may run it at all,
`baseBranch`, `taskTimeoutMs` and `runCeilingMs`. These describe the repository, so every machine
serving that project runs under the same values.

**On the worker** (Settings → Workers, the fleet console): what this machine is called, whether it
may run, the instance kill switch, and `pollIntervalMs`. These describe the laptop.

Only fields an operator actually set travel to the worker; everything else resolves against the
defaults compiled into it, so raising a default reaches every machine that never pinned it. The
worker still carries `maxDiffLines` and `maxDiffFiles`: they are the fallback a Size gate uses when
its own block names no limit.

**Nothing merges unless the agent says so.** A project running the shipped **Default** agent gets a
branch pushed and a pull request opened, and the task moves to review — nothing lands on the base
branch. Give it an agent whose sequence ends with **Merge** and it merges its own work.
