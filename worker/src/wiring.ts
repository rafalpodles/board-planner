import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { hostname } from "os";
import { dirname, join } from "path";
import { ApiClient, createApiClient } from "./api.js";
import { createCommandHandlers, createRunGuard, SHUTDOWN_SIGNAL } from "./commands.js";
import {
  applyPolicy,
  Assignment,
  RepoInventory,
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
import { pinnedAccount, resolveGhToken } from "./github-account.js";
import { gateFromEntry } from "./gates/from-entry.js";
import { createRunner, Runner } from "./exec.js";
import { childEnv } from "./env.js";
import { createExecutor } from "./executor.js";
import { LocalServer, LocalServerDeps, startLocalServer } from "./local-server.js";
import { createLoop } from "./loop.js";
import { createOutbox, Store } from "./outbox.js";
import { PipelineDeps, runTask } from "./pipeline.js";
import {
  checkRepo,
  pathWithTools,
  PreflightCheck,
  PreflightDeps,
  PreflightReport,
  runPreflight,
} from "./preflight.js";
import { createReporter } from "./reporter.js";
import { abortableSleep } from "./sleep.js";
import { HeartbeatDeps, loadIdentity, PROTOCOL_VERSION, startHeartbeat } from "./registration.js";
import { bindRepository, createAllowlistReader, repoInventory } from "./repos.js";
import {
  createTelemetry,
  dropWhenBusy,
  isOutcome,
  isQuota,
  Progress,
  Telemetry,
  TelemetryUpdate,
} from "./telemetry.js";
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
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  log: (message: string) => void;
  logError: (message: string) => void;
  uid: number;
  realpath: (path: string) => string;
  stat: (path: string) => { uid: number; mode: number };
  fetchImpl: typeof fetch;
  createStore: (path: string) => Store;
  // null for "not there", so a missing manifest is not confused with an unreadable one
  readFile: (path: string) => string | null;
  execPath: string;
  isExecutable: (path: string) => boolean;
  runPreflight: (deps: PreflightDeps) => Promise<PreflightReport>;
  // childEnv() copies PATH from this process, so repairing the worker's own is what reaches every
  // child — and, through `claude -p`, every grandchild. Named as a dependency rather than done by
  // assignment because that coupling is the whole point of the check.
  setPath: (value: string) => void;
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
    sleep: abortableSleep,
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
    readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    execPath: process.execPath,
    isExecutable: (path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    runPreflight,
    setPath: (value) => {
      process.env.PATH = value;
    },
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
  let inventory: RepoInventory[] = [];
  // Why the inventory could not be read, surfaced on the heartbeat so a broken repos.json shows up
  // in the console instead of looking like a machine that simply has nothing.
  let inventoryError = "";
  let bound = new Map<string, { path: string; worktreeRoot: string; config: EffectiveConfig }>();
  const reapedProjects = new Set<string>();

  // What this machine can actually do, established once at startup. Null until then, and reported
  // as undefined while it is, so a worker mid-startup never claims to be broken.
  let preflight: PreflightReport | null = null;
  // The gates' own requirements, which only exist relative to a bound repository, so they are
  // recomputed on every rebind rather than once at startup
  let repoChecks: PreflightCheck[] = [];

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
      baseBranch: repo.config.baseBranch,
      pollIntervalMs: repo.config.pollIntervalMs,
      taskTimeoutMs: repo.config.taskTimeoutMs,
      runCeilingMs: repo.config.runCeilingMs,
      maxDiffLines: repo.config.maxDiffLines,
      maxDiffFiles: repo.config.maxDiffFiles,
      model: repo.config.model,
      fallbackModel: repo.config.fallbackModel,
      reviewModel: repo.config.reviewModel,
    };
  }

  // Resolving the binaries is only half of it. childEnv() copies PATH from this process, and a
  // worker started by launchd — or by an app launched from Finder — has one with no Homebrew and no
  // nvm on it. So the resolved directories go onto the worker's own PATH, which is what every child
  // and, through `claude -p`, every grandchild then inherits. Without this the check passes and
  // every task still fails.
  async function establishPreflight(): Promise<void> {
    try {
      preflight = await deps.runPreflight({
        runner: deps.runner,
        env: deps.env,
        execPath: deps.execPath,
        isExecutable: deps.isExecutable,
        pinnedGithubAccount: pinnedAccount(deps.readFile, bootstrap.stateDir),
      });
    } catch (error) {
      deps.logError(`preflight could not run: ${String(error)}`);
      return;
    }

    const repaired = pathWithTools(preflight.paths, deps.env.PATH ?? "");
    if (repaired !== deps.env.PATH) {
      deps.setPath(repaired);
      deps.log("PATH extended with the directories the required tools were found in");
    }

    for (const check of preflight.checks) {
      if (!check.ok) deps.logError(`preflight: ${check.name} — ${check.detail}`);
    }
  }

  // A failure keeps the previous inventory rather than reporting an empty one: the server would
  // otherwise overwrite what it knows, and this machine would silently stop being offered anything.
  async function refreshInventory(): Promise<void> {
    let result;
    try {
      result = await repoInventory({ runner: deps.runner, readAllowlist });
    } catch (error) {
      result = { ok: false as const, reason: `could not read repos.json: ${String(error)}` };
    }
    if (result.ok) {
      inventory = result.repos;
      inventoryError = "";
      return;
    }
    inventoryError = result.reason;
    deps.logError(result.reason);
  }

  // A refusal here must not crash the worker or touch any other assignment: it is recorded and
  // surfaced on the next heartbeat as bindingError, and that one project is simply left unbound —
  // absent from bound, so the loop never attempts to claim from it.
  async function rebind(): Promise<void> {
    const identity = loadIdentity(identityStore);
    const nextBound = new Map<string, { path: string; worktreeRoot: string; config: EffectiveConfig }>();
    const errors: string[] = [];

    if (identity) {
      for (const assignment of assignments) {
        // The server sends a remote, never a path. Resolving it here, against this machine's own
        // inventory, is what keeps "where anything runs" a local decision.
        const local = inventory.find((r) => r.remote === assignment.remote);
        if (!local) {
          errors.push(`${assignment.project}: no checkout of ${assignment.remote} on this machine`);
          continue;
        }
        const result = await bindRepository(
          {
            runner: deps.runner,
            readAllowlist,
            realpath: deps.realpath,
            stat: deps.stat,
            uid: deps.uid,
            workerId: identity.workerId,
          },
          local.path
        );
        if (result.ok) {
          // Each project resolves its own policy against this worker's defaults, so two projects on
          // one machine can want different models, limits and merge behaviour.
          nextBound.set(assignment.project, {
            path: result.path,
            worktreeRoot: result.worktreeRoot,
            config: applyPolicy(policy, assignment.policy),
          });
        } else {
          errors.push(`${assignment.project}: ${result.reason}`);
        }
      }
    }

    bound = nextBound;
    repoChecks = [...bound.values()].flatMap((repo) => checkRepo(deps.readFile, repo.path));
    heartbeat.reportBindingError([inventoryError, ...errors].filter(Boolean).join("; "));

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

    await refreshInventory();
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

  // An outcome is durable and already has a route: reporter.ts writes it to the board through the
  // outbox, which survives a restart. This feed is the volatile one and carries phases only.
  const isPhase = (update: TelemetryUpdate): update is Progress =>
    !isQuota(update) && !isOutcome(update);

  // The run this worker has already been told it lost. The phases still in flight while that run
  // unwinds would otherwise re-abort it and repeat the message once each.
  let lostRun: { taskId: string; runId: string } | null = null;

  const postPhase = dropWhenBusy(async (update: TelemetryUpdate) => {
    const run = currentRun;
    if (!run || !isPhase(update)) return;

    const { applied } = await api.postEvent({
      taskId: run.taskId,
      runId: run.runId,
      phase: update.phase,
    });
    if (applied) return;

    // applied:false is the server having written nothing, and recordTaskPhase writes nothing for
    // two reasons: the run no longer holds the task — someone moved it with force, which is what
    // this reacts to — or the event was overtaken by one carrying a higher seq. Only the first can
    // reach a run of this worker's that is still live: api.ts stamps seq from a counter that only
    // ever rises, dropWhenBusy keeps a single post in flight so two of ours never race, and the
    // claim unsets phaseSeq, so nothing this run sends can land behind something newer. The
    // refusal a healthy worker really does produce is the post that settles after its own run has
    // ended — told apart by identity here, since by then the run in flight is different work and
    // aborting would kill it.
    if (currentRun !== run || lostRun === run) return;
    lostRun = run;
    deps.logError(
      `task ${run.taskId}: the server no longer has run ${run.runId} holding it — stopping the run`
    );
    runs.abort();
  });

  telemetry.subscribe((update) => {
    // Filtered before dropWhenBusy, not inside it: an update with nowhere to go must not spend the
    // single in-flight slot that the next real phase needs.
    if (!isPhase(update) || !currentRun) return;
    postPhase(update);
  });

  // Read per run, not captured at startup: an operator who picks a different account in the app
  // gets it on the next task rather than on the next launch, the same way policy changes land.
  // Empty leaves gh to resolve its own identity, which is what every machine did before BP-373.
  async function githubIdentityToken(): Promise<string> {
    const account = pinnedAccount(deps.readFile, bootstrap.stateDir);
    if (!account) return "";

    const ghPath = preflight?.paths.gh ?? "";
    const token = await resolveGhToken(deps.runner, ghPath, account, childEnv([], deps.env));
    if (!token) {
      // Loud, and then out of the way: falling back to gh's active account is what happens next,
      // and a run that pushes as the wrong name is the thing this message has to make findable.
      deps.logError(
        `could not resolve a token for the pinned GitHub account ${account} — delivery falls back to whichever account gh has active`
      );
    }
    return token;
  }

  async function execute(task: ClaimedTask): Promise<void> {
    const taskConfig = configFor(task.projectId);
    if (!taskConfig) {
      // The assignment was reassigned or lost its binding between claim and here — release
      // rather than strand a task this worker can no longer act on
      await api.release(task.projectId, task.taskId).catch(() => {});
      return;
    }

    const githubToken = await githubIdentityToken();

    currentRun = { taskId: task.taskId, runId: task.runId };
    try {
      await runs.under((signal) => {
        const pipeline: PipelineDeps = {
          config: taskConfig,
          api,
          columnIds: (projectId) => api.columnIds(projectId),
          createReporter: (client, statusIds) =>
            createReporter(client, statusIds, (message) => deps.logError(message), outbox),
          createDelivery: (runner, baseBranch) => createDelivery(runner, baseBranch, githubToken),
          workspace: createWorkspace(taskConfig, deps.runner),
          executor: createExecutor(taskConfig, deps.runner),
          collectDiff,
          gateFor: gateFromEntry,
          recordRun: (project, record) => outbox.add({ kind: "run", projectId: project, record }),
          runner: deps.runner,
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
    enrolmentToken: bootstrap.enrolmentToken,
    repos: () => (inventoryError ? undefined : inventory),
    preflight: () => {
      if (!preflight) return undefined;
      const checks = [...preflight.checks, ...repoChecks];
      return { ok: checks.every((c) => c.ok), account: preflight.account, checks };
    },
    forgetEnrolmentToken: bootstrap.enrolmentTokenFile
      ? () => rmSync(bootstrap.enrolmentTokenFile, { force: true })
      : undefined,
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
    config: () => ({
      apiUrl: bootstrap.apiBaseUrl,
      workerName: bootstrap.workerName,
      projectCount: bound.size,
      pollIntervalMs: policy.pollIntervalMs,
      projects: [...bound.entries()].map(([project, repo]) => ({
        project,
        baseBranch: repo.config.baseBranch,
        model: repo.config.model,
        reviewModel: repo.config.reviewModel,
        maxDiffLines: repo.config.maxDiffLines,
        taskTimeoutMs: repo.config.taskTimeoutMs,
      })),
      // Read here rather than taken from the startup report: an operator who picks another account
      // in the app must see the answer change without restarting the worker, which is also exactly
      // when it changes for the next run.
      githubAccount:
        pinnedAccount(deps.readFile, bootstrap.stateDir) || preflight?.githubAccount || "",
      githubAccounts: preflight?.githubAccounts ?? [],
    }),
    log: deps.logError,
  });
  // A worker that cannot open its socket is a worker without a menubar, not a worker that stops
  // claiming — and an unobserved rejection would take the process down under Node 22.
  local.ready.catch((error) => deps.logError(`local control socket unavailable: ${String(error)}`));

  return {
    async run() {
      // First of all, because it repairs the PATH every later child is spawned with — including
      // the git this run's own inventory scan shells out to.
      await establishPreflight();

      // Before the first heartbeat, which is what carries it: the server matches projects against
      // these remotes, so reporting an empty inventory would leave this machine unassigned until
      // the next heartbeat and the next refresh had both come round.
      await refreshInventory();

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

    // Children are in their own session now, so a terminal Ctrl-C no longer reaches the agent —
    // loop.stop() alone is a flag checked between tasks, which would mean waiting out a run that
    // can last the full task timeout. Aborting matches what the operator's stop command already
    // does, and the run is released with its attempt refunded, which is right: the operator
    // stopping the worker is not the task failing.
    shutdown() {
      loop.stop();
      runs.abort(SHUTDOWN_SIGNAL);
    },
  };
}
