# CP-161 part B — execution telemetry

Revision 2. Revision 1 (`cb51cc9`) was reviewed independently and came back with six Criticals. The
root cause of half of them was the same: **it planned a migration to an output format nobody had
observed.** Every event shape in it was invented.

This revision is built on a captured transcript, committed as a fixture, and it states plainly where
observation stops and inference begins.

Part A gave the server the ability to say *stop*. Part B gives the human the ability to see *what is
happening right now* — on the board, and in the menubar app.

## What was measured before writing this

A real `claude -p` run with the executor's own flags, captured to
`worker/src/__fixtures__/stream-success.ndjson` (system events and thinking blocks redacted,
everything else verbatim). What it settles:

| Question | Answer | Consequence |
|---|---|---|
| Does `stream-json` need `--verbose` under `-p`? | **Yes.** The CLI refuses: `When using --print, --output-format=stream-json requires --verbose` | Revision 1 omitted it. Its first commit would have failed *every* run and drained the retry ladder on every queued task. |
| What is the usage-limit signal? | A first-class **`rate_limit_event`** carrying `rate_limit_info: {status, resetsAt, rateLimitType, utilization, isUsingOverage, surpassedThreshold}` | Revision 1 invented `result.subtype === "error_usage_limit"`. It does not exist. |
| Domain of `status`? | `"allowed" \| "allowed_warning" \| "rejected"` (CLI binary: 68 / 15 / 82 occurrences) | `"rejected"` is the hard signal. |
| Domain of `result.subtype`? | `"success" \| "error_max_turns" \| "error_during_execution"` | No usage-limit subtype. Confirms the above. |
| Does `--json-schema` survive? | Yes — payload still arrives as a **string** in the final `result` event's `result` field. There is also a pre-parsed `structured_output` object. | `extractResultPayload` survives; only envelope selection changes. |
| Is file content really in stdout? | **Yes.** The fixture contains `1\texport const answer = 41;` verbatim inside a `tool_result`. | The poisoning risk below is measured, not theoretical. |
| How large is the stream? | 115 KB for a one-line edit — but **91% is the `system` init event** (91 tools, 142 slash commands, 139 agents, 80 skills). | The size story is a *fixed ~100 KB header*, not growth proportional to the task. This kills the case for a global cap. |

**Still unobserved:** an actual `status: "rejected"` event, and the exit-1/empty-stdout variant. Both
are already encoded in `worker/src/executor.test.ts` (`:103-112` and `:61-70`) from earlier real runs.
**Those two tests are the specification. This plan does not delete them.**

## The trap, stated once

`isUsageLimit` (`worker/src/executor.ts:30`) scans the *whole* of stdout for `usage limit reached`.
Today stdout is one result blob, so that is safe. After the migration stdout carries the content of
every file the agent read — and that phrase appears in **eight files of this repository**, including
`executor.ts` itself.

An agent working on the worker reads its own source → false usage limit → `release({refund: true})` →
the loop `continue`s **without sleeping**. An unbounded, free retry loop, triggered precisely by the
tasks this worker exists to run.

The fix is not a better regex. It is: **classify from typed events, never from raw text — except
stderr, which structurally cannot carry file content.**

## Loose ends from part A, honestly

Part A closed C1–C3. **C4 is still open**: worker registration is `withAdmin`
(`src/app/api/workers/register/route.ts:8`), so the laptop holds an instance-admin token, and the
agent — running `bypassPermissions` with `Read` — can read it off disk and lift its own kill switch.
`grep -i enrol` returns nothing in this repo. rpo has deferred the one-time enrolment token to a
separate conversation.

**This plan does not paper over it.** Revision 1's Task 4 justified the socket design with "the worst
an agent gains by reading the secret is the ability to watch a run and stop it." That was false while
C4 is open. It is deleted, and the socket is designed as if the secret were already compromised —
because it effectively is.

---

## Task 1 — migrate to `stream-json`, classify from events

**Files:** `worker/src/stream.ts` (new), `worker/src/stream.test.ts` (new), `worker/src/executor.ts`,
`worker/src/executor.test.ts`, `worker/src/__fixtures__/stream-success.ndjson` (committed).

**Consumes:** nothing. **Produces:** `parseStream`, and a correct `RunOutcome` for the same inputs as
today.

Format change and every consumer fixed **in one commit**. No window where `main` is broken.

**Step 1 — `stream.ts`.** `parseStream(stdout: string): StreamEvent[]`. Split on newlines, `JSON.parse`
each non-empty line, **skip unparseable lines rather than throwing** — a partial final line is normal
when a process is killed. Narrow on `type`: `system`, `assistant`, `user`, `rate_limit_event`,
`result`. Unknown types pass through as `{type: string}` and are ignored by callers; the CLI adds
event types between versions and an unknown one must never be fatal.

**Step 2 — flags.** `--output-format json` → `--output-format stream-json --verbose`. Nothing else in
the argv changes.

**Step 3 — envelope selection.** Replace `extractEnvelope`'s "first `{` to last `}`" slice — which
across NDJSON yields invalid JSON and would make *every* run `{kind:"error"}` — with: take the **last**
event whose `type === "result"`. `extractResultPayload` stays; the fixture proves the payload is still
a JSON string in `result`.

**Step 4 — classification, in this order.** After `timedOut`:

1. Any `rate_limit_event` with `rate_limit_info.status === "rejected"` → `{kind: "usage_limit"}`.
2. Else final `result` has `is_error === true` **and** the phrase matches **its own `result` field
   only** (not the stream) → `{kind: "usage_limit"}`. The exit-0 case at `executor.test.ts:103-112`.
3. Else `isUsageLimit(result.stderr)` → `{kind: "usage_limit"}`. **Keep this.** stderr carries CLI
   diagnostics, never file content, and it is the only signal in the exit-1/empty-stdout case at
   `executor.test.ts:61-70`.
4. Else parse the payload as today.

**Delete `isUsageLimit(result.stdout)` and nothing else.** That single call is the vulnerability.

**Step 5 — `pipeline.ts` is out of scope.** Revision 1 said "the same applies to `hitUsageLimit` in
`pipeline.ts`". It does not. The review gate (`worker/src/gates/review.ts:126`) still uses
`--output-format json`, so its stdout is still one blob and the text scan there is both safe and
load-bearing. Removing it turns a reviewer hitting a subscription limit into a *gate rejection*:
branch pushed, "blocked at the review gate" comment, human summoned to a billing event. Leave it.

**Step 6 — tests, all from the fixture.**
- `parseStream` on the fixture returns 11 events, last one `type: "result"`.
- A truncated fixture (drop the final 20 bytes) still parses every complete line.
- An unknown `type` is preserved and ignored.
- `executor` on the fixture returns `{kind: "result"}` with the parsed payload.
- **Poisoning test:** a fixture whose `tool_result` contains the literal `usage limit reached` while
  the final `result` is a clean success → `{kind: "result"}`.
  *Mutation check: restore the stdout scan and confirm this test fails.*
- **Both existing usage-limit tests, translated to stream shape, still pass.** Not deleted. If a
  translated test cannot be made to pass, **stop and report** — that means the classification is
  wrong, not the test.
- `rate_limit_event` with `status: "rejected"` → `{kind: "usage_limit"}`.
- `rate_limit_event` with `status: "allowed_warning"` → **not** a usage limit. This is the one in the
  real fixture; treating a warning as a limit would stall the queue at 75% utilization.

**No stdout cap in this task.** Revision 1 added a 256 KB tail to `exec.ts` claiming "every existing
consumer reads error output". False, and the consequence is a silently weakened security gate:
`diff.ts:22` returns stdout as the **payload** of `git diff --numstat`, whose output is sorted by path
— so a head-truncating tail drops exactly the dot-directories `.claude/`, `.github/workflows/`,
`.husky/`. `protectedPathsGate` reads `diff.changedFiles`, so it stops seeing them, and `buildGate`
then runs npm on a worktree with a swapped `package.json`. `delivery.ts:97` `JSON.parse`s stdout;
`repos.ts:180` compares it exactly. If a cap is ever needed it is `RunOpts.maxStdoutBytes`, opt-in,
set only on the `claude` call, with an explicit `CommandResult.stdoutTruncated` flag — never a silent
global tail. The measurement above shows it is not needed: the bulk is a fixed header.

**Gate:** `npm test && npm run build` in `worker/`, plus one real end-to-end run through the rig
confirming a task still reaches `done`.

---

## Task 2 — `telemetry.ts`: a typed bus with a structurally safe summary

**Files:** `worker/src/telemetry.ts` (new), `worker/src/telemetry.test.ts` (new).

**Consumes:** `StreamEvent` from Task 1. **Produces:** `Telemetry` — consumed by Tasks 4 and 6.

**Step 1 — two types, and the whole safety argument lives in their shape.**

```ts
export interface ToolActivity { name: string; target?: string }        // "Edit", "src/foo.ts"
export interface Progress { phase: Phase; tool?: ToolActivity; turns: number; costUsd?: number }
export interface Quota { status: "allowed" | "allowed_warning" | "rejected";
                         utilization: number; resetsAt: number; rateLimitType: string }
```

`ToolActivity.target` is a **path or identifier, never content**. The summarised type is
*structurally incapable* of carrying file bodies, prompts or diffs. That is the guarantee — not a
scrubbing pass over a rich type, which is a filter that has to be right every single time.

**Step 2 — `summarise(event): Progress | Quota | null`.** From `assistant` events with `tool_use`
content, take `name` plus a target derived only from a whitelist of input keys (`file_path`, `path`,
`pattern`, `command` → **first word only**). Everything else dropped. From `rate_limit_event`, map to
`Quota`. From `result`, take `num_turns` and `total_cost_usd`. Everything else → `null`.

**Step 3 — the bus.** `subscribe(fn)`, `emit(event)`, `recent(): Progress[]` over a bounded ring
buffer of 50. Two sinks, both wired in Task 6. **No ring buffer in `stream.ts`** — revision 1 put one
there with no consumer; `telemetry.recent()` is the only one.

**Step 4 — failure policy, fixed here so no implementer invents it.** The server sink is
fire-and-forget: at most one POST in flight, excess **dropped not queued**, `.catch(() => {})` on
every call. Phase events are not reports — a lost one costs a stale UI for seconds, while an unhandled
rejection from a synchronous `emit` in `pipeline.ts` exits the process under Node 22. Deliberately
**no outbox**; `reporter.ts` has one because a lost *report* strands a task.

**Step 5 — the test that actually proves it.** Build a **full** `tool_use` event whose input contains
a secret (`{file_path: "x.ts", content: "TOKEN=cpw_deadbeef…"}`), run it through `summarise`, assert
`JSON.stringify(result)` does not contain it. Revision 1 asserted on `toServer.mock.calls` after
emitting a tool event — which passes trivially if tool events never reach the server at all, proving
nothing about the type.

---

## Task 3 — phase on the task, **and the client that gets it there**

**Files:** `src/models/task.ts`, `src/lib/task-service.ts`,
`src/app/api/workers/[workerId]/events/route.ts` (new) + test, `worker/src/api.ts`,
`worker/src/api.test.ts`, `src/types/index.ts`.

**Consumes:** Task 2's `Progress`. **Produces:** `execution.phase`, and `api.postEvent()` — consumed
by Tasks 6, 7, 8.

**This task owns the transport end to end.** Revision 1 split it: route in one task, wiring in
another, and **no task at all** added the HTTP client — while `api.ts:141`'s `send()` hardcodes
`${apiBaseUrl}/api/projects/${projectId}${path}` and structurally cannot address `/api/workers/...`.
That is ledger line 90 repeating verbatim: *"task 3 built the field, task 10 built the consumer,
neither owned the join."* All four whole-branch Criticals in part A lived in exactly this kind of seam.

**Step 1 — schema.** On `Task.execution`: `phase?: string`, `phaseAt?: Date`, `phaseSeq?: number`.
Add `runId?: string`, assigned **server-side at claim** and returned in `ClaimedTask` — the worker
reads it from the claim response (`raw.execution?.runId`), it does not mint its own.

**Step 2 — the endpoint.** `POST /api/workers/[workerId]/events` wrapped in **`withWorker`**, which
already 403s a mismatched `params.workerId` (`src/lib/middleware.ts:52`). Revision 1 specified no auth
at all — that would allow writing `execution.phase` on any task in the instance. Update filter:
`{_id: taskId, "execution.workerId": String(worker._id), "execution.runId": runId}` — **the run is the
authorization**, so a stale worker cannot write to a task it no longer holds.

**Step 3 — ordering.** Guard with
`$or: [{"execution.phaseSeq": {$exists: false}}, {"execution.phaseSeq": {$lt: seq}}]`. A bare `$lt`
never matches a missing field, so every pre-existing task would silently drop its first phase — the
trap is already documented 20 lines away at `src/lib/task-service.ts:582-588`.

**Step 4 — clearing.** Phase must clear on **every** exit from active, not just `changeStatus`
(`:137`): `updateTask` (`:302`, the PUT form path), `releaseTask` (`:604`), `releaseExpiredTasks`
(`:532`). A gate rejection lands in a `review`-role column, not `done` — so the most common non-merge
outcome is precisely the one revision 1's "terminal status" wording missed, and it would leave a
frozen "running tests" badge forever.

**Step 5 — the client.** `api.postEvent(workerId, body)` in `worker/src/api.ts`, using the **worker
credential** (`cpw_`), not the API token, addressing `/api/workers/...` — which needs a second
base-path helper alongside `send()`. Test asserts the URL and the `X-Worker-Id` / auth headers.

**Step 6 — the test that catches the seam.** One worker-side test asserting the `runId` from
`api.claim` reaches the `postEvent` payload. Note `worker/tsconfig.json:13` excludes
`src/**/*.test.ts` and vitest transpiles without typechecking, so adding a field to `ClaimedTask`
raises **no error** in the ~10 fixture-bearing test files — `task.runId` would simply be `undefined`
everywhere and every server-side test would pass on a hand-written value. Nothing but this test
notices.

---

## Task 4 — local socket, designed as if the secret is already gone

**Files:** `worker/src/local-server.ts` (new) + test, `worker/src/main.ts`, `worker/src/config.ts`.

**Consumes:** Task 2's `Telemetry`, and **`CommandHandlers`** from `worker/src/commands.ts`.

**Step 1 — transport.** Unix domain socket at `${CP_STATE_DIR}/worker.sock`, mode `0600`, unlinked on
startup and at exit. Not a TCP port: a port is reachable by every process on the machine and by
anything that can make a browser issue a request to localhost.

**Step 2 — `CommandHandlers`, not `Loop`.** Revision 1 had the socket call `loop.pause()` directly.
That bypasses both the ack — the console would sit on "Pausing…" forever — and the `lastAppliedAt`
recency guard that `commands.ts:48-64` owns and that part A needed a separate round to get right.
Ledger line 70: *stop = abort + `loop.pause()`, never `loop.stop()`*. The socket goes through the same
door as the server channel or it drifts from it.

**Step 3 — a closed route list.** `GET /status`, `GET /stream` (SSE of `Progress`), `POST /pause`,
`POST /resume`, `POST /stop`. Anything else → 404. **No `GET /logs`** — revision 1 specified it with no
source; the worker has no log file, everything goes to `console.error` and thence to launchd.

**Step 4 — the honest security statement.** Filesystem permissions are the whole boundary. While C4 is
open the agent runs as the same uid and can reach this socket; it could pause its own worker. It
cannot escalate through it — the socket exposes no repository binding, no credential, and no route
that starts work. That is the actual claim, and it is smaller than revision 1's.

**Step 5 — extract the wiring factory here.** `main.ts` has no test file. Revision 1 had Task 4 add
untested wiring to it and Task 6 rewrite that wiring two commits later, leaving the seam open in
between. The extraction moves **into this task**, so no task ever adds untested code to `main.ts`.

---

## Task 5 — scrub what still reaches the board

**Files:** `src/lib/scrub.ts` (new) + test, `worker/src/reporter.ts`, `worker/src/pipeline.ts`.

Task 2 makes telemetry structurally safe. This covers the other path: gate output and error messages,
which are free text and land in task comments.

**Step 1 — anchored patterns; redact the match, not the line.**
`ghp_[A-Za-z0-9]{36}`, `cpw?_[a-f0-9]{32,}`, `sk-ant-[\w-]{20,}`, `Bearer [A-Za-z0-9._~+/-]{20,}`.
Revision 1 used a bare `sk-`, which matches `ta`**sk-**`service`, `ri`**sk-**`based`, `di`**sk-**`usage`
— and then dropped the whole line, which for a gate rejection is the single most informative line
there is. Replace the match with `[redacted]`; keep the line.

**Step 2 — both call sites.** `reporter.ts`, **and** `pipeline.ts:109`, which publishes a comment
through `deps.api.comment` directly. Revision 1 said "centrally in reporter.ts" and would have missed
the second.

**Step 3 — table-driven test**, each row `{input, mustNotAppear, mustAppear}`. Revision 1's first row
had `mustNotAppear: "~"` — the character that is supposed to survive.

---

## Task 6 — wire telemetry through the run

**Files:** `worker/src/pipeline.ts`, `worker/src/executor.ts`, `worker/src/main.ts` via the Task 4
factory.

`executor` gains an optional `onEvent` called per parsed stream event — which requires `exec.ts` to
expose incremental stdout, so this task adds an `onStdout` chunk callback rather than only resolving
at exit. `pipeline` emits a coarse phase at each stage boundary (`claiming`, `worktree`, `agent`,
`gates:<name>`, `push`, `pr`, `merge`). Both sinks attach in the factory; both tested there.

---

## Task 7 — execution panel on the task detail page

**Files:** `src/components/tasks/TaskDetail.tsx` (+ its existing test), and whatever supplies
`execution` to the client.

Shows: current phase, elapsed since `phaseAt`, worker name, link to the branch. Refreshes on the
page's existing `usePollWhileVisible`.

**Two things it deliberately does not show**, both verified in code:
- **"last error"** — `execution.lastError` is only ever written as `""`
  (`src/lib/task-service.ts:596`), so the field would always be blank.
- **"attempt 2 of 3"** — `attempts` is *decremented* on refund (`:647`), making it a remaining-budget
  counter, not an attempt number.

Better to omit than to render a number that lies.

---

## Task 8 — phase on the board, **including the API that carries it**

**Files:** `src/app/api/admin/workers/route.ts`, `toApiWorker`, `ApiWorker` in `src/types/index.ts`,
`src/app/(app)/settings/workers/page.tsx`.

Revision 1 listed only `page.tsx`, which makes the task **unimplementable**: `GET /api/admin/workers`
returns `Worker` documents through `toApiWorker`, and phase lives on `Task.execution`. The route gains
a lookup — `Task.find({"execution.workerId": {$in: ids}, status: {$in: activeRoles}})` — and
`ApiWorker` gains `currentTask?: {key, title, phase, phaseAt}`.

---

## Tasks 9a / 9b / 9c — three unrelated changes, separated

Revision 1's Task 9 was a junk drawer, and its first item had no writer.

**9a — configurable model.** `WorkerConfig` gains `model`/`fallbackModel`; touches `config.ts`,
`main.ts` (`configFor`, `:63-80`) **and `gates/review.ts:136`**, which hardcodes `--model opus`
separately. Revision 1 listed none of these files.

**9b — process group.** `spawn({detached: true})` plus `process.kill(-pid, …)` for **both** signals in
`terminate()`, tolerating `ESRCH`. The riskiest change in part B, landing directly on the
`exit`/`close` drain part A just added (`worker/src/exec.ts:99-111`). It also changes signal delivery
for children that currently escape it — `pipeline.ts:216-218` deliberately passes no signal to
`gh pr merge`, and a group kill on timeout would now reach it. Its own task, its own tests.

**9c — dropped.** Revision 1's TTL index had nothing to index: this plan stores three scalars on the
task, no phase *history*. A retention policy for a collection nobody writes to is dead code. If phase
history is ever wanted, that is a new design conversation, not a leftover step.

---

## Verification, corrected

Revision 1's list could pass while the thing was broken. Fixed:

1. Task reaches `done` through the rig; phase advances on the board and **clears** — checked for a
   **gate rejection** as well as a merge, since rejection is the common case and lands in `review`.
2. Board console shows the running task's phase (needs Task 8's API change).
3. `nc -U ${CP_STATE_DIR}/worker.sock` returns status; `ls -l` shows `0600`; a process under a
   different uid is refused. *(Revision 1 invoked `cp-worker status`, a command that does not exist —
   `worker/package.json` declares no `bin`.)*
4. **Poisoning, negative:** a task whose diff contains `usage limit reached` completes normally.
5. **Poisoning, positive — the twin revision 1 lacked:** a genuine `rate_limit_event`
   `status: "rejected"` is still classified as a usage limit and **does not** charge the attempt.
   Without this, item 4 passes just as well when usage-limit detection is entirely dead — exactly the
   state revision 1 would have shipped.
6. Secrets in gate output are redacted in the task comment; the surrounding line survives.
7. **Dropped.** Revision 1 asserted no secret appears in any process's argv. It cannot pass: the
   review gate pastes the diff into a prompt passed as an argv element (`gates/review.ts:79-88, :126`),
   and no task here migrates it to stdin. Part A recorded the same shape as *"PLAN DEFECT, mine"*.
   Moving the review gate to stdin is real work and belongs in its own task, not smuggled in as a
   checkbox.

## A capability this plan did not go looking for

`rate_limit_event` carries `utilization`, `resetsAt`, `rateLimitType` and `isUsingOverage` on every
run. That is a live subscription gauge, free — the menubar can show "76% of the seven-day limit,
resets Tuesday" with no extra API call, and the worker could decline to claim new work as it nears the
ceiling instead of discovering it mid-task.

Out of scope here. Worth its own task. It only became visible by capturing the stream instead of
imagining it.
