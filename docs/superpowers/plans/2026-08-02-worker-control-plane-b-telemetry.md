# Worker control plane, part B — telemetry and the live view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an opaque eight-minute run legible. The worker starts reporting what it is doing as it does it — a full-fidelity stream to a local socket, a summarised phase feed to the board — so an operator can answer *stuck or working?* without reading a log file over SSH into their own laptop.

**Architecture:** One `emit` in the worker fans out at two fidelities. The loud data (every file the agent touches) stays on the machine, reachable over a loopback socket that can only read, pause and stop. The durable data (phase transitions, outcomes) goes to the server, where the task card and the fleet console read it. The two views differ in resolution, not in truth.

**Tech Stack:** Node 22+ for the worker, Next.js 16 App Router route handlers, Mongoose 8 on MongoDB 4.4, vitest in both packages.

**Depends on:** part A (`docs/superpowers/plans/2026-07-31-worker-control-plane-a-governance.md`), merged into this branch at `6e4f179`.

## Global Constraints

- **MongoDB 4.4** — no `$dateTrunc`, `$dateAdd`/`$dateDiff`, `$setWindowFields`, no `$lookup` mixing `localField`/`foreignField` with an inline `pipeline`.
- **Any array (aggregation pipeline) update needs `updatePipeline: true`.** Mocked-Mongoose tests do not validate driver options — assert the option explicitly. This gap produced a 500 on the release path that a whole green suite passed.
- Document interfaces use `Types.ObjectId` and expose a separate `Api*` interface for responses.
- Route handlers take `Request`; `context.params` is `Promise<Record<string, string>>`. There is no `Params` type.
- Every git invocation passes `GIT_CONFIG_NOSYSTEM=1` and `-c core.fsmonitor=false -c core.pager=cat`.
- Comments minimal — design rationale belongs in the commit message, not the source.
- English; conventional commits; no trailers or footers.
- No new dependencies without checking `npm ls <name>` first.
- **Every implementation report must quote the `git diff --stat` of its own commit.** In part A a report claimed a removal its commit never made; the diff stat makes report and commit unable to disagree.

## The trap this part walks into

`worker/src/executor.ts` runs `claude -p` with `--output-format json` and reads one blob at the end. Moving to `stream-json` is what makes everything else in this plan possible, and it breaks two things that currently look fine:

**The parser.** `extractEnvelope` slices from the first `{` to the last `}`. Across NDJSON that spans from the `init` message to the final `result` and is not valid JSON, so every run would end as `{kind:"error"}` — requeued, attempt charged, three strikes to human review. The whole queue dies on one flag change.

**The usage-limit heuristic, which becomes self-poisoning.** `isUsageLimit` scans all of stdout. That is safe today because stdout holds only the final result. With a stream it holds the contents of every file the agent read — and the phrase `usage limit reached` appears in eight files of this repository, including `executor.ts` and `pipeline.ts`. An agent working on the worker would read its own source, produce a false usage limit, release **with the attempt refunded**, and the loop would `continue` without sleeping: an unbounded free loop, on exactly the tasks this worker exists to do.

Both are addressed in Task 1, before anything consumes the stream.

---

## File Structure

**Worker**

| File | Responsibility |
|---|---|
| `worker/src/stream.ts` | Line-framed NDJSON reader over a chunk callback; owns the partial-line buffer |
| `worker/src/telemetry.ts` | One `emit`, fanned out at two fidelities; the only module that decides what each channel sees |
| `worker/src/local-server.ts` | Unix domain socket: status, event stream, log tail, and only `pause`/`stop` |
| `worker/src/exec.ts` (modify) | A chunk callback so a caller can consume output as it arrives |
| `worker/src/executor.ts` (modify) | `stream-json`, typed classification, prompt on stdin |
| `worker/src/pipeline.ts` (modify) | Emits phase transitions |
| `worker/src/reporter.ts` (modify) | Scrubs board comments |
| `worker/src/main.ts` (modify) | Wires telemetry and the local socket |

**Server**

| File | Responsibility |
|---|---|
| `src/models/task.ts` (modify) | `execution.phase`, `phaseSeq`, `phaseStartedAt` |
| `src/app/api/workers/[workerId]/events/route.ts` | Accepts phase transitions, conditional on `runId` and `seq` |
| `src/components/tasks/ExecutionPanel.tsx` | Which worker, which attempt, current phase, elapsed |
| `src/app/(app)/settings/workers/page.tsx` (modify) | Phase column, now that there is a phase |

---

### Task 1: `stream.ts` and the `stream-json` migration

The enabling change, and the one that breaks the queue if done carelessly.

**Files:**
- Create: `worker/src/stream.ts`, `worker/src/stream.test.ts`
- Modify: `worker/src/exec.ts`, `worker/src/exec.test.ts`, `worker/src/executor.ts`, `worker/src/executor.test.ts`

**Interfaces:**
- Produces: `createLineReader(onLine: (line: string) => void): { push(chunk: Buffer): void; end(): void }`
- Produces: `RunOpts.onStdout?: (chunk: Buffer) => void`

- [ ] **Step 1: Write the failing test**

`worker/src/stream.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createLineReader } from "./stream.js";

describe("createLineReader", () => {
  it("emits complete lines and holds a partial one", () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    reader.push(Buffer.from('{"a":1}\n{"b":'));
    expect(lines).toEqual(['{"a":1}']);

    reader.push(Buffer.from('2}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  // A chunk boundary inside a multi-byte character corrupts exactly the line carrying the contract
  it("does not corrupt a multi-byte character split across chunks", () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));
    const utf8 = Buffer.from('{"s":"→"}\n');

    reader.push(utf8.subarray(0, 7));
    reader.push(utf8.subarray(7));

    expect(lines).toEqual(['{"s":"→"}']);
    expect(lines[0]).not.toContain("�");
  });

  it("flushes a trailing line with no newline on end", () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    reader.push(Buffer.from('{"a":1}'));
    reader.end();

    expect(lines).toEqual(['{"a":1}']);
  });

  it("skips blank lines rather than emitting empty strings", () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    reader.push(Buffer.from("\n\n{\"a\":1}\n\n"));

    expect(lines).toEqual(['{"a":1}']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run src/stream.test.ts`
Expected: FAIL — cannot resolve `./stream.js`.

- [ ] **Step 3: Implement `stream.ts`**

Use `StringDecoder` from `node:string_decoder` for the partial-character case; a plain `chunk.toString()` splits multi-byte characters at chunk boundaries and produces `U+FFFD` in whichever line happens to straddle one.

- [ ] **Step 4: Give `exec.ts` a chunk callback**

`RunOpts` gains `onStdout?: (chunk: Buffer) => void`, called as data arrives. The accumulated `stdout` string stays for existing callers, but **cap it** — with `stream-json` a thirty-minute run carries every file the agent read, and the current code concatenates without bound. Keep a bounded tail (the last 256 KB is enough for every existing consumer, all of which read error output) and note the truncation in the returned string.

- [ ] **Step 5: Move `executor.ts` to `stream-json`**

Replace `--output-format json` with `--output-format stream-json`. Parse each line as it arrives; keep the **last event whose `type` is `"result"`** and a bounded ring buffer of recent events for telemetry (Task 2 consumes it).

**Classification changes, and this is the part that matters:**

- The final result comes from the typed `result` event, not from slicing the whole of stdout.
- **A usage limit is recognised only from the typed event** — its `subtype`, or whatever field the CLI actually sets. **Never** from scanning raw text. Delete the stdout scan; the same applies to `hitUsageLimit` in `pipeline.ts`, which reads a gate's `reason` string.
- Pass the prompt on **stdin**, not `argv`. `RunOpts.stdin` already exists from part A and is unused. Today the prompt and, in the review gate, the full diff are visible to any process on the machine through `ps`.

- [ ] **Step 6: Write the test that would have caught the self-poisoning**

```ts
it("does not read a usage limit out of file contents the agent happened to print", async () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: "…usage limit reached…" } }),
    JSON.stringify({ type: "user", message: { content: "file says: usage limit reached" } }),
    JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify(RESULT) }),
  ].join("\n");
  const { runner } = runnerStreaming(stream);

  const outcome = await createExecutor(config, runner).execute(task, "/wt");

  expect(outcome.kind).toBe("result");
});

it("recognises a real usage limit from the typed event", async () => {
  const stream = JSON.stringify({ type: "result", subtype: "error_usage_limit" });
  const { runner } = runnerStreaming(stream);

  expect((await createExecutor(config, runner).execute(task, "/wt")).kind).toBe("usage_limit");
});
```

Confirm the first test fails against the old text-scanning classification before you delete it.

- [ ] **Step 7: Run everything and commit**

Run: `cd worker && npx vitest run && npm run build`

```bash
git add worker/src
git commit -m "feat(worker): parse the agent's output as a stream (CP-161)"
```

---

### Task 2: `telemetry.ts` — one emit, two fidelities

**Files:**
- Create: `worker/src/telemetry.ts`, `worker/src/telemetry.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: `createTelemetry(deps): { emit(event: RunEvent): void; subscribe(cb): () => void; recent(): RunEvent[] }`
- Produces: `RunEvent` (full) and `PhaseEvent` (summarised)

- [ ] **Step 1: Write the failing test**

The critical one is negative:

```ts
// The server feed must be shaped so it CANNOT carry content, not merely trimmed of it
it("never lets file contents reach the server feed", () => {
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const toServer = vi.fn();
  const telemetry = createTelemetry({ toServer, ... });

  telemetry.emit({
    kind: "tool",
    tool: "Read",
    path: "src/config.ts",
    input: `a file containing ${secret}`,
    result: `and more ${secret}`,
  });

  expect(JSON.stringify(toServer.mock.calls)).not.toContain(secret);
});

it("gives the local subscriber the full event", () => { /* input and result both present */ });
it("summarises a phase transition for the server", () => { /* {phase, seq, at} only */ });
it("keeps a bounded ring of recent events", () => { /* push 500, expect the cap */ });
it("survives a subscriber that throws", () => { /* one bad subscriber does not stop the others */ });
```

- [ ] **Step 2–4: Implement, run, commit**

The summarised event type must be **structurally incapable** of carrying a content field — build it by naming the fields it may have (`tool`, `phase`, `path`, `bytesRead`, `bytesWritten`, `durationMs`, `exitCode`, `ok`), never by deleting fields from the full event. A redaction someone can forget to apply is not a boundary.

```bash
git commit -m "feat(worker): one emit, two fidelities (CP-161)"
```

---

### Task 3: Phase transitions from the pipeline

**Files:**
- Modify: `worker/src/pipeline.ts`, `worker/src/pipeline.test.ts`, `worker/src/types.ts`, `worker/src/api.ts`
- Modify: `src/models/task.ts`, `src/types/index.ts`
- Create: `src/app/api/workers/[workerId]/events/route.ts` and its test

**Interfaces:**
- Consumes: `telemetry.emit` (Task 2)
- Produces: `POST /api/workers/:workerId/events` accepting `{taskId, runId, seq, phase}`

- [ ] **Step 1: `runId` must reach the pipeline**

It is generated inline in `loop.ts` (`deps.api.claim(randomUUID())`) and thrown away; `ClaimedTask` does not carry it. Without it a buffered event from a dead run overwrites the phase of a live one. Add it to `ClaimedTask` and thread it through.

- [ ] **Step 2: Write the failing tests**

Server side, the conditional write is the substance:

```ts
it("ignores a phase from a run that is no longer the current one", async () => { /* runId mismatch → no write */ });
it("ignores a phase whose seq is not greater than the stored one", async () => { /* two instant gates cannot land out of order */ });
it("clears the phase when the task reaches a terminal status", async () => { /* a merged task must not show "build · 4h ago" forever */ });
```

- [ ] **Step 3–5: Implement, run, commit**

`Task.execution` gains `phase`, `phaseSeq`, `phaseStartedAt`. The write is conditional on `execution.runId` matching and `execution.phaseSeq` being lower. `changeStatus` clears the phase on a terminal move.

```bash
git commit -m "feat(worker): report phase transitions (CP-161)"
```

---

### Task 4: The local socket

**Files:**
- Create: `worker/src/local-server.ts`, `worker/src/local-server.test.ts`
- Modify: `worker/src/main.ts`

**Interfaces:**
- Consumes: `telemetry.subscribe` (Task 2), `Loop` (part A)
- Produces: `startLocalServer(deps): { close(): void }`

- [ ] **Step 1: Write the failing test**

```ts
it("listens on a unix socket, never a TCP port", async () => { /* no port bound */ });
it("refuses a request without the local secret", async () => { /* 401, handler not reached */ });
it("streams events to a connected client", async () => { /* emit → received */ });
it("exposes no route that changes what the worker executes", async () => {
  // Full compromise of the local secret must buy watching and stopping, nothing more
  for (const path of ["/run", "/reload-config", "/config", "/assignments"]) {
    expect((await request(path, "POST")).status).toBe(404);
  }
});
it("pauses and stops", async () => { /* the only two mutating routes */ });
```

- [ ] **Step 2–4: Implement, run, commit**

A **unix domain socket** at `<stateDir>/worker.sock`, mode `0600` — not a TCP port. That removes browser reachability entirely: nothing to rebind to, no `Host` header to validate.

Routes: `GET /status`, `GET /stream`, `GET /logs`, `POST /pause`, `POST /stop`. Nothing else, ever.

Be honest in the module's comment about what the secret is worth: the agent runs as the same uid and can read `<stateDir>` at will, so the secret is no boundary against it. What makes that acceptable is that the socket **cannot redirect the worker** — the worst an agent gains by reading the secret is the ability to watch a run and stop it.

```bash
git commit -m "feat(worker): a loopback socket that can only watch and stop (CP-161)"
```

---

### Task 5: Scrub what reaches the board

**Files:**
- Modify: `worker/src/reporter.ts`, `worker/src/reporter.test.ts`

- [ ] **Step 1: Write the failing test**

Board comments already leak today: gate rejections carry `outputTail`, and `pipeline.ts` puts absolute worktree paths into comments.

```ts
it.each([
  ["/Users/rpo/Documents/Projects/ClaudePlanner/worker", "~"],
  ["https://x-access-token:ghp_secret@github.com/o/r", "ghp_secret"],
])("scrubs %s before it reaches the board", async (input, mustNotAppear) => { … });

it("drops a line carrying something shaped like a credential", async () => {
  // ghp_, cp_, cpw_, sk-, AKIA, -----BEGIN
});
```

- [ ] **Step 2–4: Implement centrally in `reporter.ts`**, not per call site, run, commit.

```bash
git commit -m "fix(worker): stop board comments carrying paths and secrets (CP-161)"
```

---

### Task 6: Wire telemetry into the worker

**Files:**
- Modify: `worker/src/main.ts`, `worker/src/executor.ts`, `worker/src/pipeline.ts`

- [ ] **Step 1–4: Wire, verify, commit**

`main.ts` constructs the telemetry bus once, hands `emit` to the executor and the pipeline, and starts the local socket. This is the join that part A's review showed nobody owns by default — `main.ts` has no test file, and every defect the whole-branch review found lived in a seam only `main.ts` closed. Extract the wiring into a testable factory the way part A's `createRunGuard`/`createCommandHandlers` were extracted, and test it.

```bash
git commit -m "feat(worker): wire telemetry and the local socket (CP-161)"
```

---

### Task 7: The execution panel on the task card

**Files:**
- Create: `src/components/tasks/ExecutionPanel.tsx` and its test
- Modify: the task detail page

- [ ] **Step 1–4: Build, verify live, commit**

Shows: which worker, current phase and elapsed time.

**It does not show "last error".** `execution.lastError` is only ever written as `""` — nothing puts content there — so the field would render empty forever. Either `reporter` starts writing it, which is new data and its own decision, or the panel does not offer it. This plan chooses not to offer it.

**Nor "attempt 2 of 3".** `attempts` is decremented on refund, so it is a budget counter, not an ordinal. Show it as attempts spent, or not at all.

```bash
git commit -m "feat(tasks): show what the worker is doing on the task card (CP-161)"
```

---

### Task 8: The phase column in the fleet console

**Files:**
- Modify: `src/app/(app)/settings/workers/page.tsx`

- [ ] **Step 1–3: Add the column, verify live, commit**

Part A's Task 12 deliberately omitted this because `Task.execution.phase` did not exist. It does now.

```bash
git commit -m "feat(admin): show the current phase in the fleet console (CP-161)"
```

---

### Task 9: Retention and the loose ends part A parked

**Files:**
- Modify: `src/models/task.ts` or a new events collection, `worker/src/exec.ts`, `worker/src/executor.ts`

- [ ] **Step 1: A TTL index on whatever stores phase history**, 30–90 days. Nothing currently bounds it.

- [ ] **Step 2: Kill the process group, not the pid.** From part A's cluster review: `child.kill` signals one process, so a `Bash`-tool grandchild of a killed `claude` can still be writing when `git worktree remove --force` runs. `spawn({detached: true})` plus `process.kill(-pid)` closes that and the inherited-stdio hang together. This was deliberately deferred as too risky to combine with the abort fix; it is safe to do on its own, with the existing abort tests as the net.

- [ ] **Step 3: Wire `EffectiveConfig.model`.** It is parsed, documented as live policy, writable by a project admin — and `executor.ts` hardcodes `"--model","opus"`. A project admin who sets it gets a 200 and no effect.

- [ ] **Step 4: Run everything and commit**

```bash
git commit -m "chore(worker): bound retention, kill the process group, honour the model policy (CP-161)"
```

---

## Verification for part B

On the CP-158 rig, with the scratch repository under `~/cp-rig/`:

1. A run's phases appear on the task card as they happen, and the card stops showing a phase once the task is done.
2. The fleet console shows the same phases, one resolution coarser.
3. `cp-worker status` — or a plain `curl --unix-socket` — streams the agent's file-by-file activity live.
4. The same request without the local secret is refused, and no TCP port is listening.
5. A task whose description makes the agent read `worker/src/executor.ts` completes normally — **it does not produce a false usage limit**, which is the failure this plan's Task 1 exists to prevent.
6. A gate rejection comment on the board contains no absolute path and no token-shaped string.
7. `ps` during a run shows no prompt and no diff in the command line.

Part C — the menubar app — gets its own plan, written after this one has been reviewed.
