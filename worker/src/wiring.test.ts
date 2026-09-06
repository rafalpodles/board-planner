import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { ApiClient, ClaimRefused, PhaseEvent } from "./api.js";
import { ControlDeps } from "./control.js";
import { Runner } from "./exec.js";
import { LocalConfigView, LocalServer, LocalServerDeps } from "./local-server.js";
import { Store } from "./outbox.js";
import { PreflightReport } from "./preflight.js";
import { Heartbeat, HeartbeatDeps } from "./registration.js";
import { createTelemetry } from "./telemetry.js";
import { ClaimedTask } from "./types.js";
import { createWorker, WorkerDeps } from "./wiring.js";
import { scopedConfigListZ } from "./config-list.fixtures.js";

const STATE_DIR = "/tmp/cp-wiring-test-state";

interface RemoteCall {
  args: string[];
  env: NodeJS.ProcessEnv;
}

// GIT_CONFIG_COUNT/KEY_n/VALUE_n is how hardenedGitConfig carries config in the environment. Read
// back the way git reads it, so the assertion is about the configuration that reaches git and not
// about the spelling of a variable name.
function gitConfigPairs(env: NodeJS.ProcessEnv): [string, string][] {
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  const pairs: [string, string][] = [];
  for (let index = 0; index < count; index += 1) {
    pairs.push([env[`GIT_CONFIG_KEY_${index}`] ?? "", env[`GIT_CONFIG_VALUE_${index}`] ?? ""]);
  }
  return pairs;
}

const ENV = {
  CP_API_URL: "https://app.example.com",
  CP_API_TOKEN: "cp_admin_token",
  CP_WORKER_NAME: "worker-1",
  CP_STATE_DIR: STATE_DIR,
};

const IDENTITY = JSON.stringify({ workerId: "6a7c686f70ed274cf658b1b3", credential: "cpw_x", heartbeatMs: 60_000 });

function memoryStore(contents: string): Store {
  let text = contents;
  return {
    read: () => text,
    write: (next) => {
      text = next;
    },
  };
}

function fakeHeartbeat(bindingErrors: string[] = []): Heartbeat {
  return {
    tick: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    onAbort: vi.fn(),
    ack: vi.fn(),
    reportBindingError: vi.fn((message: string) => {
      bindingErrors.push(message);
    }),
  };
}

// Everything the wiring reaches for, replaced. No process ever spawns, no socket ever binds and no
// request ever leaves — what is under test is which component each seam was joined to.
function harness(overrides: Partial<WorkerDeps> = {}) {
  const heartbeat = fakeHeartbeat();
  const local: LocalServer = { ready: Promise.resolve(), close: vi.fn().mockResolvedValue(undefined) };

  const seen = {
    heartbeat: undefined as HeartbeatDeps | undefined,
    control: undefined as ControlDeps | undefined,
    local: undefined as LocalServerDeps | undefined,
  };

  const control = { close: vi.fn() };
  const logError = vi.fn<WorkerDeps["logError"]>();

  const deps: Partial<WorkerDeps> = {
    env: ENV,
    runner: { run: vi.fn() } as unknown as Runner,
    hostname: () => "host-1",
    sleep: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    logError,
    uid: 501,
    realpath: (path) => path,
    stat: () => ({ uid: 501, mode: 0o40700 }),
    fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch,
    createStore: (path) => memoryStore(path.endsWith("worker.json") ? IDENTITY : ""),
    createApi: () =>
      ({
        claim: vi.fn().mockResolvedValue(null),
        release: vi.fn().mockResolvedValue(undefined),
      }) as unknown as ApiClient,
    startHeartbeat: (heartbeatDeps) => {
      seen.heartbeat = heartbeatDeps;
      return heartbeat;
    },
    connectControl: (controlDeps) => {
      seen.control = controlDeps;
      return control;
    },
    startLocalServer: (localDeps) => {
      seen.local = localDeps;
      return local;
    },
    ...overrides,
  };

  const worker = createWorker(deps);
  return { worker, seen, heartbeat, control, local, logError };
}

describe("the local socket's place in the wiring", () => {
  // The two server channels deliver the same standing command, so they must share the guard that
  // tells a redelivery from a fresh instruction.
  it("gives both server channels the one guarded dispatcher", () => {
    const { seen } = harness();

    expect(seen.heartbeat?.handlers).toBe(seen.control?.handlers);
  });

  // The socket still goes through commands.ts — a socket handed loop.pause() would skip the
  // acknowledgement — but by the local entry point. Handing it the server's record would order this
  // laptop's clock against the server's, and a fast laptop would drop a board-issued stop.
  it("keeps the socket out of the guard the server's clock writes to", () => {
    const { seen } = harness();

    expect(seen.local?.handlers).toBeDefined();
    expect(seen.local?.handlers).not.toBe(seen.heartbeat?.handlers);
  });

  it("puts the socket in the worker's own state directory", () => {
    const { seen } = harness();

    expect(seen.local?.socketPath).toBe(join(STATE_DIR, "worker.sock"));
  });

  it("reports the live loop's pause state, not a copy taken at startup", () => {
    const { seen } = harness();

    expect(seen.local?.paused()).toBe(false);
    seen.local?.handlers.pause();

    expect(seen.local?.paused()).toBe(true);
  });

  it("gives the socket the same telemetry bus the run reports into", () => {
    const telemetry = createTelemetry();
    const { seen } = harness({ createTelemetry: () => telemetry });

    telemetry.emit({ phase: "agent" });

    expect(seen.local?.telemetry).toBe(telemetry);
    expect(seen.local?.telemetry.recent()).toEqual([{ phase: "agent" }]);
  });
});

describe("the worker's lifecycle", () => {
  it("closes the socket, the control stream and the heartbeat when the loop ends", async () => {
    const { worker, heartbeat, control, local } = harness();

    const running = worker.run();
    worker.shutdown();
    await running;

    expect(heartbeat.stop).toHaveBeenCalledTimes(1);
    expect(control.close).toHaveBeenCalledTimes(1);
    expect(local.close).toHaveBeenCalledTimes(1);
  });

  // Since children run in their own session, a terminal Ctrl-C reaches only the worker. Without an
  // abort, shutdown is a flag checked between tasks — so stopping could mean waiting out the whole
  // task timeout with the agent still working.
  it("keeps claiming when the socket cannot be opened at all", async () => {
    const { worker, logError } = harness({
      startLocalServer: () => ({
        ready: Promise.reject(new Error("EADDRINUSE")),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const running = worker.run();
    worker.shutdown();
    await running;

    expect(logError).toHaveBeenCalledWith(expect.stringContaining("local control socket unavailable"));
  });
});

// Nothing below is mocked between the agent's stdout and the two sinks. Everything part B built is
// inert until this join exists, and in part A every whole-branch defect lived in exactly this kind
// of seam: a producer in one task, a consumer in another, and no test that ran both at once.
describe("telemetry, from the agent's stdout to the two sinks", () => {
  const REPO = "/repos/demo";
  const REMOTE = "git@github.com:owner/repo.git";
  // A second checkout on the same machine, for the tests about what a quarantine covers
  const OTHER_REPO = "/repos/other";
  const OTHER_REMOTE = "git@github.com:owner/other.git";
  const remoteFor = (cwd?: string) => (cwd === OTHER_REPO ? OTHER_REMOTE : REMOTE);
  const BASE_SHA = "cafef00d";
  const SERVER_RUN_ID = "run-minted-by-the-server";
  const AGENT_SECRET = "cpw_deadbeef0123456789abcdef01234567";

  const CLAIMED: ClaimedTask = {
    taskId: "t1",
    projectId: "p1",
    taskKey: "CP-9",
    taskNumber: 9,
    title: "Add a thing",
    description: "body",
    acceptanceCriteria: [],
    attempts: 1,
    runId: SERVER_RUN_ID,
    // The default agent, as the server resolves it: today's pipeline, one entry per stage. The
    // blocks name no model, so the project's policy is still what these tests are reading.
    agent: {
      agentId: "a1",
      name: "Default",
      sequence: [
        { key: "implement", kind: "step", name: "Implement", prompt: "make the change", capability: "edit" },
        { key: "protected-paths", kind: "gate", name: "Protected files", gateKind: "protected-paths" },
        { key: "diff-size", kind: "gate", name: "Size", gateKind: "diff-size" },
        { key: "test-presence", kind: "gate", name: "Test written", gateKind: "test-presence" },
        { key: "build", kind: "gate", name: "Builds", gateKind: "build" },
        { key: "test-run", kind: "gate", name: "Tests pass", gateKind: "test-run" },
        { key: "review", kind: "gate", name: "Reviewed", gateKind: "review" },
        { key: "push", kind: "step", name: "Push", deterministic: true },
        { key: "pull-request", kind: "step", name: "Pull request", deterministic: true },
      ],
    },
  };

  // The task the worker moves on to, so a refusal that settles late has a live run to endanger
  const NEXT_TASK: ClaimedTask = { ...CLAIMED, taskId: "t2", taskKey: "CP-10", taskNumber: 10 };

  const RESULT_PAYLOAD = {
    status: "completed",
    summary: "did it",
    filesChanged: ["src/a.ts"],
    testsAdded: [],
    blockedReason: "",
  };

  // Shaped like the captured fixture: an init event that summarises to nothing, one tool call whose
  // input carries a secret, and the final result.
  const AGENT_STREAM = `${[
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Edit",
            input: { file_path: "src/a.ts", content: `TOKEN=${AGENT_SECRET}` },
          },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 3,
      total_cost_usd: 0.42,
      result: JSON.stringify(RESULT_PAYLOAD),
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n")}\n`;

  // 17 bytes: small enough that every line is cut, and a tick apart, the way a real pipe flushes
  function pipeFlushes(text: string): string[] {
    const parts: string[] = [];
    for (let index = 0; index < text.length; index += 17) parts.push(text.slice(index, index + 17));
    return parts;
  }

  function streamingRunner(
    claudeCalls: string[][] = [],
    onAgentStart?: (nth: number) => void,
    everyCall: string[][] = [],
    remoteCalls: RemoteCall[] = [],
    // What `config --list --show-scope` answers. Only that listing: `--local --list` is what
    // bindRepository scans, and a key visible to both would be refused at binding time instead —
    // which is the path BP-346 records as the one an include.path or worktree-scope key evades.
    scopedConfig: string | Record<string, string> = ""
  ): Runner {
    const scopedFor = (cwd?: string) =>
      typeof scopedConfig === "string" ? scopedConfig : (scopedConfig[cwd ?? ""] ?? "");
    return {
      async run(command, args, opts) {
        everyCall.push([command, ...args]);
        if (command === "git" && args.includes("--show-scope")) {
          return { code: 0, stdout: scopedFor(opts.cwd), stderr: "", timedOut: false };
        }
        // everyCall keeps argv only, and the base lookup's hardening lives entirely in its
        // environment — workspace.ts composes those two calls' env instead of their args.
        if (command === "git" && (args[0] === "ls-remote" || args[0] === "fetch")) {
          remoteCalls.push({ args, env: opts.env ?? {} });
        }
        if (command === "claude") {
          claudeCalls.push(args);
          onAgentStart?.(claudeCalls.length);
          for (const part of pipeFlushes(AGENT_STREAM)) {
            opts.onStdout?.(part);
            await new Promise((resolve) => setImmediate(resolve));
          }
          return { code: 0, stdout: AGENT_STREAM, stderr: "", timedOut: false };
        }
        // The base is resolved off the wire now, so ls-remote has to answer with the ref it was
        // asked for; whether the *right* ref is picked out is gate-integrity's subject, on real git
        if (args[0] === "ls-remote") {
          return { code: 0, stdout: `${BASE_SHA}\t${args[args.length - 1]}\n`, stderr: "", timedOut: false };
        }
        // workspace.ts verifies the fetched sha with `rev-parse --verify <sha>^{commit}` before
        // trusting it as the base; collectDiff then refuses anything that is not an object id, so
        // this has to answer with one rather than the content-free "" every other call gets
        if (args.includes("--verify")) {
          return { code: 0, stdout: `${BASE_SHA}\n`, stderr: "", timedOut: false };
        }
        // bindRepository insists the path is its own toplevel; every other git call is content-free
        return {
          code: 0,
          // The directory it ran in, not a constant: bindRepository insists a path is its own
          // toplevel, and a fixture answering the same path for every cwd cannot have a second
          // checkout at all.
          stdout: args.includes("rev-parse")
            ? (opts.cwd ?? REPO)
            : args.includes("get-url")
              ? remoteFor(opts.cwd)
              : "",
          stderr: "",
          timedOut: false,
        };
      },
    };
  }

  // One full pass of the real loop: register, refresh, bind, claim, run, and stop. The diff comes
  // back empty, so the run ends where most real ones do — rejected at a gate, not merged.
  // postEvent is deliberately a plain function, never a vi.fn: a spy attaches its own handler to
  // whatever it returns, which quietly settles a rejection the source left unhandled — and that is
  // exactly the failure this suite has to be able to see.
  async function runOneTask(
    postEvent: ApiClient["postEvent"] = async () => ({ applied: true }),
    policy?: Record<string, unknown>,
    opts: {
      assignmentRemote?: string;
      extraAssignmentFields?: Record<string, unknown>;
      readFile?: (path: string) => string | null;
      // Written into the run's own state directory before the worker starts, the way an operator's
      // choices already sit there — repos.json, worker.json, and now the pinned GitHub account
      stateFiles?: Record<string, string>;
      // Claimed in order, one per pass of the loop, then the queue runs dry
      tasks?: ClaimedTask[];
      // The board refusing the claim outright, in the server's words (BP-512). A string refuses
      // every project; a map refuses only the projects it names, which is what it takes to put one
      // project's board refusal next to a sibling's quarantine.
      claimRefusal?: string | Record<string, string>;
      onAgentStart?: (nth: number) => void;
      // What the checkout's scoped git config says, for the tests about a planted key
      scopedConfig?: string | Record<string, string>;
      // Written into repos.json; defaults to the single REPO every other test uses
      repos?: string[];
      // Replaces the single p1 assignment; each entry binds by remote the way the server's do
      assignments?: { project: string; remote: string }[];
      // How many passes the loop is allowed before it is stopped. One is a single pass, which is
      // what almost every test here wants; two is what it takes to see whether a project is
      // claimed from AGAIN.
      passes?: number;
      // Moves the clock on at each sleep, so a later pass really re-binds: refreshServerState is
      // throttled by MIN_REFRESH_INTERVAL_MS and would otherwise return without doing anything,
      // which makes "survives a rebind" a claim no test could see.
      clockJumpOnSleepMs?: number;
    } = {}
  ) {
    let seenHeartbeat: HeartbeatDeps | undefined;
    const stateDir = mkdtempSync(join(tmpdir(), "cp-wiring-run-"));
    writeFileSync(join(stateDir, "repos.json"), JSON.stringify({ repos: opts.repos ?? [REPO] }), {
      mode: 0o600,
    });

    for (const [name, contents] of Object.entries(opts.stateFiles ?? {})) {
      writeFileSync(join(stateDir, name), contents, { mode: 0o600 });
    }

    const telemetry = createTelemetry();
    const posted: PhaseEvent[] = [];
    const claudeCalls: string[][] = [];
    const everyCall: string[][] = [];
    const remoteCalls: RemoteCall[] = [];
    const bindingErrors: string[] = [];
    const queue = opts.tasks ?? [CLAIMED];
    const logError = vi.fn();
    let claims = 0;
    let slept = 0;
    // wiring reads Date.now() directly for the refresh throttle, so this is what lets a test move
    // past it. Installed inside the try below rather than here: this file has no afterEach, so a
    // spy installed before the worker is built would outlive a throw and stand for the rest of it.
    let clockOffset = 0;
    let serverFetch = vi.fn();
    const wallClock = Date.now;
    let localConfig: (() => LocalConfigView) | undefined;

    const api = {
      claim: vi.fn<ApiClient["claim"]>(async (projectId) => {
        const refusal =
          typeof opts.claimRefusal === "string" ? opts.claimRefusal : opts.claimRefusal?.[projectId];
        if (refusal) throw new ClaimRefused(refusal);
        return queue[claims++] ?? null;
      }),
      setStatus: vi.fn<ApiClient["setStatus"]>().mockResolvedValue(undefined),
      comment: vi.fn<ApiClient["comment"]>().mockResolvedValue(undefined),
      release: vi.fn<ApiClient["release"]>().mockResolvedValue(undefined),
      statusIds: vi
        .fn<ApiClient["statusIds"]>()
        .mockResolvedValue({ approved: "todo", review: "in_review", done: "done" }),
      columnIds: vi
        .fn<ApiClient["columnIds"]>()
        .mockResolvedValue(["todo", "in_progress", "in_review", "done"]),
      postEvent: (event: PhaseEvent) => {
        posted.push(event);
        return postEvent(event);
      },
    };

    let stop = (): void => {};
    const worker = createWorker({
      env: { ...ENV, CP_STATE_DIR: stateDir },
      runner: streamingRunner(
        claudeCalls,
        opts.onAgentStart,
        everyCall,
        remoteCalls,
        opts.scopedConfig
      ),
      hostname: () => "host-1",
      // the loop only sleeps once it has nothing left to claim, which is one pass after the run
      sleep: async () => {
        clockOffset += opts.clockJumpOnSleepMs ?? 0;
        if (++slept >= (opts.passes ?? 1)) stop();
      },
      log: vi.fn(),
      logError,
      uid: 501,
      realpath: (path) => path,
      stat: () => ({ uid: 501, mode: 0o40700 }),
      // Held rather than inlined: refreshServerState is this call's only caller, so the count is
      // how a test says whether a rebind actually happened instead of assuming the clock got it there.
      fetchImpl: (serverFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          // What this machine could set up but has not — read only by the socket, never by the
          // claim loop
          offers: [
            {
              project: "p2",
              key: "SB",
              name: "Sandbox",
              repositoryUrl: "https://github.com/owner/sandbox",
            },
          ],
          // Work policy travels with the assignment now: it describes the project, so two projects
          // on one machine can resolve differently.
          assignments: (
            opts.assignments ?? [{ project: "p1", remote: opts.assignmentRemote ?? REMOTE }]
          ).map((assignment) => ({
            ...assignment,
            ...(opts.extraAssignmentFields ?? {}),
            ...(policy ? { policy } : {}),
          })),
        }),
      })) as unknown as typeof fetch,
      createStore: (path) => memoryStore(path.endsWith("worker.json") ? IDENTITY : ""),
      createApi: () => api as unknown as ApiClient,
      createTelemetry: () => telemetry,
      // A checkout with what the gates need, unless a test says otherwise. Left to the real
      // filesystem this described a repository with no lockfile and no scripts — which since
      // BP-379 is one the worker declines to claim from, so every run test would be asserting
      // against a machine that correctly refuses to work.
      readFile:
        opts.readFile ??
        ((path: string) =>
          path.endsWith("package-lock.json")
            ? "{}"
            : path.endsWith("package.json")
              ? JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
              // Everything else still comes off the real filesystem, which is how the state
              // directory written by `stateFiles` reaches the worker.
              : existsSync(path)
                ? readFileSync(path, "utf8")
                : null),
      startHeartbeat: (heartbeatDeps) => {
        seenHeartbeat = heartbeatDeps;
        return fakeHeartbeat(bindingErrors);
      },
      connectControl: () => ({ close: vi.fn() }),
      startLocalServer: (localDeps) => {
        localConfig = localDeps.config;
        return { ready: Promise.resolve(), close: vi.fn().mockResolvedValue(undefined) };
      },
    });
    stop = () => worker.shutdown();

    const clock = vi.spyOn(Date, "now").mockImplementation(() => wallClock() + clockOffset);
    try {
      await worker.run();
    } finally {
      clock.mockRestore();
      rmSync(stateDir, { recursive: true, force: true });
    }

    return {
      api,
      posted,
      bindingErrors,
      logError,
      claimed: claudeCalls.length > 0,
      everyCall,
      remoteCalls,
      workspacePaths: claudeCalls.flat(),
      phases: posted.map((event) => event.phase),
      telemetry,
      worker,
      claudeArgs: claudeCalls[0] ?? [],
      localConfig,
      heartbeatDeps: seenHeartbeat,
      rebinds: serverFetch.mock.calls.length,
    };
  }

  // Children run in their own session since the process-group change, so a terminal Ctrl-C reaches
  // only the worker. loop.stop() alone is a flag checked between tasks, which would mean waiting out
  // a run that can last the full task timeout with the agent still working.
  it("aborts the run in flight when the worker is asked to shut down", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cp-shutdown-"));
    writeFileSync(join(stateDir, "repos.json"), JSON.stringify({ repos: [REPO] }), { mode: 0o600 });
    let sawAbort = false;
    let claims = 0;
    let reachedSleep = false;
    let shutdown = () => {};

    const hangingRunner: Runner = {
      async run(command, args, opts) {
        if (command === "claude") {
          shutdown();
          // shutdown aborts synchronously, so the signal is already aborted by the time we look —
          // registering a listener first and only then calling shutdown would wait forever
          if (!opts.signal?.aborted) {
            await new Promise<void>((resolve) => opts.signal?.addEventListener("abort", () => resolve()));
          }
          sawAbort = opts.signal?.aborted === true;
          return { code: 143, stdout: "", stderr: "aborted", timedOut: false };
        }
        if (args[0] === "ls-remote") {
          return { code: 0, stdout: `${REPO}\t${args[args.length - 1]}\n`, stderr: "", timedOut: false };
        }
        return { code: 0, stdout: args.includes("rev-parse") ? REPO : args.includes("get-url") ? REMOTE : "", stderr: "", timedOut: false };
      },
    };

    const worker = createWorker({
      env: { ...ENV, CP_STATE_DIR: stateDir },
      runner: hangingRunner,
      hostname: () => "host-1",
      // reaching this at all means the abort did not end the run — without it the loop spins with
      // nothing to claim and never yields, which starves even the test timeout
      sleep: async () => {
        reachedSleep = true;
        worker.shutdown();
      },
      log: vi.fn(),
      logError: vi.fn(),
      uid: 501,
      realpath: (path) => path,
      stat: () => ({ uid: 501, mode: 0o40700 }),
      // A checkout the gates would accept: since BP-379 the loop declines to claim from one that
      // fails checkRepo, and this test is about aborting a run, not about refusing to start one.
      readFile: (path: string) =>
        path.endsWith("package-lock.json")
          ? "{}"
          : path.endsWith("package.json")
            ? JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
            : null,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ assignments: [{ project: "p1", remote: REMOTE }] }),
      }) as unknown as typeof fetch,
      createStore: (path) => memoryStore(path.endsWith("worker.json") ? IDENTITY : ""),
      createApi: () =>
        ({
          claim: vi.fn(async () => (claims++ === 0 ? CLAIMED : null)),
          setStatus: vi.fn().mockResolvedValue(undefined),
          comment: vi.fn().mockResolvedValue(undefined),
          release: vi.fn().mockResolvedValue(undefined),
          statusIds: vi.fn().mockResolvedValue({ approved: "todo", review: "in_review", done: "done" }),
          columnIds: vi.fn().mockResolvedValue(["todo", "in_progress", "in_review", "done"]),
          postEvent: async () => ({ applied: true }),
        }) as unknown as ApiClient,
      startHeartbeat: () => fakeHeartbeat(),
      connectControl: () => ({ close: vi.fn() }),
      startLocalServer: () => ({ ready: Promise.resolve(), close: vi.fn().mockResolvedValue(undefined) }),
    });
    shutdown = () => worker.shutdown();

    try {
      await worker.run();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }

    expect(sawAbort).toBe(true);
    expect(reachedSleep).toBe(false);
  });

  // runTask signals "machine-fault" when the base branch cannot be resolved — the loop is meant to
  // read that off the seam this worker wires them together through and end the pass without
  // sleeping. A wiring bug that drops the disposition (`execute` declared Promise<void> and the
  // pipeline's return value never handed back) type-checks silently, because Promise<void> is
  // assignable to Promise<void | "machine-fault">, and produces a hot loop instead: the worker
  // claims again immediately with no poll interval on an unreachable remote.
  // ls-remote is where resolveFreshBase reads the base branch off the wire; failing it is what
  // turns workspace.create's failure into a transport-kind BaseUnavailableError, i.e. a machine
  // fault. Every other call is the content-free catch-all the rest of this file's runners use to
  // satisfy bindRepository/checkRepo.
  const unreachableRemote: Runner = {
    async run(_command, args) {
      if (args[0] === "ls-remote") {
        return { code: 1, stdout: "", stderr: "unreachable", timedOut: false };
      }
      return {
        code: 0,
        stdout: args.includes("rev-parse") ? REPO : args.includes("get-url") ? REMOTE : "",
        stderr: "",
        timedOut: false,
      };
    },
  };

  async function runAgainstUnreachableRemote(options: { passes: number; endlessQueue?: boolean }) {
    const stateDir = mkdtempSync(join(tmpdir(), "cp-machine-fault-"));
    writeFileSync(join(stateDir, "repos.json"), JSON.stringify({ repos: [REPO] }), { mode: 0o600 });

    const counts = { claims: 0, sleeps: 0 };
    let stop = (): void => {};

    const api = {
      claim: vi.fn(async () => {
        counts.claims++;
        return options.endlessQueue || counts.claims === 1 ? CLAIMED : null;
      }),
      setStatus: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      statusIds: vi.fn().mockResolvedValue({ approved: "todo", review: "in_review", done: "done" }),
      columnIds: vi.fn().mockResolvedValue(["todo", "in_progress", "in_review", "done"]),
      postEvent: async () => ({ applied: true }),
      postRun: vi.fn().mockResolvedValue(undefined),
    };

    const worker = createWorker({
      env: { ...ENV, CP_STATE_DIR: stateDir },
      runner: unreachableRemote,
      hostname: () => "host-1",
      sleep: async () => {
        counts.sleeps++;
        if (counts.sleeps >= options.passes) stop();
      },
      log: vi.fn(),
      logError: vi.fn(),
      uid: 501,
      realpath: (path) => path,
      stat: () => ({ uid: 501, mode: 0o40700 }),
      readFile: (path: string) =>
        path.endsWith("package-lock.json")
          ? "{}"
          : path.endsWith("package.json")
            ? JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
            : null,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ assignments: [{ project: "p1", remote: REMOTE }] }),
      }) as unknown as typeof fetch,
      createStore: (path) => memoryStore(path.endsWith("worker.json") ? IDENTITY : ""),
      createApi: () => api as unknown as ApiClient,
      startHeartbeat: () => fakeHeartbeat(),
      connectControl: () => ({ close: vi.fn() }),
      startLocalServer: () => ({ ready: Promise.resolve(), close: vi.fn().mockResolvedValue(undefined) }),
    });
    stop = () => worker.shutdown();

    try {
      await worker.run();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
    return { api, counts };
  }

  it("stops claiming for the cycle, without sleeping mid-pass, when the base branch cannot be resolved", async () => {
    const { counts } = await runAgainstUnreachableRemote({ passes: 1 });

    // A propagated machine-fault ends the pass on the very claim that hit it: one claim, then
    // sleep. The bug this guards claims a fault as ordinary work instead, so the loop skips the
    // sleep and claims again immediately — it would only give up once the queue itself ran dry,
    // claiming a second time (and finding nothing left) before ever sleeping.
    expect(counts.claims).toBe(1);
    expect(counts.sleeps).toBe(1);
  });

  // Three passes over the same unresolvable base, which is what a laptop that lost its wifi does
  // all night. The reporter dedupes a repeated release comment, but it is built per run, so the
  // memory behind that dedupe has to be wired somewhere that outlives one — otherwise every poll
  // writes the card another identical comment and fires another webhook, Slack message and
  // notification with it: ~120 an hour at the default interval.
  it("comments once about a base it cannot resolve, however many passes hit the same fault", async () => {
    const { api, counts } = await runAgainstUnreachableRemote({ passes: 3, endlessQueue: true });

    expect(counts.claims).toBe(3);
    expect(api.release).toHaveBeenCalledTimes(3);
    expect(api.comment).toHaveBeenCalledTimes(1);
    expect(api.comment.mock.calls[0][2]).toMatch(/Returned to the queue: .*could not resolve base branch main/s);
  });

  // The whole run, as the board would see it: the three stage boundaries it got past, the three
  // events its own agent produced, and the three gates it reached before the empty diff was
  // rejected. Nothing is dropped here because every emission is separated by at least one await,
  // which is all dropWhenBusy's single in-flight slot needs to clear.
  it("carries a pipeline stage boundary to the server", async () => {
    const { api, phases } = await runOneTask();

    expect(api.claim).toHaveBeenCalled();
    expect(phases).toEqual([
      "claiming",
      "worktree",
      // the block the run is on, then the three events its own agent produced under it
      "step:implement",
      "agent",
      "agent",
      // protected-paths first: it is what decides whether the agent was allowed to write the files
      // the build and test gates would go on to execute
      "gates:protected-paths",
      "gates:diff-size",
      "gates:test-presence",
    ]);
  });

  // An outcome is durable and reaches the board through reporter.ts and its outbox. Letting one
  // onto this feed posts `phase: undefined` against a live run — the shape the phase field is
  // matched on — and spends the single in-flight slot the next real phase needs.
  it("keeps outcomes off the server's phase feed, which carries stages only", async () => {
    const { posted } = await runOneTask();

    expect(posted.length).toBeGreaterThan(0);
    expect(posted.every((event) => typeof event.phase === "string" && event.phase !== "")).toBe(true);
    expect(posted.map((event) => event.phase)).not.toContain(undefined);
  });

  // The pipeline names "agent" exactly once, at the stage boundary. Every further one was produced
  // by parsing the agent's stdout mid-run, so more than one is proof the stream reached the server.
  it("carries an event off the agent's own stream to the server", async () => {
    const { phases, telemetry } = await runOneTask();

    expect(phases.filter((phase) => phase === "agent").length).toBeGreaterThan(1);
    // and it really is the stream: only a parsed tool_use can produce a tool
    expect(telemetry.recent()).toContainEqual({
      phase: "agent",
      tool: { name: "Edit", target: "src/a.ts" },
    });
  });

  // The whole path in one pass — the server's own policy JSON, through applyPolicy and configFor,
  // into the argv of the process that does the work. This is the join no unit test can see: config
  // knows the policy, executor knows the flag, and until now nothing carried one to the other.
  it("runs the agent on the model the server's policy names", async () => {
    const { claudeArgs } = await runOneTask(undefined, {
      model: "haiku",
      fallbackModel: "opus",
    });

    expect(claudeArgs[claudeArgs.indexOf("--model") + 1]).toBe("haiku");
    expect(claudeArgs[claudeArgs.indexOf("--fallback-model") + 1]).toBe("opus");
  });

  // BP-373. `gh auth switch` is global machine state any terminal can flip, so the identity a run
  // pushes as has to be resolved by name at the start of that run rather than left to whichever
  // account gh happens to have active when delivery reaches the remote.
  it("resolves the pinned github account's token by name before the run", async () => {
    const { everyCall } = await runOneTask(undefined, undefined, {
      stateFiles: { "github.json": JSON.stringify({ account: "owner" }) },
    });

    expect(everyCall).toContainEqual([
      expect.stringContaining("gh"),
      "auth",
      "token",
      "--user",
      "owner",
    ]);
  });

  // The seam gate-integrity.integration.test.ts cannot reach: that test mirrors what this call site
  // composes rather than calling it, so a createWorkspace(...) that stopped passing
  // remoteFetchEnv(...) would leave it green. The lookup's `git fetch` runs inside the checkout,
  // whose config a previous run's agent can write, and an `[url "ext::<program> %S"] insteadOf =
  // <the pinned URL>` there runs that program holding GH_TOKEN, GITHUB_TOKEN and SSH_AUTH_SOCK —
  // measured. protocol.ext.allow=never is what refuses it, and nothing but hardenedGitConfig() puts
  // it in this environment; a plain { GH_TOKEN, GITHUB_TOKEN } would authenticate just as well and
  // carry none of it.
  it("gives the base lookup the hardened git environment, not merely a token", async () => {
    const { remoteCalls } = await runOneTask();

    // Both halves of the lookup, and named rather than counted: an empty list would satisfy every
    // assertion below it.
    expect(remoteCalls.map((call) => call.args[0])).toEqual(["ls-remote", "fetch"]);
    for (const call of remoteCalls) {
      expect(gitConfigPairs(call.env)).toContainEqual(["protocol.ext.allow", "never"]);
    }
  });

  // Opt-in. Asking gh for "the token" with nothing pinned would hand back the active account's,
  // which is the very thing being pinned away from.
  it("asks gh for no token at all when no account is pinned", async () => {
    const { everyCall } = await runOneTask();

    expect(everyCall.filter((call) => call.includes("token"))).toEqual([]);
  });

  // A pin the keyring cannot answer for must not take the run down with it: delivery falls back to
  // gh's own resolution, and the reason is on the operator's log rather than inside a 403 later.
  it("says so and carries on when the pinned account has no token to give", async () => {
    const { logError } = await runOneTask(undefined, undefined, {
      stateFiles: { "github.json": JSON.stringify({ account: "logged-out-account" }) },
    });

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("logged-out-account")
    );
  });

  // Same join as the model test below, one surface further on: the server's policy has to reach the
  // socket the operator's own cockpit reads, or the app shows defaults while the run uses something
  // else. config knows the policy and local-server serves it; nothing carried one to the other.
  // Reporting one "model" would show an operator a value no run is using once two projects on one
  // machine resolve differently, so the socket reports each bound project instead.
  it("serves each project's own resolved policy on the socket, not the startup defaults", async () => {
    const { localConfig } = await runOneTask(undefined, {
      model: "haiku",
      reviewModel: "opus",
      maxDiffLines: 77,
    });

    expect(localConfig?.()).toMatchObject({
      apiUrl: "https://app.example.com",
      workerName: "worker-1",
      projectCount: 1,
      // Asserted against the producer, not only against a fixture: local-server serves this object
      // untransformed, so nothing else would notice the field being dropped or renamed here
      pollIntervalMs: 30_000,
    });
    expect(localConfig?.().projects).toEqual([
      expect.objectContaining({
        project: "p1",
        model: "haiku",
        reviewModel: "opus",
        maxDiffLines: 77,
      }),
    ]);
  });

  // BP-375. The app can only offer to set up a project it has heard of, and assignments carry only
  // the ones already working — so the socket has to carry the other half.
  it("serves the projects it could set up but has no checkout of", async () => {
    const { localConfig } = await runOneTask();

    expect(localConfig?.().offers).toEqual([
      {
        project: "p2",
        key: "SB",
        name: "Sandbox",
        repositoryUrl: "https://github.com/owner/sandbox",
      },
    ]);
  });

  // The cockpit's Connection tab answers "which account did that push act as" from this, so it has
  // to be the live pin rather than the value preflight read when the process started.
  it("serves the pinned github account on the socket, and never a token", async () => {
    const { localConfig } = await runOneTask(undefined, undefined, {
      stateFiles: { "github.json": JSON.stringify({ account: "owner" }) },
    });

    const view = localConfig?.();
    expect(view?.githubAccount).toBe("owner");
    expect(JSON.stringify(view)).not.toMatch(/gho_|ghp_|cpw_/);
  });

  it("puts no credential and no repository path on the socket", async () => {
    const { localConfig } = await runOneTask();

    expect(JSON.stringify(localConfig?.())).not.toMatch(/cp_admin_token|cpw_|\/repos\/demo/);
  });

  it("runs the agent on today's models when the server's policy names none", async () => {
    const { claudeArgs } = await runOneTask();

    expect(claudeArgs[claudeArgs.indexOf("--model") + 1]).toBe("opus");
    expect(claudeArgs[claudeArgs.indexOf("--fallback-model") + 1]).toBe("sonnet");
  });

  it("addresses every event to the task and the run the server itself minted", async () => {
    const { posted } = await runOneTask();

    expect(posted.length).toBeGreaterThan(0);
    for (const event of posted) {
      expect(event.taskId).toBe("t1");
      expect(event.runId).toBe(SERVER_RUN_ID);
    }
  });

  it("sends the server nothing the agent wrote", async () => {
    const { posted, telemetry } = await runOneTask();

    expect(JSON.stringify(posted)).not.toContain(AGENT_SECRET);
    expect(JSON.stringify(posted)).not.toContain("TOKEN=");
    expect(JSON.stringify(telemetry.recent())).not.toContain(AGENT_SECRET);
  });

  it("fills the socket's own view of the run from the same bus", async () => {
    const { telemetry } = await runOneTask();

    const phases = telemetry.recent().map((progress) => progress.phase);
    expect(phases).toContain("claiming");
    expect(phases).toContain("gates:diff-size");
    expect(telemetry.recent().at(-1)).toBeDefined();
  });

  it("posts nothing once the run is over, when the worker no longer holds the task", async () => {
    const { posted, telemetry } = await runOneTask();

    const afterTheRun = posted.length;
    telemetry.emit({ phase: "merge" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(afterTheRun).toBeGreaterThan(0);
    expect(posted.length).toBe(afterTheRun);
  });

  // emit() is called synchronously from inside a pipeline stage, so a rejection nobody handles is
  // an unhandledRejection, and Node's default action for one is to end the process. Asserted on the
  // process, because the run finishes either way and only the missing rejection tells them apart.
  it("leaves no unhandled rejection when the server refuses every event", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const refusing: ApiClient["postEvent"] = () =>
      Promise.reject(new Error("403: that run no longer holds this task"));

    process.on("unhandledRejection", record);
    let run;
    try {
      run = await runOneTask(refusing);
      // unhandledRejection is reported at the end of a turn, so give it one
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", record);
    }

    expect(unhandled).toEqual([]);
    expect(run.posted.length).toBeGreaterThan(0);
    // and the run still reached the board with its verdict
    expect(run.api.setStatus).toHaveBeenCalledWith("p1", "t1", "in_review");
  });

  // A task can be taken from a running worker: changeStatus refuses while a run holds it, but a
  // person can override with force, and the server then clears the run from the task. Every phase
  // post after that comes back applied:false — the only sign the worker gets that the rest of this
  // run is tokens spent on work whose result will be refused.
  describe("a task taken from the run that holds it", () => {
    it("stops the run when the server says it no longer holds the task", async () => {
      const run = await runOneTask(async (event) => ({ applied: event.phase !== "agent" }));

      // released, not gate-rejected: the run ended where the refusal arrived
      expect(run.api.release).toHaveBeenCalledWith("p1", "t1");
      expect(run.api.setStatus).not.toHaveBeenCalledWith("p1", "t1", "in_review");
      expect(run.phases.some((phase) => phase.startsWith("gates:"))).toBe(false);
      // said once, not once per phase still in flight while the run unwinds
      const lost = run.logError.mock.calls.filter(([message]) =>
        message.includes("no longer has run")
      );
      expect(lost).toHaveLength(1);
    });

    // The server answers applied:false for an overtaken event too, and a post that settles after
    // its own run has ended is indistinguishable from one. Ending the run in flight on it would
    // kill the next task's run — real work, for a refusal that concerns the previous one.
    it("leaves the run in flight alone when the refusal belongs to the run before it", async () => {
      let deliverLate = (): void => {};
      const late = new Promise<{ applied: boolean }>((resolve) => {
        deliverLate = () => resolve({ applied: false });
      });

      const run = await runOneTask(
        async (event) =>
          event.taskId === "t1" && event.phase === "agent" ? late : { applied: true },
        undefined,
        {
          tasks: [CLAIMED, NEXT_TASK],
          // the first task's refusal lands while the second task's run is the one in flight
          onAgentStart: (nth) => {
            if (nth === 2) deliverLate();
          },
        }
      );

      expect(run.api.setStatus).toHaveBeenCalledWith("p1", "t2", "in_review");
      expect(run.api.release).not.toHaveBeenCalled();
      expect(run.logError).not.toHaveBeenCalledWith(expect.stringContaining("no longer has run"));
    });

    it("aborts nothing when the refusal lands with no run in flight at all", async () => {
      let deliverLate = (): void => {};
      const late = new Promise<{ applied: boolean }>((resolve) => {
        deliverLate = () => resolve({ applied: false });
      });

      const run = await runOneTask(async (event) =>
        event.phase === "agent" ? late : { applied: true }
      );

      // the loop has stopped by now, so there is no run for a refusal to be about
      deliverLate();
      await new Promise((resolve) => setImmediate(resolve));

      expect(run.api.setStatus).toHaveBeenCalledWith("p1", "t1", "in_review");
      expect(run.logError).not.toHaveBeenCalledWith(expect.stringContaining("no longer has run"));
    });
  });

  // The invariant the whole change exists to protect, and the one that had no test: an assignment
  // naming a remote this machine does not have must bind nothing and say why.
  describe("the server can never name a directory here", () => {
    it("binds nothing and reports the reason when the remote is not on this machine", async () => {
      const run = await runOneTask(undefined, undefined, {
        assignmentRemote: "git@github.com:someone/else.git",
      });

      expect(run.claimed).toBe(false);
      expect(run.bindingErrors.join(" ")).toMatch(/no checkout of git@github\.com:someone\/else\.git/);
    });

    // The gates run `npm ci` and `npm run build` unconditionally, so a repository without a
    // lockfile or without those scripts fails every task forever. It can only be checked once a
    // repository is bound, so the report has to pick it up on rebind rather than at startup.
    it("adds the bound repository's own shortcomings to the report", async () => {
      const run = await runOneTask(undefined, undefined, {
        readFile: (path) =>
          path.endsWith("package.json") ? JSON.stringify({ scripts: { test: "vitest" } }) : null,
      });

      const report = run.heartbeatDeps?.preflight?.();
      expect(report?.ok).toBe(false);
      expect(report?.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(
        expect.arrayContaining(["package-lock.json", "build script"])
      );
      expect(report?.checks.find((c) => c.name === "package-lock.json")?.detail).toContain(REPO);
    });

    // BP-379. Found by running it: MP-75 was claimed from a repository with no lockfile and no
    // test script, an agent worked for sixteen minutes, and the run died at a gate whose reason
    // checkRepo had already reported at binding time.
    it("does not claim from a repository its own checks already failed", async () => {
      const run = await runOneTask(undefined, undefined, {
        readFile: (path) =>
          path.endsWith("package.json") ? JSON.stringify({ scripts: { lint: "eslint" } }) : null,
      });

      expect(run.claimed).toBe(false);
      expect(run.api.claim).not.toHaveBeenCalled();
    });

    it("says which project it is refusing, and why, rather than idling silently", async () => {
      const run = await runOneTask(undefined, undefined, {
        readFile: (path) =>
          path.endsWith("package.json") ? JSON.stringify({ scripts: { lint: "eslint" } }) : null,
      });

      expect(run.logError).toHaveBeenCalledWith(
        expect.stringContaining("not claiming for project p1")
      );
      expect(run.logError).toHaveBeenCalledWith(expect.stringContaining("package-lock.json"));
    });

    // "Why is this machine sitting on a project and doing nothing" has to be answerable from the
    // cockpit, not only from a log line that scrolled past.
    it("says on the socket why the project is not being worked on", async () => {
      const run = await runOneTask(undefined, undefined, {
        readFile: (path) =>
          path.endsWith("package.json") ? JSON.stringify({ scripts: { lint: "eslint" } }) : null,
      });

      expect(run.localConfig?.().projects[0].blocked).toContain("package-lock.json");
    });

    /**
     * BP-504. A key git runs on checkout, planted in a scope `bindRepository`'s own scan does not
     * read — the permanent window BP-346 records. The run refuses before `git worktree add` checks
     * anything out, and the project is then quarantined, because refusing alone leaves the loop
     * claiming the same clone on the next pass for ever.
     */
    describe("a checkout carrying a key git would run on checkout", () => {
      const PLANTED = scopedConfigListZ("filter.z.smudge=touch /tmp/pwned", "worktree");

      it("does not claim for that project again on the next pass", async () => {
        const run = await runOneTask(undefined, undefined, {
          scopedConfig: PLANTED,
          tasks: [CLAIMED, CLAIMED],
          passes: 2,
        });

        expect(run.api.claim).toHaveBeenCalledTimes(1);
      });

      // The control, and the reason the assertion above is about quarantine rather than about the
      // loop merely backing off: with nothing planted, the same budget claims again. Counted as
      // "more than once" rather than exactly twice — a pass that claimed something does not sleep
      // before the next one, so the sleep budget is not the pass count.
      it("keeps claiming over the same budget when nothing is planted", async () => {
        const run = await runOneTask(undefined, undefined, {
          tasks: [CLAIMED, CLAIMED],
          passes: 2,
        });

        expect(run.api.claim.mock.calls.length).toBeGreaterThan(1);
      });

      /**
       * The rebind is what would undo this, and it is why the map is not cleared there the way
       * `unusable` is: that one is recomputed from a static check, while this one records that
       * something planted an executable key in a checkout this machine binds. A re-scan reading
       * clean thirty seconds later is exactly what re-planting produces.
       */
      it("stays quarantined across a rebind", async () => {
        const run = await runOneTask(undefined, undefined, {
          scopedConfig: PLANTED,
          tasks: [CLAIMED, CLAIMED],
          passes: 2,
          // Past MIN_REFRESH_INTERVAL_MS, so a later pass genuinely re-binds rather than returning
          // from the throttle
          clockJumpOnSleepMs: 60_000,
        });

        // Asserted, not assumed. Without this the test is green whether or not a rebind ever
        // happened — "no rebind" and "a rebind that preserved the quarantine" look identical from
        // the claim count — so raising the throttle constant, or changing the sleep budget, would
        // silently turn it into a copy of the test above.
        expect(run.rebinds, "no rebind happened, so this proves nothing").toBeGreaterThan(1);
        expect(run.api.claim).toHaveBeenCalledTimes(1);
      });

      // The control for the one above: the same two passes and the same clock jump, with nothing
      // planted, keep claiming — so that assertion is about the quarantine surviving and not about
      // a rebind that never happened.
      it("re-binds and keeps claiming over that same jump when nothing is planted", async () => {
        const run = await runOneTask(undefined, undefined, {
          tasks: [CLAIMED, CLAIMED],
          passes: 2,
          clockJumpOnSleepMs: 60_000,
        });

        expect(run.rebinds).toBeGreaterThan(1);
        expect(run.api.claim.mock.calls.length).toBeGreaterThan(1);
      });

      it("never checks anything out of the poisoned clone", async () => {
        const run = await runOneTask(undefined, undefined, { scopedConfig: PLANTED });

        expect(
          run.everyCall.some((call) => call.join(" ").includes("worktree add")),
          "the worktree was created anyway"
        ).toBe(false);
      });

      /**
       * The quarantine is keyed on the CHECKOUT, and this is why: `rebind` resolves a project's
       * repository by remote, so several projects can share one path — and the poison is in that
       * path's config, not in any project. Keyed per project, each sibling paid its own claim, its
       * own refusal and its own window against a clone the machine already knew about.
       */
      it("covers every project bound to the same checkout, not only the one that hit it", async () => {
        const run = await runOneTask(undefined, undefined, {
          scopedConfig: PLANTED,
          assignments: [
            { project: "p1", remote: REMOTE },
            { project: "p2", remote: REMOTE },
          ],
        });

        const blocked = run.localConfig?.().projects ?? [];
        expect(blocked).toHaveLength(2);
        for (const project of blocked) {
          expect(project.blocked, `project ${project.project} was left claimable`).toContain(
            "filter.z.smudge"
          );
        }
      });

      /**
       * And it is only the poisoned checkout. Every test above proves the quarantine reaches far
       * enough — siblings on the same path, a second poisoned path — and none of them proved it
       * stops there: quarantining every bound checkout on the machine the moment one is poisoned
       * left the whole suite green. A machine with two repositories would go silent on both, and
       * the second one is not compromised.
       */
      it("leaves a clean checkout on the same machine claimable", async () => {
        const run = await runOneTask(undefined, undefined, {
          repos: [REPO, OTHER_REPO],
          assignments: [
            { project: "p1", remote: REMOTE },
            { project: "p2", remote: OTHER_REMOTE },
          ],
          scopedConfig: { [REPO]: PLANTED },
          tasks: [CLAIMED, { ...CLAIMED, projectId: "p2", taskId: "t2" }],
          passes: 2,
        });

        const projects = run.localConfig?.().projects ?? [];
        expect(projects.find((project) => project.project === "p1")?.blocked).toContain(
          "filter.z.smudge"
        );
        expect(
          projects.find((project) => project.project === "p2")?.blocked,
          "the clean checkout was quarantined along with the poisoned one"
        ).toBe("");
        // And not only on the screen: it is still claimed for.
        expect(run.api.claim.mock.calls.map((call) => call[0])).toContain("p2");
      });

      // And it is per checkout rather than per machine: a second poisoned repository is quarantined
      // on its own, so "the first one wins" cannot pass for this.
      it("quarantines a second poisoned checkout too", async () => {
        const run = await runOneTask(undefined, undefined, {
          repos: [REPO, OTHER_REPO],
          assignments: [
            { project: "p1", remote: REMOTE },
            { project: "p2", remote: OTHER_REMOTE },
          ],
          scopedConfig: { [REPO]: PLANTED, [OTHER_REPO]: PLANTED },
          tasks: [CLAIMED, { ...CLAIMED, projectId: "p2", taskId: "t2" }],
          passes: 2,
        });

        const blocked = run.localConfig?.().projects ?? [];
        expect(blocked).toHaveLength(2);
        for (const project of blocked) {
          expect(project.blocked, `project ${project.project} was left claimable`).toContain(
            "filter.z.smudge"
          );
        }
      });

      /**
       * The console is where a person looks, and until this the answer lived only on the worker's
       * own stderr: the report read `ready`, `bindingError` was empty, and the project simply
       * stopped being claimed. The sibling map — projects whose checkout fails the gates — has
       * reported itself through this list since BP-379.
       */
      it("reports itself as a failed check, so the console says the machine stopped on purpose", async () => {
        const run = await runOneTask(undefined, undefined, { scopedConfig: PLANTED });

        const report = run.heartbeatDeps?.preflight?.();
        expect(report?.ok).toBe(false);
        const check = report?.checks.find((c) => c.name === "checkout quarantined");
        expect(check?.detail).toContain("filter.z.smudge");
        expect(check?.detail).toContain(REPO);
        expect(check?.detail, "the report does not say how to recover").toContain("restart");
      });

      // The control for the one above: a healthy machine does not report a quarantine it has not
      // made — otherwise the assertion is about a check that is always there.
      it("reports no such check when nothing is planted", async () => {
        const run = await runOneTask(undefined, undefined, {});

        const report = run.heartbeatDeps?.preflight?.();
        expect(report?.checks.some((c) => c.name === "checkout quarantined")).toBe(false);
      });

      /**
       * The one thing here no test pins, said rather than left for a mutation to find: which of the
       * two reasons `blocked` shows when a project is BOTH gate-unusable and quarantined. A project
       * that fails its own checks is never claimed from (BP-379), so it never reaches the run that
       * quarantines — the state is unreachable today, and a test for it would have to build a
       * machine that cannot exist. The order in `wiring.ts` is what it should say if a later change
       * makes it reachable, not a behaviour this suite guarantees.
       */
      it("shows the gate requirement when that is the only reason, which is the reachable half", async () => {
        const run = await runOneTask(undefined, undefined, {
          readFile: (path) =>
            path.endsWith("package.json") ? JSON.stringify({ scripts: { lint: "eslint" } }) : null,
        });

        expect(run.localConfig?.().projects[0].blocked).toContain("package-lock.json");
      });

      it("says on the socket why the project is not being worked on", async () => {
        const run = await runOneTask(undefined, undefined, { scopedConfig: PLANTED });

        const blocked = run.localConfig?.().projects[0].blocked;
        expect(blocked).toContain("filter.z.smudge");
        // The whole sentence, not the bare finding. This field sits in the menubar next to the
        // gates' detail sentences and the board's own refusal, where `filter.z.smudge (worktree)`
        // on its own says neither that the machine stopped on purpose nor what to do about it.
        expect(blocked).toContain(REPO);
        expect(blocked, "the way out is not on the screen a person is looking at").toContain(
          "restart"
        );
      });

      /**
       * The board's own refusal (BP-512) is the third reason `blocked` can carry, and unlike the
       * gate one it really can sit next to a quarantine. Not on the project that hit the poison —
       * a successful claim clears its refusal before the run starts — but on a SIBLING bound to
       * the same checkout: `p2`'s board refuses, then `p1`'s run poisons the checkout they share,
       * and `p2` is dropped from the pass before its board is ever asked again. Its refusal is
       * frozen at whatever the board last said, while the checkout is the thing an operator has to
       * go and fix, so that is what the cockpit shows.
       */
      it("shows the quarantine over a sibling's older board refusal, which outlives it", async () => {
        const run = await runOneTask(undefined, undefined, {
          scopedConfig: PLANTED,
          // p2 first: a machine fault ends the pass, so p1 has to be claimed after p2 has been
          // refused, or the refusal is never recorded and this passes for the wrong reason.
          assignments: [
            { project: "p2", remote: REMOTE },
            { project: "p1", remote: REMOTE },
          ],
          claimRefusal: { p2: "This board has no column meaning In progress, so nothing moves." },
        });

        const p2 = run.localConfig?.().projects.find((project) => project.project === "p2");
        expect(p2?.blocked, "nothing was chosen between: no reason was recorded").not.toBe("");
        expect(p2?.blocked).toContain("filter.z.smudge");
      });

      // The control: the same two projects and the same refusal, with nothing planted. Without it
      // a refusal that named a project no assignment carries would leave the assertion above
      // passing for the ordinary reason that the quarantine was the only reason set.
      it("shows the board's refusal when that is all there is", async () => {
        const run = await runOneTask(undefined, undefined, {
          assignments: [
            { project: "p2", remote: REMOTE },
            { project: "p1", remote: REMOTE },
          ],
          claimRefusal: { p2: "This board has no column meaning In progress, so nothing moves." },
        });

        const projects = run.localConfig?.().projects ?? [];
        expect(projects.find((project) => project.project === "p2")?.blocked).toBe(
          "This board has no column meaning In progress, so nothing moves."
        );
        expect(
          projects.find((project) => project.project === "p1")?.blocked,
          "the sibling was blocked too, so the refusal above is not the only thing at work"
        ).toBe("");
      });

      /**
       * Once per checkout, not once per pass: an operator reading stderr for the reason a machine
       * went quiet should find one line, not a line every poll interval for as long as the worker
       * runs.
       *
       * What makes it so is the `assignments()` filter, NOT `quarantineProject`'s own early
       * return — measured: removing that guard leaves this green, because a quarantined checkout
       * is never claimed for again, so the function is never reached a second time. The guard is
       * defensive against a caller that does not exist yet. This test pins the property an
       * operator sees; it deliberately does not pin which of the two produces it, because either
       * one alone is enough and a test that named one would be a test of the wrong thing.
       */
      it("says it once, however many passes go by", async () => {
        const run = await runOneTask(undefined, undefined, {
          scopedConfig: PLANTED,
          tasks: [CLAIMED, CLAIMED],
          passes: 3,
          clockJumpOnSleepMs: 60_000,
        });

        const quarantineLines = run.logError.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.startsWith("quarantining "));
        expect(run.rebinds, "no rebind happened, so this proves nothing").toBeGreaterThan(1);
        expect(quarantineLines).toHaveLength(1);
      });

      it("says it in the worker's own log too, with the finding and what an operator has to do", async () => {
        const run = await runOneTask(undefined, undefined, { scopedConfig: PLANTED });

        const said = run.logError.mock.calls.map((call) => String(call[0]));
        const line = said.find((message) => message.startsWith("quarantining "));
        // One line carrying all three: which checkout, what is in it, and the way out. Asserted on
        // the same string rather than across three calls — a reader gets one line, not a set.
        expect(line, `no quarantine line among ${JSON.stringify(said)}`).toBeDefined();
        expect(line).toContain(REPO);
        expect(line).toContain("filter.z.smudge");
        expect(line).toContain("restarted");
      });

      /**
       * The task is not the one at fault, and nothing ever resets execution.attempts.
       *
       * "release was called" is not the assertion: `reporter.requeued` releases too, with
       * `{ refund: false }`, which is exactly the charging this must not do. So the absence of that
       * option is what says the attempt came back.
       */
      it("hands the task back rather than charging it for the machine's compromise", async () => {
        const run = await runOneTask(undefined, undefined, { scopedConfig: PLANTED });

        expect(run.api.release).toHaveBeenCalled();
        expect(run.api.release).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ refund: false })
        );
      });
    });

    it("claims as before from a repository that has what the gates need", async () => {
      const run = await runOneTask(undefined, undefined, {
        readFile: (path) =>
          path.endsWith("package.json")
            ? JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
            : "{}",
      });

      expect(run.claimed).toBe(true);
      expect(run.localConfig?.().projects[0].blocked).toBe("");
    });

    // The other answer to the same question (BP-512): a checkout that is fine, on a board that
    // refuses to claim at all. The cockpit has to show the board's reason in the same place.
    it("says on the socket why the board itself refused the claim", async () => {
      const run = await runOneTask(undefined, undefined, {
        claimRefusal: "This board has no column meaning In progress, so nothing moves.",
      });

      expect(run.claimed).toBe(false);
      expect(run.localConfig?.().projects[0].blocked).toBe(
        "This board has no column meaning In progress, so nothing moves."
      );
      expect(run.logError).toHaveBeenCalledWith(
        expect.stringContaining("not claiming for project p1: This board has no column meaning")
      );
    });

    it("says nothing about a bound repository that has what the gates need", async () => {
      const run = await runOneTask(undefined, undefined, {
        readFile: (path) =>
          path.endsWith("package.json")
            ? JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
            : "{}",
      });

      const report = run.heartbeatDeps?.preflight?.();
      const repoNames = ["package-lock.json", "build script", "test script"];
      expect(report?.checks.filter((c) => repoNames.includes(c.name) && !c.ok)).toEqual([]);
    });

    // A server that sends a path alongside the remote must not get one used
    it("ignores a path the server sends alongside the remote", async () => {
      const run = await runOneTask(undefined, undefined, {
        extraAssignmentFields: { proposedPath: "/etc", path: "/etc" },
      });

      expect(run.workspacePaths.some((arg) => arg.startsWith("/etc"))).toBe(false);
    });
  });
});

// The check is only worth having if what it resolves actually reaches the child. Resolving
// `claude` through a login shell and then spawning a child whose PATH cannot see it is the exact
// failure mode this task exists to close: preflight green, every task failing.
describe("preflight's place in the wiring", () => {
  const RESOLVED = {
    git: "/opt/homebrew/bin/git",
    npm: "/opt/homebrew/bin/npm",
    claude: "/Users/me/.local/bin/claude",
    gh: "/opt/homebrew/bin/gh",
  };

  const PASSING: PreflightReport = {
    ok: true,
    account: "someone@example.com",
    checks: [{ name: "git", ok: true, detail: RESOLVED.git }],
    paths: RESOLVED,
    githubAccounts: [{ login: "octocat", active: true }],
    githubAccount: "octocat",
    githubPinned: false,
  };

  function preflightHarness(overrides: Partial<WorkerDeps> = {}) {
    const setPath = vi.fn();
    return {
      setPath,
      ...harness({
        env: { ...ENV, PATH: "/usr/bin:/bin" },
        runPreflight: vi.fn().mockResolvedValue(PASSING),
        setPath,
        ...overrides,
      }),
    };
  }

  it("puts the directories the tools were resolved in onto the PATH every child inherits", async () => {
    const { worker, setPath } = preflightHarness();

    const running = worker.run();
    worker.shutdown();
    await running;

    expect(setPath).toHaveBeenCalledWith("/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin");
  });

  it("leaves the PATH alone when every tool is already reachable from it", async () => {
    const { worker, setPath } = preflightHarness({
      env: { ...ENV, PATH: "/opt/homebrew/bin:/Users/me/.local/bin" },
    });

    const running = worker.run();
    worker.shutdown();
    await running;

    expect(setPath).not.toHaveBeenCalled();
  });

  it("reports nothing before preflight has run, rather than reporting a machine as broken", () => {
    const { seen } = preflightHarness();

    expect(seen.heartbeat?.preflight?.()).toBeUndefined();
  });

  it("reports the verdict and the claude account on the heartbeat", async () => {
    const { worker, seen } = preflightHarness();

    const running = worker.run();
    worker.shutdown();
    await running;

    expect(seen.heartbeat?.preflight?.()).toMatchObject({
      ok: true,
      account: "someone@example.com",
    });
  });

  it("keeps the worker running when preflight itself blows up", async () => {
    const { worker, logError, seen } = preflightHarness({
      runPreflight: vi.fn().mockRejectedValue(new Error("no shell on this machine")),
    });

    const running = worker.run();
    worker.shutdown();
    await expect(running).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith(expect.stringContaining("preflight could not run"));
    expect(seen.heartbeat?.preflight?.()).toBeUndefined();
  });
});
