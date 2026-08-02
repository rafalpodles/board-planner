import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { hostname } from "os";
import { dirname, join } from "path";
import { createApiClient } from "./api.js";
import { createOutbox, Store } from "./outbox.js";
import {
  applyPolicy,
  Assignment,
  DEFAULT_POLICY,
  EffectiveConfig,
  loadBootstrap,
  parseAssignments,
  WorkerConfig,
} from "./config.js";
import { connectControl } from "./control.js";
import { createDelivery } from "./delivery.js";
import { collectDiff } from "./diff.js";
import { createRunner } from "./exec.js";
import { createExecutor } from "./executor.js";
import { buildGates } from "./gates/index.js";
import { createLoop } from "./loop.js";
import { PipelineDeps, runTask } from "./pipeline.js";
import { createReporter } from "./reporter.js";
import { loadIdentity, PROTOCOL_VERSION, startHeartbeat } from "./registration.js";
import { bindRepository, createAllowlistReader } from "./repos.js";
import { ClaimedTask } from "./types.js";
import { createWorkspace, reapOrphans } from "./workspace.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const WORKER_VERSION = "1.0.0";
const MIN_REFRESH_INTERVAL_MS = 30_000;

function fileStore(path: string): Store {
  return {
    read: () => (existsSync(path) ? readFileSync(path, "utf8") : ""),
    write: (text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, { mode: 0o600 });
    },
  };
}

async function main(): Promise<void> {
  const bootstrap = loadBootstrap(process.env);
  const runner = createRunner();
  const api = createApiClient(bootstrap);

  const identityStore = fileStore(join(bootstrap.stateDir, "worker.json"));
  const outbox = createOutbox(fileStore(join(bootstrap.stateDir, "outbox.jsonl")));
  const readAllowlist = createAllowlistReader(bootstrap.stateDir);
  const uid = process.getuid ? process.getuid() : 0;

  // Everything below is worker-wide policy and the assignment list, both server-controlled and
  // both revisable without a restart — see refreshServerState(). Bound repositories are re-derived
  // from the assignment list every refresh; reapedProjects makes sure a live worktree is force-
  // removed at most once per project, the first time this process starts working with it.
  let policy: EffectiveConfig = DEFAULT_POLICY;
  let assignments: Assignment[] = [];
  let bound = new Map<string, { path: string; worktreeRoot: string }>();
  const reapedProjects = new Set<string>();

  function configFor(projectId: string): WorkerConfig | null {
    const identity = loadIdentity(identityStore);
    const repo = bound.get(projectId);
    if (!identity || !repo) return null;
    return {
      apiBaseUrl: bootstrap.apiBaseUrl,
      apiToken: bootstrap.apiToken,
      stateDir: bootstrap.stateDir,
      repoPath: repo.path,
      worktreeRoot: repo.worktreeRoot,
      workerId: identity.workerId,
      baseBranch: policy.baseBranch,
      pollIntervalMs: policy.pollIntervalMs,
      taskTimeoutMs: policy.taskTimeoutMs,
      maxDiffLines: policy.maxDiffLines,
      maxDiffFiles: policy.maxDiffFiles,
    };
  }

  // A refusal here must not crash the worker or touch any other assignment: it is recorded and
  // surfaced on the next heartbeat as bindingError, and that one project is simply left unbound —
  // absent from bound, so the loop never attempts to claim from it.
  async function rebind(): Promise<void> {
    const identity = loadIdentity(identityStore);
    const nextBound = new Map<string, { path: string; worktreeRoot: string }>();
    const errors: string[] = [];

    if (identity) {
      for (const assignment of assignments) {
        const result = await bindRepository(
          {
            runner,
            readAllowlist,
            realpath: realpathSync,
            stat: (p) => {
              const info = statSync(p);
              return { uid: info.uid, mode: info.mode };
            },
            uid,
            workerId: identity.workerId,
          },
          assignment.proposedPath
        );
        if (result.ok) {
          nextBound.set(assignment.project, { path: result.path, worktreeRoot: result.worktreeRoot });
        } else {
          errors.push(`${assignment.project}: ${result.reason}`);
        }
      }
    }

    bound = nextBound;
    heartbeat.reportBindingError(errors.join("; "));

    for (const projectId of bound.keys()) {
      if (reapedProjects.has(projectId)) continue;
      reapedProjects.add(projectId);
      const taskConfig = configFor(projectId);
      if (!taskConfig) continue;
      const reaped = await reapOrphans(createWorkspace(taskConfig, runner), taskConfig.worktreeRoot).catch(
        () => 0
      );
      if (reaped > 0) {
        console.log(`reaped ${reaped} worktree(s) left by an earlier run for project ${projectId}`);
      }
    }
  }

  // The single source of current policy and assignments, whether this run just registered, is
  // reusing a stored identity from a previous run (Task 5's GET, since no register() response
  // exists to read this from in that case), or is picking up a change made after startup.
  let lastRefresh = 0;
  async function refreshServerState(): Promise<void> {
    if (Date.now() - lastRefresh < MIN_REFRESH_INTERVAL_MS) return;
    lastRefresh = Date.now();

    const identity = loadIdentity(identityStore);
    if (!identity) return;

    try {
      const response = await fetch(`${bootstrap.apiBaseUrl}/api/workers/${identity.workerId}`, {
        headers: {
          Authorization: `Bearer ${identity.credential}`,
          "X-Worker-Id": identity.workerId,
          "X-CP-Protocol": String(PROTOCOL_VERSION),
        },
      });
      if (!response.ok) return;
      const body = (await response.json()) as { policy?: unknown; assignments?: unknown };
      policy = applyPolicy(policy, body.policy);
      assignments = parseAssignments(body.assignments);
    } catch (error) {
      console.error(`could not refresh worker policy: ${String(error)}`);
      return;
    }

    await rebind();
  }

  const workerName = bootstrap.workerName;
  const heartbeat = startHeartbeat({
    apiBaseUrl: bootstrap.apiBaseUrl,
    apiToken: bootstrap.apiToken,
    registration: { name: workerName, host: hostname(), platform: process.platform, version: WORKER_VERSION },
    store: identityStore,
  });
  let current: AbortController | null = null;
  // Deliberately abort-only — see the commit message for why this needs no matching un-pause.
  heartbeat.onAbort(() => current?.abort());

  async function execute(task: ClaimedTask): Promise<void> {
    const taskConfig = configFor(task.projectId);
    if (!taskConfig) {
      // The assignment was reassigned or lost its binding between claim and here — release
      // rather than strand a task this worker can no longer act on
      await api.release(task.projectId, task.taskId).catch(() => {});
      return;
    }

    const controller = new AbortController();
    current = controller;
    const deps: PipelineDeps = {
      config: taskConfig,
      api,
      columnIds: (projectId) => api.columnIds(projectId),
      createReporter: (client, statusIds) =>
        createReporter(client, statusIds, (message) => console.error(message), outbox),
      createDelivery,
      workspace: createWorkspace(taskConfig, runner),
      executor: createExecutor(taskConfig, runner),
      collectDiff,
      runner,
      gates: buildGates(taskConfig, runner),
      signal: controller.signal,
    };
    try {
      await runTask(deps, task);
    } finally {
      current = null;
    }
  }

  async function drain(): Promise<void> {
    await refreshServerState();
    const { delivered, pending, dropped } = await outbox.flush(api);
    if (delivered || pending || dropped) {
      console.log(`outbox: delivered ${delivered}, still pending ${pending}, dropped ${dropped}`);
    }
  }

  const loop = createLoop({
    pollIntervalMs: () => policy.pollIntervalMs,
    assignments: () => [...bound.keys()],
    api,
    execute,
    sleep,
    drain,
  });

  // "stop" pauses rather than calling loop.stop() — see the commit message for why.
  const control = connectControl({
    apiBaseUrl: bootstrap.apiBaseUrl,
    identitySource: identityStore,
    handlers: {
      pause: () => {
        loop.pause();
        if (loop.paused()) heartbeat.ack("pause");
      },
      resume: () => {
        loop.resume();
        if (!loop.paused()) heartbeat.ack("resume");
      },
      stop: () => {
        current?.abort();
        loop.pause();
        if (loop.paused()) heartbeat.ack("stop");
      },
    },
  });

  process.on("SIGTERM", () => loop.stop());
  process.on("SIGINT", () => loop.stop());

  await heartbeat.tick();
  // A failure here must not keep the worker from starting its loop — drain() retries this on the
  // worker's normal cadence once running, the same as any later refresh failure.
  await refreshServerState().catch((error) => console.error(`initial state refresh failed: ${String(error)}`));

  console.log(
    `worker ${loadIdentity(identityStore)?.workerId ?? "(unregistered)"} polling ${bootstrap.apiBaseUrl}`
  );
  await loop.start();
  heartbeat.stop();
  control.close();
  console.log("worker stopped");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
