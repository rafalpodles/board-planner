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

const STATE_DIR = "/tmp/cp-wiring-test-state";

interface RemoteCall {
  args: string[];
  env: NodeJS.ProcessEnv;
}

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
  it("gives both server channels the one guarded dispatcher", () => {
    const { seen } = harness();

    expect(seen.heartbeat?.handlers).toBe(seen.control?.handlers);
  });

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

describe("telemetry, from the agent's stdout to the two sinks", () => {
  const REPO = "/repos/demo";
  const REMOTE = "git@github.com:owner/repo.git";
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

  const NEXT_TASK: ClaimedTask = { ...CLAIMED, taskId: "t2", taskKey: "CP-10", taskNumber: 10 };

  const RESULT_PAYLOAD = {
    status: "completed",
    summary: "did it",
    filesChanged: ["src/a.ts"],
    testsAdded: [],
    blockedReason: "",
  };

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

  function pipeFlushes(text: string): string[] {
    const parts: string[] = [];
    for (let index = 0; index < text.length; index += 17) parts.push(text.slice(index, index + 17));
    return parts;
  }

  function streamingRunner(
    claudeCalls: string[][] = [],
    onAgentStart?: (nth: number) => void,
    everyCall: string[][] = [],
    remoteCalls: RemoteCall[] = []
  ): Runner {
    return {
      async run(command, args, opts) {
        everyCall.push([command, ...args]);
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
        if (args[0] === "ls-remote") {
          return { code: 0, stdout: `${BASE_SHA}\t${args[args.length - 1]}\n`, stderr: "", timedOut: false };
        }
        if (args.includes("--verify")) {
          return { code: 0, stdout: `${BASE_SHA}\n`, stderr: "", timedOut: false };
        }
        return {
          code: 0,
          stdout: args.includes("rev-parse") ? REPO : args.includes("get-url") ? REMOTE : "",
          stderr: "",
          timedOut: false,
        };
      },
    };
  }

  async function runOneTask(
    postEvent: ApiClient["postEvent"] = async () => ({ applied: true }),
    policy?: Record<string, unknown>,
    opts: {
      assignmentRemote?: string;
      extraAssignmentFields?: Record<string, unknown>;
      readFile?: (path: string) => string | null;
      stateFiles?: Record<string, string>;
      tasks?: ClaimedTask[];
      claimRefusal?: string;
      onAgentStart?: (nth: number) => void;
    } = {}
  ) {
    let seenHeartbeat: HeartbeatDeps | undefined;
    const stateDir = mkdtempSync(join(tmpdir(), "cp-wiring-run-"));
    writeFileSync(join(stateDir, "repos.json"), JSON.stringify({ repos: [REPO] }), { mode: 0o600 });

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
    let localConfig: (() => LocalConfigView) | undefined;

    const api = {
      claim: vi.fn<ApiClient["claim"]>(async () => {
        if (opts.claimRefusal) throw new ClaimRefused(opts.claimRefusal);
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
      runner: streamingRunner(claudeCalls, opts.onAgentStart, everyCall, remoteCalls),
      hostname: () => "host-1",
      sleep: async () => stop(),
      log: vi.fn(),
      logError,
      uid: 501,
      realpath: (path) => path,
      stat: () => ({ uid: 501, mode: 0o40700 }),
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          offers: [
            {
              project: "p2",
              key: "SB",
              name: "Sandbox",
              repositoryUrl: "https://github.com/owner/sandbox",
            },
          ],
          assignments: [
            {
              project: "p1",
              remote: opts.assignmentRemote ?? REMOTE,
              ...(opts.extraAssignmentFields ?? {}),
              ...(policy ? { policy } : {}),
            },
          ],
        }),
      }) as unknown as typeof fetch,
      createStore: (path) => memoryStore(path.endsWith("worker.json") ? IDENTITY : ""),
      createApi: () => api as unknown as ApiClient,
      createTelemetry: () => telemetry,
      readFile:
        opts.readFile ??
        ((path: string) =>
          path.endsWith("package-lock.json")
            ? "{}"
            : path.endsWith("package.json")
              ? JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
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

    try {
      await worker.run();
    } finally {
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
    };
  }

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
      sleep: async () => {
        reachedSleep = true;
        worker.shutdown();
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

    expect(counts.claims).toBe(1);
    expect(counts.sleeps).toBe(1);
  });

  it("comments once about a base it cannot resolve, however many passes hit the same fault", async () => {
    const { api, counts } = await runAgainstUnreachableRemote({ passes: 3, endlessQueue: true });

    expect(counts.claims).toBe(3);
    expect(api.release).toHaveBeenCalledTimes(3);
    expect(api.comment).toHaveBeenCalledTimes(1);
    expect(api.comment.mock.calls[0][2]).toMatch(/Returned to the queue: .*could not resolve base branch main/s);
  });

  it("carries a pipeline stage boundary to the server", async () => {
    const { api, phases } = await runOneTask();

    expect(api.claim).toHaveBeenCalled();
    expect(phases).toEqual([
      "claiming",
      "worktree",
      "step:implement",
      "agent",
      "agent",
      "gates:protected-paths",
      "gates:diff-size",
      "gates:test-presence",
    ]);
  });

  it("keeps outcomes off the server's phase feed, which carries stages only", async () => {
    const { posted } = await runOneTask();

    expect(posted.length).toBeGreaterThan(0);
    expect(posted.every((event) => typeof event.phase === "string" && event.phase !== "")).toBe(true);
    expect(posted.map((event) => event.phase)).not.toContain(undefined);
  });

  it("carries an event off the agent's own stream to the server", async () => {
    const { phases, telemetry } = await runOneTask();

    expect(phases.filter((phase) => phase === "agent").length).toBeGreaterThan(1);
    expect(telemetry.recent()).toContainEqual({
      phase: "agent",
      tool: { name: "Edit", target: "src/a.ts" },
    });
  });

  it("runs the agent on the model the server's policy names", async () => {
    const { claudeArgs } = await runOneTask(undefined, {
      model: "haiku",
      fallbackModel: "opus",
    });

    expect(claudeArgs[claudeArgs.indexOf("--model") + 1]).toBe("haiku");
    expect(claudeArgs[claudeArgs.indexOf("--fallback-model") + 1]).toBe("opus");
  });

  it("resolves the pinned github account's token by name before the run", async () => {
    const { everyCall } = await runOneTask(undefined, undefined, {
      stateFiles: { "github.json": JSON.stringify({ account: "rafalpodles" }) },
    });

    expect(everyCall).toContainEqual([
      expect.stringContaining("gh"),
      "auth",
      "token",
      "--user",
      "rafalpodles",
    ]);
  });

  it("gives the base lookup the hardened git environment, not merely a token", async () => {
    const { remoteCalls } = await runOneTask();

    expect(remoteCalls.map((call) => call.args[0])).toEqual(["ls-remote", "fetch"]);
    for (const call of remoteCalls) {
      expect(gitConfigPairs(call.env)).toContainEqual(["protocol.ext.allow", "never"]);
    }
  });

  it("asks gh for no token at all when no account is pinned", async () => {
    const { everyCall } = await runOneTask();

    expect(everyCall.filter((call) => call.includes("token"))).toEqual([]);
  });

  it("says so and carries on when the pinned account has no token to give", async () => {
    const { logError } = await runOneTask(undefined, undefined, {
      stateFiles: { "github.json": JSON.stringify({ account: "logged-out-account" }) },
    });

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("logged-out-account")
    );
  });

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

  it("serves the pinned github account on the socket, and never a token", async () => {
    const { localConfig } = await runOneTask(undefined, undefined, {
      stateFiles: { "github.json": JSON.stringify({ account: "rafalpodles" }) },
    });

    const view = localConfig?.();
    expect(view?.githubAccount).toBe("rafalpodles");
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
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", record);
    }

    expect(unhandled).toEqual([]);
    expect(run.posted.length).toBeGreaterThan(0);
    expect(run.api.setStatus).toHaveBeenCalledWith("p1", "t1", "in_review");
  });

  describe("a task taken from the run that holds it", () => {
    it("stops the run when the server says it no longer holds the task", async () => {
      const run = await runOneTask(async (event) => ({ applied: event.phase !== "agent" }));

      expect(run.api.release).toHaveBeenCalledWith("p1", "t1");
      expect(run.api.setStatus).not.toHaveBeenCalledWith("p1", "t1", "in_review");
      expect(run.phases.some((phase) => phase.startsWith("gates:"))).toBe(false);
      const lost = run.logError.mock.calls.filter(([message]) =>
        message.includes("no longer has run")
      );
      expect(lost).toHaveLength(1);
    });

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

      deliverLate();
      await new Promise((resolve) => setImmediate(resolve));

      expect(run.api.setStatus).toHaveBeenCalledWith("p1", "t1", "in_review");
      expect(run.logError).not.toHaveBeenCalledWith(expect.stringContaining("no longer has run"));
    });
  });

  describe("the server can never name a directory here", () => {
    it("binds nothing and reports the reason when the remote is not on this machine", async () => {
      const run = await runOneTask(undefined, undefined, {
        assignmentRemote: "git@github.com:someone/else.git",
      });

      expect(run.claimed).toBe(false);
      expect(run.bindingErrors.join(" ")).toMatch(/no checkout of git@github\.com:someone\/else\.git/);
    });

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

    it("says on the socket why the project is not being worked on", async () => {
      const run = await runOneTask(undefined, undefined, {
        readFile: (path) =>
          path.endsWith("package.json") ? JSON.stringify({ scripts: { lint: "eslint" } }) : null,
      });

      expect(run.localConfig?.().projects[0].blocked).toContain("package-lock.json");
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

    it("ignores a path the server sends alongside the remote", async () => {
      const run = await runOneTask(undefined, undefined, {
        extraAssignmentFields: { proposedPath: "/etc", path: "/etc" },
      });

      expect(run.workspacePaths.some((arg) => arg.startsWith("/etc"))).toBe(false);
    });
  });
});

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
