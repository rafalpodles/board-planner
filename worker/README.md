# ClaudePlanner execution worker

Claims approved tasks, runs Claude Code headless in an isolated git worktree, enforces the merge
gates and carries a task through to `done` — with nobody at the keyboard.

The worker talks to the app over REST with a Bearer token and never touches MongoDB directly: the
app runs on Railway while the checkout lives on a laptop behind NAT, and a machine executing
agent-written code has no business holding database credentials.

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
| `CP_PROJECT_ID` | yes | — |
| `CP_REPO_PATH` | yes | — |
| `CP_WORKTREE_ROOT` | no | `<repo>/../cp-worktrees` |
| `CP_BASE_BRANCH` | no | `main` |
| `CP_POLL_INTERVAL_MS` | no | `30000` |
| `CP_TASK_TIMEOUT_MS` | no | `1800000` |
| `CP_CONCURRENCY` | no | `1` |
| `CP_MAX_DIFF_LINES` | no | `400` |
| `CP_MAX_DIFF_FILES` | no | `10` |
| `CP_WORKER_ID` | no | `worker-<hostname>` |

`CP_API_TOKEN` is a ClaudePlanner API token scoped to the project. `CP_PROJECT_ID` accepts either
the project key or its ObjectId — tasks are named from the project's own key either way.

Claude Code runs on the logged-in CLI session. Never set `ANTHROPIC_API_KEY`, or runs bill per
token instead of drawing on the subscription.

`CP_CONCURRENCY` is parsed and reported but the loop still takes one task per cycle; raising it
needs a worker pool, which is deliberately deferred until the single-task path has run for a while.

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

The plist carries the paths for this machine — check `ProgramArguments`, `CP_REPO_PATH` and `PATH`
before loading it anywhere else. Logs go to `/tmp/claudeplanner-worker.log` and
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
