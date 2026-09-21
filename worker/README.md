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
claim → worktree → claude -p → clean-tree check → gates → push → PR → review column
claim → … → PR → merge → done                 (when the agent ends with a Merge step)
```

Every step reports to the board, so the task's comments are the run log.

The gates and their order are the **agent's** — the shipped Default agent runs them roughly
cheapest first, and a `protected-paths` gate always stands before anything that executes the
repository's own scripts. The first rejection stops the run:

| Gate | Rejects when |
|---|---|
| `diff-size` | the diff is larger than the limit on the Size gate that rejected it, or the worker's `maxDiffLines`/`maxDiffFiles` where that gate names none |
| `protected-paths` | the change touches files a later step executes or loads as instructions — manifests and lockfiles, build and test configs, anything under `scripts/`, `.husky/`, `.github/workflows/`, `.github/actions/` or `.claude/`, agent instruction files, container and CI manifests, the build manifests of other ecosystems, and `.gitattributes`/`.gitmodules` |
| `test-presence` | the change touches code without touching a test |
| `build` | `npm run build` fails |
| `test-run` | the test suite fails |
| `review` | a second Claude, with a clean context, rejects the diff — present because the agent carries a Reviewed gate |

A rejection pushes the branch — unless the run committed nothing, the provenance check refuses the
history, or `protected-paths` is what refused, which withholds the push deliberately — comments which gate said no, and routes the task to the review column, every time: there is no automatic retry
of a rejected change the way there is for a crash or a timeout below. Whoever reclaims the task next
(a person, or the PM) does start with more than the last attempt had, though: the gate's reason
travels with the claim as `previousRejectionReason` and reaches the coding step's own prompt, though
never the review gate's — a retry knows what it was rejected for, and the gate stays as blind to
there having been one as it always was. A second attempt rejected for the exact same reason gets a
comment saying so, rather than one that reads like a fresh finding.
A `protected-paths` rejection also records the change on the task, so that a person can read it
there and **accept** it: the machine then pushes that exact commit and opens a pull request. See
[Accepting a refused change](#accepting-a-refused-change). A usage limit returns the task to the queue with its attempt refunded — it is not the
task's failure. A crash or timeout also returns it to the queue, but spends the attempt, so a
repeating failure runs out of retries and lands in front of a human instead of cycling forever.

## Configuration

Bootstrap is everything the worker needs before it can even register — where the server is, how
to authenticate to it once, a name to register under, and where to keep the identity that
registration mints.

| Variable | Required | Default |
|---|---|---|
| `CP_API_URL` | yes | — |
| `CP_ENROLMENT_TOKEN` or `CP_ENROLMENT_TOKEN_FILE` | first start only | — |
| `CP_WORKER_NAME` | yes | — |
| `CP_STATE_DIR` | no | `~/.boardplanner` |
| `CP_ALLOW_UNCONFINED_AGENT` | no | unset |

The last one is not bootstrap and not a setting: it is a risk acceptance, and the only other thing
read from the environment. It runs the agent with nothing confining its writes. `1`, `true` and
`yes` all mean yes, after trimming and lower-casing; anything else, including `0` and `false`,
leaves the confinement on. See **Safety** for what accepting it means and why it is not a policy
field. Everything else an operator can choose is worker policy, below.

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
{ "account": "owner" }
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

When the owner's password changes — by themselves, by an admin, or through a reset — every machine
they enrolled loses its credential along with their sessions and tokens. The worker then gets 401
and must be enrolled again — from the machine, or with a fresh enrolment token.

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
and `SIGINT` both abandon the run in flight rather than waiting it out, and the task goes back to
the queue with the attempt counted, so a supervisor restarting in a loop cannot retry it for ever.

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
  blocked means either; such a board is refused at the claim (next bullet) rather than having the
  gate skipped on it.
- **A board that cannot claim says so.** A run needs four roles — `approved` to take work from,
  `active` to move it into, `review` and `done` to deliver it to. A board missing any of them is
  refused at the claim with a 409 naming the role, rather than the 204 an empty queue gets; the
  worker logs it once per reason rather than every poll, and the menubar shows it against the
  project (BP-512). Refused at the claim rather than at run start, because a task claimed onto such
  a board and handed back was claimed again on the very next pass, without a poll interval. The
  board's settings refuse to remove the last `active` or `done` column in the first place; a run
  that still finds a role missing — the columns edited between the claim and the run — hands the
  task back with the attempt charged, so three such runs park it for a person.
- **An unreviewed merge is shown, never forbidden.** A Merge step with no Reviewed gate after the
  last step that writes is graded *risky* in the agent editor and runs exactly as composed: whether
  to merge unreviewed is the operator's call. Where a Reviewed gate is present it is a separate
  Claude with no memory of writing the code: it is given the task and the diff, and can read, never
  write, a clean checkout of the commit. The shipped Default agent
  merges nothing; it stops at the pull request.
- **Nothing executes before the static gates have read the diff.** `protected-paths` refuses
  changes to `package.json`, lockfiles, `.npmrc`, hooks and workflows *before* the build gate runs
  npm on the worktree, and installs run with `--ignore-scripts`. Cost ordering alone would have
  executed agent-written lifecycle scripts first.
- **Nothing is checked out of a poisoned clone, and a poisoned clone is not tried twice.** The
  first thing a run does is read the shared checkout's own git config and refuse it if it carries a
  key git would run — a `filter.<name>.smudge`, an `ext::` transport, an `include.path` this cannot
  vouch for. That has to come first because `git worktree add` **checks files out**, and a checkout
  is where a smudge filter runs: a key an earlier run's agent planted in `<main>/.git/config`
  otherwise executes inside the call that creates the worktree, before any gate on that attempt has
  seen anything. Measured on git 2.50.1.

  The scan reads the repository's own scopes, so the calls that make the checkout also drop
  `~/.gitconfig` — without that a filter defined there ran on a checkout with **nothing planted in
  the repository at all**, and no scan of the repository could ever have seen it. Measured. Since
  BP-516 that is true of every git call this worker makes but one — the read of the commit identity
  before the agent starts, which is the whole of what that file is still asked for — and not only of
  the calls that create a worktree, which is what lets the scan and the call it guards read the same
  config.

  The same scan runs at **bind time**, against the shared checkout, before anything is claimed
  (BP-517). It used to be a narrower list of its own: `--local --list`, which cannot see a
  per-worktree config, judged by a rule that did not refuse `include.path`. A checkout carrying
  either bound cleanly and was refused by the first run instead — which quarantines the project and
  every sibling on that path. Judging it once, with one function, is what keeps the two answers the
  same as the rules change.

  Refusing alone would only hand the same clone to the next attempt, so the checkout is
  **quarantined**: this machine stops claiming for every project bound to it — the poison is in the
  path's config, not in a project — and the task is handed back with its attempt refunded, because
  it did nothing wrong. Settings → Workers shows it as a failed check naming the key, and the
  worker's log says the same thing. The quarantine is deliberately not lifted by the next rebind,
  because a re-scan reading clean thirty seconds later is exactly what re-planting produces. Remove
  the key, then restart the worker.

  Two things quarantine a checkout, and both are a file that path's projects share: a key somebody
  planted, and a config that leaves no identity to commit as (BP-516). A config git would not read at
  all — a checkout being re-cloned, a machine under load — still refuses the run, because a config
  this cannot read is one it cannot vouch for, but it does not latch the project off until the
  process restarts.

  The key is **not** cleared for you. Writing to a config an attacker also writes is a race, and it
  destroys the evidence of what was planted.

  Neither is the worktree. A **tampered-checkout** refusal keeps it, with what the agent wrote and
  the planted config still in it, and parks the task rather than requeueing it at the same checkout
  (BP-506) — the comment names the key and the path. A config this cannot *read* is not that: it
  refuses the same staging, but as an ordinary failure, so the task requeues and the comment names
  the path alone, because there is no key to name. Every ordinary commit failure keeps the tree the
  same way — whichever call threw, the agent's work is in it and in no history, and the `finally`
  that tidies up is the only thing between it and `worktree remove --force` — but only until the
  next attempt rebuilds the worktree. Where it stops: a step that never reaches its commit, on a
  timeout, a usage limit or a block, does not set the flag that keeps it, and the tree goes.
- **The agent's own writes cannot leave its worktree.** Both calls to the CLI — the step that
  writes the change and the review gate — run under `sandbox-exec` with a profile that denies every
  write and allows back exactly one directory: the worktree for the step, the throwaway checkout for
  the reviewer. The kernel refuses, so it holds for `Write`, for `Edit`, for a symlink planted inside
  the worktree and written through, and for a process the CLI spawns writing a file itself.

  **What it closes.** A step runs with `--permission-mode bypassPermissions`, so `Write` used to take
  any absolute path this user can reach. `$HOME/.claude/settings.json` is the shortest one: a hook
  there runs a shell command on the next `claude` — a later step in the same run, and, with a much
  larger blast radius, **your own interactive `claude`**, the next time you open one. Measured: a
  `SessionStart` hook fires even on a run that never authenticates, so planting one does not need a
  successful run to arm it. Not the review gate, which passes `--safe-mode`. Nothing downstream could
  see any of it: the file is outside the repository, so it never reaches the diff and
  `protected-paths` cannot match a path it is never given. `~/.zshrc`,
  `~/Library/LaunchAgents/*.plist` and `~/.gitconfig` were the same escape with different timing.

  **The npm gates are inside it too** (**BP-608**). `npm ci`, `npm run build` and `npm test` run
  agent-written code — a test file is exactly what an Implement step is asked to write — so a step
  that wrote a test which writes to your home, followed by a Test gate that ran it, reached outside
  in two moves. Each command now gets the worktree and a scratch directory of its own (handed to it
  as `TMPDIR`, so `os.tmpdir()` and `mktemp` find it), and nothing else; the install also gets a
  **per-account npm cache** under the temp directory, or wherever `CP_NPM_CACHE` points, never your
  own `~/.npm` — named for the uid, so two workers you run share it. What that leaves: the cache is shared between runs on this machine, so a package an
  agent could get written into it is one a later run installs — npm verifies tarball integrity
  against the lockfile, which bounds it, and your own cache is out of reach either way. A machine
  that cannot confine refuses the gate rather than running it unconfined.

  **A write a daemon performs on the process's behalf** was the way out that `file-write*` could not
  see (**BP-630**): `(allow default)` leaves `process-exec` and `mach-lookup` open, so a test file
  that spawned `defaults write` had cfprefsd write a plist under `~/Library/Preferences` for it,
  outside the worktree, exit 0. The profile now denies `mach-lookup` on cfprefsd's daemon and agent
  service names, and the same command writes nothing. What that costs was measured rather than
  assumed — `defaults read` still answers, `npm ci`/`npm run build`/`npm test` still pass, git still
  commits, and the agent CLI still runs under both tool lists — because denying a lookup is not a
  write-only deny. What no measurement here covers is a program that reads a preference *only*
  through that daemon: it sees the default instead, which for a run is the answer a fresh account
  would give. Every other daemon reachable the same way is still open, and no list of service
  names closes that; so are reads, and the network, neither of which this touches at all.

  **A file git will not print** (**BP-603**). Four things take a file's contents out of a patch: a
  bare `-diff` attribute, a `diff=<name>` driver declared binary in the config, a file git decides
  is binary on its own, and a submodule pointer. The **submodule pointer is refused** by
  `protected-paths`: its whole change is two object ids, in a repository these gates never fetch,
  so neither a reviewer nor a person reading the pull request can say what it now brings in. By
  that gate and only that gate — gates are the blocks an agent names (`gates/from-entry.ts`), so a
  sequence without a **Protected files** step has no such refusal, which is BP-626. The
  other three are **allowed and named**: a binary fixture or an image is ordinary work, and a gate
  refusing every one of them would be switched off — so the review gate is told, in the prompt,
  which files it is not being shown and that it should decline if their contents would matter.

  **macOS only.** Seatbelt is what this uses. **A machine that cannot confine takes no work at
  all**: the loop stops claiming, says why once, and keeps heartbeating, so the fleet screen and the
  menubar still show it and the kill switch still reaches it. Draining what it already owes carries
  on. That covers a Mac whose probe failed as much as a Linux box, because the gate reads
  preflight's answer for this machine rather than the platform.

  The step-level refusal is still there underneath: it is what stops an unconfined agent running.
  A task it does refuse is released with its attempt refunded rather than failed, so nothing walks
  the queue into the escalation column. The run is recorded as **machineFault**, not `released`
  (**BP-609**): the board action is the same as a usage limit's, and the outcome is the only place
  the difference survives — a released run repairs itself on a clock, a machine fault is one
  somebody has to go and look at. The menubar raises its own notification for it — once per project
  per run of consecutive faults, not once per poll, because the fault repeats every cycle for as
  long as it lasts — and reads `.faulted` rather than idle.

  Preflight answers the question at boot by confining a probe and watching it fail to escape, so a
  machine where `sandbox-exec` is missing or the profile stopped compiling reads red rather than
  green. To run unconfined anyway, set `CP_ALLOW_UNCONFINED_AGENT=1` in the worker's own
  environment; it is never a worker policy field, because policy comes down from the server and the
  agent reaches the server.

  **What it costs.** The implementer step does not pass `--safe-mode`, so it still loads
  `~/.claude/settings.json` — and every hook there that writes anything now fails. Measured on CLI
  2.1.269: `SessionStart` hooks returning `Failed to run: EPERM … mkdir
  '~/.claude/session-env/<session>'`. They exit 1, which is non-blocking, and the run completed
  normally; a `PreToolUse` hook that exits 2 when its own write fails would instead block every tool
  call of every run on that machine. A run also leaves no `~/.claude/projects/**.jsonl` transcript
  any more — the worker keeps its own stream-json, so nothing the run needs is lost, but a debugging
  surface is gone.

  A note on the evidence, because the method has a blind spot: the measurements above read the CLI's
  exit code, stderr and `permission_denials`, and all three are blind to a single *tool* failing —
  the model routes around one and still reports success. With Bash in the list, every Bash call fails
  `EPERM` under the profile (its scratch root is outside the worktree and not derived from `TMPDIR`)
  while the run still exits 0. Neither spawn gives the agent Bash, so nothing is broken; a capability
  that adds one has to be re-measured at the tool level, and no test in this package runs the real
  CLI.

  **Not a per-run `HOME`**, which is the cheaper thing this looks like: measured, a fresh home
  answers `Not logged in`, there is no credential file under `~/.claude` to copy into one, and moving
  `HOME` would not stop `/Users/<you>/.claude/settings.json` being written by name anyway.

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
  its logged-in session there. An agent that goes looking can **read** what is under it. Writing is
  a different matter since BP-349 — see the next bullet — but the environment is the boundary for
  reading, and the filesystem is not.

  **What it costs.** `~/.gitconfig` is not read on those calls, so anything an operator keeps there
  no longer applies to delivery: a deploy key set through `core.sshCommand`, a `url.*.insteadOf`
  rewrite pointing at a mirror, or an https credential helper other than `gh`'s. Delivery
  authenticates over ssh with the agent socket, or over https through `gh auth git-credential`.

  Since BP-516 that cost is the same on the local calls, and two lines of it are worth naming.

  **Git-LFS is out, both ways round.** `git lfs install --local` writes `filter.lfs.clean` into the
  checkout's config, which is a program git runs, so `bindRepository` refuses that checkout and names
  the key. `git lfs install` on its own — the ordinary setup — writes the same keys into
  `~/.gitconfig`, which nothing refuses and which the worker no longer reads: the checkout produces
  pointer text and the commit puts working-tree bytes where a pointer belongs, quietly. Neither is a
  repository this worker can serve.

  **The ignore list is the repository's own.** `core.excludesFile` no longer decides what gets
  staged — and neither does `~/.config/git/ignore`, which git reads with no config file at all and
  which `SAFE_CONFIG` pins to `/dev/null` for that reason. What that stages is wider than a
  `.DS_Store`: the gates run `npm ci` and the build inside the worktree, so a `node_modules` or a
  `dist` the repository's own `.gitignore` does not name is committed by the next edit step, where
  the diff-size gates are what make it loud. One list is left:
  `.git/info/exclude`, untracked and reaching no diff, which is BP-640.

  **Nothing this worker commits is signed.** `commit.gpgSign=false` and `push.gpgSign=false` ride on
  every call, because signing runs a program the checkout names (`gpg.program`, or ssh's key
  command) and that is the sink the scan exists to guard. A repository whose branch protection
  requires signed commits will reject what a worker pushes.

  **An ownership refusal reads as an unreadable config.** `GIT_CONFIG_NOSYSTEM` and the null global
  file take `safe.directory` with them, so a checkout whose `.git` belongs to another uid answers
  `fatal: detected dubious ownership`, which this reports as "could not read git config in <path>".
  `bindRepository`'s own uid check catches the ordinary case first; the message is worth knowing for
  the one it does not.

  The worker's own commits are made in the same environment since BP-516, and the one thing they
  genuinely need from that file — who the commits are by — is asked of git itself before the agent
  runs (`git var GIT_AUTHOR_IDENT`, in the shared checkout, which is the local config a linked
  worktree reads) and carried in `GIT_AUTHOR_*`/`GIT_COMMITTER_*`. Asked before the fetch and before
  `worktree add`, because the answer is the same for every task, finding it out at the commit costs
  the whole run, and asking after the fetch and the checkout spends both on a question that could
  have been asked first.

  Asked in two parts, and the second is not decoration: `git var` answers with a *guess* when nothing
  is configured — `<unix user>@<hostname>` — and refuses that guess only where the hostname has no
  dot in it. So the same empty configuration says "Author identity unknown" on a laptop and
  `runner@fv-az…cloudapp.net` on a CI box, where the worker would push commits authored by somebody
  who does not exist. The address has to be one somebody configured (`config --get user.email`); the
  name is not held to that, because git fills it from the account and a name routes nowhere. CI is
  what found this, and no machine of ours could have.

  Two faults, one settlement and two blast radii. Both release the run with its attempt refunded and
  end the pass — the task did nothing and nothing it could do would help. What differs is what is
  latched off and how it is cleared. **The machine** names nobody, or its config file will not
  parse: nothing is quarantined, the reason carries git's own whole answer — or, where git would
  have guessed, the two commands to run and the address it would have used — and the next poll tries
  again, so a machine that is still broken says so again. **The checkout** leaves no identity while the machine is fine — a `user.name = ""` in the
  shared `.git/config` does it, well-formed and carrying no program, so no scan refuses it: that
  checkout is quarantined, exactly as a planted key quarantines it and for the same reason, because
  the file belongs to the path and every project bound to it shares it. Charging the attempt instead
  was tried and is worse than doing nothing: the loop claims the next task immediately, so the
  approved column of every project on that checkout empties into escalation one attempt at a time.

  What that identity is worth is worth stating too: an earlier run's agent running unconfined
  (`CP_ALLOW_UNCONFINED_AGENT=1`) can write `user.email` into that file or into the shared
  `.git/config`, since a confined one writes nowhere but its worktree. Neither is a key git *runs*,
  so no scan refuses it. A commit's author is as trustworthy as the machine's own configuration. The account a
  push acts as is pinned separately (BP-373), and that one is not writable from the checkout.
- **Nothing the server sends becomes a path or an option.** Everything below arrives over HTTP from
  whichever server this worker is enrolled with, and everything past that boundary runs on somebody's
  laptop at their uid. Two of these were live: a `workerId` of `../../../../Users/owner/Library/LaunchAgents`
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
  left alone. **One exception:** a worktree holding a change somebody is being asked to accept is
  kept, named by a marker under `<CP_STATE_DIR>/decisions/`. That marker has no expiry, unlike a
  run's two-hour lease, so an unanswered decision pins a worktree until somebody answers it.
  Accepting, declining and giving up all release it — provided this machine still serves that
  project, because both removing a worktree and reaping one resolve through the binding. Lose the
  assignment while a decision is open and the marker is kept rather than dropped, since dropping it
  would hand the directory to a reaper equally unable to run. After seven days the hold is released
  anyway and the path is logged: the worktree is then yours to remove, and a later rebind collects
  anything left.
- **Accepting a refused change is the one report that does not go through the outbox.** Everything
  else this worker says is queued and retried until it lands; a decision settlement is not, because
  it can become *permanently* invalid — the decision superseded by a second claim, or given up on —
  and a 409 that can never succeed would hold every comment, status move and run record behind it
  for twenty polls. Instead, a settlement the board did not take leaves the worktree and the
  record as they were, counts the attempt on the marker, and is tried again after one, two, four and
  eight minutes. After five attempts the record is settled failed with the count in its
  reason, for a person to accept again once they have looked. Retrying is safe because it is
  idempotent: the same commit to the same branch is already there, and the pull
  request that exists is the one reported.
- **A report that cannot be delivered is not lost.** Merging to `main` redeploys the app, so the
  report right after a merge is the one most likely to fail — and a lost one would leave the task
  sitting in the active column where nothing can claim it again. Undelivered reports persist to
  `<CP_STATE_DIR>/outbox.jsonl` and go out before the next task is claimed.
- **A task abandoned by a dead worker comes back.** The claim endpoint frees anything whose lease
  has outlived it, without refunding the attempt, so a task that repeatedly outlives its worker
  runs out of attempts and reaches a human.

## Accepting a refused change

The `protected-paths` gate says a human has to read the change, and the pipeline deliberately does
not push it — what the branch carries is exactly what the gate refused. Before BP-381 that left the
work as a commit in a worktree on whichever machine claimed the task, reachable only from a shell
on that machine.

Now the run also writes a record on the task: the gate, every file the change touches, the commit
it was judged at, and the patch itself. The task screen renders it, and the machine's **owner** —
or an instance admin, in an interactive session, never a machine credential — can answer.

| Answer | What the machine does |
|--------|-----------------------|
| Accept | pushes that commit to `<taskKey>/worker` and opens a pull request. Never merges. |
| Decline | removes the worktree and says so. |
| Give up | settles the record so the task stops waiting. The worktree goes on that machine's next poll — so for a machine that really is gone, the checkout stays until somebody removes it. |

Accepting is checked again on this side before anything is pushed: `refs/heads/<branch>` must still
be the accepted commit, and the patch re-derived from the recorded base must still hash to what the
person was shown. Either failing reports `refused` with the reason, and a refused or failed
decision can be accepted again — a network fault does not cost a second reading.

**Three families can never be accepted here.**

- A change touching a `.yml` under `.github/workflows/`, or anything under `.github/actions/`,
  because for a `push` event GitHub runs the workflow from the pushed ref — accepting one would run
  the agent's own version of CI.
- A change whose patch was too large to carry.
- A change holding a file `git diff` will not print — a binary asset, one something in the
  repository marks as one, or a submodule pointer, whose whole diff is two object ids. For the
  first three `--numstat` reports `-` for both counts and the patch says `Binary files … differ`;
  a gitlink is read from its file mode instead. See `DiffStats.suppressedDiffs`.

The last two are the same rule twice: the record is the reading surface, and nobody can accept what
they were not shown.

Be clear about what accepting spends: on a repository whose CI is `on: push`, the push itself runs
the change's own build configuration on a runner — as whichever GitHub account **that machine**
pushes as, which is the one pinned in its `github.json` or, failing that, whichever `gh` has active
there. Not the account of whoever accepted, who may be an instance admin answering for a machine
that is not theirs. The panel says so before the button does anything.

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
readable by the agent, and an unscoped instance-admin token there would let it switch its own
`enabled` flag back on.

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
machine owns it. An instance admin keeps the fleet console and the kill switch (`enabled`) and is
no longer a required step.

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

**Nothing merges unless the agent says so.** A task running the shipped **Default** agent gets a
branch pushed and a pull request opened, and the task moves to review — nothing lands on the base
branch. Give it an agent whose sequence ends with **Merge** and it merges its own work.
