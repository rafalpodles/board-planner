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

The pull request carries the agent's summary and, under it, the gates the run passed before it was
opened — each with the commands it ran (`npm ci --ignore-scripts --no-audit --no-fund` and
`npm run build` for `build`, `npm test` for `test-run`) and how long it took (BP-780). The agent
itself has no shell, and is told that the worker runs these checks after it, so its summary does
not claim the tests were never run.

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

The pin also decides who the commits are **by** (BP-779). With an account pinned, each run asks
GitHub for that account (`gh api user`, with its own token) and authors its commits as its display
name and its noreply address, `<id>+<login>@users.noreply.github.com` — so a machine whose global
git config names a work identity does not put it into a personal repository. To commit as something
else, put both a name and an address beside the pin:

```json
{ "account": "owner", "name": "Owner Name", "email": "owner@example.com" }
```

The menubar keeps those two when the same account is picked again, and drops them when another one
is. Nothing is written to the checkout's git config: the identity travels in the environment of the
commit alone. With nothing pinned, commits carry what git config names on this machine, as before.
Preflight names the identity either way, as its `commit identity` row, and warns when GitHub would
not say who the pinned account is and the machine's own config is used instead.

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

Without a clone: every release carries `board-planner-worker-X.Y.Z.tar.gz`, built by
`pack.sh` — this directory's `dist/`, `launchd/` and a `package.json` with nothing to install.
Unpack it and run `npm start` (or `node dist/main.js`) inside the `worker/` it contains. A tarball
a browser downloaded is quarantined, and so is everything `tar` unpacks from it, including the
process reaper at `dist/bin/cp-reap`. The worker does not run a reaper whose quarantine was never
approved — the first run of one from an unsigned build, or offline, can wait on Gatekeeper
indefinitely — so release it once with `xattr -dr com.apple.quarantine worker` before the first
start. Otherwise the worker builds its
own reaper with the command-line tools, and takes no work if they are not installed.

The worker reports its version to the server on every heartbeat, read from the `package.json` it
ships with: beside `main.js` in the menubar app, beside `dist/` in the tarball and in a clone. The
release build stamps the tag's version into both, and release-please keeps this directory's own
`package.json` at the last release, so the fleet screen shows what each machine actually runs
(BP-768).

The menubar app reaches the worker over a unix socket, `<CP_STATE_DIR>/worker.sock`. macOS caps a
socket path at 104 bytes, so when that path would be longer the socket moves to
`/tmp/cp-worker-<uid>-<digest of CP_STATE_DIR>/worker.sock`, in a directory the worker creates at
mode 0700 and refuses to use if anybody else owns it or can write to it. The menubar derives the
same path from the same state directory, so nothing needs configuring (BP-778).

As a macOS service:

Write the enrolment token first, to a file only you can read — never into the plist, which sits
at `0644` and rides along into Time Machine. With the token copied from Settings → Machines →
"Connect a machine":

```bash
mkdir -p -m 700 ~/.boardplanner
install -m 600 /dev/null ~/.boardplanner/token && pbpaste > ~/.boardplanner/token
```

The plist points `CP_ENROLMENT_TOKEN_FILE` at that file. The worker will not use one that is readable
by group or others: a worker with no identity yet stays unregistered and logs that reason, including
`run chmod 600 on it`, until you fix the file and
run the `unload` and `load` below again. A worker that has already registered
never uses the token, so a leftover file there does not stop it. The inline variable still works
for a container, where there is no file to protect.

Then install the plist and load it. It ships with four placeholders rather than one developer's
values, named in the comment at its top: `REPO_DIR`, `HOME_DIR`, `BOARD_URL` and `MACHINE_NAME`.
Substitute all four as you install it, with your own board's address if it is not the hosted one:

```bash
sed -e "s|REPO_DIR|$(cd .. && pwd)|g" -e "s|HOME_DIR|$HOME|g" \
    -e "s|BOARD_URL|https://app.board-planner.com|g" -e "s|MACHINE_NAME|$(hostname -s)|g" \
  launchd/com.boardplanner.worker.plist > ~/Library/LaunchAgents/com.boardplanner.worker.plist
launchctl unload ~/Library/LaunchAgents/com.boardplanner.worker.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.boardplanner.worker.plist
```

The `unload` makes the sequence safe to repeat: it stops a copy already loaded, so the `load` picks up
the new plist.

Loading it before the token is in place starts a worker that stays unregistered: it reads the token
only when it starts, so it logs every 30 seconds that it has none until you `launchctl unload` and
`load` it again.

A worker whose `CP_API_URL` is still `BOARD_URL`, or is not an `http` or `https` address at all,
stops at start and says so in the error log rather than retrying an address it cannot reach —
`launchd` starts it again every 30 seconds, so the line repeats until you fix the plist and unload
and load it.

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
  changes to `package.json`, lockfiles, `.npmrc`, `.husky/` and workflows *before* the build gate
  runs npm on the worktree, and installs run with `--ignore-scripts`. Cost ordering alone would have
  executed agent-written lifecycle scripts first. Not real git hooks — reaching one needs a path
  with a `.git` component in the name, which the ordinary staging path (`commitAll`'s `git add`)
  refuses; the low-level plumbing that could build one anyway needs Bash, which the agent does not
  have (BP-310).
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
  it did nothing wrong. The worker's log names the key, and so does the menubar app on that
  project's row; an instance admin also sees it as a failed check in Settings → Workers. The
  quarantine is deliberately not lifted by the next rebind,
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
  that tidies up is the only thing between it and the worktree's removal — but only until the
  next attempt rebuilds the worktree. Where it stops: a step that never reaches its commit, on a
  timeout, a usage limit or a block, does not set the flag that keeps it, and the tree goes.
- **The agent's own writes cannot leave its worktree.** Both calls to the CLI — the step that
  writes the change and the review gate — run under `sandbox-exec` with a profile that denies every
  write and allows back exactly one directory: the worktree for the step, the throwaway checkout for
  the reviewer. The kernel refuses, so it holds for `Write`, for `Edit`, for a symlink planted inside
  the worktree and written through, and for a process the CLI spawns writing a file itself.

  **The directory is the one recorded at creation, never the path resolved again** (**BP-804**). The
  profile's allowance covers the worktree itself, so a confined process — a daemon a Test gate left
  running, say — can delete it and put a symlink to `$HOME` in its place, and a path resolved at the
  next spawn would then allow the next step to write your home. The worker records the worktree's
  real path and its device and inode when it creates it, and refuses to confine anything to it once
  it is a symlink, missing, or a different directory; the same check runs before every step, agent
  steps included, as well as before every gate and delivery. Between that check and the spawn, the
  profile names the recorded path literally, and seatbelt checks the resolved path of each write, so
  a symlink put there afterwards permits nothing through it (measured on macOS 26.6.2). Every other
  directory a confinement allows — a gate's scratch directory, the npm cache, the review checkout —
  is resolved through its parent only and refused if it is itself a symlink, so a `CP_NPM_CACHE`
  that is a symlink is refused rather than followed — preflight reads red on it before the machine
  claims anything; point it at the real directory. A worktree found replaced, before a step or gate
  or at its confinement, fails the run and keeps the worktree as evidence; it is not reported as a
  machine that cannot confine, so it neither refunds the attempt nor stops the worker claiming.

  **What the worker itself does to a worktree follows no symlink either.** `git worktree remove`
  deletes by path and resolves it again as it goes, so a worktree swapped for a symlink to a
  directory holding a copy of its `.git` file had git empty that directory; `worktree add` checked
  out through a symlink left at the path. The worker no longer asks git to delete a worktree or a
  review checkout: it renames the entry to a `.discard-*` name beside it — a symlink moves as a
  link, and no sandbox rule names the new path — and removes it there, first clearing `uchg`/`uappnd`
  flags and making writable a tree a step locked. Then it removes the clone's admin entries for
  that task's attempts under its own root and no others — not `git worktree prune`, which would also
  unregister any worktree of yours whose directory is missing at that moment. An entry that still
  will not move is left in place and the next attempt uses a fresh name. Every entry for the task under the root is cleared that way before
  each attempt, registered or not, so a leftover symlink cannot wedge the task. Each attempt's
  worktree has a fresh name, `<taskKey>.<nonce>`, so a process an earlier attempt left running holds
  no rule over it. A decision's settlement checks the recorded directory too before it pushes, and a
  merge refuses a pull request URL it cannot name the repository of, because without `--repo`
  `gh pr merge --delete-branch` checks the base out in the worktree.

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
  names closes that; so are reads, which this does not touch at all.

  **The network is loopback-only for `npm run build` and `npm test`** (**BP-720**). Reads stay
  open — the agent has `Read` over the disk anyway, and confining reads would take the CLI's own
  session with it — so a test the agent wrote can read a credential under your home, `~/.npmrc`,
  `~/.config/gh`, `~/.aws`, and the only thing between it and the internet was nothing. Those two
  commands now run with every outbound connection refused except to this machine, and no setting
  turns it back on short of `CP_ALLOW_UNCONFINED_AGENT`, which drops it with the rest of the sandbox
  (the gate's reason then says nothing about the network); `npm ci` keeps the network for the
  registry, and both `claude` spawns keep it for the API. A suite that starts a server on
  `127.0.0.1` or `::1` and talks to it still passes; one that reaches off the machine fails with
  `connect EPERM`, and the gate's reason says the network was loopback-only. Three daemons that
  fetch a URL on a process's behalf, outside the profile, are denied by name in those two commands:
  nsurlsessiond (a background `NSURLSession`), trustd (the AIA and OCSP URLs of a certificate the
  test hands it) and WebKit's networking process — each reached a listener from a process with no
  network at all. That is a denylist, and it closes those three, not the category. What else this
  does not close: seatbelt's `localhost` is every address this machine holds, so a listener here
  that forwards — an HTTP proxy, an SSH tunnel — is still a way out, and it ignores an IPv6 scope,
  so `fe80::1%en0` or `%utun0` is let through and a packet goes out on that link (narrowing it to
  IPv4 would refuse `::1`, where node binds `localhost` on macOS); unix sockets stay open apart
  from the named local services below (BP-810) — Docker's usual sockets among them, though one under
  another name would still start a container with the network — and with them name resolution
  through mDNSResponder, so a lookup of a name that encodes
  a secret still reaches a DNS server.

  **npm settings pinned against a project `.npmrc`.** Every npm command runs with `git`, `proxy`,
  `https-proxy`, `node-options`, `strict-ssl` and `umask` pinned in its environment, which npm reads
  ahead of any `.npmrc` — for a non-empty value; `null` clears only a key that is not a string. The
  pins cover those keys as npm spells them, and only those. Measured before the pins: a `git=` naming a script in the worktree ran it for any git
  dependency, `--ignore-scripts` or not; a `proxy=` with an http registry handed the token in your
  `~/.npmrc` to whoever ran the proxy; and a `node-options=--require <file>` ran that file during
  `npm ci`, network open, because npm exports it as `NODE_OPTIONS` and a git dependency with a
  prepare script is prepared by a child `npm install`. The environment rather than a refusal of a
  changed `.npmrc`, because one an earlier gate's code writes is untracked and reaches no diff. The
  cost: a proxy or `node-options` in your own `~/.npmrc` is overridden too. Still open: a key spelled
  otherwise — upper case or underscores, `IGNORE_SCRIPTS=false`, `GIT=`, `HTTPS_PROXY=`,
  `NODE_OPTIONS=` — is exported by npm to the child it spawns for a git dependency, over the pins,
  so there it can still turn scripts back on or name a git binary, a proxy or node options, with the
  network open during `npm ci` (**BP-812**); a git dependency still runs git and that child npm;
  `ca`, `cafile`, `cert` and `key` cannot be neutralised from the environment, so a project
  `.npmrc` can make npm trust a certificate someone on the path presents; and a registry pointed at
  `http://` sends that registry's token in clear text to the same host.

  **Everything that inherits a confined spawn's sandbox is killed when the spawn ends**
  (**BP-796**). A process group is not enough: a step or a test that runs `setsid`, double-forks or
  backgrounds with `nohup` leaves the group and the session and is reparented to launchd, so it used
  to keep writing into the worktree after the step ended — between the checks the pipeline makes
  and the commit that trusts them. What such a process cannot shed is its sandbox: children inherit
  it and a confined process cannot apply another. So every confined spawn's profile also denies a
  mach service name of its own, and when the spawn exits — normally, on a timeout or on a stop — the
  worker kills every live process whose sandbox denies that name while allowing a sibling nobody
  names, looping until none is left. A second name, stable for this worker's state directory, is
  denied too, and reaped when the worker starts, before preflight and before the first claim: that
  is what reaches a survivor of a worker process that crashed, was killed or was restarted. Two
  workers of one operator have different state directories, so neither kills the other's spawns.
  A survivor of a worker older than this carries no such name, and a restart does not reach it.

  **Not covered: a program the spawn asks another process to start.** It would start outside the
  sandbox and carry no mark, so nothing here sees it. The launch routes measured so far are refused
  instead — LaunchServices and AppleEvents below (**BP-807**), `launchctl submit` by launchd itself;
  every other daemon is the open category above.

  The check is `sandbox_check`, which Node cannot call, so it runs in a small helper. Releases carry
  it built — universal, at `bin/cp-reap` in the tarball and in the app, where it is signed with the
  app and checked against the app's signature before use — and a clone of this repository builds it
  with `/usr/bin/cc` instead (`build-reaper.sh` makes the release one; the tarball's copy is signed
  and notarised on its own by `sign-reaper.sh`). A bundled helper is refused if it was built from
  other source than the worker it ships with, if anyone other than this user, root or the owner of
  the worker's own code could replace it, or if the spawn about to run may write where it lives, and
  it must find and kill a confined probe within five seconds before it is trusted. One whose
  quarantine was never approved (the attribute's flags lack 0x40) is not run at all — except inside
  an app whose signature still verifies, since the app was assessed when it was opened and
  unzipping leaves the attribute on every file in it. A bundled helper that is quarantined or fails any of those checks gives way to
  one built with `/usr/bin/cc` when `xcode-select -p` finds the command-line tools — asked that way
  because `/usr/bin/cc` itself offers to install them — and the worker logs a warning naming why the
  bundled one was not used. **It fails closed**: a helper that
  cannot be built or trusted refuses every confined spawn before it starts, and a process the helper
  cannot kill, or one that keeps reappearing, makes that run a **machine fault** and refuses every
  later confined spawn until a retry finds nothing left. The preflight sandbox row reports only what
  is known when the worker starts — the helper, and the startup reap. Under
  `CP_ALLOW_UNCONFINED_AGENT=1` there is no sandbox to mark, so none of this applies.

  **A program launched on the process's behalf** was the same shape with a worse outcome
  (**BP-807**): `open -g -j <bundle>` returned 0 under the profile and LaunchServices started the
  bundle's program with ppid 1, outside the sandbox, where it wrote a file a direct write could not.
  That is arbitrary code as you, from any step or gate. The profile now also denies `mach-lookup` on
  the four services those routes go through, measured on macOS 26.6.2:
  `com.apple.coreservices.quarantine-resolver` (CoreServicesUIAgent, which performs the launch) and
  `com.apple.runningboard` (what LaunchServices falls back to for a bundle it already knows), so
  `open` and NSWorkspace launch nothing; `com.apple.lsd.modifydb`, so a bundle in the worktree
  cannot be registered as the handler a later click on a link would start; and
  `com.apple.coreservices.appleevents`, so an AppleEvent to another app — `tell application
  "Terminal" to do script …` — fails before it is sent, with no consent prompt. A job handed to
  launchd (`launchctl submit`, `bootstrap`) was already refused by launchd itself, and a setuid
  `crontab` is refused its exec. What it cost: `npm ci`, `npm run build`, `npm test`, git and the
  executor's real `claude -p` invocation all still succeed under it.

  **A local daemon reached over a unix socket** was the other half of that category (**BP-810**):
  the Docker socket answered, and a bind mount gives a container write access anywhere in your home;
  a tmux server you already run ran a command outside the sandbox; watchman answered, and its
  triggers run commands; and `launchctl enable`/`disable`/`bootout gui/<uid>/…` worked from inside
  and persists. The profile now refuses a connection to:
  - Docker: any `docker.sock`, anything under a `.docker` directory, Docker Desktop's own sockets
    under `~/Library/Containers/com.docker.docker`, colima's under `.colima` or `.config/colima`,
    OrbStack's under `.orbstack`, and podman's under `.local/share/containers/podman` or in your
    temp directory's `podman` (`/private/var/folders/…/T/podman`);
  - tmux under any `tmux-<uid>` directory, wherever it is: tmux always puts its sockets in one, and
    a `$TMUX_TMPDIR` set only in your shell is invisible to a LaunchAgent, so the worker does not
    try to resolve it — relative, not yet created or unset, the pattern covers it;
  - screen's socket directories (`.screen`, `screens/S-<user>`); macOS's own screen listens on a
    FIFO, which the write deny already refuses;
  - watchman's (`watchman/<user>-state`).

  Most patterns are matched wherever the path is, not against your home, so a relocated home is
  still caught, and seatbelt matches the resolved path, so a symlink to one of them does not get
  round it. The price of that: `docker.sock`, `.docker/`, `Library/Containers/com.docker.docker/`,
  `.colima/`, `.config/colima/`, `.orbstack/`, `.local/share/containers/podman/`, `.screen/`,
  `screens/S-<user>/`, `tmux-<digits>/` and `watchman/<name>-state/` are **unanchored**, so an
  honest project socket under a directory named like that is refused too. Podman's temp directory
  is anchored where podman puts it, so a `podman/` or `colima/` directory of your own is not.
  These denies are always the last rules of the profile, because a later rule allowing unix sockets
  was measured to reopen them. The profile also refuses to run `/bin/launchctl`, read-only
  subcommands included.

  **It is a denylist**, and what it leaves is worth naming. **launchd itself is not refused**, only
  that binary: a copy re-signed ad hoc inside the worktree runs (measured, and pinned by a test named
  as a known gap), as does any program that speaks to launchd directly. A Docker context, `tmux -S`
  or `WATCHMAN_SOCK` pointing at a socket elsewhere is
  reachable, and so is every other local daemon — ssh-agent through `SSH_AUTH_SOCK`, an SSH
  ControlMaster socket (an open connection to another machine), Rancher Desktop's lima `ssh.sock`,
  and anything not listed above. A project whose tests need Docker (testcontainers, say) cannot
  reach it from a gate. What it cost was measured: an ordinary unix socket still connects; `npm ci`,
  `npm run build` and `npm test` (with a test that serves its own socket), git and `claude
  --version` still succeed; and the executor's real `claude -p` (haiku, an edit step writing one
  file) completed and wrote it. The CLI does call `launchctl` itself, to install and start its own
  background daemon; that run did not need it. Reachable but untested: SMAppService and login items,
  an existing Shortcut that runs a shell script (`shortcuts run`), and a bundle the system registers
  on its own (Spotlight indexing a worktree) becoming the handler for a URL you open yourself. And,
  as above, every service not named. Preflight tries an `open` at boot, so a macOS that moves *that*
  launch elsewhere shows up as a red sandbox row rather than as an escape.

  **jest, and anything else that uses watchman, runs without it** (**BP-813**). With its socket and
  state directory refused, `watchman get-sockname` fails with an exit code, and jest does not fall
  back from that: jest 29 crashed before running a test, and jest 30 waited on a watchman command
  that never answered and **exited 0 having run no test**, so a failing suite passed the Test gate.
  The profile now also refuses to run any executable named `watchman`, wherever it is installed —
  unanchored, so a program of your own by that name is refused too. A spawn refused `EPERM` ends every
  client without watchman: jest 30's jest-haste-map treats `EACCES`, `ENOENT`, `ENOTDIR` and
  `EPERM` as "not installed", jest 29 and metro fall back on any error from their probe, and
  fb-watchman reports the error to its caller rather than hanging. jest and metro then crawl the
  file system instead. Measured on macOS with watchman 2026.07.27 running: jest 29 and 30 now run the suite and
  report a failing test as a failure, with no watchman message; vitest, `node --test`, `npm ci` and
  `npm run build` are unchanged. `CI=true` and a `WATCHMAN_SOCK` pointing nowhere were measured
  too and fix neither version: jest has no environment setting that turns watchman off, only
  `--watchman=false` or `watchman: false` in its config. Your own shell is untouched; this holds
  only inside the sandbox, for the agent's spawns and the gates alike.

  **A signal to a process outside the spawn** (**BP-809**): `(allow default)` let a step or a test
  `kill -STOP` or `kill -KILL` any process of yours — the worker itself, so it stops claiming or dies
  before it reaps; the reaper helper and its probe; your editor or shell. The profile now ends with
  `(deny signal)` and `(allow signal (target same-sandbox))`, so a confined process can signal itself,
  its children and anything they `setsid`, and nothing else: measured, `kill` from inside answers
  `Operation not permitted` for a process you started, for the worker, and for another confined
  spawn even under the same profile, so a daemon an earlier gate left cannot signal a later one. It
  holds in the gates' loopback-only mode too, and these are the profile's last rules because a later
  `(allow signal)` was measured to reopen it. Signals *into* the sandbox are untouched: the worker's
  timeout, its SIGKILL after the grace period, a stop and the reaper still kill a confined process.
  What it cost was measured: `npm ci`, `npm run build` and `npm test` with a vitest forks pool and a
  two-worker jest pool, each test spawning and killing a child; git; `claude --version`; and the
  executor's real `claude -p` (haiku, an edit step writing one file) all still succeed. A program
  that probes whether a process outside is alive with signal 0 now gets `EPERM` rather than an
  answer.

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
  its logged-in session there. An agent that goes looking can **read** what is under it —
  `~/.boardplanner/worker.json` (this worker's own board credential), `~/.config/gh/hosts.yml`,
  `~/.claude/.credentials.json`, `~/.npmrc`, `~/.ssh`, `~/.aws`, all at this process's own uid.
  Writing is a different matter since BP-349 — see the next bullet — but the environment is the
  boundary for reading, and the filesystem is not: "a subprocess cannot inherit this worker's
  secrets" is true of what travels in `env`, not of what the agent's own filesystem access can
  reach (BP-310).

  **What it costs.** `~/.gitconfig` is not read on those calls, so anything an operator keeps there
  no longer applies to delivery: a deploy key set through `core.sshCommand`, a `url.*.insteadOf`
  rewrite pointing at a mirror, or an https credential helper other than `gh`'s. Delivery
  authenticates over ssh with the agent socket, or over https through `gh auth git-credential` —
  named by the absolute path preflight resolved for gh, like every spawn of git, gh, `claude` and
  `npm`, so nothing earlier on the worker's PATH answers instead; a machine where gh was not found
  has no https helper at all (BP-641, BP-733).

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
  the diff-size gates are what make it loud. `.git/info/exclude` has no key that turns it off, so
  before staging, after every edit step and before every gate the worker asks whether each ignored
  path would be ignored by the base commit's own `.gitignore` files alone, and refuses the run —
  naming the rule's file and line from `git check-ignore -v` — for any path that would not. That
  covers `info/exclude`, a new nested `.gitignore` (which can ignore itself), and a rule added to,
  reordered in or deleted from a tracked one; an edit to a `.gitignore` leaves its base rules
  trusted (BP-640). **An entry in the main clone's own `.git/info/exclude` now fails every run that
  leaves a matching file in the worktree**, so move such entries into the repository's `.gitignore`.
  What the base `.gitignore` itself ignores still reaches no diff and can still be run by the Test
  gate — a file under an ignored `dist/`, say — which is BP-795.

  **The worktree's `.git` file is not trusted once the agent starts.** In a linked worktree it is a
  file inside the worktree, and a confined step can rewrite it to name a git dir of its own, with
  its own remote, ignore rules and index. So the git dir is recorded when the worktree is created,
  and every git and `gh` call the worker makes in the worktree names it through
  `GIT_DIR`/`GIT_WORK_TREE` — derived from the main clone's own record of the worktree, never from
  the worktree's `.git` file. Before
  each step, each commit, each gate and each push, pull request or merge, the worker also compares the `.git`
  file with what git wrote and lists the index for `skip-worktree`/`assume-unchanged` flags the
  checkout did not start with; either one refuses the run and says what changed (BP-794). A sparse
  checkout's own flags are recorded at creation and pass. A worktree refused this way is kept until
  the next attempt on the task, which discards it like any other.

  **A nested repository fails the run.** git checks a submodule for changes by running itself
  inside it, under that repository's own config — so a clean filter in a `.git/config` the Test
  gate's code left in the worktree used to run outside the sandbox on the worker's next `git status`
  or `git add`. At the same checkpoints as the ignore check, and before a push or a pull request,
  the worker now refuses an untracked repository anywhere outside an ignored directory, and a
  submodule path that has a `.git` in it. **Running `git submodule update --init` fails the run**,
  from a gate or from an Implement step — the step's commit refuses it as a tampered checkout — and
  so does **a test suite that leaves scratch git repositories in a directory the repository does
  not ignore**. A repository's submodules are otherwise untouched, since a worktree leaves them
  empty, and a change to a submodule pointer is still committed and refused by protected-paths.
  Delivery also pins `push.recurseSubmodules=no` and `fetch.recurseSubmodules=false` (BP-803).
  **A process a gate leaves running can still win the race**: it can populate a `.git` between the
  check and the `git add` or `gh`'s own `git status` that follows — one win is enough where the base
  already has a submodule — and only killing what a gate leaves behind (BP-796) closes that.

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
  push acts as is pinned separately (BP-373), and that one is not writable from the checkout. A
  pinned account (above, BP-779) takes this question away from git config altogether: git is not
  asked, and the commit carries the account's own name and noreply address.
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
  | `taskKey` | the project's key and the task number | a directory under the worktree root (`<taskKey>.<nonce>`, a new name on every attempt), and a git branch | `^[A-Za-z0-9][A-Za-z0-9_-]*-\d+$`, `pathFor` refuses a path that leaves the root, and `push` refuses a branch that is not a git ref name before building `<commit>:refs/heads/<branch>` out of it — git splits a push refspec at its *last* colon |
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
- **Unticking a project in the menubar honours the same "worktree of your own" boundary the
  reaper above does**, independently: a worktree outside `cp-worktrees` blocks the checkout's
  removal rather than being taken with it, and a submodule's working directory is left alone too
  rather than deleted out from under its superproject. The decision marker above is the reaper's
  own mechanism; this removal reads none — it refuses on nothing more than a lock, a dirty
  worktree or one it does not recognise as the worker's own (BP-507).
- **Accepting a refused change is the one report that does not go through the outbox.** Everything
  else this worker says is queued and retried until it lands; a decision settlement is not, because
  it can become *permanently* invalid — the decision superseded by a second claim, or given up on —
  and a 409 that can never succeed would be retried for twenty polls, holding back every report
  queued behind it for that task. Instead, a settlement the board did not take leaves the worktree
  and the record as they were, counts the attempt on the marker, and is tried again after one, two,
  four and eight minutes. After five attempts the record is settled failed with the count in its
  reason, for a person to accept again once they have looked. Retrying is safe because it is
  idempotent: the same commit to the same branch is already there, and the pull
  request that exists is the one reported.
- **A report that cannot be delivered is not lost.** Merging to `main` redeploys the app, so the
  report right after a merge is the one most likely to fail — and a lost one would leave the task
  sitting in the active column where nothing can claim it again. Undelivered reports persist to
  `<CP_STATE_DIR>/outbox.jsonl` and go out before the next task is claimed. A failure holds back
  only what it names — for a 409 that one task, for a project that no longer has this machine,
  that project — and anything else, a network failure or a redeploy, stops the flush, so an outage
  costs one attempt rather than one per task.
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

One, and it cannot lift this worker's kill switch. That is the point: the worker runs the coding
agent at the same uid with `Read` and `bypassPermissions`, so anything on this disk is readable by
the agent, and an unscoped instance-admin token there would let it switch its own `enabled` flag
back on.

**The `cpw_` credential in `worker.json`** — minted at registration, and the only one the worker
uses: claiming, reporting status, commenting, releasing, and all of `/api/workers/**`. No route
outside the worker API accepts it.

**`CP_ENROLMENT_TOKEN` / `CP_ENROLMENT_TOKEN_FILE`** — single-use, one hour to live. Mint one from
Settings → Machines → "Connect a machine" and put it on the machine. The first registration spends it
server-side, the worker deletes the file, and it is never needed again — a worker with an identity
in `worker.json` does not re-register. Optional by design: an enrolled worker must keep booting
after you remove it, so a token file that is gone is not an error. One that is there but readable
by group or others is ignored by a registered worker; a worker with no identity yet stays
unregistered and logs the reason, with `chmod 600` in it.

**`CP_API_TOKEN` / `CP_API_TOKEN_FILE`** — **no longer used**, and not a credential this worker
holds. The worker's own `cpw_` credential
does the claiming and the reporting, and its scope is re-derived on every call from the projects
this machine is actually assigned to, so it cannot drift the way a minted list does. The kill switch
still holds: `PATCH /api/workers/:id` refuses every machine credential, worker credentials included.

## Which repositories this machine will run

`repos.json` in `CP_STATE_DIR` is the only thing that decides where anything runs:

```json
{ "repos": ["/Users/you/code/the-repo"] }
```

Mode 0600, absolute paths only. On every refresh the worker resolves each entry's `origin` and
reports `{remote, path}` upward — whether or not the server answered its own request on that
refresh, so a checkout added while the worker runs is reported without a restart (BP-776). The server matches those remotes against each project's configured
repository and answers with the projects this machine may serve — **as remotes, never as paths.**

That direction matters. The server cannot name a directory on this machine: it says "this project is
enabled and its repository is X", and the worker looks X up in its own inventory. A project whose
repository is not in `repos.json` here is simply reported unbound, and no amount of server-side
configuration changes that.

A checkout the worker refuses — under a system or temporary directory such as `/private/tmp`,
writable by others, not its own git toplevel — is reported as the machine's binding error for that
project. The board then counts the machine as not live for that project: the assignee's own task
says why and what to do, and Project settings → Workers lists the machine as unable to use its
checkout (BP-777).

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

**On the project** (Settings → Workers, the project owner; an instance admin can lock it off, and
the lock wins): whether workers may run it at all, `baseBranch`, `taskTimeoutMs` and `runCeilingMs`. These describe the repository, so every machine
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
