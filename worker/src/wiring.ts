import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { hostname } from "os";
import { dirname, join } from "path";
import { ApiClient, createApiClient } from "./api.js";
import { createCommandHandlers, createRunGuard } from "./commands.js";
import {
  applyPolicy,
  Assignment,
  Bootstrap,
  DEFAULT_POLICY,
  EffectiveConfig,
  loadBootstrap,
  localSocketPath,
  parseAssignments,
  WorkerConfig,
} from "./config.js";
import { connectControl, ControlDeps } from "./control.js";
import { createDelivery } from "./delivery.js";
import { collectDiff } from "./diff.js";
import { createRunner, Runner } from "./exec.js";
import { createExecutor } from "./executor.js";
import { buildGates } from "./gates/index.js";
import { LocalServer, LocalServerDeps, startLocalServer } from "./local-server.js";
import { createLoop } from "./loop.js";
import { createOutbox, Store } from "./outbox.js";
import { PipelineDeps, runTask } from "./pipeline.js";
import { createReporter } from "./reporter.js";
import { HeartbeatDeps, loadIdentity, PROTOCOL_VERSION, startHeartbeat } from "./registration.js";
import { bindRepository, createAllowlistReader } from "./repos.js";
import { createTelemetry, dropWhenBusy, isQuota, Telemetry } from "./telemetry.js";
import { ClaimedTask } from "./types.js";
import { createWorkspace, reapOrphans } from "./workspace.js";

const WORKER_VERSION = "1.0.0";
const MIN_REFRESH_INTERVAL_MS = 30_000;

// Every ambient thing the wiring used to reach for directly. main.ts is the one place that supplies
// none of them; a test supplies whichever it needs to watch. The point of the split is that the
// joins between components are now assertable — in part A every whole-branch defect lived in a seam
// that only this file's untested predecessor ever closed.
export interface WorkerDeps {
  env: Record<string, string | undefined>;
  runner: Runner;
  hostname: () => string;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  logError: (message: string) => void;
  uid: number;
  realpath: (path: string) => string;
  stat: (path: string) => { uid: number; mode: number };
  fetchImpl: typeof fetch;
  createStore: (path: string) => Store;
  createApi: (bootstrap: Bootstrap) => ApiClient;
  createTelemetry: () => Telemetry;
  startHeartbeat: typeof startHeartbeat;
  connectControl: (deps: ControlDeps) => { close(): void };
  startLocalServer: (deps: LocalServerDeps) => LocalServer;
}

export interface WorkerRuntime {
  run(): Promise<void>;
  shutdown(): void;
}

function fileStore(path: string): Store {
  return {
    read: () => (existsSync(path) ? readFileSync(path, "utf8") : ""),
    write: (text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, { mode: 0o600 });
    },
  };
}

export function defaultWorkerDeps(): WorkerDeps {
  return {
    env: process.env,
    runner: createRunner(),
    hostname,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(message),
    logError: (message) => console.error(message),
    uid: process.getuid ? process.getuid() : 0,
    realpath: realpathSync,
    stat: (path) => {
      const info = statSync(path);
      return { uid: info.uid, mode: info.mode };
    },
    fetchImpl: (...args) => fetch(...args),
    createStore: fileStore,
    createApi: (bootstrap) => createApiClient(bootstrap),
    createTelemetry,
    startHeartbeat,
    connectControl,
    startLocalServer,
  };
}

export function createWorker(overrides: Partial<WorkerDeps> = {}): WorkerRuntime {
  const deps: WorkerDeps = { ...defaultWorkerDeps(), ...overrides };
  const bootstrap = loadBootstrap(deps.env);
  const api = deps.createApi(bootstrap);

  const identityStore = deps.createStore(join(bootstrap.stateDir, "worker.json"));
  const outbox = createOutbox(deps.createStore(join(bootstrap.stateDir, "outbox.jsonl")));
  const readAllowlist = createAllowlistReader(bootstrap.stateDir);

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
      model: policy.model,
      fallbackModel: policy.fallbackModel,
      reviewModel: policy.reviewModel,
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
            runner: deps.runner,
            readAllowlist,
            realpath: deps.realpath,
            stat: deps.stat,
            uid: deps.uid,
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
      const reaped = await reapOrphans(
        createWorkspace(taskConfig, deps.runner),
        taskConfig.worktreeRoot
      ).catch(() => 0);
      if (reaped > 0) {
        deps.log(`reaped ${reaped} worktree(s) left by an earlier run for project ${projectId}`);
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
      const response = await deps.fetchImpl(`${bootstrap.apiBaseUrl}/api/workers/${identity.workerId}`, {
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
      deps.logError(`could not refresh worker policy: ${String(error)}`);
      return;
    }

    await rebind();
  }

  const runs = createRunGuard();

  // One bus, two sinks, and this is the only place either is attached. The socket subscribes to the
  // whole bounded Progress; the server gets the phase alone, since PhaseEvent has nowhere to put
  // anything else. Both read what the run emits — nothing here reads the run's output itself.
  const telemetry = deps.createTelemetry();

  // Which task the updates on the bus belong to. The server authorizes an event against the run
  // recorded on the task, so a phase emitted once the run is over — a late stdout chunk, a sink
  // still draining — is a write against a task this worker no longer holds. Refused here rather
  // than relying on the server to notice.
  let currentRun: { taskId: string; runId: string } | null = null;

  const postPhase = dropWhenBusy((update) => {
    const run = currentRun;
    if (!run || isQuota(update)) return Promise.resolve();
    return api.postEvent({ taskId: run.taskId, runId: run.runId, phase: update.phase });
  });

  telemetry.subscribe((update) => {
    // Filtered before dropWhenBusy, not inside it: an update with nowhere to go must not spend the
    // single in-flight slot that the next real phase needs.
    if (isQuota(update) || !currentRun) return;
    postPhase(update);
  });

  async function execute(task: ClaimedTask): Promise<void> {
    const taskConfig = configFor(task.projectId);
    if (!taskConfig) {
      // The assignment was reassigned or lost its binding between claim and here — release
      // rather than strand a task this worker can no longer act on
      await api.release(task.projectId, task.taskId).catch(() => {});
      return;
    }

    currentRun = { taskId: task.taskId, runId: task.runId };
    try {
      await runs.under((signal) => {
        const pipeline: PipelineDeps = {
          config: taskConfig,
          api,
          columnIds: (projectId) => api.columnIds(projectId),
          createReporter: (client, statusIds) =>
            createReporter(client, statusIds, (message) => deps.logError(message), outbox),
          createDelivery,
          workspace: createWorkspace(taskConfig, deps.runner),
          executor: createExecutor(taskConfig, deps.runner),
          collectDiff,
          runner: deps.runner,
          gates: buildGates(taskConfig, deps.runner),
          signal,
          telemetry,
        };
        return runTask(pipeline, task);
      });
    } finally {
      currentRun = null;
    }
  }

  async function drain(): Promise<void> {
    await refreshServerState();
    const { delivered, pending, dropped } = await outbox.flush(api);
    if (delivered || pending || dropped) {
      deps.log(`outbox: delivered ${delivered}, still pending ${pending}, dropped ${dropped}`);
    }
  }

  const loop = createLoop({
    pollIntervalMs: () => policy.pollIntervalMs,
    assignments: () => [...bound.keys()],
    api,
    execute,
    sleep: deps.sleep,
    drain,
    log: deps.logError,
  });

  // One dispatcher behind all three transports — see the commit message for why the heartbeat, not
  // the stream, is the one that has to work. Two entry points, though: the server channels share a
  // recency guard over the server's clock, and the local socket must stay out of it.
  const channels = createCommandHandlers({
    loop,
    runs,
    ack: (command) => heartbeat.ack(command),
  });

  const heartbeatDeps: HeartbeatDeps = {
    apiBaseUrl: bootstrap.apiBaseUrl,
    apiToken: bootstrap.apiToken,
    registration: {
      name: bootstrap.workerName,
      host: deps.hostname(),
      platform: process.platform,
      version: WORKER_VERSION,
    },
    store: identityStore,
    handlers: channels.remote,
    fetchImpl: deps.fetchImpl,
    log: deps.logError,
  };
  const heartbeat = deps.startHeartbeat(heartbeatDeps);
  // Deliberately abort-only — see the commit message for why this needs no matching un-pause.
  heartbeat.onAbort(() => runs.abort());

  const control = deps.connectControl({
    apiBaseUrl: bootstrap.apiBaseUrl,
    identitySource: identityStore,
    handlers: channels.remote,
    fetchImpl: deps.fetchImpl,
    log: deps.logError,
  });

  // The socket is given the bus, not the right to write to it: its dependency is subscribe/recent.
  const local = deps.startLocalServer({
    socketPath: localSocketPath(bootstrap.stateDir),
    handlers: channels.local,
    telemetry,
    paused: () => loop.paused(),
    log: deps.logError,
  });
  // A worker that cannot open its socket is a worker without a menubar, not a worker that stops
  // claiming — and an unobserved rejection would take the process down under Node 22.
  local.ready.catch((error) => deps.logError(`local control socket unavailable: ${String(error)}`));

  return {
    async run() {
      await heartbeat.tick();
      // A failure here must not keep the worker from starting its loop — drain() retries this on
      // the worker's normal cadence once running, the same as any later refresh failure.
      await refreshServerState().catch((error) =>
        deps.logError(`initial state refresh failed: ${String(error)}`)
      );

      deps.log(
        `worker ${loadIdentity(identityStore)?.workerId ?? "(unregistered)"} polling ${bootstrap.apiBaseUrl}`
      );
      await loop.start();

      heartbeat.stop();
      control.close();
      await local.close();
      deps.log("worker stopped");
    },

    shutdown() {
      loop.stop();
    },
  };
}
