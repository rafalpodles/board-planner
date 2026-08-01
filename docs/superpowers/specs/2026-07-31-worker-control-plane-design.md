# Worker control plane — menubar app, live telemetry and fleet console

**Task:** CP-161 · **Depends on:** CP-158 · **Date:** 2026-07-31
**Revision 2** — rewritten after two independent reviews. The first revision's core premise was
wrong; see *Trust model*.

## Problem

The execution worker built in CP-158 works and has no face. It is configured by twelve environment
variables and a restart, reports only after the fact through board comments, and cannot be paused,
inspected or reconfigured without a terminal on the machine it runs on. One worker serves one
repository for one project, and that pairing exists only in a plist.

`Project.repository` — `url`, `defaultBranch`, `localPath` — was added by CP-158 and nothing reads
it. `Task.execution` records the worker, the run id and the attempt count, and nothing displays it.

The gap this closes is **trust in an autonomous process**: the worker merges to `main` unattended,
and today the only way to know what it is doing is to read a log file on your own laptop.

## Constraints

**The worker runs where the code is.** It needs a git checkout and a logged-in Claude Code CLI
session, so it lives on a laptop while the app lives on Railway, behind NAT. The app cannot open a
connection to it.

**The app cannot host WebSockets.** ClaudePlanner runs on plain `next start` with no custom server.
SSE is already in production here — `src/app/api/projects/[projectId]/pm/chat/route.ts` streams
`text/event-stream`. An outbound SSE connection opened *by the worker* makes NAT irrelevant and
lets the server push instantly.

**The agent is not confined.** It runs with `--permission-mode bypassPermissions` and
`Bash(npm *)`, and `npm exec` is arbitrary command execution. The tool allowlist is a guardrail
against accidents, not a security boundary, and no part of this design may assume otherwise.

**Two surfaces that both own state will diverge.** Exactly one store holds the truth.

## Trust model

The first revision said: *"Everything else is server-owned, including the repository path. There
are no local overrides beyond bootstrap."* That is wrong, and it is wrong in a way that turns a
control plane into a remote code execution channel.

**A repository path is not configuration. It is a capability grant** — it selects which code runs
on the laptop. A directory need only contain a `.git/config` the operator did not write:
`core.fsmonitor`, `core.pager`, `diff.external`, `core.sshCommand` and `filter.*` hold command
strings that git executes. Point a worker at such a directory and `git status` is enough. No model
has to cooperate.

The corrected model, in one sentence:

> The server may say **what work exists** and **stop**; the laptop decides **where anything runs**.

Concretely:

| Decision | Authority | Why |
|---|---|---|
| Which tasks exist, their order, their status | Server | It is the board |
| Whether a worker may claim at all | Server | A kill switch a worker can ignore is not a kill switch |
| Which directory a worker executes in | **Laptop** | It is a capability, and the server is internet-facing |
| Thresholds, gate list, base branch, model | Server | Policy, not capability — worst case is a bad review, not code execution |
| Live telemetry | Laptop | Hundreds of events per run; never needs to leave the machine |

And its mirror: **the agent must hold no credential that lets it answer the "where" question for
itself.** CP-158 already fixed the first half of that — the child environment is an allowlist, so
`CP_API_TOKEN` no longer reaches the agent (`037e4b7`).

## Core split — by data type, not by consumer

| Data | Owner | Transport | Why |
|---|---|---|---|
| Configuration, commands | Server (Mongo) | SSE down, POST up | One truth, reachable from anywhere |
| Live run telemetry | Worker (in memory) | loopback socket | Hundreds of events per run, full fidelity, no network cost |
| Run outcomes | Server (board) | POST, with the CP-158 outbox behind it | Durable history |

The loud data stays local; the durable data goes to the server. The menubar panel sees every file
the agent touches because that is two hops away in memory. The web console sees `build · 22s ·
passed`. The two views differ in resolution, not in truth.

This is why the menubar app is not a second control plane: it is the worker's face. Configuration
edited there is a `PATCH` to the server, which pushes it back down. Neither UI holds authority.

**Rejected — everything through the server.** Uniform, and the menubar app would be just another
API client. But the agent event stream is hundreds of events per run; shipping it to Railway is
expensive, would be throttled, and throttling destroys the thing worth building. It also makes the
panel useless during a network blip while the worker keeps working a metre away.

**Rejected — everything local, server as mirror.** Fastest to feel, but configuration then has no
single owner and the divergence problem returns, buried deeper.

## Identity and enforcement

Today `POST /tasks/claim` takes `workerId` from the request body and writes it to
`execution.workerId` without checking it against anything. It is a label, not an identity. Any
`Worker.enabled` or `lockedByInstance` flag delivered only over SSE is therefore unenforceable:
drop the SSE connection — or change one string in the body — and the lock does nothing.

**A per-worker credential, minted at registration.** `POST /api/workers/register` returns a secret
stored alongside bootstrap (Keychain for the menubar app, a `0600` file otherwise). Every later
call presents it. `workerId` is derived server-side from that credential and **removed from the
claim body**. Identity is server-assigned; `hostname()` is a label, so two MacBooks that both
default to `MacBook-Pro.local` do not collapse into one record.

**The lock is enforced at the claim, in the same request.** Before `Task.findOneAndUpdate`, load
the worker and refuse with 403 unless it is registered, `enabled`, not `lockedByInstance`, has a
fresh `lastSeenAt`, and holds an assignment for that project. Claiming *requires* reaching the
server, so this is the one enforcement point that cannot be starved by dropping SSE.

**The heartbeat carries the verdict too.** A 403 on heartbeat means *abort the run in flight*, not
merely stop claiming. The heartbeat rides the polling path, so it survives SSE loss.

**A protocol version travels with registration and every POST.** The claim refuses an unknown or
missing version — which also refuses a pre-CP-161 worker still running from a plist, closing the
migration hole rather than leaving an invisible worker merging to `main`.

There is a millisecond TOCTOU between the lock check and the claim. It is bounded by
`taskTimeoutMs` and by the heartbeat 403; a two-collection transaction on Mongo 4.4 would buy less
than it costs.

## The repository binding

The server stores a **proposed** path; the worker executes only against paths in a local allowlist
at `~/.claudeplanner/repos.json` (mode `0600`), written by the menubar app's folder picker or by
the operator's editor. A pushed path that is not in the allowlist puts the worker into a visible
"needs approval on this machine" state — the panel already has that shape for *needs a human*.

At adoption, not at use, the worker canonicalises with `realpath` and refuses when:

- the resolved path is not an exact allowlist entry (this kills allowlist-then-symlink-swap);
- the path is not absolute, or contains `..`;
- it sits under `~/Library`, `~/.ssh`, `~/.config`, `~/.claude`, `/etc`, `/System`, or any
  `node_modules` segment;
- `<path>/.git` is missing, or `git rev-parse --show-toplevel` does not return the path itself;
- the owner is not the worker's uid, or it is group- or world-writable.

Then, before anything else runs in a newly bound repository: `git config --local --list` must not
set `core.fsmonitor`, `core.pager`, `core.sshCommand`, `core.hooksPath`, `diff.external`,
`filter.*.clean`, `filter.*.smudge` or `alias.*`. Every git invocation passes
`GIT_CONFIG_NOSYSTEM=1 -c core.fsmonitor=false -c core.pager=cat`.

`worktreeRoot` derives from the validated path and is never independently settable. **No repository
URL is ever accepted for cloning** — `Project.repository.url` may be displayed and nothing more.

`Project.repository.localPath` is **deprecated and removed**. A path belongs to a worker, not a
project; with two workers on one project it is not even well defined. `url` and `defaultBranch`
remain as project policy.

## Configuration resolution

**Project policy → worker overrides → bootstrap**, with the repository binding sitting outside the
chain as a capability the laptop grants.

Bootstrap is the API URL and the credentials; it cannot come from the server because it is what
reaches the server.

## API authorization

The natural implementation — `withProjectAccess` on `/api/workers/:id` — is wrong: it admits any
project member, including any token scoped to that project. CP-157 got this right and its comment
says why, so this copies `admin/agents/[projectId]/route.ts` rather than the project routes.

| Field | Who |
|---|---|
| Assignments, `enabled`, `lockedByInstance`, gate list, base branch | Instance admin (`withAdmin`) |
| Diff thresholds, model, poll interval | Project admin (`withProjectAdmin`) |
| The executing path itself | Nobody over the API — the local allowlist is the authority |

Bodies are validated field by field with an explicit switch; no `$set` from a request-shaped
object. Every change is written to `projectAuditLog` with the acting user — a silent retarget is
the whole point of the attack. Scoped tokens are refused outright for worker writes: retargeting a
laptop should require an interactive admin session.

## Components

### Worker — new modules

| Module | Responsibility |
|---|---|
| `registration.ts` | Registers, holds the credential, heartbeats, handles a 403 as abort |
| `control.ts` | SSE client: commands, config, `wake`; reconnect with jittered backoff |
| `local-server.ts` | Unix domain socket at `~/.claudeplanner/worker.sock` (`0600`) |
| `telemetry.ts` | One `emit`, fanned out at two fidelities |
| `repos.ts` | The local allowlist, canonicalisation and the refusal rules above |

### Worker — changed

`executor.ts` (stream parsing, prompt on stdin), `config.ts` (env demoted to bootstrap),
`pipeline.ts` (emits phases, checks the abort signal), `exec.ts` (streaming callback, `AbortSignal`,
stdin), every gate and `delivery.ts` (they receive the signal).

The first revision claimed `telemetry.ts` would be the only module aware of two channels. That was
wishful: `reporter.ts` is already a server channel with its own offline handling, and `exec.ts`
must learn to stream. The honest claim is narrower — **`telemetry.ts` is the only module that
decides fidelity per channel.**

### Stopping actually stops

`RunOpts` has no cancellation primitive, so "stop kills the run" is currently unimplementable: a
stop arriving during a ten-minute `npm run build` would be noticed eight minutes later, after the
merge. `RunOpts` gains `signal?: AbortSignal`; one `AbortController` per run is threaded through
`PipelineDeps`; `pipeline.ts` checks between phases.

**Stop implies pause.** Otherwise: stop → release with refund → the loop `continue`s without
sleeping → `claim` sorts by `{order, createdAt}` and hands back the same task → the run restarts
with the attempt refunded, forever. Stop returns the task to the queue *and* the worker stops
claiming until the operator resumes.

### The `stream-json` migration

`executor.ts` moves from `--output-format json` to `stream-json`, which is what makes live activity
possible. Two things break unless done deliberately:

**The parser.** `extractEnvelope` slices from the first `{` to the last `}`, which across NDJSON
spans from the `init` message to the final `result` and is not valid JSON. Parsing must be
line-framed with a `StringDecoder` (a multi-byte character split across chunk boundaries otherwise
corrupts exactly the line that carries the contract), keeping the last `result` event and a bounded
ring buffer — not the whole of stdout, which for a thirty-minute run is now every file the agent
read.

**Usage-limit classification.** `isUsageLimit` scans all of stdout. Harmless today, because stdout
holds only the final result. With a stream it holds file contents — and the phrase
`usage limit reached` appears in eight files of this repository. An agent reading `executor.ts`
would produce a false usage limit, which releases *with the attempt refunded*, and the loop
`continue`s without sleeping: an unbounded free loop, on precisely the tasks this worker exists to
do. Classification must key on the typed stream event (`type === "result"`, `subtype`), never on
raw text. The same applies to `hitUsageLimit` in `pipeline.ts`.

## Data model

**`Worker`:** server-assigned id, credential hash, name, host, platform, version, protocol version,
`lastSeenAt`, `enabled`, `lockedByInstance`, assignments (project → *proposed* path), and
`command` / `commandIssuedAt` / `commandAckedAt`.

Commands need desired *and* applied state. Without it the console says "Paused" the instant the
`PATCH` returns, while the worker is five minutes into a thirty-minute run — and twenty minutes
later a merge lands. The UI renders "Pausing…" until acknowledged, and surfaces "not acknowledged
for Xs".

**`Task.execution`** gains `phase`, `phaseSeq` and `phaseStartedAt`. `runId` must travel in
`ClaimedTask` — today it is generated inline in `loop.ts` and discarded — because without it a
buffered event from a dead run overwrites the phase of a live one, and without `phaseSeq` two
instant gates can land out of order and stick. Writes are conditional on matching `runId` and a
greater `seq`. Terminal statuses clear `phase`, or a merged task shows "build · 4h ago" forever.

## Surfaces

### Menubar app (SwiftUI `MenuBarExtra`)

Native, because this is the operator's cockpit and the demo surface. Cross-platform, if ever
needed, is the web console's job.

The icon carries state without a click: outline when idle, filled when working, amber when
something waits for a human, red when contact is lost. The title shows `CP-161 · build 1:42` while
working.

The panel: health header, current task, a vertical pipeline stepper, recent agent actions,
controls, today's tally. The stepper is the substance — it makes an eight-minute black box readable
and answers the only question asked mid-run: *stuck or working?*

Three states decide how it feels: **idle** ("Waiting for work · CP · 6 merged today"),
**disconnected** ("Can't reach ClaudePlanner · retrying in 12s" — distinguishing a dead worker from
a dead network), and **needs a human**.

Preferences: Connection (URL, credential in Keychain), Repositories (the local allowlist, with the
folder picker as the only way to add one), Policy (per project, inherited vs overridden), Advanced.
`CP_CONCURRENCY` is **not** exposed: the loop is sequential and the panel has no representation for
more than one run.

Notifications on merged, gate rejected, needs human review, usage limit.

First launch: URL and credential → discover projects → point at a repository for each → done.

### Local socket

A unix domain socket rather than a TCP port, which removes browser reachability entirely — nothing
to rebind to, no `Host` header to validate.

**It is read-only plus fail-safe commands.** `GET /status`, `GET /stream`, `GET /logs`, and only
`pause` and `stop`. No `run`, no `reload-config`, no path or branch parameter, ever. The local
secret is worthless against the agent — same uid, and `0600` defends against other users, which the
agent is not. Designing the socket so it *cannot* redirect the worker is what makes that
irrelevant: full compromise buys watching a run and stopping it.

### Web console `/admin/workers`

A sibling of `/admin/agents`: name, host, last seen, current task and phase, version, enable
toggle, instance lock. Row expands to the phase timeline. Project settings gains an **Execution**
section.

### Task card

Shows worker, current phase and elapsed time. It does **not** promise "last error":
`execution.lastError` is only ever written as `""`, so the panel would always be empty — either
`reporter` starts writing it (new data, not free) or the card does not offer it. Nor "attempt 2 of
3": `attempts` is decremented on refund, so it is a budget counter, not an ordinal.

## Failure modes

**SSE drops.** Reconnect with jittered backoff; degrade to polling. The stream carries `: ping`
every 15s, as `pm/chat` does, or a proxy will cut it silently and the degradation goes unnoticed.

**Server unreachable.** The worker caches config and starts on it, marked stale. The first
revision's "worker stops claiming after 15 minutes" is dropped as a *control* — a promise a stale
or compromised worker will not keep, and redundant anyway, since a claim already requires reaching
the server. Server-side enforcement replaces it; the worker-side timer stays as a courtesy.

**Merging to `main` redeploys the app.** Railway auto-deploys from `main`, so a successful run
kills the worker's own control channel: SSE drops and the report lands during a 502 window. CP-158
already made reports survive this (`74a5848`, outbox); the panel must expect the disconnect rather
than presenting it as a fault.

**Commands mid-run.** Pause finishes the current task. Stop aborts it and requeues **with the
attempt refunded** — an operator's decision is not the task's failure — and stops claiming.

**Two workers, one repository.** Registration refuses when another live worker holds the same
project and path *on the same host*, deduplicated by `git rev-parse --git-common-dir` after
realpath rather than by the configured string. Scoping to host matters: with a self-asserted claim
anyone could squat a pairing and lock the real worker out. An instance admin can force takeover.

**Reaping.** `reapOrphans` force-removes every worktree under the root; with two workers sharing a
root that kills a live one. The root is per-worker.

## Telemetry and leakage

The server feed is an **allowlist of scalars** — `{tool, phase, path, bytesRead, bytesWritten,
durationMs, exitCode, ok}` — and the summarised event type is shaped so it *cannot* represent a
content field. Otherwise `stream-json` puts `Read` results, `Edit` payloads and `Bash` stdout into
Mongo, where every project member can read them and the PM agent pulls them into context.

Board comments already leak today: gate rejections carry `outputTail`, which contains absolute
paths (`/Users/rpo/…`), dependency versions and anything a build script echoes. Scrubbing goes in
`reporter.ts` centrally — `$HOME` → `~`, strip `https://[^@]*@`, drop lines matching `ghp_`, `cp_`,
`sk-`, `AKIA`, `-----BEGIN`.

The phase/event collection gets a TTL index (30–90 days). Nothing else bounds it.

The prompt and the full diff currently travel through `argv`, readable by any local process via
`ps`. While `executor.ts` is being changed anyway, they move to stdin.

## Testing

Everything except the model stays behind `Runner`, so the suite runs without spawning Claude.

- `telemetry.ts` — one `emit`, asserting fidelity per channel, and **one negative test**: feed the
  local channel an event containing a known secret and assert the server channel's serialised
  output does not contain it.
- `control.ts` — a synthetic `ReadableStream`: reconnect, malformed frames, degradation to polling.
- `local-server.ts` — an ephemeral socket; explicit tests that a request without the secret is
  refused, that no state-changing route exists beyond pause and stop, and that no TCP port is bound.
- `repos.ts` — each refusal rule, including allowlist-then-symlink-swap and hostile `git config`.
- `registration.ts` — the claim 403 matrix (unregistered, disabled, locked, stale, wrong project),
  and the heartbeat 403 aborting a run in flight.
- `executor.ts` — a `stream-json` fixture whose file contents contain `usage limit reached`,
  asserting it is **not** classified as a usage limit.

**The rule learned on 2026-07-31:** mocked-Mongoose tests do not validate driver options. An array
update needs `updatePipeline: true` and a mock accepts it without. Every pipeline update gets an
assertion on the option *and* one exercise against a real MongoDB. That gap produced a 500 on the
release path that the whole unit suite passed straight through.

**Live end-to-end** on the CP-158 rig — local app, scratch repository, stubbed `gh` that really
merges — with the menubar app attached, exercising pause, stop and the instance lock.

## Already fixed in CP-158

So the plan does not redo them: the executor and gate environments are an allowlist (`037e4b7`);
`npm ci --ignore-scripts` and the `protected-paths` gate run before anything executes; undelivered
reports persist and drain; abandoned tasks are freed by lease expiry (`74a5848`).

## Sequencing

Server side first — the `Worker` model, registration, claim enforcement — because everything else
is a client of it and it is the part that makes the design's safety claims true. Then the worker's
new modules, then the menubar app, then the console.

Since all state and the protocol live server-side, the UI layer stays thin and replaceable, which
is what keeps the cross-platform decision reversible.
