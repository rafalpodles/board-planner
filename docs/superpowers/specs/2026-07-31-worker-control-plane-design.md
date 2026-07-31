# Worker control plane — menubar app, live telemetry and fleet console

**Task:** CP-161 · **Depends on:** CP-158 · **Date:** 2026-07-31

## Problem

The execution worker built in CP-158 works and has no face. It is configured by twelve
environment variables and a restart, reports only after the fact through board comments, and
cannot be paused, inspected or reconfigured without a terminal on the machine it runs on. One
worker serves one repository for one project, and that pairing exists only in a plist.

`Project.repository` — `url`, `defaultBranch`, `localPath` — was added by CP-158 and nothing reads
it. `Task.execution` records the worker, the run id, the attempt count and the last error, and
nothing displays it. The data to make the worker legible is already being written; it has nowhere
to go.

The gap this closes is not features. It is **trust in an autonomous process**: the worker merges
to `main` unattended, and today the only way to know what it is doing is to read a log file over
SSH into your own laptop.

## Constraints that shape everything

**The worker runs where the code is.** It needs a git checkout and a logged-in Claude Code CLI
session, so it lives on a laptop while the app lives on Railway. It is behind NAT, so the app
cannot open a connection to it.

**The app cannot host WebSockets.** ClaudePlanner runs on plain `next start` with no custom
server. Next's App Router cannot upgrade a connection without one. SSE, however, is already in
production here — `src/app/api/projects/[projectId]/pm/chat/route.ts` streams `text/event-stream`
today. An outbound SSE connection opened *by the worker* makes NAT irrelevant and lets the server
push instantly.

**Two surfaces that both own state will diverge.** Whatever shape this takes, exactly one store
holds the truth.

## Core decision — split by data type, not by consumer

Three kinds of data flow through this system and they have different needs:

| Data | Owner | Transport | Why |
|---|---|---|---|
| Configuration, commands | Server (Mongo) | SSE down, POST up | One truth, reachable from anywhere, survives reinstalling the Mac |
| Live run telemetry | Worker (in memory) | `127.0.0.1` SSE | Hundreds of events per run; full fidelity, zero network cost, works offline |
| Run outcomes | Server (board) | POST | Durable history, already implemented as task comments |

The loud data stays local; the durable data goes to the server. The menubar panel sees every file
the agent edits because that is two hops away in memory. The web console sees `build · 22s ·
passed` because that is what someone not sitting at the machine needs. **Neither view is wrong —
they differ in resolution, not in truth.**

This resolves the two-surfaces problem without dropping a surface. The menubar app is not a second
control plane; it is the worker's face. Configuration edited there is a `PATCH` to the server,
which pushes it back down over SSE. Neither UI holds authority, so neither can disagree with the
other.

### Alternatives rejected

**Everything through the server.** Uniform and simple, and the menubar app would be just another
API client. Rejected because the agent event stream is hundreds of events per run: shipping it to
Railway is expensive, would have to be throttled, and throttling destroys the one thing that makes
the live view worth building. It also makes the panel useless during a network blip while the
worker keeps working a metre away.

**Everything local, server as a mirror.** Fastest to feel, but configuration then has no single
owner and the divergence problem returns, buried deeper.

## Enabling change

`worker/src/executor.ts` invokes `claude -p` with `--output-format json` and receives one blob when
the run ends. For the entire run — often minutes — the worker knows nothing.

It moves to `--output-format stream-json`, parsing tool-use events as they arrive. The final
schema-validated result is still extracted from the stream, so the existing contract holds.

This is the only place where "live" costs an architectural change, and it is the single source of
the difference between a progress bar and watching an agent work.

## Components

### Worker — four new modules, three changed

| Module | Responsibility |
|---|---|
| `registration.ts` | Registers on boot, heartbeats every 30s, reports version and load |
| `control.ts` | SSE client: receives commands, config updates and `wake` |
| `local-server.ts` | HTTP + SSE bound to `127.0.0.1`, guarded by a local secret |
| `telemetry.ts` | One `emit`, fanned out to the full local stream and a summarised server feed |
| `executor.ts` ⟳ | Parses `stream-json`; emits per-tool activity |
| `config.ts` ⟳ | Env demoted to bootstrap; effective config arrives from the server |
| `pipeline.ts` ⟳ | Emits phase transitions instead of going quiet between gates |

`telemetry.ts` is the only module aware that two channels exist. Everything else calls `emit` and
stays ignorant of where events go. The whole complexity of the chosen split lives in one file, and
is therefore testable in one file.

### App

**New model `Worker`:** name, host, platform, version, `lastSeenAt`, status, assignments
(project → local path), `enabled`, `lockedByInstance`.

`lockedByInstance` follows the precedent set by CP-157 for PM agents: an instance-level kill switch
the project side cannot clear.

**Extended `Task.execution`:** adds `phase` and `phaseStartedAt`, so the web console and the task
card can answer "what is it doing right now" without a new collection.

**`Project.repository` starts being read** — it is dead today — and gains project policy: base
branch, diff thresholds, active gates, model.

**Routes:**

| Route | Purpose |
|---|---|
| `POST /api/workers/register` | Register, receive id and effective config |
| `POST /api/workers/:id/heartbeat` | Liveness, version, load |
| `GET /api/workers/:id/stream` | SSE: `command`, `config`, `wake` |
| `POST /api/workers/:id/events` | Phase transitions and outcomes |
| `GET`/`PATCH /api/workers/:id` | Read and edit worker configuration |
| `GET /api/admin/workers` | Fleet listing |

`wake` has a useful side effect: when the server can say "there is work", picking up a task stops
waiting for the poll interval. **Polling remains as the degraded path** — if SSE drops, control
loses immediacy but work continues.

### Configuration resolution

**Project policy → worker overrides → bootstrap.**

Bootstrap (API URL, token, optional worker name) stays on the machine — in the Keychain for the
menubar app, in the plist or environment for a headless run. It cannot come from the server
because it is what reaches the server.

Everything else is server-owned, including the repository path. A path is machine-specific, but
that makes it a property of the *worker record*, not a reason to keep it in a local file: stored
server-side it is visible from the web console and survives reinstalling the machine.

There are no local overrides beyond bootstrap. Local overrides are what create divergence.

## Surfaces

### Menubar app (SwiftUI `MenuBarExtra`)

Native rather than Electron or Tauri: this is the operator's cockpit and the demo surface, and
platform-native notifications, menu bar behaviour and polish are the point. Cross-platform, if it
is ever needed, is the web console's job — a customer running the worker in a container will never
see this app.

**The icon carries state without a click.** Outline when idle, filled when working, an amber dot
when something waits for a human, red when the worker has lost contact. The title shows
`CP-161 · build 1:42` while working and disappears when there is nothing to say, with a preference
for those who want icon only.

**The panel** — health header, current task, a vertical pipeline stepper, recent agent actions,
controls, and today's tally. The stepper is the substance, not decoration: an autonomous agent is
opaque by nature, and naming each phase with a state and a duration is what makes an eight-minute
black box readable. It also answers the only question actually asked mid-run: *is it stuck or
working?*

Three states the happy path does not show, and which decide how the app feels:

- **Idle** — "Waiting for work · CP · 6 merged today". Confirmation the system is alive, not a
  blank panel.
- **Disconnected** — "Can't reach ClaudePlanner · retrying in 12s" with a retry button.
  Distinguishing "the worker died" from "the network died" leads to entirely different reactions.
- **Needs a human** — the task, the gate that refused, and a button straight to the board.

**Preferences**, four tabs: Connection (URL, token in Keychain, worker name); Repositories (project
→ local path, folder picker, validation that it is a git repo and the branch exists); Policy (per
project — base branch, diff thresholds, gates, model, showing inherited vs overridden); Advanced
(poll interval, timeouts, concurrency, log level, launch at login).

**Notifications** on the four events that mean something — merged, gate rejected, needs human
review, usage limit — with actions in the notification itself.

**First launch** is where a viewer forms their opinion: URL and token → the app discovers projects
→ point at a repository for each → done. No config file, no terminal.

### Web console `/admin/workers`

A sibling of `/admin/agents`, following its pattern: a table of workers with name, host, last seen,
current task and phase, version, an enable toggle and the instance lock. Expanding a row shows the
phase timeline of the current run. Instance-wide defaults, as the agents page already does.

Project settings gains an **Execution** section beside General, Board, Integrations and PM Agent.

### Task card

The cheapest win here: `Task.execution` already holds the worker, the attempt and the last error,
and none of it is visible. A panel on the card shows which worker, attempt 2 of 3, current phase,
elapsed time and last error. No new data — it just stops being hidden.

## Failure modes

**SSE drops.** Reconnect with jittered backoff, degrade to polling, panel shows "retrying". Work
continues; only the immediacy of control is lost.

**Server unreachable at boot.** The worker caches its last known configuration on disk and starts
on it, marked stale, so a Railway hiccup does not stop work. **But not indefinitely**: after 15
minutes without contact it stops claiming new tasks. The reason is specific — `lockedByInstance`
must fail safe. A worker that cannot be reached must not run forever.

**Commands mid-run.** *Pause* finishes the current task and stops claiming. *Stop* kills the run
and returns the task to the queue **with the attempt refunded**, because an operator's decision is
not the task's failure — the same principle already applied to usage limits in CP-158.

**Two workers, one repository.** Registration refuses when another live worker holds the same
project and path. Two processes in one worktree root is guaranteed corruption.

**Local endpoint is an attack surface.** The worker runs an agent with `bypassPermissions`. The
endpoint binds `127.0.0.1` only and requires a local secret, written to `~/.claudeplanner/worker.json`
with mode `0600`. Without this, any process on the machine can drive an agent with write access to
the repository.

**Stale workers.** Version is reported on registration and heartbeat; the console flags workers
running an old build, because a protocol change with a stale worker in the fleet is a silent
failure.

## Testing

Everything except the model stays behind the `Runner` interface, so the suite continues to run
without spawning Claude, touching GitHub or creating a worktree.

- `telemetry.ts` — one `emit`, asserting each channel receives the right fidelity.
- `control.ts` — driven by a synthetic `ReadableStream`, not a network. Covers reconnect,
  malformed frames and the degradation to polling.
- `local-server.ts` — bound to an ephemeral port, with an explicit test that a request without the
  secret is refused and that it never binds a non-loopback interface.
- `registration.ts` — the duplicate-worker refusal, and the 15-minute stale-config cutoff.
- App routes — vitest with mocked Mongoose.

**One rule learned the expensive way on 2026-07-31:** mocked-Mongoose tests do not validate driver
options. An array (aggregation pipeline) update needs `updatePipeline: true`, and a mock accepts it
without. Every pipeline update gets an explicit assertion on the option *and* one exercise against
a real MongoDB. That single gap produced a 500 on the release path that the whole unit suite passed
straight through.

**Live end-to-end** on the rig from CP-158 — local app, scratch repository, stubbed `gh` that
really merges — extended with the menubar app attached, watching a task run from `todo` to `done`
with phases streaming.

## Sequencing

The menubar app comes first as the operator cockpit and demo surface; the web console grows in
parallel as what a customer gets. A cross-platform build is deliberately deferred until it is
demonstrably needed.

Because all state and the entire protocol live server-side, the UI layer stays thin and
replaceable. That is what keeps the cross-platform decision reversible.
