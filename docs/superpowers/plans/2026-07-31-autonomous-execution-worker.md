# Autonomous Execution Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone worker process that claims `todo` tasks, runs Claude Code headless in an isolated git worktree, enforces four merge gates and carries the task to `done` without a human.

**Architecture:** New `worker/` package beside `mcp-server/`. It polls the app over REST with a Bearer token and never touches MongoDB — the app runs on Railway while the git checkout lives on a laptop behind NAT. Per task: atomic claim → `git worktree` → headless `claude -p` with `--json-schema` → gates in cost order → PR → merge → `done`.

**Tech Stack:** TypeScript (strict), Node 20+, Vitest, Mongoose 9 (app side only), Claude Code CLI 2.1.220+, `gh` CLI.

Spec: `docs/superpowers/specs/2026-07-31-autonomous-execution-worker-design.md`
Task: CP-158

## Global Constraints

- TypeScript `strict: true` in both packages. No `any` in new code; use `unknown` plus narrowing.
- The worker communicates with the app **only** over REST with a Bearer token. It never imports from `src/`, never opens a Mongo connection.
- Claude Code runs on the logged-in CLI session. Never set `ANTHROPIC_API_KEY` in the worker's spawn environment.
- Comments follow the repo convention: none by default. Only a one-line note for a non-obvious workaround.
- Conventional commits, English, no `Co-Authored-By` trailer, no generated-by footer.
- Branch for all work: `cp-158/autonomous-execution-worker` (already created).
- Every worker-side subprocess call (`claude`, `git`, `gh`, `npm`) sits behind an interface so tests never spawn a real process.
- Diff-size thresholds, poll interval, timeout and concurrency are worker configuration (env), not per-project settings.

## File Structure

**Main app (`src/`):**

| File | Responsibility |
|---|---|
| `vitest.config.ts` | Create — test runner config |
| `src/types/index.ts` | Modify — `IProjectRepository`, `ITaskExecution`, extend `IProject`/`ITask` |
| `src/models/project.ts` | Modify — `repository` subdocument |
| `src/models/task.ts` | Modify — `execution` subdocument |
| `src/lib/task-service.ts` | Modify — add `claimNextTask` |
| `src/lib/task-service.test.ts` | Create — claim race and eligibility tests |
| `src/app/api/projects/[projectId]/tasks/claim/route.ts` | Create — `POST` claim endpoint |

**Worker (`worker/`):**

| File | Responsibility |
|---|---|
| `worker/package.json`, `worker/tsconfig.json`, `worker/vitest.config.ts` | Package scaffold |
| `worker/src/config.ts` | Env parsing and validation |
| `worker/src/types.ts` | Shared types across worker modules |
| `worker/src/api.ts` | REST client for the app |
| `worker/src/queue.ts` | Claim and release |
| `worker/src/workspace.ts` | Worktree lifecycle, orphan reaping |
| `worker/src/exec.ts` | Subprocess interface + real implementation |
| `worker/src/executor.ts` | Claude Code invocation and result parsing |
| `worker/src/gates/{diff-size,test-presence,build,review,index}.ts` | Four gates |
| `worker/src/delivery.ts` | PR creation and merge |
| `worker/src/reporter.ts` | Status transitions and comments |
| `worker/src/loop.ts` | Run loop, concurrency, shutdown |
| `worker/src/main.ts` | Entry point |
| `worker/launchd/com.claudeplanner.worker.plist` | macOS service definition |

---

### Task 1: Vitest in the main repo

Stage 0. The `test-presence` gate is vacuous until the repo can run tests.

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`
- Create: `src/lib/columns.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` runs Vitest; `*.test.ts` colocated beside sources

- [ ] **Step 1: Install Vitest**

```bash
npm install --save-dev vitest@^3
```

- [ ] **Step 2: Create the config**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
```

- [ ] **Step 3: Add the script**

In `package.json`, add to `scripts`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Write a test against existing code**

`src/lib/columns.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getColumnIds, roleOf } from "./columns";
import { DEFAULT_PROJECT_COLUMNS } from "@/types";

describe("columns", () => {
  it("returns default column ids when a project has none", () => {
    expect(getColumnIds(null)).toContain("todo");
  });

  it("maps the todo column to the approved role", () => {
    expect(roleOf({ columns: DEFAULT_PROJECT_COLUMNS }, "todo")).toBe("approved");
  });
});
```

- [ ] **Step 5: Run and verify it passes**

Run: `npm test`
Expected: 2 passing. If `roleOf` takes a different argument shape, read `src/lib/columns.ts:32` and adjust the call — do not change the source.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts package.json package-lock.json src/lib/columns.test.ts
git commit -m "test: add vitest to the main app (CP-158)"
```

---

### Task 2: Data model — `Project.repository` and `Task.execution`

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/models/project.ts`
- Modify: `src/models/task.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `IProjectRepository { url: string; defaultBranch: string; localPath: string }`, `ITaskExecution { runId: string; workerId: string; attempts: number; startedAt: Date | null; lastError: string }`, `IProject.repository`, `ITask.execution`

- [ ] **Step 1: Add the types**

In `src/types/index.ts`, before `export interface IProject`:

```ts
export interface IProjectRepository {
  url: string;
  defaultBranch: string;
  localPath: string;
}

export interface ITaskExecution {
  runId: string;
  workerId: string;
  attempts: number;
  startedAt: Date | null;
  lastError: string;
}
```

Add `repository: IProjectRepository;` to `IProject` and `execution: ITaskExecution;` to `ITask`.

- [ ] **Step 2: Add the Project subdocument**

In `src/models/project.ts`, add inside `projectSchema` fields:

```ts
    repository: {
      url: { type: String, default: "" },
      defaultBranch: { type: String, default: "main" },
      localPath: { type: String, default: "" },
    },
```

- [ ] **Step 3: Add the Task subdocument**

In `src/models/task.ts`, add inside `taskSchema` fields:

```ts
    execution: {
      runId: { type: String, default: "" },
      workerId: { type: String, default: "" },
      attempts: { type: Number, default: 0 },
      startedAt: { type: Date, default: null },
      lastError: { type: String, default: "" },
    },
```

- [ ] **Step 4: Verify the build**

Run: `npm run build`
Expected: succeeds. TypeScript errors here mean the interface and schema disagree — fix the interface, not the schema.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/models/project.ts src/models/task.ts
git commit -m "feat(models): add project repository and task execution state (CP-158)"
```

---

### Task 3: `claimNextTask` service function

The claim must be atomic. A read-then-update lets two workers both see `todo` and both write `in_progress`.

**Files:**
- Modify: `src/lib/task-service.ts`
- Create: `src/lib/task-service.test.ts`

**Interfaces:**
- Consumes: `ITaskExecution` (Task 2), `getProjectColumns`/`roleOf` from `src/lib/columns.ts`
- Produces: `claimNextTask(projectId: string, workerId: string, runId: string): Promise<ITask | null>`

- [ ] **Step 1: Write the failing test**

`src/lib/task-service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const findOneAndUpdate = vi.fn();
const findById = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { findOneAndUpdate } }));
vi.mock("@/models/project", () => ({ Project: { findById } }));

const { claimNextTask } = await import("./task-service");

describe("claimNextTask", () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findById.mockReset();
    findById.mockReturnValue({ lean: () => Promise.resolve({ columns: null }) });
  });

  it("filters on the approved-role column so an in_progress task cannot be re-claimed", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    const filter = findOneAndUpdate.mock.calls[0][0];
    expect(filter.status).toEqual({ $in: ["todo"] });
    expect(filter.project).toBe("p1");
  });

  it("claims tasks that predate the execution subdocument", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    const filter = findOneAndUpdate.mock.calls[0][0];
    expect(filter.$or).toEqual([
      { "execution.attempts": { $exists: false } },
      { "execution.attempts": { $lt: 3 } },
    ]);
  });

  it("stamps worker identity and increments attempts", async () => {
    findOneAndUpdate.mockResolvedValue({ _id: "t1", taskNumber: 1 });

    await claimNextTask("p1", "worker-a", "run-1");

    const update = findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.status).toBe("in_progress");
    expect(update.$set["execution.workerId"]).toBe("worker-a");
    expect(update.$set["execution.runId"]).toBe("run-1");
    expect(update.$inc["execution.attempts"]).toBe(1);
  });

  it("returns null when nothing is claimable", async () => {
    findOneAndUpdate.mockResolvedValue(null);
    expect(await claimNextTask("p1", "worker-a", "run-1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/task-service.test.ts`
Expected: FAIL — `claimNextTask is not a function`

- [ ] **Step 3: Implement**

Append to `src/lib/task-service.ts`:

```ts
export async function claimNextTask(
  projectId: string,
  workerId: string,
  runId: string
): Promise<ITask | null> {
  await connectDB();

  const project = await Project.findById(projectId, "columns").lean();
  const approved = getProjectColumns(project)
    .filter((c) => c.role === "approved")
    .map((c) => c.id);
  if (approved.length === 0) return null;

  return Task.findOneAndUpdate(
    {
      project: projectId,
      status: { $in: approved },
      // Mongoose applies defaults at hydration, so tasks created before the
      // execution subdocument existed have no such field — and $lt never
      // matches a missing one
      $or: [
        { "execution.attempts": { $exists: false } },
        { "execution.attempts": { $lt: MAX_EXECUTION_ATTEMPTS } },
      ],
    },
    {
      $set: {
        status: ACTIVE_STATUS,
        "execution.workerId": workerId,
        "execution.runId": runId,
        "execution.startedAt": new Date(),
        "execution.lastError": "",
      },
      $inc: { "execution.attempts": 1 },
    },
    { returnDocument: "after", sort: { priority: -1, order: 1, createdAt: 1 } }
  );
}
```

Add near the top of the file:

```ts
export const MAX_EXECUTION_ATTEMPTS = 3;
const ACTIVE_STATUS = "in_progress";
```

Ensure `getProjectColumns` is imported from `./columns` (the file already imports `getColumnIds` from there).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/task-service.test.ts`
Expected: 3 passing

- [ ] **Step 5: Commit**

```bash
git add src/lib/task-service.ts src/lib/task-service.test.ts
git commit -m "feat(tasks): atomic claim for the execution worker (CP-158)"
```

---

### Task 4: Claim endpoint

**Files:**
- Create: `src/app/api/projects/[projectId]/tasks/claim/route.ts`

**Interfaces:**
- Consumes: `claimNextTask` (Task 3), `withProjectAccess` from `src/lib/middleware.ts`
- Produces: `POST /api/projects/:projectId/tasks/claim` → `200` with the task, or `204` when the queue is empty

- [ ] **Step 1: Write the route**

```ts
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { claimNextTask } from "@/lib/task-service";

export const POST = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const { workerId, runId } = await request.json();
  if (typeof workerId !== "string" || !workerId.trim()) {
    return NextResponse.json({ error: "workerId is required" }, { status: 400 });
  }
  if (typeof runId !== "string" || !runId.trim()) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }

  const task = await claimNextTask(projectId, workerId, runId);
  if (!task) {
    return new NextResponse(null, { status: 204 });
  }

  return NextResponse.json(task);
});
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 3: Commit**

```bash
git add src/app/api/projects/\[projectId\]/tasks/claim/route.ts
git commit -m "feat(api): claim endpoint for the execution worker (CP-158)"
```

---

### Task 5: Worker package scaffold and config

**Files:**
- Create: `worker/package.json`, `worker/tsconfig.json`, `worker/vitest.config.ts`
- Create: `worker/src/config.ts`, `worker/src/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `WorkerConfig { apiBaseUrl, apiToken, projectId, repoPath, worktreeRoot, pollIntervalMs, taskTimeoutMs, concurrency, maxDiffLines, maxDiffFiles, workerId }`, `loadConfig(env: NodeJS.ProcessEnv): WorkerConfig`

- [ ] **Step 1: Create the package files**

`worker/package.json`:

```json
{
  "name": "claudeplanner-worker",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/main.js",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^26.1.0",
    "typescript": "^5.9.3",
    "vitest": "^3.0.0"
  }
}
```

`worker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`worker/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 2: Write the failing test**

`worker/src/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  CP_API_URL: "https://app.example.com",
  CP_API_TOKEN: "cp_token",
  CP_PROJECT_ID: "CP",
  CP_REPO_PATH: "/repo",
};

describe("loadConfig", () => {
  it("applies defaults for optional settings", () => {
    const cfg = loadConfig(base);
    expect(cfg.pollIntervalMs).toBe(30_000);
    expect(cfg.taskTimeoutMs).toBe(1_800_000);
    expect(cfg.concurrency).toBe(1);
    expect(cfg.maxDiffLines).toBe(400);
    expect(cfg.maxDiffFiles).toBe(10);
    expect(cfg.baseBranch).toBe("main");
  });

  it("honours an explicit base branch", () => {
    expect(loadConfig({ ...base, CP_BASE_BRANCH: "develop" }).baseBranch).toBe("develop");
  });

  it("throws naming the missing variable", () => {
    expect(() => loadConfig({ ...base, CP_API_TOKEN: undefined })).toThrow(/CP_API_TOKEN/);
  });

  it("derives a stable worker id from the hostname when unset", () => {
    expect(loadConfig(base).workerId).toMatch(/.+/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd worker && npm install && npx vitest run src/config.test.ts`
Expected: FAIL — cannot resolve `./config.js`

- [ ] **Step 4: Implement**

`worker/src/config.ts`:

```ts
import { hostname } from "os";
import { join } from "path";

export interface WorkerConfig {
  apiBaseUrl: string;
  apiToken: string;
  projectId: string;
  repoPath: string;
  worktreeRoot: string;
  baseBranch: string;
  pollIntervalMs: number;
  taskTimeoutMs: number;
  concurrency: number;
  maxDiffLines: number;
  maxDiffFiles: number;
  workerId: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (!value || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function number(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return parsed;
}

export function loadConfig(env: Env): WorkerConfig {
  const repoPath = required(env, "CP_REPO_PATH");
  return {
    apiBaseUrl: required(env, "CP_API_URL").replace(/\/$/, ""),
    apiToken: required(env, "CP_API_TOKEN"),
    projectId: required(env, "CP_PROJECT_ID"),
    repoPath,
    worktreeRoot: env.CP_WORKTREE_ROOT?.trim() || join(repoPath, "..", "cp-worktrees"),
    baseBranch: env.CP_BASE_BRANCH?.trim() || "main",
    pollIntervalMs: number(env, "CP_POLL_INTERVAL_MS", 30_000),
    taskTimeoutMs: number(env, "CP_TASK_TIMEOUT_MS", 1_800_000),
    concurrency: number(env, "CP_CONCURRENCY", 1),
    maxDiffLines: number(env, "CP_MAX_DIFF_LINES", 400),
    maxDiffFiles: number(env, "CP_MAX_DIFF_FILES", 10),
    workerId: env.CP_WORKER_ID?.trim() || `worker-${hostname()}`,
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd worker && npx vitest run src/config.test.ts`
Expected: 3 passing

- [ ] **Step 6: Commit**

```bash
git add worker/package.json worker/tsconfig.json worker/vitest.config.ts worker/src/config.ts worker/src/config.test.ts worker/package-lock.json
git commit -m "feat(worker): package scaffold and configuration (CP-158)"
```

---

### Task 6: Shared types and API client

**Files:**
- Create: `worker/src/types.ts`, `worker/src/api.ts`, `worker/src/api.test.ts`

**Interfaces:**
- Consumes: `WorkerConfig` (Task 5)
- Produces: `ClaimedTask`, `ApiClient` with `claim()`, `setStatus(taskId, status)`, `comment(taskId, body)`

- [ ] **Step 1: Write the shared types**

`worker/src/types.ts`:

```ts
export interface ClaimedTask {
  taskId: string;
  taskKey: string;
  taskNumber: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  attempts: number;
}

export interface ExecutionResult {
  status: "completed" | "blocked";
  summary: string;
  filesChanged: string[];
  testsAdded: string[];
  blockedReason: string;
}

export type RunOutcome =
  | { kind: "result"; result: ExecutionResult }
  | { kind: "usage_limit" }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

export interface DiffStats {
  changedLines: number;
  changedFiles: string[];
  patch: string;
}

export interface GateContext {
  worktreePath: string;
  task: ClaimedTask;
  result: ExecutionResult;
  diff: DiffStats;
}

export interface GateResult {
  ok: boolean;
  reason: string;
}

export interface Gate {
  name: string;
  run(context: GateContext): Promise<GateResult>;
}
```

- [ ] **Step 2: Write the failing test**

`worker/src/api.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createApiClient } from "./api.js";

const config = {
  apiBaseUrl: "https://app.example.com",
  apiToken: "cp_token",
  projectId: "CP",
  workerId: "worker-a",
} as never;

describe("createApiClient", () => {
  it("returns null when the claim endpoint reports an empty queue", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const api = createApiClient(config, fetchMock as never);
    expect(await api.claim("run-1")).toBeNull();
  });

  it("maps a claimed task onto ClaimedTask", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        _id: "t1",
        taskNumber: 158,
        title: "Do the thing",
        description: "body",
        checklist: [{ text: "first", done: false }],
        execution: { attempts: 1 },
      }),
    });
    const api = createApiClient(config, fetchMock as never);

    const task = await api.claim("run-1");

    expect(task).toEqual({
      taskId: "t1",
      taskKey: "CP-158",
      taskNumber: 158,
      title: "Do the thing",
      description: "body",
      acceptanceCriteria: ["first"],
      attempts: 1,
    });
  });

  it("sends the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const api = createApiClient(config, fetchMock as never);
    await api.claim("run-1");
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer cp_token");
  });

  it("throws on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    const api = createApiClient(config, fetchMock as never);
    await expect(api.claim("run-1")).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd worker && npx vitest run src/api.test.ts`
Expected: FAIL — cannot resolve `./api.js`

- [ ] **Step 4: Implement**

`worker/src/api.ts`:

```ts
import { WorkerConfig } from "./config.js";
import { ClaimedTask } from "./types.js";

type Fetch = typeof globalThis.fetch;

export interface ApiClient {
  claim(runId: string): Promise<ClaimedTask | null>;
  setStatus(taskId: string, status: string): Promise<void>;
  comment(taskId: string, body: string): Promise<void>;
}

interface RawTask {
  _id: string;
  taskNumber: number;
  title: string;
  description: string;
  checklist?: Array<{ text: string }>;
  execution?: { attempts?: number };
}

export function createApiClient(config: WorkerConfig, fetchImpl: Fetch = fetch): ApiClient {
  const base = `${config.apiBaseUrl}/api/projects/${config.projectId}`;

  async function send(path: string, method: string, body?: unknown): Promise<Response> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`${method} ${path} failed: ${response.status} ${detail}`);
    }
    return response;
  }

  return {
    async claim(runId) {
      const response = await send("/tasks/claim", "POST", {
        workerId: config.workerId,
        runId,
      });
      if (response.status === 204) return null;

      const raw = (await response.json()) as RawTask;
      return {
        taskId: raw._id,
        taskKey: `${config.projectId}-${raw.taskNumber}`,
        taskNumber: raw.taskNumber,
        title: raw.title,
        description: raw.description,
        acceptanceCriteria: (raw.checklist ?? []).map((item) => item.text),
        attempts: raw.execution?.attempts ?? 0,
      };
    },

    async setStatus(taskId, status) {
      await send(`/tasks/${taskId}/status`, "PATCH", { status });
    },

    async comment(taskId, body) {
      await send(`/tasks/${taskId}/comments`, "POST", { body });
    },
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd worker && npx vitest run src/api.test.ts`
Expected: 4 passing

- [ ] **Step 6: Commit**

```bash
git add worker/src/types.ts worker/src/api.ts worker/src/api.test.ts
git commit -m "feat(worker): shared types and REST client (CP-158)"
```

---

### Task 7: Subprocess interface

Everything that spawns a process goes through here, so no test ever runs `claude`, `git` or `gh`.

**Files:**
- Create: `worker/src/exec.ts`, `worker/src/exec.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `CommandResult { code: number; stdout: string; stderr: string; timedOut: boolean }`, `Runner { run(cmd: string, args: string[], opts: RunOpts): Promise<CommandResult> }`, `createRunner()`

- [ ] **Step 1: Write the failing test**

`worker/src/exec.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createRunner } from "./exec.js";

describe("createRunner", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await createRunner().run("node", ["-e", "process.stdout.write('hi')"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hi");
    expect(result.timedOut).toBe(false);
  });

  it("reports a non-zero exit code without throwing", async () => {
    const result = await createRunner().run("node", ["-e", "process.exit(3)"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.code).toBe(3);
  });

  it("flags a timeout", async () => {
    const result = await createRunner().run("node", ["-e", "setTimeout(() => {}, 10000)"], {
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run src/exec.test.ts`
Expected: FAIL — cannot resolve `./exec.js`

- [ ] **Step 3: Implement**

`worker/src/exec.ts`:

```ts
import { spawn } from "child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOpts {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface Runner {
  run(command: string, args: string[], opts: RunOpts): Promise<CommandResult>;
}

export function createRunner(): Runner {
  return {
    run(command, args, opts) {
      return new Promise((resolve) => {
        const child = spawn(command, args, {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, opts.timeoutMs);

        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });

        child.on("error", (error) => {
          clearTimeout(timer);
          resolve({ code: -1, stdout, stderr: String(error), timedOut });
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr, timedOut });
        });
      });
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run src/exec.test.ts`
Expected: 3 passing

- [ ] **Step 5: Commit**

```bash
git add worker/src/exec.ts worker/src/exec.test.ts
git commit -m "feat(worker): subprocess runner with timeout capture (CP-158)"
```

---

### Task 8: Worktree lifecycle

**Files:**
- Create: `worker/src/workspace.ts`, `worker/src/workspace.test.ts`

**Interfaces:**
- Consumes: `Runner` (Task 7), `WorkerConfig` (Task 5)
- Produces: `createWorkspace(config, runner)` → `{ create(taskKey, slug): Promise<string>; destroy(taskKey): Promise<void>; listWorktrees(): Promise<string[]> }`

- [ ] **Step 1: Write the failing test**

`worker/src/workspace.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createWorkspace } from "./workspace.js";

const config = {
  repoPath: "/repo",
  worktreeRoot: "/worktrees",
} as never;

function runnerReturning(stdout = "") {
  const run = vi.fn().mockResolvedValue({ code: 0, stdout, stderr: "", timedOut: false });
  return { runner: { run }, run };
}

describe("createWorkspace", () => {
  it("creates a worktree on a task-keyed branch", async () => {
    const { runner, run } = runnerReturning();
    const path = await createWorkspace(config, runner).create("CP-158", "worker");

    expect(path).toBe("/worktrees/CP-158");
    expect(run).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "cp-158/worker", "/worktrees/CP-158"],
      expect.objectContaining({ cwd: "/repo" })
    );
  });

  it("removes the worktree and deletes the branch", async () => {
    const { runner, run } = runnerReturning();
    await createWorkspace(config, runner).destroy("CP-158");

    expect(run).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/worktrees/CP-158"],
      expect.anything()
    );
  });

  it("throws when git fails to create the worktree", async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "exists", timedOut: false });
    await expect(createWorkspace(config, { run }).create("CP-158", "worker")).rejects.toThrow(/exists/);
  });

  it("parses existing worktree paths", async () => {
    const { runner } = runnerReturning(
      "worktree /repo\n\nworktree /worktrees/CP-1\n\nworktree /worktrees/CP-2\n"
    );
    expect(await createWorkspace(config, runner).listWorktrees()).toEqual([
      "/repo",
      "/worktrees/CP-1",
      "/worktrees/CP-2",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run src/workspace.test.ts`
Expected: FAIL — cannot resolve `./workspace.js`

- [ ] **Step 3: Implement**

`worker/src/workspace.ts`:

```ts
import { join } from "path";
import { WorkerConfig } from "./config.js";
import { Runner } from "./exec.js";

const GIT_TIMEOUT_MS = 60_000;

export interface Workspace {
  create(taskKey: string, slug: string): Promise<string>;
  destroy(taskKey: string): Promise<void>;
  listWorktrees(): Promise<string[]>;
}

export function createWorkspace(config: WorkerConfig, runner: Runner): Workspace {
  const pathFor = (taskKey: string) => join(config.worktreeRoot, taskKey);

  async function git(args: string[]): Promise<string> {
    const result = await runner.run("git", args, {
      cwd: config.repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  }

  return {
    async create(taskKey, slug) {
      const path = pathFor(taskKey);
      const branch = `${taskKey.toLowerCase()}/${slug}`;
      await git(["worktree", "add", "-b", branch, path]);
      return path;
    },

    async destroy(taskKey) {
      await git(["worktree", "remove", "--force", pathFor(taskKey)]);
    },

    async listWorktrees() {
      const output = await git(["worktree", "list", "--porcelain"]);
      return output
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length).trim());
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run src/workspace.test.ts`
Expected: 4 passing

- [ ] **Step 5: Commit**

```bash
git add worker/src/workspace.ts worker/src/workspace.test.ts
git commit -m "feat(worker): git worktree lifecycle (CP-158)"
```

---

### Task 9: Claude Code executor

**Files:**
- Create: `worker/src/executor.ts`, `worker/src/executor.test.ts`

**Interfaces:**
- Consumes: `Runner` (Task 7), `ClaimedTask`, `RunOutcome`, `ExecutionResult` (Task 6), `WorkerConfig` (Task 5)
- Produces: `createExecutor(config, runner)` → `{ execute(task: ClaimedTask, worktreePath: string): Promise<RunOutcome> }`, `RESULT_SCHEMA`

- [ ] **Step 1: Write the failing test**

`worker/src/executor.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createExecutor } from "./executor.js";

const config = { taskTimeoutMs: 1000, apiBaseUrl: "https://app.example.com", apiToken: "cp_t" } as never;

const task = {
  taskId: "t1",
  taskKey: "CP-158",
  taskNumber: 158,
  title: "Add a thing",
  description: "Do it well",
  acceptanceCriteria: ["works"],
  attempts: 1,
};

function runnerReturning(result: Record<string, unknown>) {
  const run = vi.fn().mockResolvedValue(result);
  return { runner: { run }, run };
}

describe("createExecutor", () => {
  it("parses a schema-conforming result", async () => {
    const payload = {
      status: "completed",
      summary: "done",
      filesChanged: ["a.ts"],
      testsAdded: ["a.test.ts"],
      blockedReason: "",
    };
    const { runner } = runnerReturning({
      code: 0,
      stdout: JSON.stringify({ result: JSON.stringify(payload) }),
      stderr: "",
      timedOut: false,
    });

    const outcome = await createExecutor(config, runner).execute(task, "/wt");

    expect(outcome).toEqual({ kind: "result", result: payload });
  });

  it("never passes an API key so the subscription is used", async () => {
    const { runner, run } = runnerReturning({
      code: 0,
      stdout: JSON.stringify({ result: '{"status":"completed","summary":"","filesChanged":[],"testsAdded":[],"blockedReason":""}' }),
      stderr: "",
      timedOut: false,
    });

    await createExecutor(config, runner).execute(task, "/wt");

    expect(run.mock.calls[0][2].env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("classifies a usage limit as its own outcome", async () => {
    const { runner } = runnerReturning({
      code: 1,
      stdout: "",
      stderr: "Claude usage limit reached. Your limit will reset at 3pm.",
      timedOut: false,
    });

    expect(await createExecutor(config, runner).execute(task, "/wt")).toEqual({ kind: "usage_limit" });
  });

  it("reports a timeout", async () => {
    const { runner } = runnerReturning({ code: -1, stdout: "", stderr: "", timedOut: true });
    expect(await createExecutor(config, runner).execute(task, "/wt")).toEqual({ kind: "timeout" });
  });

  it("reports unparseable output as an error", async () => {
    const { runner } = runnerReturning({ code: 0, stdout: "not json", stderr: "", timedOut: false });
    const outcome = await createExecutor(config, runner).execute(task, "/wt");
    expect(outcome.kind).toBe("error");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run src/executor.test.ts`
Expected: FAIL — cannot resolve `./executor.js`

- [ ] **Step 3: Implement**

`worker/src/executor.ts`:

```ts
import { WorkerConfig } from "./config.js";
import { Runner } from "./exec.js";
import { ClaimedTask, ExecutionResult, RunOutcome } from "./types.js";

export const RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    testsAdded: { type: "array", items: { type: "string" } },
    blockedReason: { type: "string" },
  },
  required: ["status", "summary", "filesChanged", "testsAdded", "blockedReason"],
} as const;

const ALLOWED_TOOLS = "Read Edit Write Grep Glob Bash(git *) Bash(npm *)";

const SYSTEM_PROMPT = [
  "You are executing a single task from a project board, unattended.",
  "Make the change, add or update a test covering it, and keep the diff minimal.",
  "Commit your work on the current branch using conventional commits.",
  "Do not push, do not open a pull request, do not merge — the worker does that.",
  "If the task is ambiguous or you cannot finish, return status 'blocked' with a specific reason.",
].join(" ");

function isUsageLimit(text: string): boolean {
  return /usage limit reached|rate limit|quota exceeded/i.test(text);
}

function buildPrompt(task: ClaimedTask): string {
  const criteria = task.acceptanceCriteria.length
    ? `\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
    : "";
  return `Task ${task.taskKey}: ${task.title}\n\n${task.description}${criteria}`;
}

export interface Executor {
  execute(task: ClaimedTask, worktreePath: string): Promise<RunOutcome>;
}

export function createExecutor(config: WorkerConfig, runner: Runner): Executor {
  return {
    async execute(task, worktreePath) {
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;

      const result = await runner.run(
        "claude",
        [
          "-p",
          buildPrompt(task),
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(RESULT_SCHEMA),
          "--permission-mode",
          "bypassPermissions",
          "--allowedTools",
          ALLOWED_TOOLS,
          "--append-system-prompt",
          SYSTEM_PROMPT,
          "--model",
          "opus",
          "--fallback-model",
          "sonnet",
        ],
        { cwd: worktreePath, timeoutMs: config.taskTimeoutMs, env }
      );

      if (result.timedOut) return { kind: "timeout" };
      if (isUsageLimit(result.stderr) || isUsageLimit(result.stdout)) {
        return { kind: "usage_limit" };
      }
      if (result.code !== 0) {
        return { kind: "error", message: result.stderr || `claude exited ${result.code}` };
      }

      try {
        const envelope = JSON.parse(result.stdout) as { result?: string };
        const parsed = JSON.parse(envelope.result ?? "") as ExecutionResult;
        return { kind: "result", result: parsed };
      } catch {
        return { kind: "error", message: "could not parse claude output" };
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run src/executor.test.ts`
Expected: 5 passing

- [ ] **Step 5: Commit**

```bash
git add worker/src/executor.ts worker/src/executor.test.ts
git commit -m "feat(worker): headless claude code executor (CP-158)"
```

---

### Task 10: Diff collection and the diff-size gate

**Files:**
- Create: `worker/src/diff.ts`, `worker/src/diff.test.ts`
- Create: `worker/src/gates/diff-size.ts`, `worker/src/gates/diff-size.test.ts`

**Interfaces:**
- Consumes: `Runner` (Task 7), `DiffStats`, `Gate`, `GateContext`, `GateResult` (Task 6)
- Produces: `collectDiff(runner, worktreePath, baseBranch): Promise<DiffStats>`, `diffSizeGate(maxLines, maxFiles): Gate`

- [ ] **Step 1: Write the failing diff test**

`worker/src/diff.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { collectDiff } from "./diff.js";

describe("collectDiff", () => {
  it("counts changed lines and files from numstat", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "3\t1\tsrc/a.ts\n10\t0\tsrc/a.test.ts\n", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: "diff --git ...", stderr: "", timedOut: false });

    const diff = await collectDiff({ run }, "/wt", "main");

    expect(diff.changedFiles).toEqual(["src/a.ts", "src/a.test.ts"]);
    expect(diff.changedLines).toBe(14);
    expect(diff.patch).toBe("diff --git ...");
  });

  it("treats binary markers as zero lines", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "-\t-\timage.png\n", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "", timedOut: false });

    const diff = await collectDiff({ run }, "/wt", "main");

    expect(diff.changedLines).toBe(0);
    expect(diff.changedFiles).toEqual(["image.png"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run src/diff.test.ts`
Expected: FAIL — cannot resolve `./diff.js`

- [ ] **Step 3: Implement diff collection**

`worker/src/diff.ts`:

```ts
import { Runner } from "./exec.js";
import { DiffStats } from "./types.js";

const GIT_TIMEOUT_MS = 60_000;

export async function collectDiff(
  runner: Runner,
  worktreePath: string,
  baseBranch: string
): Promise<DiffStats> {
  const opts = { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS };

  const numstat = await runner.run("git", ["diff", "--numstat", `${baseBranch}...HEAD`], opts);
  if (numstat.code !== 0) {
    throw new Error(`git diff --numstat failed: ${numstat.stderr}`);
  }

  let changedLines = 0;
  const changedFiles: string[] = [];
  for (const line of numstat.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, file] = line.split("\t");
    if (!file) continue;
    changedFiles.push(file.trim());
    if (added !== "-" && removed !== "-") {
      changedLines += Number(added) + Number(removed);
    }
  }

  const patch = await runner.run("git", ["diff", `${baseBranch}...HEAD`], opts);
  return { changedLines, changedFiles, patch: patch.stdout };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run src/diff.test.ts`
Expected: 2 passing

- [ ] **Step 5: Write the failing gate test**

`worker/src/gates/diff-size.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { diffSizeGate } from "./diff-size.js";

const context = (changedLines: number, changedFiles: string[]) =>
  ({ diff: { changedLines, changedFiles, patch: "" } }) as never;

describe("diffSizeGate", () => {
  it("accepts a small diff", async () => {
    const result = await diffSizeGate(400, 10).run(context(50, ["a.ts"]));
    expect(result.ok).toBe(true);
  });

  it("rejects too many lines and names the threshold", async () => {
    const result = await diffSizeGate(400, 10).run(context(401, ["a.ts"]));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/401.*400/);
  });

  it("rejects too many files", async () => {
    const files = Array.from({ length: 11 }, (_, i) => `f${i}.ts`);
    const result = await diffSizeGate(400, 10).run(context(10, files));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/11.*10/);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd worker && npx vitest run src/gates/diff-size.test.ts`
Expected: FAIL — cannot resolve `./diff-size.js`

- [ ] **Step 7: Implement the gate**

`worker/src/gates/diff-size.ts`:

```ts
import { Gate } from "../types.js";

export function diffSizeGate(maxLines: number, maxFiles: number): Gate {
  return {
    name: "diff-size",
    async run({ diff }) {
      if (diff.changedLines > maxLines) {
        return { ok: false, reason: `diff is ${diff.changedLines} lines, limit is ${maxLines}` };
      }
      if (diff.changedFiles.length > maxFiles) {
        return {
          ok: false,
          reason: `diff touches ${diff.changedFiles.length} files, limit is ${maxFiles}`,
        };
      }
      return { ok: true, reason: "" };
    },
  };
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `cd worker && npx vitest run src/gates/diff-size.test.ts`
Expected: 3 passing

- [ ] **Step 9: Commit**

```bash
git add worker/src/diff.ts worker/src/diff.test.ts worker/src/gates/diff-size.ts worker/src/gates/diff-size.test.ts
git commit -m "feat(worker): diff collection and diff-size gate (CP-158)"
```

---

### Task 11: Test-presence and build gates

**Files:**
- Create: `worker/src/gates/test-presence.ts`, `worker/src/gates/test-presence.test.ts`
- Create: `worker/src/gates/build.ts`, `worker/src/gates/build.test.ts`

**Interfaces:**
- Consumes: `Gate`, `GateContext` (Task 6), `Runner` (Task 7)
- Produces: `testPresenceGate(): Gate`, `buildGate(runner, timeoutMs): Gate`

- [ ] **Step 1: Write the failing test-presence test**

`worker/src/gates/test-presence.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { testPresenceGate } from "./test-presence.js";

const context = (changedFiles: string[]) =>
  ({ diff: { changedLines: 10, changedFiles, patch: "" } }) as never;

describe("testPresenceGate", () => {
  it("accepts a diff containing a test file", async () => {
    expect((await testPresenceGate().run(context(["src/a.ts", "src/a.test.ts"]))).ok).toBe(true);
  });

  it("rejects a diff with no test file", async () => {
    const result = await testPresenceGate().run(context(["src/a.ts"]));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no test/i);
  });

  it("accepts .test.tsx as a test file", async () => {
    expect((await testPresenceGate().run(context(["src/A.test.tsx"]))).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run src/gates/test-presence.test.ts`
Expected: FAIL — cannot resolve `./test-presence.js`

- [ ] **Step 3: Implement**

`worker/src/gates/test-presence.ts`:

```ts
import { Gate } from "../types.js";

const TEST_FILE = /\.(test|spec)\.tsx?$/;

export function testPresenceGate(): Gate {
  return {
    name: "test-presence",
    async run({ diff }) {
      const hasTest = diff.changedFiles.some((file) => TEST_FILE.test(file));
      return hasTest
        ? { ok: true, reason: "" }
        : { ok: false, reason: "no test file was added or changed" };
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run src/gates/test-presence.test.ts`
Expected: 3 passing

- [ ] **Step 5: Write the failing build test**

`worker/src/gates/build.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildGate } from "./build.js";

const context = { worktreePath: "/wt" } as never;

describe("buildGate", () => {
  it("accepts a zero exit code", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "", timedOut: false });
    expect((await buildGate({ run }, 5000).run(context)).ok).toBe(true);
  });

  it("rejects and carries the tail of the output", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "Type error on line 4", timedOut: false });
    const result = await buildGate({ run }, 5000).run(context);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Type error on line 4/);
  });

  it("rejects on timeout", async () => {
    const run = vi.fn().mockResolvedValue({ code: -1, stdout: "", stderr: "", timedOut: true });
    const result = await buildGate({ run }, 5000).run(context);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timed out/i);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd worker && npx vitest run src/gates/build.test.ts`
Expected: FAIL — cannot resolve `./build.js`

- [ ] **Step 7: Implement**

`worker/src/gates/build.ts`:

```ts
import { Runner } from "../exec.js";
import { Gate } from "../types.js";

const MAX_REASON_CHARS = 2000;

export function buildGate(runner: Runner, timeoutMs: number): Gate {
  return {
    name: "build",
    async run({ worktreePath }) {
      const result = await runner.run("npm", ["run", "build"], {
        cwd: worktreePath,
        timeoutMs,
      });

      if (result.timedOut) {
        return { ok: false, reason: "build timed out" };
      }
      if (result.code !== 0) {
        const output = (result.stderr || result.stdout).slice(-MAX_REASON_CHARS);
        return { ok: false, reason: `build failed:\n${output}` };
      }
      return { ok: true, reason: "" };
    },
  };
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `cd worker && npx vitest run src/gates/build.test.ts`
Expected: 3 passing

- [ ] **Step 9: Commit**

```bash
git add worker/src/gates/test-presence.ts worker/src/gates/test-presence.test.ts worker/src/gates/build.ts worker/src/gates/build.test.ts
git commit -m "feat(worker): test-presence and build gates (CP-158)"
```

---

### Task 12: Review gate

A second Claude with no history from the authoring session, receiving only the diff and the task.

**Files:**
- Create: `worker/src/gates/review.ts`, `worker/src/gates/review.test.ts`
- Create: `worker/src/gates/index.ts`

**Interfaces:**
- Consumes: `Runner` (Task 7), `Gate` (Task 6)
- Produces: `reviewGate(runner, timeoutMs): Gate`, `buildGates(config, runner): Gate[]`

- [ ] **Step 1: Write the failing test**

`worker/src/gates/review.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { reviewGate } from "./review.js";

const context = {
  worktreePath: "/wt",
  task: { taskKey: "CP-158", title: "Add a thing", description: "body", acceptanceCriteria: [] },
  diff: { changedLines: 10, changedFiles: ["a.ts"], patch: "diff --git a/a.ts" },
} as never;

function claudeReturning(verdict: Record<string, unknown>) {
  const run = vi.fn().mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({ result: JSON.stringify(verdict) }),
    stderr: "",
    timedOut: false,
  });
  return { runner: { run }, run };
}

describe("reviewGate", () => {
  it("accepts an approving verdict", async () => {
    const { runner } = claudeReturning({ approved: true, reason: "looks right" });
    expect((await reviewGate(runner, 5000).run(context)).ok).toBe(true);
  });

  it("rejects and carries the reviewer's reason", async () => {
    const { runner } = claudeReturning({ approved: false, reason: "drops the error branch" });
    const result = await reviewGate(runner, 5000).run(context);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/drops the error branch/);
  });

  it("passes the diff in the prompt", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });
    await reviewGate(runner, 5000).run(context);
    expect(run.mock.calls[0][1].join(" ")).toContain("diff --git a/a.ts");
  });

  it("fails closed when the reviewer output cannot be parsed", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "garbage", stderr: "", timedOut: false });
    const result = await reviewGate({ run }, 5000).run(context);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run src/gates/review.test.ts`
Expected: FAIL — cannot resolve `./review.js`

- [ ] **Step 3: Implement**

`worker/src/gates/review.ts`:

```ts
import { Runner } from "../exec.js";
import { Gate, GateContext } from "../types.js";

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["approved", "reason"],
} as const;

const REVIEWER_PROMPT =
  "You are reviewing a diff produced by another agent for correctness against the stated task. " +
  "Approve only if the change does what the task asks without introducing a defect. " +
  "Reject if it is incomplete, changes unrelated behaviour, or drops an error path. " +
  "Style preferences are not grounds for rejection.";

function buildPrompt(context: GateContext): string {
  const criteria = context.task.acceptanceCriteria.length
    ? `\nAcceptance criteria:\n${context.task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
    : "";
  return [
    `Task ${context.task.taskKey}: ${context.task.title}`,
    context.task.description,
    criteria,
    "",
    "Diff under review:",
    context.diff.patch,
  ].join("\n");
}

export function reviewGate(runner: Runner, timeoutMs: number): Gate {
  return {
    name: "review",
    async run(context) {
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;

      const result = await runner.run(
        "claude",
        [
          "-p",
          buildPrompt(context),
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(VERDICT_SCHEMA),
          "--append-system-prompt",
          REVIEWER_PROMPT,
          "--allowedTools",
          "Read Grep Glob",
          "--model",
          "opus",
        ],
        { cwd: context.worktreePath, timeoutMs, env }
      );

      if (result.timedOut) return { ok: false, reason: "review timed out" };

      try {
        const envelope = JSON.parse(result.stdout) as { result?: string };
        const verdict = JSON.parse(envelope.result ?? "") as { approved: boolean; reason: string };
        return verdict.approved
          ? { ok: true, reason: verdict.reason }
          : { ok: false, reason: verdict.reason };
      } catch {
        return { ok: false, reason: "could not parse the reviewer verdict" };
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run src/gates/review.test.ts`
Expected: 4 passing

- [ ] **Step 5: Assemble the gate list in cost order**

`worker/src/gates/index.ts`:

```ts
import { WorkerConfig } from "../config.js";
import { Runner } from "../exec.js";
import { Gate } from "../types.js";
import { diffSizeGate } from "./diff-size.js";
import { testPresenceGate } from "./test-presence.js";
import { buildGate } from "./build.js";
import { reviewGate } from "./review.js";

const BUILD_TIMEOUT_MS = 600_000;
const REVIEW_TIMEOUT_MS = 600_000;

export function buildGates(config: WorkerConfig, runner: Runner): Gate[] {
  return [
    diffSizeGate(config.maxDiffLines, config.maxDiffFiles),
    testPresenceGate(),
    buildGate(runner, BUILD_TIMEOUT_MS),
    reviewGate(runner, REVIEW_TIMEOUT_MS),
  ];
}
```

- [ ] **Step 6: Commit**

```bash
git add worker/src/gates/review.ts worker/src/gates/review.test.ts worker/src/gates/index.ts
git commit -m "feat(worker): review gate and gate ordering (CP-158)"
```

---

### Task 13: Reporter

**Files:**
- Create: `worker/src/reporter.ts`, `worker/src/reporter.test.ts`

**Interfaces:**
- Consumes: `ApiClient` (Task 6), `ClaimedTask`, `ExecutionResult`
- Produces: `createReporter(api)` → `{ blocked, gateRejected, released, merged, failed }`, each `(task, ...) => Promise<void>`

- [ ] **Step 1: Write the failing test**

`worker/src/reporter.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createReporter } from "./reporter.js";

const task = { taskId: "t1", taskKey: "CP-158" } as never;

function apiSpy() {
  return { claim: vi.fn(), setStatus: vi.fn().mockResolvedValue(undefined), comment: vi.fn().mockResolvedValue(undefined) };
}

describe("createReporter", () => {
  it("routes a blocked task to needs_human_review with the reason", async () => {
    const api = apiSpy();
    await createReporter(api).blocked(task, "requirements are ambiguous");

    expect(api.setStatus).toHaveBeenCalledWith("t1", "needs_human_review");
    expect(api.comment.mock.calls[0][1]).toMatch(/requirements are ambiguous/);
  });

  it("names the gate and the pushed branch when a gate rejects", async () => {
    const api = apiSpy();
    await createReporter(api).gateRejected(task, "diff-size", "diff is 900 lines, limit is 400", "cp-158/worker");

    expect(api.setStatus).toHaveBeenCalledWith("t1", "needs_human_review");
    expect(api.comment.mock.calls[0][1]).toMatch(/diff-size/);
    expect(api.comment.mock.calls[0][1]).toMatch(/900 lines/);
    expect(api.comment.mock.calls[0][1]).toMatch(/cp-158\/worker/);
  });

  it("returns a released task to todo without a status comment", async () => {
    const api = apiSpy();
    await createReporter(api).released(task, "usage limit reached");

    expect(api.setStatus).toHaveBeenCalledWith("t1", "todo");
  });

  it("closes a merged task as done with the PR url", async () => {
    const api = apiSpy();
    await createReporter(api).merged(task, "https://github.com/x/y/pull/7", "added the thing");

    expect(api.setStatus).toHaveBeenCalledWith("t1", "done");
    expect(api.comment.mock.calls[0][1]).toMatch(/pull\/7/);
  });

  it("comments even when the status update fails, so nothing is silently lost", async () => {
    const api = apiSpy();
    api.setStatus.mockRejectedValue(new Error("boom"));
    await expect(createReporter(api).blocked(task, "x")).resolves.toBeUndefined();
    expect(api.comment).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run src/reporter.test.ts`
Expected: FAIL — cannot resolve `./reporter.js`

- [ ] **Step 3: Implement**

`worker/src/reporter.ts`:

```ts
import { ApiClient } from "./api.js";
import { ClaimedTask } from "./types.js";

export interface Reporter {
  blocked(task: ClaimedTask, reason: string): Promise<void>;
  gateRejected(task: ClaimedTask, gate: string, reason: string, branch: string): Promise<void>;
  released(task: ClaimedTask, reason: string): Promise<void>;
  merged(task: ClaimedTask, prUrl: string, summary: string): Promise<void>;
  failed(task: ClaimedTask, reason: string): Promise<void>;
}

export function createReporter(api: ApiClient): Reporter {
  async function report(taskId: string, status: string, body: string): Promise<void> {
    await api.comment(taskId, body).catch(() => {});
    await api.setStatus(taskId, status).catch(() => {});
  }

  return {
    async blocked(task, reason) {
      await report(
        task.taskId,
        "needs_human_review",
        `The execution worker stopped: the agent reported it could not finish.\n\n${reason}`
      );
    },

    async gateRejected(task, gate, reason, branch) {
      await report(
        task.taskId,
        "needs_human_review",
        `The execution worker blocked the merge at the **${gate}** gate.\n\n${reason}\n\nThe work is pushed to \`${branch}\` for inspection.`
      );
    },

    async released(task, reason) {
      await report(task.taskId, "todo", `Returned to the queue: ${reason}`);
    },

    async merged(task, prUrl, summary) {
      await report(task.taskId, "done", `Merged ${prUrl}\n\n${summary}`);
    },

    async failed(task, reason) {
      await report(
        task.taskId,
        "needs_human_review",
        `The execution worker gave up after ${task.attempts} attempts.\n\n${reason}`
      );
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run src/reporter.test.ts`
Expected: 5 passing

- [ ] **Step 5: Commit**

```bash
git add worker/src/reporter.ts worker/src/reporter.test.ts
git commit -m "feat(worker): board reporting for every terminal outcome (CP-158)"
```

---

### Task 14: Delivery — PR and merge

**Files:**
- Create: `worker/src/delivery.ts`, `worker/src/delivery.test.ts`

**Interfaces:**
- Consumes: `Runner` (Task 7), `ClaimedTask`
- Produces: `createDelivery(runner)` → `{ push(worktreePath, branch): Promise<void>; openPr(worktreePath, task, summary): Promise<string>; merge(worktreePath, prUrl): Promise<void> }`

- [ ] **Step 1: Write the failing test**

`worker/src/delivery.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createDelivery } from "./delivery.js";

const task = { taskKey: "CP-158", title: "Add a thing" } as never;

const ok = { code: 0, stdout: "", stderr: "", timedOut: false };

describe("createDelivery", () => {
  it("pushes the branch upstream", async () => {
    const run = vi.fn().mockResolvedValue(ok);
    await createDelivery({ run }).push("/wt", "cp-158/worker");

    expect(run).toHaveBeenCalledWith(
      "git",
      ["push", "-u", "origin", "cp-158/worker"],
      expect.objectContaining({ cwd: "/wt" })
    );
  });

  it("returns the pr url from gh output", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ ...ok, stdout: "https://github.com/x/y/pull/7\n" });

    const url = await createDelivery({ run }).openPr("/wt", task, "did the thing");

    expect(url).toBe("https://github.com/x/y/pull/7");
    expect(run.mock.calls[0][1]).toContain("--title");
  });

  it("prefixes the pr title with the task key", async () => {
    const run = vi.fn().mockResolvedValue({ ...ok, stdout: "https://github.com/x/y/pull/7" });
    await createDelivery({ run }).openPr("/wt", task, "summary");

    const args = run.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--title") + 1]).toBe("CP-158: Add a thing");
  });

  it("throws when the merge fails", async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "not mergeable", timedOut: false });
    await expect(createDelivery({ run }).merge("/wt", "https://x/pull/7")).rejects.toThrow(/not mergeable/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run src/delivery.test.ts`
Expected: FAIL — cannot resolve `./delivery.js`

- [ ] **Step 3: Implement**

`worker/src/delivery.ts`:

```ts
import { Runner } from "./exec.js";
import { ClaimedTask } from "./types.js";

const TIMEOUT_MS = 120_000;

export interface Delivery {
  push(worktreePath: string, branch: string): Promise<void>;
  openPr(worktreePath: string, task: ClaimedTask, summary: string): Promise<string>;
  merge(worktreePath: string, prUrl: string): Promise<void>;
}

export function createDelivery(runner: Runner): Delivery {
  async function run(command: string, args: string[], cwd: string): Promise<string> {
    const result = await runner.run(command, args, { cwd, timeoutMs: TIMEOUT_MS });
    if (result.code !== 0) {
      throw new Error(`${command} ${args[0]} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  }

  return {
    async push(worktreePath, branch) {
      await run("git", ["push", "-u", "origin", branch], worktreePath);
    },

    async openPr(worktreePath, task, summary) {
      return run(
        "gh",
        ["pr", "create", "--title", `${task.taskKey}: ${task.title}`, "--body", summary],
        worktreePath
      );
    },

    async merge(worktreePath, prUrl) {
      await run("gh", ["pr", "merge", prUrl, "--merge", "--delete-branch"], worktreePath);
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run src/delivery.test.ts`
Expected: 4 passing

- [ ] **Step 5: Commit**

```bash
git add worker/src/delivery.ts worker/src/delivery.test.ts
git commit -m "feat(worker): pull request creation and merge (CP-158)"
```

---

### Task 15: Task pipeline

Wires claim → worktree → execute → gates → deliver → report, with worktree cleanup guaranteed.

**Files:**
- Create: `worker/src/pipeline.ts`, `worker/src/pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 6–14
- Produces: `runTask(deps, task): Promise<void>` where `deps = { config, workspace, executor, gates, delivery, reporter, runner }`

- [ ] **Step 1: Write the failing test**

`worker/src/pipeline.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runTask } from "./pipeline.js";

const task = {
  taskId: "t1",
  taskKey: "CP-158",
  taskNumber: 158,
  title: "Add a thing",
  description: "body",
  acceptanceCriteria: [],
  attempts: 1,
};

const goodResult = {
  status: "completed" as const,
  summary: "did it",
  filesChanged: ["a.ts"],
  testsAdded: ["a.test.ts"],
  blockedReason: "",
};

function deps(overrides: Record<string, unknown> = {}) {
  return {
    config: { repoPath: "/repo", baseBranch: "main", maxDiffLines: 400, maxDiffFiles: 10 },
    workspace: {
      create: vi.fn().mockResolvedValue("/wt"),
      destroy: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn(),
    },
    executor: { execute: vi.fn().mockResolvedValue({ kind: "result", result: goodResult }) },
    collectDiff: vi.fn().mockResolvedValue({ changedLines: 10, changedFiles: ["a.ts"], patch: "d" }),
    gates: [],
    delivery: {
      push: vi.fn().mockResolvedValue(undefined),
      openPr: vi.fn().mockResolvedValue("https://x/pull/7"),
      merge: vi.fn().mockResolvedValue(undefined),
    },
    reporter: {
      blocked: vi.fn(),
      gateRejected: vi.fn(),
      released: vi.fn(),
      merged: vi.fn(),
      failed: vi.fn(),
    },
    ...overrides,
  } as never;
}

describe("runTask", () => {
  it("merges and reports done on the happy path", async () => {
    const d = deps();
    await runTask(d, task);

    expect(d.delivery.merge).toHaveBeenCalled();
    expect(d.reporter.merged).toHaveBeenCalledWith(task, "https://x/pull/7", "did it");
  });

  it("releases the task back to todo on a usage limit", async () => {
    const d = deps({ executor: { execute: vi.fn().mockResolvedValue({ kind: "usage_limit" }) } });
    await runTask(d, task);

    expect(d.reporter.released).toHaveBeenCalled();
    expect(d.delivery.merge).not.toHaveBeenCalled();
  });

  it("reports blocked without opening a pr", async () => {
    const blocked = { ...goodResult, status: "blocked" as const, blockedReason: "ambiguous" };
    const d = deps({ executor: { execute: vi.fn().mockResolvedValue({ kind: "result", result: blocked }) } });
    await runTask(d, task);

    expect(d.reporter.blocked).toHaveBeenCalledWith(task, "ambiguous");
    expect(d.delivery.openPr).not.toHaveBeenCalled();
  });

  it("stops at the first failing gate and names it", async () => {
    const failing = { name: "diff-size", run: vi.fn().mockResolvedValue({ ok: false, reason: "too big" }) };
    const later = { name: "review", run: vi.fn() };
    const d = deps({ gates: [failing, later] });
    await runTask(d, task);

    expect(d.reporter.gateRejected).toHaveBeenCalledWith(task, "diff-size", "too big", "cp-158/worker");
    expect(later.run).not.toHaveBeenCalled();
    expect(d.delivery.merge).not.toHaveBeenCalled();
  });

  it("pushes the rejected branch before discarding the worktree", async () => {
    const failing = { name: "diff-size", run: vi.fn().mockResolvedValue({ ok: false, reason: "too big" }) };
    const d = deps({ gates: [failing] });
    await runTask(d, task);

    expect(d.delivery.push).toHaveBeenCalledWith("/wt", "cp-158/worker");
    expect(d.workspace.destroy).toHaveBeenCalledWith("CP-158");
  });

  it("diffs against the configured base branch", async () => {
    const d = deps({ config: { repoPath: "/repo", baseBranch: "develop" } });
    await runTask(d, task);

    expect(d.collectDiff).toHaveBeenCalledWith(d.runner, "/wt", "develop");
  });

  it("destroys the worktree even when a gate throws", async () => {
    const exploding = { name: "build", run: vi.fn().mockRejectedValue(new Error("boom")) };
    const d = deps({ gates: [exploding] });
    await runTask(d, task);

    expect(d.workspace.destroy).toHaveBeenCalledWith("CP-158");
  });

  it("keeps the worktree when the merge fails so it can be inspected", async () => {
    const d = deps({
      delivery: {
        push: vi.fn(),
        openPr: vi.fn().mockResolvedValue("https://x/pull/7"),
        merge: vi.fn().mockRejectedValue(new Error("not mergeable")),
      },
    });
    await runTask(d, task);

    expect(d.reporter.failed).toHaveBeenCalled();
    expect(d.workspace.destroy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run src/pipeline.test.ts`
Expected: FAIL — cannot resolve `./pipeline.js`

- [ ] **Step 3: Implement**

`worker/src/pipeline.ts`:

```ts
import { WorkerConfig } from "./config.js";
import { Delivery } from "./delivery.js";
import { Executor } from "./executor.js";
import { Reporter } from "./reporter.js";
import { Workspace } from "./workspace.js";
import { ClaimedTask, DiffStats, Gate } from "./types.js";
import { Runner } from "./exec.js";

export interface PipelineDeps {
  config: WorkerConfig;
  workspace: Workspace;
  executor: Executor;
  collectDiff: (runner: Runner, worktreePath: string, baseBranch: string) => Promise<DiffStats>;
  runner: Runner;
  gates: Gate[];
  delivery: Delivery;
  reporter: Reporter;
}

const SLUG = "worker";

export async function runTask(deps: PipelineDeps, task: ClaimedTask): Promise<void> {
  const { config, workspace, executor, gates, delivery, reporter } = deps;
  const branch = `${task.taskKey.toLowerCase()}/${SLUG}`;

  let worktreePath: string;
  try {
    worktreePath = await workspace.create(task.taskKey, SLUG);
  } catch (error) {
    await reporter.released(task, `could not create a worktree: ${String(error)}`);
    return;
  }

  let keepWorktree = false;
  try {
    const outcome = await executor.execute(task, worktreePath);

    if (outcome.kind === "usage_limit") {
      await reporter.released(task, "usage limit reached");
      return;
    }
    if (outcome.kind === "timeout") {
      await reporter.released(task, "the run timed out");
      return;
    }
    if (outcome.kind === "error") {
      await reporter.released(task, outcome.message);
      return;
    }
    if (outcome.result.status === "blocked") {
      await reporter.blocked(task, outcome.result.blockedReason);
      return;
    }

    const diff = await deps.collectDiff(deps.runner, worktreePath, config.baseBranch);
    const context = { worktreePath, task, result: outcome.result, diff };

    for (const gate of gates) {
      const verdict = await gate.run(context);
      if (!verdict.ok) {
        // Push before cleanup: the worktree is about to go, so the branch is
        // the only surviving copy of the rejected work
        await delivery.push(worktreePath, branch).catch(() => {});
        await reporter.gateRejected(task, gate.name, verdict.reason, branch);
        return;
      }
    }

    await delivery.push(worktreePath, branch);
    const prUrl = await delivery.openPr(worktreePath, task, outcome.result.summary);

    try {
      await delivery.merge(worktreePath, prUrl);
    } catch (error) {
      keepWorktree = true;
      await reporter.failed(task, `merge failed for ${prUrl}: ${String(error)}`);
      return;
    }

    await reporter.merged(task, prUrl, outcome.result.summary);
  } catch (error) {
    await reporter.released(task, `the worker hit an unexpected error: ${String(error)}`);
  } finally {
    if (!keepWorktree) {
      await workspace.destroy(task.taskKey).catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run src/pipeline.test.ts`
Expected: 6 passing

- [ ] **Step 5: Commit**

```bash
git add worker/src/pipeline.ts worker/src/pipeline.test.ts
git commit -m "feat(worker): task pipeline from claim to merge (CP-158)"
```

---

### Task 16: Run loop, entry point and service

**Files:**
- Create: `worker/src/loop.ts`, `worker/src/loop.test.ts`, `worker/src/main.ts`
- Create: `worker/launchd/com.claudeplanner.worker.plist`
- Create: `worker/README.md`

**Interfaces:**
- Consumes: `ApiClient` (Task 6), `runTask` (Task 15), `WorkerConfig` (Task 5)
- Produces: `createLoop({ config, api, execute, sleep })` → `{ start(): Promise<void>; stop(): void }`

- [ ] **Step 1: Write the failing test**

`worker/src/loop.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createLoop } from "./loop.js";

const task = { taskId: "t1", taskKey: "CP-158" } as never;

describe("createLoop", () => {
  it("runs a claimed task then stops when asked", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const api = { claim: vi.fn().mockResolvedValue(task), setStatus: vi.fn(), comment: vi.fn() };
    const loop = createLoop({
      config: { pollIntervalMs: 1, concurrency: 1, workerId: "w" } as never,
      api,
      execute,
      sleep: vi.fn().mockImplementation(async () => loop.stop()),
    });

    await loop.start();

    expect(execute).toHaveBeenCalledWith(task);
  });

  it("sleeps when the queue is empty", async () => {
    const sleep = vi.fn();
    const api = { claim: vi.fn().mockResolvedValue(null), setStatus: vi.fn(), comment: vi.fn() };
    const loop = createLoop({
      config: { pollIntervalMs: 30_000, concurrency: 1, workerId: "w" } as never,
      api,
      execute: vi.fn(),
      sleep: sleep.mockImplementation(async () => loop.stop()),
    });

    await loop.start();

    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("keeps running after a claim throws", async () => {
    let calls = 0;
    const api = {
      claim: vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls === 1) throw new Error("network down");
        return null;
      }),
      setStatus: vi.fn(),
      comment: vi.fn(),
    };
    const loop = createLoop({
      config: { pollIntervalMs: 1, concurrency: 1, workerId: "w" } as never,
      api,
      execute: vi.fn(),
      sleep: vi.fn().mockImplementation(async () => {
        if (calls >= 2) loop.stop();
      }),
    });

    await loop.start();

    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npx vitest run src/loop.test.ts`
Expected: FAIL — cannot resolve `./loop.js`

- [ ] **Step 3: Implement the loop**

`worker/src/loop.ts`:

```ts
import { randomUUID } from "crypto";
import { ApiClient } from "./api.js";
import { WorkerConfig } from "./config.js";
import { ClaimedTask } from "./types.js";

export interface LoopDeps {
  config: WorkerConfig;
  api: ApiClient;
  execute: (task: ClaimedTask) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export interface Loop {
  start(): Promise<void>;
  stop(): void;
}

export function createLoop(deps: LoopDeps): Loop {
  let running = true;

  return {
    async start() {
      while (running) {
        try {
          const task = await deps.api.claim(randomUUID());
          if (task) {
            await deps.execute(task);
            continue;
          }
        } catch (error) {
          console.error("worker cycle failed:", error);
        }
        await deps.sleep(deps.config.pollIntervalMs);
      }
    },

    stop() {
      running = false;
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npx vitest run src/loop.test.ts`
Expected: 3 passing

- [ ] **Step 5: Write the entry point**

`worker/src/main.ts`:

```ts
import { loadConfig } from "./config.js";
import { createApiClient } from "./api.js";
import { createRunner } from "./exec.js";
import { createWorkspace } from "./workspace.js";
import { createExecutor } from "./executor.js";
import { createDelivery } from "./delivery.js";
import { createReporter } from "./reporter.js";
import { buildGates } from "./gates/index.js";
import { collectDiff } from "./diff.js";
import { runTask } from "./pipeline.js";
import { createLoop } from "./loop.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function reapOrphans(
  workspace: ReturnType<typeof createWorkspace>,
  worktreeRoot: string
): Promise<void> {
  const worktrees = await workspace.listWorktrees().catch(() => []);
  for (const path of worktrees) {
    if (!path.startsWith(worktreeRoot)) continue;
    const taskKey = path.slice(worktreeRoot.length).replace(/^\//, "");
    if (taskKey) {
      await workspace.destroy(taskKey).catch(() => {});
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const runner = createRunner();
  const api = createApiClient(config);
  const workspace = createWorkspace(config, runner);
  const deps = {
    config,
    workspace,
    executor: createExecutor(config, runner),
    collectDiff,
    runner,
    gates: buildGates(config, runner),
    delivery: createDelivery(runner),
    reporter: createReporter(api),
  };

  await reapOrphans(workspace, config.worktreeRoot);

  const loop = createLoop({
    config,
    api,
    execute: (task) => runTask(deps, task),
    sleep,
  });

  process.on("SIGTERM", () => loop.stop());
  process.on("SIGINT", () => loop.stop());

  console.log(`worker ${config.workerId} polling ${config.apiBaseUrl} every ${config.pollIntervalMs}ms`);
  await loop.start();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 6: Verify the build**

Run: `cd worker && npm run build`
Expected: succeeds, `dist/main.js` exists

- [ ] **Step 7: Write the launchd service**

`worker/launchd/com.claudeplanner.worker.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claudeplanner.worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/rpo/Documents/Projects/ClaudePlanner/worker/dist/main.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CP_API_URL</key>
    <string>https://claude-planner-production.up.railway.app</string>
    <key>CP_PROJECT_ID</key>
    <string>CP</string>
    <key>CP_REPO_PATH</key>
    <string>/Users/rpo/Documents/Projects/ClaudePlanner</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/Users/rpo/.local/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/claudeplanner-worker.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/claudeplanner-worker.error.log</string>
</dict>
</plist>
```

- [ ] **Step 8: Write the README**

`worker/README.md`:

````markdown
# ClaudePlanner execution worker

Claims `todo` tasks, runs Claude Code headless in an isolated git worktree, enforces merge
gates and carries the task to `done`.

## Configuration

| Variable | Required | Default |
|---|---|---|
| `CP_API_URL` | yes | — |
| `CP_API_TOKEN` | yes | — |
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

`CP_API_TOKEN` is a ClaudePlanner API token scoped to the project. Claude Code runs on the
logged-in CLI session — never set `ANTHROPIC_API_KEY`, or runs bill per token instead of
drawing on the subscription.

## Running

```bash
npm install && npm run build && npm start
```

As a macOS service:

```bash
cp launchd/com.claudeplanner.worker.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.claudeplanner.worker.plist
```

Set `CP_API_TOKEN` in the keychain or the plist before loading. Logs go to
`/tmp/claudeplanner-worker.log`.
````

- [ ] **Step 9: Run the full worker suite**

Run: `cd worker && npm test`
Expected: all suites pass

- [ ] **Step 10: Commit**

```bash
git add worker/src/loop.ts worker/src/loop.test.ts worker/src/main.ts worker/launchd worker/README.md
git commit -m "feat(worker): run loop, entry point and launchd service (CP-158)"
```

---

### Task 17: End-to-end verification on a real task

**Files:**
- Modify: `docs/superpowers/plans/2026-07-31-autonomous-execution-worker.md` (check off)

**Interfaces:**
- Consumes: everything
- Produces: a merged PR opened by the worker with nobody at the keyboard

- [ ] **Step 1: Configure the project repository**

In the app, set `Project.repository` for CP: `url` to the GitHub remote, `defaultBranch` to `main`. Verify with:

```bash
curl -s -H "Authorization: Bearer $CP_API_TOKEN" "$CP_API_URL/api/projects/CP" | head -40
```

- [ ] **Step 2: Create a deliberately small task**

Create a task in CP titled "Add a formatDuration helper", status `todo`, assignee `claude`, with acceptance criteria "formats seconds as `1m 5s`" and "has a unit test".

- [ ] **Step 3: Run the worker in the foreground**

Run: `cd worker && CP_API_TOKEN=<token> npm start`
Expected: log line showing the claim, then a worktree under `../cp-worktrees/CP-<n>`

- [ ] **Step 4: Watch it through the gates**

Expected: the task reaches `done`, a PR is merged, and the task carries a comment with the PR url. If it stops at a gate, the comment names the gate — that is correct behaviour, not a failure.

- [ ] **Step 5: Verify cleanup**

Run: `git worktree list`
Expected: only the main checkout remains.

- [ ] **Step 6: Commit the plan with boxes checked**

```bash
git add docs/superpowers/plans/2026-07-31-autonomous-execution-worker.md
git commit -m "docs: mark the execution worker plan complete (CP-158)"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: worker package and config → 5; REST client and `ClaimedTask` → 6; atomic claim → 3 and 4; `Project.repository` / `Task.execution` → 2; worktree isolation → 8; headless Claude Code with `--json-schema` → 9; four gates in cost order → 10, 11, 12; PR and merge → 14; error handling table → 13 and 15; run loop and orphan reaping → 16; Vitest prerequisite → 1; launchd → 16.

**Deliberate deferrals.** Two spec items are stated in the spec but not implemented as separate machinery in this plan, and are worth naming rather than hiding:

- **Concurrency above 1.** `createLoop` processes one task per cycle. `config.concurrency` is parsed and documented but not yet honoured. With the default of 1 this is correct behaviour, not a bug; raising it requires a worker pool, which is its own task once the single-task path is proven.
- **Attempt-based give-up.** The `attempts` counter is incremented by `claimNextTask` and `MAX_EXECUTION_ATTEMPTS` filters claims, so a task that fails three times stops being claimed. It lands in a quiet state rather than being moved to `needs_human_review` by the worker. `reporter.failed` exists and is called on merge failure; wiring it to attempt exhaustion needs a sweep on the app side.

Both are follow-up tasks on CP-158, not blockers for the first autonomous merge.

**Placeholder scan.** No TBD, no "handle errors appropriately", every code step carries real code.

**Type consistency.** `ClaimedTask`, `ExecutionResult`, `RunOutcome`, `DiffStats`, `GateContext`, `GateResult` and `Gate` are defined once in Task 6 and used unchanged in 9–15. `Runner.run(command, args, opts)` is defined in Task 7 and called with that shape everywhere. `collectDiff(runner, worktreePath, baseBranch)` matches its use in `pipeline.ts`. `Reporter` methods match their call sites in `runTask`.
