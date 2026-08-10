# Board Planner execution worker

Claims approved tasks, runs Claude Code headless in an isolated git worktree, enforces the merge
gates and carries a task through to `done` — with nobody at the keyboard.

The worker talks to the app over REST with a Bearer token and never touches MongoDB directly: the
app runs on Railway while the checkout lives on a laptop behind NAT, and a machine executing
agent-written code has no business holding database credentials.

A single worker process can serve more than one project: it registers once, an instance admin
assigns it whichever projects it should work, and the poll loop claims from each assignment in
turn.

User-facing documentation lives on the docs site, under **AI and automation → Execution
workers**: what the gates do, how to enable a project, which tasks get picked up, and how to stop a
machine. This file is the operator's view — what has to be true on the box itself.

## How one task runs

```
claim → worktree → claude -p → clean-tree check → gates → push → PR → merge → done
```

Every step reports to the board, so the task's comments are the run log.

The gates run in cost order, cheapest first, and the first rejection stops the run:

| Gate | Rejects when |
|---|---|
| `diff-size` | the diff is larger than the worker's `maxDiffLines` or `maxDiffFiles` policy |
| `protected-paths` | the change touches files a later step executes or loads as instructions |
| `test-presence` | the change touches code without touching a test |
| `build` | `npm run build` fails |
| `test-run` | the test suite fails |
| `review` | a second Claude, with a clean context, rejects the diff |

A rejection pushes the branch, comments which gate said no, and routes the task to the review
column. A usage limit returns the task to the queue with its attempt refunded — it is not the
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

A worker has no identity until an instance admin registers it and assigns it one or more projects
in `/settings/workers`. Until then it polls but claims nothing: `/tasks/claim` and the rest of
`/api/workers/**` refuse any request without a credential the server itself issued.

On first run the worker registers itself with its enrolment token and persists the response — a
`workerId` and a `cpw_`-prefixed credential — to `<CP_STATE_DIR>/worker.json`, mode `0600`. Every
later run reuses that file; the worker registers again only if the file is missing or the server
rejects its stored credential with 401. A run that reuses a stored identity, rather than
registering fresh, reads its current policy and assignments back from `GET /api/workers/:id`.

Registration assigns projects, but not a filesystem. The repository path an admin proposes for
each assigned project must still be approved on this machine, by listing it in
`<CP_STATE_DIR>/repos.json`. A worker pointed at a path outside its own allowlist leaves that one
project unbound and idle, with the reason visible as `bindingError` in `/settings/workers` — its
other assignments keep working normally.

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

- **Nothing is claimed that was not offered.** A project's `claimScope` decides what the approved
  column actually hands over. On `assigned`, the default, a worker takes only tasks assigned to the
  user that project nominates — so enabling a project claims nothing until somebody hands a task
  over, one at a time. `any` adds unassigned tasks, which is the whole column. A task assigned to
  anyone else is never taken under either scope.

  The nominee is an ordinary user a person picks, deliberately not the worker's own identity: that
  is an auto-created `worker-<id>` account with kind `machine`, excluded from every list the
  product offers. Keying the predicate on it would have described a hand-over nobody could perform.
- **Nothing merges unreviewed.** The review gate is a separate Claude with no memory of writing
  the code, and it sees only the diff.
- **Nothing executes before the static gates have read the diff.** `protected-paths` refuses
  changes to `package.json`, lockfiles, `.npmrc`, hooks and workflows *before* the build gate runs
  npm on the worktree, and installs run with `--ignore-scripts`. Cost ordering alone would have
  executed agent-written lifecycle scripts first.
- **No subprocess inherits the worker's secrets.** The child environment is an allowlist, so
  the worker's credential reaches neither the agent nor any dependency's install script. Only delivery,
  which runs our own commands, carries what `git` and `gh` need for the remote.
- **The executor runs with `bypassPermissions` inside the worktree**, so the worktree is checked
  for uncommitted files before the gates run — an agent cannot hide a change from the gates by
  never staging it.
- **A rejected branch is always pushed** before its worktree is discarded; if the push fails the
  worktree is kept and the comment says where it is.
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

Instance-wide, not per project. A worker that reports a checkout matching a project's repository is
offered that project, for **every** project with workers enabled — there is no per-worker list of
which projects a machine may serve.

That is deliberate. A worker credential comes from a single-use enrolment token that only an
instance admin can mint from an interactive session, so the set of workers is already the set an
admin chose to admit, and admitting a machine admits it to the instance. Reporting a remote it does
not really have gains a worker nothing it could run: it resolves the checkout from this file, so a
false remote earns an assignment it then fails to bind.

Revisit this if workers are ever enrolled by someone other than an instance admin, or if two
projects on one instance must not share a machine.

## Where settings live

**On the project** (Settings → Workers, instance admin): whether workers may run it at all, and how
— `autoMerge`, `baseBranch`, `taskTimeoutMs`, `maxDiffLines`, `maxDiffFiles`, `model`,
`fallbackModel`, `reviewModel`. These describe the repository and the work, so every machine serving
that project runs under the same values.

**On the worker** (Settings → Workers, the fleet console): what this machine is called, whether it
may run, the instance kill switch, and `pollIntervalMs`. These describe the laptop.

Only fields an operator actually set travel to the worker; everything else resolves against the
defaults compiled into it, so raising a default reaches every machine that never pinned it.

**`autoMerge` is off unless you turn it on.** A project nobody has configured gets a branch pushed
and a pull request opened, and the task moves to review — nothing lands on the base branch.
