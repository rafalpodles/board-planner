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
  ProjectOffer,
  ProjectCatalogueEntry,
  Bootstrap,
  DEFAULT_POLICY,
  EffectiveConfig,
  loadBootstrap,
  localSocketPath,
  parseAssignments,
  parseOffers,
  parseCatalogue,
  WorkerConfig,
} from "./config.js";
import { connectControl, ControlDeps } from "./control.js";
import { createDelivery, hardenedGitConfig } from "./delivery.js";
import { collectDiff } from "./diff.js";
import { pinnedAccount, resolveGhToken } from "./github-account.js";
import { gateFromEntry } from "./gates/from-entry.js";
import { createRunner, Runner } from "./exec.js";
import { childEnv } from "./env.js";
import { createExecutor } from "./executor.js";
import { LocalServer, LocalServerDeps, startLocalServer } from "./local-server.js";
import { createLoop } from "./loop.js";
import { createOutbox, Store } from "./outbox.js";
import { PipelineDeps, RunDisposition, runTask } from "./pipeline.js";
import {
  checkRepo,
  pathWithTools,
  PreflightCheck,
  PreflightDeps,
  PreflightReport,
  runPreflight,
} from "./preflight.js";
import { createReporter, ReleaseMemory } from "./reporter.js";
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
  readFile: (path: string) => string | null;
  execPath: string;
  isExecutable: (path: string) => boolean;
  runPreflight: (deps: PreflightDeps) => Promise<PreflightReport>;
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

function remoteFetchEnv(githubToken: string): () => NodeJS.ProcessEnv {
  return () => ({
    ...hardenedGitConfig(),
    ...(githubToken ? { GH_TOKEN: githubToken, GITHUB_TOKEN: githubToken } : {}),
  });
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
  const releaseComments: ReleaseMemory = new Map();
  const readAllowlist = createAllowlistReader(bootstrap.stateDir);

  let policy: EffectiveConfig = DEFAULT_POLICY;
  let assignments: Assignment[] = [];
  let inventory: RepoInventory[] = [];
  let offers: ProjectOffer[] = [];
  let catalogue: ProjectCatalogueEntry[] = [];
  let inventoryError = "";
  let bound = new Map<string, { path: string; worktreeRoot: string; config: EffectiveConfig; remote: string }>();
  const reapedProjects = new Set<string>();

  let preflight: PreflightReport | null = null;
  let repoChecks: PreflightCheck[] = [];
  const unusable = new Map<string, string>();
  const quarantined = new Map<string, string>();

  const checkoutOf = (projectId: string): string =>
    bound.get(projectId)?.path ?? `project:${projectId}`;

  const quarantineReasonFor = (projectId: string): string | undefined =>
    quarantined.get(checkoutOf(projectId));

  function quarantineProject(projectId: string, reason: string): void {
    const checkout = checkoutOf(projectId);
    if (quarantined.has(checkout)) return;
    quarantined.set(
      checkout,
      `${checkout}: its git config carries ${reason}. Remove the key, then restart this worker.`
    );
    deps.logError(
      `quarantining ${checkout}: its git config carries ${reason}. ` +
        `Nothing on this machine will claim for any project on that checkout again until the key ` +
        `is gone and this worker is restarted.`
    );
  }

  const quarantineChecks = (): PreflightCheck[] =>
    [...quarantined.entries()].map(([checkout, detail]) => ({
      name: "checkout quarantined",
      ok: false,
      detail,
    }));

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

  async function rebind(): Promise<void> {
    const identity = loadIdentity(identityStore);
    const nextBound = new Map<
      string,
      { path: string; worktreeRoot: string; config: EffectiveConfig; remote: string }
    >();
    const errors: string[] = [];

    if (identity) {
      for (const assignment of assignments) {
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
          nextBound.set(assignment.project, {
            path: result.path,
            worktreeRoot: result.worktreeRoot,
            config: applyPolicy(policy, assignment.policy),
            remote: assignment.remote,
          });
        } else {
          errors.push(`${assignment.project}: ${result.reason}`);
        }
      }
    }

    bound = nextBound;
    unusable.clear();
    repoChecks = [...bound.entries()].flatMap(([projectId, repo]) => {
      const checks = checkRepo(deps.readFile, repo.path);
      const failing = checks.filter((check) => !check.ok);
      if (failing.length) {
        unusable.set(projectId, failing.map((check) => check.detail).join("; "));
      }
      return checks;
    });

    for (const [projectId, reason] of unusable) {
      deps.logError(
        `not claiming for project ${projectId}: its checkout cannot pass the gates — ${reason}`
      );
    }
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
      const body = (await response.json()) as {
        policy?: unknown;
        assignments?: unknown;
        offers?: unknown;
        catalogue?: unknown;
      };
      policy = applyPolicy(policy, body.policy);
      assignments = parseAssignments(body.assignments);
      offers = parseOffers(body.offers);
      catalogue = parseCatalogue(body.catalogue);
    } catch (error) {
      deps.logError(`could not refresh worker policy: ${String(error)}`);
      return;
    }

    await refreshInventory();
    await rebind();
  }

  const runs = createRunGuard();

  const telemetry = deps.createTelemetry();

  let currentRun: { taskId: string; runId: string } | null = null;

  const isPhase = (update: TelemetryUpdate): update is Progress =>
    !isQuota(update) && !isOutcome(update);

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

    if (currentRun !== run || lostRun === run) return;
    lostRun = run;
    deps.logError(
      `task ${run.taskId}: the server no longer has run ${run.runId} holding it — stopping the run`
    );
    runs.abort();
  });

  telemetry.subscribe((update) => {
    if (!isPhase(update) || !currentRun) return;
    postPhase(update);
  });

  async function githubIdentityToken(): Promise<string> {
    const account = pinnedAccount(deps.readFile, bootstrap.stateDir);
    if (!account) return "";

    const ghPath = preflight?.paths.gh ?? "";
    const token = await resolveGhToken(deps.runner, ghPath, account, childEnv([], deps.env));
    if (!token) {
      deps.logError(
        `could not resolve a token for the pinned GitHub account ${account} — delivery falls back to whichever account gh has active`
      );
    }
    return token;
  }

  async function execute(task: ClaimedTask): Promise<RunDisposition> {
    const taskConfig = configFor(task.projectId);
    if (!taskConfig) {
      await api.release(task.projectId, task.taskId).catch(() => {});
      return;
    }

    const githubToken = await githubIdentityToken();
    const remoteUrl = bound.get(task.projectId)?.remote;

    currentRun = { taskId: task.taskId, runId: task.runId };
    try {
      return await runs.under((signal) => {
        const pipeline: PipelineDeps = {
          config: taskConfig,
          api,
          columnIds: (projectId) => api.columnIds(projectId),
          createReporter: (client, statusIds) =>
            createReporter(client, statusIds, (message) => deps.logError(message), outbox, releaseComments),
          createDelivery: (runner, baseBranch) => createDelivery(runner, baseBranch, githubToken),
          workspace: createWorkspace(taskConfig, deps.runner, remoteFetchEnv(githubToken), remoteUrl),
          executor: createExecutor(taskConfig, deps.runner),
          collectDiff,
          gateFor: gateFromEntry,
          recordRun: (project, record) => outbox.add({ kind: "run", projectId: project, record }),
          logError: deps.logError,
          quarantineProject,
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
    assignments: () =>
      [...bound.keys()].filter(
        (projectId) => !unusable.has(projectId) && !quarantineReasonFor(projectId)
      ),
    api,
    execute,
    sleep: deps.sleep,
    drain,
    log: deps.logError,
  });

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
      const checks = [...preflight.checks, ...repoChecks, ...quarantineChecks()];
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
  heartbeat.onAbort(() => runs.abort());

  const control = deps.connectControl({
    apiBaseUrl: bootstrap.apiBaseUrl,
    identitySource: identityStore,
    handlers: channels.remote,
    fetchImpl: deps.fetchImpl,
    log: deps.logError,
  });

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
        blocked:
          quarantineReasonFor(project) ?? unusable.get(project) ?? loop.unclaimable(project),
        baseBranch: repo.config.baseBranch,
        model: repo.config.model,
        reviewModel: repo.config.reviewModel,
        maxDiffLines: repo.config.maxDiffLines,
        taskTimeoutMs: repo.config.taskTimeoutMs,
      })),
      githubAccount:
        pinnedAccount(deps.readFile, bootstrap.stateDir) || preflight?.githubAccount || "",
      githubAccounts: preflight?.githubAccounts ?? [],
      offers,
      catalogue,
    }),
    log: deps.logError,
  });
  local.ready.catch((error) => deps.logError(`local control socket unavailable: ${String(error)}`));

  return {
    async run() {
      await establishPreflight();

      await refreshInventory();

      await heartbeat.tick();
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
      runs.abort(SHUTDOWN_SIGNAL);
    },
  };
}
