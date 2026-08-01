# ClaudePlanner execution worker

Claims approved tasks, runs Claude Code headless in an isolated git worktree, enforces the merge
gates and carries a task through to `done` — with nobody at the keyboard.

The worker talks to the app over REST with a Bearer token and never touches MongoDB directly: the
app runs on Railway while the checkout lives on a laptop behind NAT, and a machine executing
agent-written code has no business holding database credentials.

> **Mid-migration:** this branch is moving worker identity to server-side registration. The
> Configuration table and Registration section below describe the target shape, but `main.ts`
> still requires the pre-migration `CP_PROJECT_ID` and `CP_REPO_PATH` (it exits with `CP_REPO_PATH
> is required` without them) and does not yet read `CP_WORKER_NAME`. Set both the old and new
> variables until this note is gone.

## How one task runs

```
claim → worktree → claude -p → clean-tree check → gates → push → PR → merge → done
```

Every step reports to the board, so the task's comments are the run log.

The gates run in cost order, cheapest first, and the first rejection stops the run:

| Gate | Rejects when |
|---|---|
| `diff-size` | the diff is larger than `CP_MAX_DIFF_LINES` or `CP_MAX_DIFF_FILES` |
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

| Variable | Required | Default |
|---|---|---|
| `CP_API_URL` | yes | — |
| `CP_API_TOKEN` or `CP_API_TOKEN_FILE` | yes | — |
| `CP_WORKER_NAME` | yes | — |
| `CP_WORKTREE_ROOT` | no | `<repo>/../cp-worktrees` |
| `CP_BASE_BRANCH` | no | `main` |
| `CP_POLL_INTERVAL_MS` | no | `30000` |
| `CP_TASK_TIMEOUT_MS` | no | `1800000` |
| `CP_CONCURRENCY` | no | `1` |
| `CP_MAX_DIFF_LINES` | no | `400` |
| `CP_MAX_DIFF_FILES` | no | `10` |
| `CP_WORKER_ID` | no | `worker-<hostname>` |

`CP_API_TOKEN` must belong to an instance admin. The worker spends it once, to register itself —
every call after that, to `/tasks/claim` and the rest of `/api/workers/**`, authenticates with the
credential registration returns instead. See Registration below.

Claude Code runs on the logged-in CLI session. Never set `ANTHROPIC_API_KEY`, or runs bill per
token instead of drawing on the subscription.

`CP_CONCURRENCY` is parsed and reported but the loop still takes one task per cycle; raising it
needs a worker pool, which is deliberately deferred until the single-task path has run for a while.

## Registration

A worker has no identity until an instance admin registers it and assigns it a project in
`/admin/workers`. Until then it polls but claims nothing: `/tasks/claim` and the rest of
`/api/workers/**` refuse any request without a credential the server itself issued.

On first run the worker registers itself with `CP_API_TOKEN` and persists the response — a
`workerId` and a `cpw_`-prefixed credential — to `<CP_STATE_DIR>/worker.json`, mode `0600`. Every
later run reuses that file; the worker registers again only if the file is missing or the server
rejects its stored credential with 401.

Registration assigns a project, but not a filesystem. The repository path an admin proposes for
this worker must still be approved on this machine, by listing it in `<CP_STATE_DIR>/repos.json`.
A worker pointed at a path outside its own allowlist stays idle, with the reason visible in
`/admin/workers`.

## Running

```bash
npm install && npm run build && npm start
```

As a macOS service:

```bash
cp launchd/com.claudeplanner.worker.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.claudeplanner.worker.plist
```

Put the token in a file only you can read, and point `CP_API_TOKEN_FILE` at it — never in the
plist, which sits at `0644` and rides along into Time Machine:

```bash
install -m 600 /dev/null ~/.claudeplanner/token && pbpaste > ~/.claudeplanner/token
```

The worker refuses to start if that file is readable by group or others. `CP_API_TOKEN` still
works inline for a container, where there is no file to protect.

The plist carries the paths for this machine — check `ProgramArguments` and `PATH` before loading
it anywhere else. Logs go to `/tmp/claudeplanner-worker.log` and
`/tmp/claudeplanner-worker.error.log`.

Stop it with `launchctl unload ~/Library/LaunchAgents/com.claudeplanner.worker.plist`. `SIGTERM`
and `SIGINT` both finish the task in flight before the loop exits.

## Safety

- **Nothing merges unreviewed.** The review gate is a separate Claude with no memory of writing
  the code, and it sees only the diff.
- **Nothing executes before the static gates have read the diff.** `protected-paths` refuses
  changes to `package.json`, lockfiles, `.npmrc`, hooks and workflows *before* the build gate runs
  npm on the worktree, and installs run with `--ignore-scripts`. Cost ordering alone would have
  executed agent-written lifecycle scripts first.
- **No subprocess inherits the worker's secrets.** The child environment is an allowlist, so
  `CP_API_TOKEN` reaches neither the agent nor any dependency's install script. Only delivery,
  which runs our own commands, carries what `git` and `gh` need for the remote.
- **The executor runs with `bypassPermissions` inside the worktree**, so the worktree is checked
  for uncommitted files before the gates run — an agent cannot hide a change from the gates by
  never staging it.
- **A rejected branch is always pushed** before its worktree is discarded; if the push fails the
  worktree is kept and the comment says where it is.
- **Worktrees left by a killed worker are reaped at startup**, but only under `CP_WORKTREE_ROOT` —
  the repository checkout and any worktree of your own are left alone.
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
